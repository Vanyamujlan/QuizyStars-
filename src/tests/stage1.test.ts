import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Telegraf, type Context } from 'telegraf';
import type { Request, Response } from 'express';
import {
  firestoreRepo,
  StorageUnavailableError,
  type RepoTransaction,
  type StoreCollectionName,
} from '../db/firestore.ts';
import {
  OrderService,
  canUseTelegramUsernameAsRecipient,
  normalizeRecipientUsername,
} from '../services/OrderService.ts';
import { PaymentService } from '../services/PaymentService.ts';
import {
  FulfillmentService,
  ManualAdminFulfillmentAdapter,
  MyStarsCheckpointError,
  type FulfillmentProviderAdapter,
} from '../services/FulfillmentService.ts';
import { ProductService } from '../services/ProductService.ts';
import { UserService } from '../services/UserService.ts';
import {
  botManager,
  maskSecretsInText,
  verifyWebhookSecretToken,
  isValidTelegramUpdatePayload,
} from '../bot/bot.ts';
import { ensureAdmin, ensureOwner, registerAdminHandlers } from '../bot/handlers/adminHandler.ts';
import {
  clearAllUserInteractiveSessions,
  clearCallbackDebounceMap,
  getUserCheckoutSession,
  registerUserHandlers,
} from '../bot/handlers/userHandler.ts';
import { registerPaymentHandlers } from '../bot/handlers/paymentHandler.ts';
import {
  buildAdminMainKeyboard,
  buildAdminNotificationReviewKeyboard,
  buildAdminOrderActionKeyboard,
  buildAdminOrderRefundConfirmKeyboard,
  buildCatalogCategoriesKeyboard,
  buildMainMenuKeyboard,
  buildOrderCheckoutChooserKeyboard,
  buildOrderConfirmationKeyboard,
  buildOrderCryptoCurrencyKeyboard,
  buildPremiumTariffsKeyboard,
  buildPromptRecipientKeyboard,
  buildTopUpInvoiceKeyboard,
  buildTopUpStep1ProviderKeyboard,
  buildTopUpStep2AmountKeyboard,
  buildTopUpStep3XRocketCurrencyKeyboard,
  buildUserProfileKeyboard,
} from '../bot/keyboards.ts';
import {
  BalanceService,
  calculateTopUpCommission,
  calculateTopUpCommissionCents,
  validateTopUpAmountUsd,
  validateTopUpAmountUsdCents,
} from '../services/BalanceService.ts';
import {
  ExchangeRateUnavailableError,
  PaymentProviderGateway,
  PAYMENT_PROVIDER_CATALOG,
  XRocketApiError,
  buildXRocketApiV1Url,
  computeCryptoBotWebhookSignature,
  computeXRocketWebhookSignature,
  redactSecretsFromText,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from '../services/PaymentProviders.ts';
import {
  bpsFeeAndNetCents,
  centsToUsdString,
  compareScaledDecimal,
  convertUsdCentsToCryptoScaled,
  formatUsdCents,
  parseDecimalToScaled,
  usdInputToCents,
} from '../services/Money.ts';
import {
  formatUsd,
  getEnvConfig,
  MAX_TOPUP_AMOUNT_USD,
  MIN_TOPUP_AMOUNT_USD,
} from '../config/env.ts';
import {
  OUTLINE_EMOJI_REGISTRY,
  oe,
  oeBtn,
  oeSvg,
} from '../bot/outlineEmoji.ts';
import {
  formatAdminNotificationReviewMessage,
  formatAdminOrderCard,
  formatCatalogOverviewMessage,
  formatHelpMessage,
  formatOrderCheckoutChooserMessage,
  formatOrderConfirmationCardMessage,
  formatPremiumTariffsMessage,
  formatTermsMessage,
  formatTopUpInvoiceCardMessage,
  formatTopUpStep2AmountMessage,
  formatUserProfileMessage,
  formatUserTopUpHistoryMessage,
  formatWelcomeMessage,
} from '../bot/formatters.ts';
import {
  DigitalKeyService,
  DuplicateDigitalKeyError,
  OwnerAccessDeniedError,
  UnsupportedKeyGeneratorError,
} from '../services/DigitalKeyService.ts';
import {
  handleProviderWebhookRequest,
  handleTopUpCalculateRequest,
  renderPlainTextStatus,
} from '../../server.ts';
import { Timestamp } from 'firebase-admin/firestore';
import {
  MyStarsApiError,
  MyStarsClient,
  MyStarsFulfillmentAdapter,
  MyStarsRateLimitError,
  MyStarsRecipientIneligibleError,
  MyStarsTransportError,
  MyStarsValidationError,
  buildMyStarsApiV1Url,
  myStarsClient,
  parseRetryAfterSeconds,
  usdtDecimalToUsdCents,
  validateMyStarsMonths,
  validateMyStarsQuantity,
  validateMyStarsUsername,
} from '../services/MyStarsService.ts';
import {
  isActiveSupplierConfigured,
  resolveActiveSupplierProvider,
  validateRecipientWithActiveSupplier,
} from '../services/SupplierValidation.ts';
import type {
  MyStarsPollCheckpoint,
  Order,
  PaymentRecord,
  Product,
  StoreTransaction,
  StoreUser,
} from '../types.ts';

// Force isolated test environment so production Firestore and .data/ are NEVER touched
process.env.NODE_ENV = 'test';
process.env.ALLOW_LOCAL_FALLBACK = 'false';
process.env.ADMIN_IDS = '777000111';

interface AuditTestRecord {
  id: string;
  category: 'Payments' | 'Fulfillment' | 'Security' | 'Database';
  name: string;
  status: 'PASS' | 'FAIL';
  environment: string;
  emulatorUsed: boolean;
  details: string;
}

const testResults: AuditTestRecord[] = [];

function createMockBot(
  sentMessages: Array<{ chatId: number | string; text: string }>,
  shouldFail = false,
): Telegraf {
  return {
    telegram: {
      sendMessage: async (chatId: number | string, text: string) => {
        if (shouldFail) {
          throw new Error('Simulated Telegram API 502 Bad Gateway');
        }
        sentMessages.push({ chatId, text });
        return { message_id: Date.now() };
      },
    },
  } as unknown as Telegraf;
}

interface CapturedBotCall {
  method: string;
  text: string;
  showAlert?: boolean;
  replyMarkupJson: string;
  callbacks: string[];
}

function createWiredBotHarness(includeAdmin = false) {
  const bot = new Telegraf('000000:TEST_HARNESS_TOKEN');
  (bot as unknown as { botInfo: Record<string, unknown> }).botInfo = {
    id: 999000111,
    is_bot: true,
    first_name: 'QuizyStars',
    username: 'quizystars_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  const calls: CapturedBotCall[] = [];
  let updateSeq = 1;
  let messageSeq = 100;

  const mockCallApi = async (
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    const markup = payload.reply_markup as
      | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
      | undefined;
    const callbacks = (markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data)
      .filter((v): v is string => Boolean(v));
    calls.push({
      method,
      text: String(payload.text ?? ''),
      showAlert: payload.show_alert === true,
      replyMarkupJson: JSON.stringify(markup ?? null),
      callbacks,
    });
    if (method === 'answerCallbackQuery') return true;
    return {
      message_id: ++messageSeq,
      date: 1700000000,
      chat: { id: payload.chat_id ?? 1, type: 'private' },
      text: String(payload.text ?? ''),
    };
  };

  (bot.telegram as unknown as {
    callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
  }).callApi = mockCallApi;

  bot.use((ctx, next) => {
    (ctx.telegram as unknown as {
      callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
    }).callApi = mockCallApi;
    return next();
  });

  registerUserHandlers(bot);
  registerPaymentHandlers(bot);
  if (includeAdmin) {
    registerAdminHandlers(bot, () => ({
      connected: true,
      mode: 'polling',
      pollingActive: true,
      botUsername: 'quizystars_bot',
      lastCheckedAt: new Date().toISOString(),
    }));
  }

  return {
    bot,
    calls,
    lastUiCall: () =>
      [...calls]
        .reverse()
        .find((c) => c.method === 'sendMessage' || c.method === 'editMessageText'),
    lastAnswer: () =>
      [...calls].reverse().find((c) => c.method === 'answerCallbackQuery'),
    sendCallback: async (
      from: { id: number; username?: string; first_name: string; last_name?: string },
      data: string,
    ) => {
      await bot.handleUpdate({
        update_id: ++updateSeq,
        callback_query: {
          id: `cb_${updateSeq}`,
          from: { ...from, is_bot: false },
          chat_instance: 'test_chat_instance',
          message: {
            message_id: messageSeq,
            date: 1700000000,
            chat: { id: from.id, type: 'private' },
            text: 'previous',
          },
          data,
        },
      } as unknown as Parameters<Telegraf['handleUpdate']>[0]);
    },
    sendText: async (
      from: { id: number; username?: string; first_name: string; last_name?: string },
      text: string,
    ) => {
      await bot.handleUpdate({
        update_id: ++updateSeq,
        message: {
          message_id: ++messageSeq,
          date: 1700000000,
          chat: { id: from.id, type: 'private' },
          from: { ...from, is_bot: false },
          text,
          ...(text.startsWith('/')
            ? { entities: [{ offset: 0, length: text.split(' ')[0].length, type: 'bot_command' }] }
            : {}),
        },
      } as unknown as Parameters<Telegraf['handleUpdate']>[0]);
    },
  };
}

function createMockExpressRes(): {
  res: Response;
  getStatus: () => number;
  getJson: () => unknown;
} {
  let statusCode = 200;
  let jsonBody: unknown = null;
  const mockRes = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return mockRes;
    },
    json(payload: unknown) {
      jsonBody = payload;
      mockRes.headersSent = true;
      return mockRes;
    },
  };
  const res = mockRes as unknown as Response;

  return {
    res,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
  };
}

async function runTest(
  id: string,
  category: AuditTestRecord['category'],
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  const filterRaw = process.env.TEST_FILTER?.trim();
  if (filterRaw && !new RegExp(filterRaw).test(id)) {
    return;
  }
  try {
    const details = await fn();
    testResults.push({
      id,
      category,
      name,
      status: 'PASS',
      environment: 'Isolated In-Memory Transactional Engine + Mock Telegram API (NODE_ENV=test)',
      emulatorUsed: false,
      details,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : String(error);
    testResults.push({
      id,
      category,
      name,
      status: 'FAIL',
      environment: 'Isolated In-Memory Transactional Engine + Mock Telegram API (NODE_ENV=test)',
      emulatorUsed: false,
      details: errMsg,
    });
    throw error;
  }
}

const TEST_MOCK_CREDS = {
  cryptobotApiToken: 'test_crypto_token_secret_111',
  cryptobotApiUrl: 'https://pay.crypt.bot/api',
  xrocketApiKey: 'test_xrocket_key_secret_444',
  xrocketApiUrl: 'https://pay.api.testnet.xrocket.exchange',
};

let testInvoiceCounter = 800000;

async function payOrderViaCryptoForTest(
  order: Order,
  provider: 'cryptobot' | 'xrocket' = 'cryptobot',
  currency = provider === 'cryptobot' ? 'USD' : 'USDT',
): Promise<{ order: Order; payment: PaymentRecord; duplicate: boolean }> {
  const extInvId = `ext_test_${++testInvoiceCounter}`;
  let createdPaymentId = '';
  let expectedAmount = '';

  const transport = async (
    req: HttpTransportRequest,
  ): Promise<HttpTransportResponse> => {
    if (req.url.endsWith('/getExchangeRates')) {
      return {
        status: 200,
        ok: true,
        json: {
          ok: true,
          result: [
            { source: 'USDT', target: 'USD', rate: '1.00', is_valid: true },
            { source: 'TON', target: 'USD', rate: '5.50', is_valid: true },
          ],
        },
      };
    }
    if (req.url.endsWith('/api/v1/rates')) {
      return {
        status: 200,
        ok: true,
        json: {
          data: { USDT: '1.00', TON: '5.50' },
        },
      };
    }
    if (req.url.endsWith('/api/v1/currencies')) {
      return {
        status: 200,
        ok: true,
        json: [
          { currency: 'USDT', networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'] },
          { currency: 'TON', networks: ['TON'] },
        ],
      };
    }
    if (req.url.endsWith('/createInvoice')) {
      const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
      createdPaymentId = String(body.payload || '');
      expectedAmount = String(body.amount || '0');
      return {
        status: 200,
        ok: true,
        json: {
          ok: true,
          result: {
            invoice_id: extInvId,
            status: 'active',
            amount: expectedAmount,
            fiat: currency === 'USD' ? 'USD' : undefined,
            asset: currency === 'USD' ? undefined : currency,
            currency_type: currency === 'USD' ? 'fiat' : 'crypto',
            bot_invoice_url: `https://t.me/CryptoBot?start=${extInvId}`,
            payload: createdPaymentId,
          },
        },
      };
    }
    if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
      const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
      createdPaymentId = String(body.clientInvoiceId || '');
      expectedAmount = String(body.priceAmount || '0');
      return {
        status: 201,
        ok: true,
        json: {
          id: extInvId,
          priceAmount: expectedAmount,
          priceCurrency: currency,
          clientInvoiceId: createdPaymentId,
          status: 'PENDING',
          links: {
            telegramBotLink: `https://t.me/xrocket?start=${extInvId}`,
          },
        },
      };
    }
    if (req.url.includes('/getInvoices')) {
      return {
        status: 200,
        ok: true,
        json: {
          ok: true,
          result: {
            items: [
              {
                invoice_id: extInvId,
                status: 'paid',
                amount: expectedAmount,
                fiat: currency === 'USD' ? 'USD' : undefined,
                paid_asset: currency === 'USD' ? undefined : currency,
                currency_type: currency === 'USD' ? 'fiat' : 'crypto',
                payload: createdPaymentId,
                fee_in_usd: '0.03',
                paid_at: new Date().toISOString(),
              },
            ],
          },
        },
      };
    }
    if (req.url.includes('/api/v1/invoices?ids=')) {
      return {
        status: 200,
        ok: true,
        json: [
          {
            id: extInvId,
            priceAmount: expectedAmount,
            priceCurrency: currency,
            clientInvoiceId: createdPaymentId,
            status: 'PAID',
            paidAt: new Date().toISOString(),
          },
        ],
      };
    }
    throw new Error(`Unexpected test transport request: ${req.method} ${req.url}`);
  };

  const gateway = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
  const ps = new PaymentService('test-helper', gateway);

  const created = await ps.createOrReuseOrderPayment({
    orderId: order.orderId,
    callerTelegramId: order.userTelegramId,
    provider,
    currency,
    network: provider === 'xrocket' ? 'TON' : undefined,
  });

  const verified = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
  if (!verified.ok || !verified.order || !verified.payment) {
    throw new Error(`payOrderViaCryptoForTest failed: ${verified.reason}`);
  }
  return {
    order: verified.order,
    payment: verified.payment,
    duplicate: verified.duplicate,
  };
}

async function seedLegacyPaidXtrOrderForRefundTest(
  order: Order,
  chargeId: string,
): Promise<Order> {
  const paymentId = PaymentService.getPaymentDocId(chargeId);
  const now = new Date().toISOString();
  return firestoreRepo.runTransaction(async (tx) => {
    const freshOrder = await tx.get<Order>('orders', order.orderId);
    const freshUser = await tx.get<StoreUser>('users', order.userId);
    if (!freshOrder) throw new Error(`Order ${order.orderId} not found`);

    const updatedOrder: Order = {
      ...freshOrder,
      paymentMethod: 'telegram_stars',
      paymentStatus: 'paid',
      fulfillmentStatus: 'paid',
      telegramPaymentChargeId: chargeId,
      activePaymentId: paymentId,
      paidAt: now,
      updatedAt: now,
    };

    const paymentRec: PaymentRecord = {
      paymentId,
      kind: 'order',
      provider: 'telegram_stars',
      orderId: order.orderId,
      userId: order.userId,
      userTelegramId: order.userTelegramId,
      totalAmount: order.totalPrice,
      expectedUsdCents: order.totalPriceUsdCents ?? order.totalPrice,
      expectedAmountStr: String(order.totalPrice),
      feeUsdCents: 0,
      netUsdCents: order.totalPriceUsdCents ?? order.totalPrice,
      currency: 'XTR',
      invoicePayload: order.orderId,
      telegramPaymentChargeId: chargeId,
      status: 'paid',
      paidAt: now,
      createdAt: now,
      updatedAt: now,
    };

    tx.set<PaymentRecord>('payments', paymentId, paymentRec);
    tx.set<Order>('orders', updatedOrder.orderId, updatedOrder);
    if (freshUser) {
      tx.set<StoreUser>('users', freshUser.userId, {
        ...freshUser,
        totalOrders: (freshUser.totalOrders || 0) + 1,
        totalSpentStars: (freshUser.totalSpentStars || 0) + order.totalPrice,
        updatedAt: now,
      });
    }
    return updatedOrder;
  });
}

async function runFullAuditTestSuite(): Promise<void> {
  console.log('================================================================');
  console.log('🧪 ЗАПУСК ПОЛНОГО НАБОРА АВТОТЕСТОВ QUIZYSTARS (ISOLATED MODE)');
  console.log('================================================================');

  firestoreRepo.enableIsolatedTestMode(true);
  FulfillmentService.baseRetryDelayMs = 10;
  FulfillmentService.staleProcessingLeaseMs = 50;

  const buyer1 = {
    id: 100200301,
    username: 'buyer_one',
    first_name: 'Alex',
    last_name: 'Buyer',
  };
  const buyer2 = {
    id: 100200302,
    username: 'buyer_two',
    first_name: 'Boris',
    last_name: 'Other',
  };

  // ===========================================================================
  // 1. PAYMENTS TESTS (USD cents, CryptoBot / xRocket, payment_locks, XTR disabled)
  // ===========================================================================
  await runTest(
    'P-01',
    'Payments',
    'Успешная атомарная обработка оплаты заказа через CryptoBot в центах USD',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50', // $0.90 = 90 cents
        quantity: 2, // $1.80 = 180 cents
      });
      assert.equal(order.totalPriceUsdCents, 180);
      assert.equal(order.totalPrice, 180);
      assert.equal(order.paymentStatus, 'pending');

      const res = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      assert.equal(res.duplicate, false);
      assert.equal(res.order.paymentStatus, 'paid');
      assert.equal(res.order.fulfillmentStatus, 'paid');
      assert.equal(res.payment.expectedUsdCents, 180);

      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 1);
      assert.equal(user?.totalSpentUsdCents, 180);
      return `Заказ #${order.orderId} ($1.80) оплачен через CryptoBot, PaymentRecord создан, статистика пользователя: 1 заказ / $1.80.`;
    },
  );

  await runTest(
    'P-02',
    'Payments',
    'Повторный платёж / повторный webhook (идемпотентность verifyAndProcessOrderPayment)',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const order = orders[0];
      assert.ok(order.activePaymentId);

      const ps = new PaymentService(
        'p02-replay',
        new PaymentProviderGateway(async () => {
          throw new Error('Provider API should not be called when payment is already paid');
        }, TEST_MOCK_CREDS),
      );
      const dupRes = await ps.verifyAndProcessOrderPayment(order.activePaymentId!);

      assert.equal(dupRes.ok, true);
      assert.equal(dupRes.duplicate, true);
      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 1);
      assert.equal(user?.totalSpentUsdCents, 180);
      return 'Повторная проверка/webhook вернула duplicate=true без дублирования PaymentRecord и без повторного инкремента статистики.';
    },
  );

  await runTest(
    'P-03',
    'Payments',
    'Параллельная обработка одинакового платежа заказа (6 конкурентных потоков)',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250', // $4.20 = 420 cents
        quantity: 1,
      });

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'inv_p03_par',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=inv_p03_par',
                payload: body.payload,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 'inv_p03_par',
                    status: 'paid',
                    amount: '4.20',
                    fiat: 'USD',
                    currency_type: 'fiat',
                    payload: created.payment.paymentId,
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected: ${req.url}`);
      };

      const ps = new PaymentService(
        'p03-par',
        new PaymentProviderGateway(transport, TEST_MOCK_CREDS),
      );
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });

      const parallelResults = await Promise.all(
        Array.from({ length: 6 }, () =>
          ps.verifyAndProcessOrderPayment(created.payment.paymentId),
        ),
      );

      const freshCount = parallelResults.filter((r) => r.ok && !r.duplicate).length;
      const dupCount = parallelResults.filter((r) => r.ok && r.duplicate).length;
      assert.equal(freshCount, 1);
      assert.equal(dupCount, 5);

      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 2);
      assert.equal(user?.totalSpentUsdCents, 180 + 420);
      return 'Из 6 параллельных вызовов ровно 1 зафиксировал платёж, 5 получили duplicate=true.';
    },
  );

  await runTest(
    'P-04',
    'Payments',
    'Отклонение недоплаченного платежа по заказу (amount < expectedAmountStr)',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50', // $0.90
        quantity: 1,
      });

      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.payload || '');
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'inv_p04_under',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=inv_p04_under',
                payload: paymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'inv_p04_under',
                  status: 'paid',
                  amount: '0.10', // ожидалось 0.90 USD
                  fiat: 'USD',
                  currency_type: 'fiat',
                  payload: paymentId,
                },
              ],
            },
          },
        };
      };

      const ps = new PaymentService(
        'p04',
        new PaymentProviderGateway(transport, TEST_MOCK_CREDS),
      );
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });
      const res = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'underpaid');
      assert.equal(res.reason, 'UNDERPAID');

      const unchanged = await OrderService.getOrderById(order.orderId);
      assert.equal(unchanged?.paymentStatus, 'pending');
      return 'Платёж с заниженной суммой (0.10 вместо 0.90 USD) отклонён (UNDERPAID), заказ остался pending.';
    },
  );

  await runTest(
    'P-05',
    'Payments',
    'Отклонение платежа с неверной валютой (INVALID_CURRENCY) и отключение XTR',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const preCheck = await PaymentService.validatePreCheckout({
        invoicePayload: order.orderId,
        telegramUserId: buyer1.id,
        currency: 'XTR',
        totalAmount: order.totalPrice,
      });
      assert.equal(preCheck.ok, false);

      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.payload || '');
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'inv_p05_curr',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=inv_p05_curr',
                payload: paymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'inv_p05_curr',
                  status: 'paid',
                  amount: '0.90',
                  fiat: 'EUR',
                  currency_type: 'fiat',
                  payload: paymentId,
                },
              ],
            },
          },
        };
      };

      const ps = new PaymentService(
        'p05',
        new PaymentProviderGateway(transport, TEST_MOCK_CREDS),
      );
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });
      const res = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'INVALID_CURRENCY');
      return 'Telegram XTR отклонён в validatePreCheckout, а несовпадение валюты EUR вместо USD отклонено с INVALID_CURRENCY.';
    },
  );

  await runTest(
    'P-06',
    'Payments',
    'Отклонение оплаты заказа другого пользователя',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const ps = new PaymentService(
        'p06',
        new PaymentProviderGateway(async () => {
          throw new Error('Should not reach provider');
        }, TEST_MOCK_CREDS),
      );

      await assert.rejects(
        async () => {
          await ps.createOrReuseOrderPayment({
            orderId: order.orderId,
            callerTelegramId: buyer2.id,
            provider: 'cryptobot',
            currency: 'USD',
          });
        },
        /оплачивать чужой заказ/,
      );
      return 'Попытка оплатить чужой заказ отклонена с ошибкой владельца.';
    },
  );

  await runTest(
    'P-07',
    'Payments',
    'Отклонение оплаты отсутствующего заказа',
    async () => {
      const ps = new PaymentService(
        'p07',
        new PaymentProviderGateway(async () => {
          throw new Error('Should not reach provider');
        }, TEST_MOCK_CREDS),
      );
      await assert.rejects(
        async () => {
          await ps.createOrReuseOrderPayment({
            orderId: 'ord_non_existent_999999',
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USD',
          });
        },
        /не найден/,
      );
      return 'Оплата несуществующего заказа корректно отклонена.';
    },
  );

  await runTest(
    'P-08',
    'Payments',
    'Проброс ошибки Firestore при сбое записи во время оплаты',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.payload || '');
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'inv_p08_fail',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=inv_p08_fail',
                payload: paymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'inv_p08_fail',
                  status: 'paid',
                  amount: '0.90',
                  fiat: 'USD',
                  currency_type: 'fiat',
                  payload: paymentId,
                },
              ],
            },
          },
        };
      };

      const ps = new PaymentService(
        'p08',
        new PaymentProviderGateway(transport, TEST_MOCK_CREDS),
      );
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });

      firestoreRepo.setSimulatedFailure({
        writeError: 'Simulated Firestore DEADLINE_EXCEEDED on write',
      });

      try {
        await assert.rejects(
          async () => {
            await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
          },
          /Simulated Firestore DEADLINE_EXCEEDED on write/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }

      const afterFail = await OrderService.getOrderById(order.orderId);
      assert.equal(afterFail?.paymentStatus, 'pending');
      return 'Ошибка записи Firestore проброшена вызывающему коду, заказ остался в pending.';
    },
  );

  await runTest(
    'P-09',
    'Payments',
    'Rollback транзакции, запрет чтения после записи и защита markOrderPaid без PaymentRecord',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      // 1. Попытка отметить заказ оплаченным напрямую через markOrderPaid без PaymentRecord
      await assert.rejects(
        async () => {
          await OrderService.markOrderPaid({
            orderId: order.orderId,
            telegramPaymentChargeId: 'unverified_charge_id',
          });
        },
        /PaymentRecord не найден/,
      );

      // 2. Проверка нарушения порядка read-after-write и полного отката транзакции
      await assert.rejects(
        async () => {
          await firestoreRepo.runTransaction(async (tx) => {
            const u = await tx.get<StoreUser>('users', `tg_${buyer1.id}`);
            assert.ok(u);
            tx.set<StoreUser>('users', `tg_${buyer1.id}`, {
              ...u,
              totalOrders: 888888,
            });
            // Нарушаем правило: вызываем tx.get ПОСЛЕ tx.set
            await tx.get<Order>('orders', order.orderId);
          });
        },
        /все операции чтения \(tx\.get\) должны выполняться до операций записи/,
      );

      const userAfterRollback = await UserService.getUserByTelegramId(buyer1.id);
      assert.notEqual(userAfterRollback?.totalOrders, 888888);
      return 'Защита read-before-write сработала, транзакция откатилась, неавторизованный markOrderPaid заблокирован.';
    },
  );

  // ===========================================================================
  // 2. FULFILLMENT TESTS
  // ===========================================================================
  await runTest(
    'F-01',
    'Fulfillment',
    'Повторный запуск одной задачи выдачи (идемпотентность initiateFulfillment)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      const first = await FulfillmentService.initiateFulfillment(paid.order, bot);
      const second = await FulfillmentService.initiateFulfillment(first, bot);

      assert.equal(first.fulfillmentStatus, 'processing');
      assert.equal(second.fulfillmentStatus, 'processing');
      assert.equal(second.fulfillmentAttempts, 1);
      assert.equal(messages.length, 1);
      return 'При повторном вызове initiateFulfillment задача не дублируется (attempts=1, уведомлений=1).';
    },
  );

  await runTest(
    'F-02',
    'Fulfillment',
    'Два параллельных worker на один заказ (атомарный захват до внешней выдачи)',
    async () => {
      let adapterCalls = 0;
      const countingAdapter: FulfillmentProviderAdapter = {
        providerName: 'CountingAutoAdapter',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async (ord, ctx) => {
          adapterCalls++;
          await new Promise((r) => setTimeout(r, 25));
          return {
            handledAutomatically: true,
            status: 'completed',
            details: `Автовыдача выполнена (key=${ctx?.idempotencyKey})`,
            externalReference: `ref_${ord.orderId}`,
          };
        },
      };
      FulfillmentService.setAdapter(countingAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      // Запускаем два параллельных worker одновременно
      await Promise.all([
        FulfillmentService.initiateFulfillment(paid.order, bot),
        FulfillmentService.initiateFulfillment(paid.order, bot),
      ]);

      const finalOrder = await OrderService.getOrderById(order.orderId);
      assert.equal(adapterCalls, 1, 'Внешний адаптер должен быть вызван ровно 1 раз');
      assert.equal(finalOrder?.fulfillmentStatus, 'completed');

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return `Атомарный захват перед вызовом адаптера предотвратил гонку: adapterCalls=${adapterCalls}.`;
    },
  );

  await runTest(
    'F-03',
    'Fulfillment',
    'Падение сервера во время внешней обработки (сверка checkExternalStatus и карантин неидемпотентного провайдера)',
    async () => {
      // Сценарий А: Внешний запрос реально выполнился до падения сервера, провайдер подтверждает через checkExternalStatus
      const crashRecoveryAdapter: FulfillmentProviderAdapter = {
        providerName: 'ProviderWithStatusCheck',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async () => {
          throw new Error('Should not be called if checkExternalStatus returns alreadyExecuted=true');
        },
        checkExternalStatus: async (_ord, key) => ({
          alreadyExecuted: true,
          status: 'completed',
          details: `Выдача подтверждена провайдером по ключу ${key}`,
          externalReference: `ext_verified_${key}`,
        }),
      };
      FulfillmentService.setAdapter(crashRecoveryAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m',
        quantity: 1,
      });
      await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      // Имитируем состояние, когда сервер упал после захвата 'processing', не успев сохранить externalExecutionReference
      const pastIso = new Date(Date.now() - 5000).toISOString();
      await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
        fulfillmentStatus: 'processing',
        fulfillmentStartedAt: pastIso,
        fulfillmentAttempts: 1,
        externalExecutionReference: undefined,
      });

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      const recovered = await FulfillmentService.recoverPendingFulfillments(bot);
      const updatedOrder = await OrderService.getOrderById(order.orderId);
      assert.ok(recovered.length >= 1);
      assert.equal(updatedOrder?.fulfillmentStatus, 'completed');
      assert.ok(updatedOrder?.externalExecutionReference?.startsWith('ext_verified_'));

      // Сценарий Б: Неидемпотентный провайдер без checkExternalStatus — перевод в карантин ручной сверки (без двойной выдачи!)
      let unsafeCalls = 0;
      const nonIdempotentAdapter: FulfillmentProviderAdapter = {
        providerName: 'LegacyNonIdempotentProvider',
        supportsIdempotency: false,
        isConfigured: () => true,
        requestFulfillment: async () => {
          unsafeCalls++;
          return { handledAutomatically: true, status: 'completed', details: 'Done' };
        },
      };
      FulfillmentService.setAdapter(nonIdempotentAdapter);

      const order2 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      await payOrderViaCryptoForTest(order2, 'cryptobot', 'USD');
      await firestoreRepo.updateDoc<Order>('orders', order2.orderId, {
        fulfillmentStatus: 'processing',
        fulfillmentStartedAt: pastIso,
        fulfillmentAttempts: 1,
        externalExecutionReference: undefined,
      });

      await FulfillmentService.recoverPendingFulfillments(bot);
      const quarantinedOrder = await OrderService.getOrderById(order2.orderId);
      assert.equal(unsafeCalls, 0, 'Неидемпотентный адаптер НЕ должен вызываться повторно после крэша');
      assert.equal(quarantinedOrder?.fulfillmentStatus, 'failed');
      assert.equal(quarantinedOrder?.needsManualReconciliation, true);

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return 'Сверка checkExternalStatus восстановила выполненный заказ, а неидемпотентный заказ без сверки переведён в карантин ручной проверки (unsafeCalls=0).';
    },
  );

  await runTest(
    'F-04',
    'Fulfillment',
    'Восстановление зависшего заказа и ограничение числа попыток (MAX_FULFILLMENT_ATTEMPTS=3)',
    async () => {
      let attemptsMade = 0;
      const alwaysFailingAdapter: FulfillmentProviderAdapter = {
        providerName: 'AlwaysFailingAdapter',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async () => {
          attemptsMade++;
          throw new Error(`Provider timeout on attempt #${attemptsMade}`);
        },
      };
      FulfillmentService.setAdapter(alwaysFailingAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const bot = createMockBot([]);

      // Попытка 1, 2, 3
      for (let i = 1; i <= 3; i++) {
        await assert.rejects(async () => {
          await FulfillmentService.initiateFulfillment(paid.order, bot);
        });
      }

      const after3 = await OrderService.getOrderById(order.orderId);
      assert.equal(after3?.fulfillmentAttempts, 3);
      assert.equal(after3?.fulfillmentStatus, 'failed');
      assert.equal(after3?.needsManualReconciliation, true);

      // 4-й вызов не вызывает внешний адаптер, оставляя заказ в failed
      const fourth = await FulfillmentService.initiateFulfillment(after3!, bot);
      assert.equal(attemptsMade, 3);
      assert.equal(fourth.fulfillmentStatus, 'failed');

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return `После ${attemptsMade} неудачных попыток заказ переведён в финальный статус failed (needsManualReconciliation=true) и не застревает в processing.`;
    },
  );

  await runTest(
    'F-05',
    'Fulfillment',
    'Ошибка уведомления Telegram не отменяет подтверждённую оплату или успешную выдачу',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const failingBot = createMockBot([], true); // Telegram API бросает 502

      const inProcessing = await FulfillmentService.initiateFulfillment(
        paid.order,
        failingBot,
      );
      assert.equal(inProcessing.paymentStatus, 'paid');
      assert.equal(inProcessing.fulfillmentStatus, 'processing');
      assert.equal(inProcessing.adminNotifiedAt, undefined);

      const completed = await FulfillmentService.completeOrder({
        orderId: order.orderId,
        adminNote: 'Код активации: STARS-999-XYZ',
        adminTelegramId: 777000111,
        bot: failingBot,
      });
      assert.equal(completed.paymentStatus, 'completed');
      assert.equal(completed.fulfillmentStatus, 'completed');
      assert.equal(completed.buyerNotifiedAt, undefined);
      return 'При падении Telegram API оплата и выдача сохранены в БД (completed), флаги уведомлений ждут повторной отправки.';
    },
  );

  await runTest(
    'F-06',
    'Fulfillment',
    'Повторная отправка уведомления после восстановления связи (retryOrderNotifications)',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const unnotifiedCompleted = orders.find(
        (o) => o.fulfillmentStatus === 'completed' && !o.buyerNotifiedAt,
      );
      assert.ok(unnotifiedCompleted);

      const deliveredMessages: Array<{ chatId: number | string; text: string }> = [];
      const workingBot = createMockBot(deliveredMessages, false);

      const retryRes = await FulfillmentService.retryOrderNotifications(
        unnotifiedCompleted.orderId,
        workingBot,
      );

      assert.equal(retryRes.adminNotified, true);
      assert.equal(retryRes.buyerNotified, true);
      assert.ok(
        deliveredMessages.some((m) => m.text.includes('STARS-999-XYZ')),
        'Покупатель должен получить код активации в повторном уведомлении',
      );
      return `Уведомления админу и покупателю успешно доставлены при повторе (сообщение содержит код активации).`;
    },
  );

  await runTest(
    'F-07',
    'Fulfillment',
    'Защита от двойной выдачи при повторном запуске recovery и completeOrder',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const completedOrder = orders.find((o) => o.fulfillmentStatus === 'completed')!;

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      // Повторный вызов completeOrder и recoverPendingFulfillments
      const again = await FulfillmentService.completeOrder({
        orderId: completedOrder.orderId,
        adminNote: 'Повторное нажатие',
        bot,
      });
      await FulfillmentService.recoverPendingFulfillments(bot);

      assert.equal(again.fulfillmentStatus, 'completed');
      assert.equal(
        messages.length,
        0,
        'Повторный вызов для уже уведомлённого и выданного заказа не отправляет дублирующих сообщений',
      );
      return 'Повторный completeOrder и recoverPendingFulfillments не приводят к повторной выдаче или дублированию сообщений.';
    },
  );

  // ===========================================================================
  // 3. SECURITY TESTS
  // ===========================================================================
  await runTest(
    'S-01',
    'Security',
    'Отсутствие WEBHOOK_SECRET блокирует webhook-запуск и запросы',
    async () => {
      const prevMode = process.env.BOT_MODE;
      const prevSecret = process.env.WEBHOOK_SECRET;
      const prevUrl = process.env.WEBHOOK_URL;

      try {
        process.env.BOT_MODE = 'webhook';
        process.env.WEBHOOK_URL = 'https://example.run.app';
        process.env.WEBHOOK_SECRET = '';

        await assert.rejects(
          async () => {
            await botManager.start();
          },
          /WEBHOOK_SECRET обязательна/,
        );

        const { res, getStatus } = createMockExpressRes();
        const req = {
          header: () => undefined,
          body: { update_id: 1001 },
        } as unknown as Request;

        await botManager.handleWebhookRequest(req, res);
        assert.equal(getStatus(), 503);
      } finally {
        process.env.BOT_MODE = prevMode;
        process.env.WEBHOOK_SECRET = prevSecret;
        process.env.WEBHOOK_URL = prevUrl;
      }
      return 'Запуск в режиме webhook без WEBHOOK_SECRET завершается с ошибкой конфигурации, запросы отклоняются с кодом 503.';
    },
  );

  await runTest(
    'S-02',
    'Security',
    'Отклонение запросов с неправильным X-Telegram-Bot-Api-Secret-Token и поддельных updates',
    async () => {
      const prevSecret = process.env.WEBHOOK_SECRET;
      try {
        process.env.WEBHOOK_SECRET = 'super_secret_webhook_token_123456';

        assert.equal(
          verifyWebhookSecretToken('super_secret_webhook_token_123456', 'wrong_token'),
          false,
        );
        assert.equal(
          verifyWebhookSecretToken(
            'super_secret_webhook_token_123456',
            'super_secret_webhook_token_123456',
          ),
          true,
        );
        assert.equal(isValidTelegramUpdatePayload({ foo: 'bar' }), false);
        assert.equal(isValidTelegramUpdatePayload({ update_id: 42 }), true);

        const { res, getStatus } = createMockExpressRes();
        const forgedReq = {
          header: (name: string) =>
            name === 'X-Telegram-Bot-Api-Secret-Token' ? 'forged_token' : undefined,
          body: {
            update_id: 9999,
            message: {
              successful_payment: {
                currency: 'XTR',
                total_amount: 10,
                invoice_payload: 'ord_forged',
                telegram_payment_charge_id: 'chg_forged',
              },
            },
          },
        } as unknown as Request;

        await botManager.handleWebhookRequest(forgedReq, res);
        assert.equal(getStatus(), 401);
      } finally {
        process.env.WEBHOOK_SECRET = prevSecret;
      }
      return 'Запрос с неверным X-Telegram-Bot-Api-Secret-Token отклонён со статусом 401 Unauthorized до вызова handleUpdate.';
    },
  );

  await runTest(
    'S-03',
    'Security',
    'Блокировка неавторизованного admin callback (ensureAdmin)',
    async () => {
      let alertShown = '';
      const fakeAdminCtx = {
        from: { id: 999888777, first_name: 'Hacker' },
        callbackQuery: { id: 'cb_1', data: 'adm:orders:all' },
        answerCbQuery: async (text: string) => {
          alertShown = text;
          return true;
        },
      } as unknown as Context;

      const allowed = await ensureAdmin(fakeAdminCtx);
      assert.equal(allowed, false);
      assert.ok(alertShown.includes('только администраторам'));
      return 'Неавторизованный callback к админ-панели заблокирован (allowed=false).';
    },
  );

  await runTest(
    'S-04',
    'Security',
    'Защита от доступа к чужому заказу (setOrderRecipientUsername, createOrReuseOrderPayment) и блокировка XTR pre_checkout',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const preCheckout = await PaymentService.validatePreCheckout({
        invoicePayload: order.orderId,
        telegramUserId: buyer2.id,
        currency: 'XTR',
        totalAmount: order.totalPrice,
      });
      assert.equal(preCheckout.ok, false);

      await assert.rejects(
        async () => {
          await OrderService.setOrderRecipientUsername(
            order.orderId,
            buyer2.id,
            'intruder_user',
          );
        },
        /изменять чужой заказ/,
      );
      return 'Доступ чужого пользователя к заказу отклонён, а XTR pre_checkout отключён.';
    },
  );

  // ===========================================================================
  // 4. DATABASE TESTS
  // ===========================================================================
  await runTest(
    'D-01',
    'Database',
    'Fail-safe при недоступности Firebase: запрет создания заказов и обработки платежей',
    async () => {
      firestoreRepo.setSimulatedFailure({ unavailable: true });
      try {
        await assert.rejects(
          async () => {
            await OrderService.createOrder({
              telegramUser: buyer1,
              productId: 'stars_pack_50',
              quantity: 1,
            });
          },
          (err: unknown) => err instanceof StorageUnavailableError,
        );

        await assert.rejects(
          async () => {
            await PaymentService.createOrReuseOrderPayment({
              orderId: 'ord_any',
              callerTelegramId: buyer1.id,
              provider: 'cryptobot',
            });
          },
          (err: unknown) => err instanceof StorageUnavailableError,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'При недоступности БД выбрасывается StorageUnavailableError, заказы и платежи безопасно блокируются.';
    },
  );

  await runTest(
    'D-02',
    'Database',
    'Проброс ошибки чтения Firestore (не проглатывается)',
    async () => {
      firestoreRepo.setSimulatedFailure({
        readError: 'Simulated Firestore UNAVAILABLE on read',
      });
      try {
        await assert.rejects(
          async () => {
            await ProductService.getProductById('stars_pack_50');
          },
          /Simulated Firestore UNAVAILABLE on read/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'Ошибка чтения Firestore корректно передана вызывающему коду.';
    },
  );

  await runTest(
    'D-03',
    'Database',
    'Проброс ошибки записи Firestore (не проглатывается)',
    async () => {
      firestoreRepo.setSimulatedFailure({
        writeError: 'Simulated Firestore PERMISSION_DENIED on write',
      });
      try {
        await assert.rejects(
          async () => {
            await ProductService.createProduct({
              name: 'Test Item',
              category: 'stars',
              description: 'Test',
              price: 15,
            });
          },
          /Simulated Firestore PERMISSION_DENIED on write/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'Ошибка записи Firestore корректно передана вызывающему коду.';
    },
  );

  await runTest(
    'D-04',
    'Database',
    'Cursor pagination (startAfter) без дублей и пропусков',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      for (let i = 1; i <= 5; i++) {
        await OrderService.createOrder({
          telegramUser: buyer1,
          productId: 'stars_pack_50',
          quantity: 1,
        });
        await new Promise((r) => setTimeout(r, 5));
      }

      const page1 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 2,
      });
      assert.equal(page1.items.length, 2);
      assert.equal(page1.hasMore, true);
      assert.ok(page1.nextCursor);

      const page2 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        startAfter: page1.nextCursor,
        limit: 2,
      });
      assert.equal(page2.items.length, 2);
      assert.equal(page2.hasMore, true);

      const page3 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        startAfter: page2.nextCursor,
        limit: 2,
      });
      assert.equal(page3.items.length, 1);
      assert.equal(page3.hasMore, false);

      const allIds = [
        ...page1.items.map((o) => o.orderId),
        ...page2.items.map((o) => o.orderId),
        ...page3.items.map((o) => o.orderId),
      ];
      assert.equal(new Set(allIds).size, 5, 'Все 5 заказов должны быть уникальными без пересечений страниц');
      return 'Постраничная выборка через курсор startAfter вернула 2 + 2 + 1 = 5 уникальных заказов в правильном порядке.';
    },
  );

  await runTest(
    'D-05',
    'Database',
    'Валидация firestore.indexes.json и .gitignore',
    async () => {
      const indexesPath = path.resolve(process.cwd(), 'firestore.indexes.json');
      const indexesRaw = fs.readFileSync(indexesPath, 'utf-8');
      const parsed = JSON.parse(indexesRaw) as {
        indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>;
      };

      assert.ok(Array.isArray(parsed.indexes));
      assert.ok(parsed.indexes.length >= 10);

      const gitignore = fs.readFileSync(
        path.resolve(process.cwd(), '.gitignore'),
        'utf-8',
      );
      assert.ok(gitignore.includes('.data/'));
      assert.ok(gitignore.includes('.env'));
      return `Проверено ${parsed.indexes.length} составных индексов в firestore.indexes.json и правила защиты .gitignore.`;
    },
  );

  // ===========================================================================
  // 5. AUD-004 & AUD-005 STATE MACHINE, TWO-STEP REFUND & CONCURRENCY TESTS
  // ===========================================================================
  await runTest(
    'A-01',
    'Fulfillment',
    'AUD-005: Запрет перевода неоплаченного заказа в processing/completed и фильтрация кнопок админ-клавиатуры',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const pendingOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      // 1. Клавиатура неоплаченного заказа НЕ должна содержать кнопок выдачи или возврата
      const pendingKbJson = JSON.stringify(
        buildAdminOrderActionKeyboard(pendingOrder),
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_proc:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_proc не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_done:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_done не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_note:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_note не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_refund:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_refund не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_cancel:${pendingOrder.orderId}`),
        true,
        'Кнопка adm:ord_cancel должна быть доступна для неоплаченного заказа',
      );

      // 2. Серверная транзакция OrderService.updateOrderStatus отклоняет перевод pending -> processing
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: pendingOrder.orderId,
            fulfillmentStatus: 'processing',
            fulfillmentNote: 'Попытка взять неоплаченный заказ в работу',
          });
        },
        /заказ не оплачен/,
      );

      // 3. Серверная транзакция отклоняет перевод pending -> completed
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: pendingOrder.orderId,
            fulfillmentStatus: 'completed',
          });
        },
        /заказ не оплачен/,
      );

      const unchanged = await OrderService.getOrderById(pendingOrder.orderId);
      assert.equal(unchanged?.paymentStatus, 'pending');
      assert.equal(unchanged?.fulfillmentStatus, 'pending');
      return 'Неоплаченный заказ защищён от перевода в processing/completed на уровне клавиатуры и серверной транзакции.';
    },
  );

  await runTest(
    'A-02',
    'Security',
    'AUD-004: Серверный запрет отмены уже оплаченного или выданного заказа и запрет отката completed -> processing',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      // Клавиатура оплаченного крипто-заказа содержит кнопки выдачи, но НЕ содержит adm:ord_cancel и отключённую XTR adm:ord_refund
      const paidKbJson = JSON.stringify(buildAdminOrderActionKeyboard(paid.order));
      assert.equal(
        paidKbJson.includes(`adm:ord_proc:${order.orderId}`),
        true,
      );
      assert.equal(
        paidKbJson.includes(`adm:ord_refund:${order.orderId}`),
        false,
        'Кнопка возврата XTR adm:ord_refund должна быть удалена в Stage 4.2',
      );
      assert.equal(
        paidKbJson.includes(`adm:ord_cancel:${order.orderId}`),
        false,
        'Оплаченный заказ не должен иметь кнопки отмены adm:ord_cancel',
      );

      // Попытка отменить оплаченный заказ по старой кнопке отклоняется транзакцией
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: order.orderId,
            paymentStatus: 'cancelled',
            fulfillmentStatus: 'cancelled',
          });
        },
        /Невозможно отменить заказ.*уже имеет статус оплаты "paid"/,
      );

      // Перевод оплаченного заказа в processing разрешён
      const inProc = await OrderService.updateOrderStatus({
        orderId: order.orderId,
        fulfillmentStatus: 'processing',
      });
      assert.equal(inProc?.fulfillmentStatus, 'processing');

      // Завершаем выдачу
      const completed = await FulfillmentService.completeOrder({
        orderId: order.orderId,
        adminNote: 'Выдано',
      });
      assert.equal(completed.fulfillmentStatus, 'completed');

      // Попытка вернуть выполненный заказ обратно в processing блокируется
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: order.orderId,
            fulfillmentStatus: 'processing',
          });
        },
        /Невозможно вернуть уже выполненный заказ/,
      );

      return 'Оплаченный и выданный заказы защищены от отмены и отката статуса, XTR refund кнопка отсутствует.';
    },
  );

  await runTest(
    'A-03',
    'Payments',
    'AUD-004: Блокировка возврата XTR для неоплаченных и новых заказов (отсутствует telegram_payment_charge_id)',
    async () => {
      const pendingOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const confirmKbJson = JSON.stringify(
        buildAdminOrderRefundConfirmKeyboard(pendingOrder),
      );
      assert.equal(confirmKbJson.includes('XTR отключён'), true);
      assert.equal(
        confirmKbJson.includes(`adm:ord_refund_confirm:${pendingOrder.orderId}`),
        false,
      );

      // Попытка выполнить XTR возврат блокируется
      await assert.rejects(
        async () => {
          await PaymentService.executeOrderRefund({
            orderId: pendingOrder.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: async () => {},
          });
        },
        /отсутствует исторический telegram_payment_charge_id/,
      );

      const cancelled = await OrderService.updateOrderStatus({
        orderId: pendingOrder.orderId,
        paymentStatus: 'cancelled',
        fulfillmentStatus: 'cancelled',
      });
      assert.equal(cancelled?.paymentStatus, 'cancelled');

      return 'XTR-подтверждение возврата отключено, вызов executeOrderRefund без исторического chargeId заблокирован.';
    },
  );

  await runTest(
    'A-04',
    'Payments',
    'AUD-004: Защита от повторного возврата и конкурентных запросов для исторического XTR-заказа',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });
      await seedLegacyPaidXtrOrderForRefundTest(order, 'chg_a04_concurrent_refund');

      let telegramApiRefundCalls = 0;
      const slowTelegramRefund = async () => {
        telegramApiRefundCalls++;
        await new Promise((resolve) => setTimeout(resolve, 35));
      };

      // Запускаем 4 одновременных запроса на возврат одного и того же исторического заказа
      const settled = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          PaymentService.executeOrderRefund({
            orderId: order.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: slowTelegramRefund,
          }),
        ),
      );

      const fulfilled = settled.filter(
        (
          s,
        ): s is PromiseFulfilledResult<{
          alreadyRefunded: boolean;
          order: Order;
        }> => s.status === 'fulfilled',
      );
      const rejected = settled.filter(
        (s): s is PromiseRejectedResult => s.status === 'rejected',
      );

      assert.equal(
        fulfilled.length,
        1,
        'Ровно 1 из параллельных запросов должен выполнить возврат',
      );
      assert.equal(fulfilled[0].value.alreadyRefunded, false);
      assert.equal(fulfilled[0].value.order.paymentStatus, 'refunded');
      assert.equal(
        rejected.length,
        3,
        'Остальные 3 параллельных запроса во время полёта первого должны быть заблокированы in-flight локом',
      );
      assert.ok(
        rejected.every((r) =>
          String(r.reason).includes('уже выполняется параллельным запросом'),
        ),
      );
      assert.equal(
        telegramApiRefundCalls,
        1,
        'Telegram API refundStarPayment должен быть вызван ровно 1 раз',
      );

      const secondAttempt = await PaymentService.executeOrderRefund({
        orderId: order.orderId,
        adminTelegramId: 777000111,
        callTelegramRefund: slowTelegramRefund,
      });
      assert.equal(secondAttempt.alreadyRefunded, true);
      assert.equal(telegramApiRefundCalls, 1);

      return `Из 4 конкурентных запросов ровно 1 выполнил исторический возврат (calls=${telegramApiRefundCalls}), 3 отклонены in-flight локом.`;
    },
  );

  // ===========================================================================
  // 6. STAGE 3.1: AUD-015, AUD-016, AUD-003, AUD-007 TESTS
  // ===========================================================================
  await runTest(
    'A-05',
    'Payments',
    'AUD-015: Распределённая блокировка возврата через Firestore transaction между двумя независимыми экземплярами PaymentService',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });
      await seedLegacyPaidXtrOrderForRefundTest(order, 'chg_a05_distributed_lock');

      const serviceNodeA = new PaymentService('node-A');
      const serviceNodeB = new PaymentService('node-B');

      let telegramRefundCalls = 0;
      const simulatedTelegramRefund = async () => {
        telegramRefundCalls++;
        await new Promise((resolve) => setTimeout(resolve, 40));
      };

      const [resA, resB] = await Promise.allSettled([
        serviceNodeA.executeOrderRefund({
          orderId: order.orderId,
          adminTelegramId: 777000111,
          callTelegramRefund: simulatedTelegramRefund,
        }),
        serviceNodeB.executeOrderRefund({
          orderId: order.orderId,
          adminTelegramId: 777000111,
          callTelegramRefund: simulatedTelegramRefund,
        }),
      ]);

      const successes = [resA, resB].filter(
        (
          r,
        ): r is PromiseFulfilledResult<{
          alreadyRefunded: boolean;
          order: Order;
        }> => r.status === 'fulfilled',
      );
      const failures = [resA, resB].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.ok(
        String(failures[0].reason).includes(
          'уже выполняется параллельным запросом',
        ),
      );
      assert.equal(telegramRefundCalls, 1);

      const orderStuck = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      await seedLegacyPaidXtrOrderForRefundTest(orderStuck, 'chg_a05_expired_lock_guard');

      const veryOldTimestamp = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      await firestoreRepo.updateDoc<Order>('orders', orderStuck.orderId, {
        refundState: 'refund_in_progress',
        refundLockToken: 'rflock_crashed_node_old',
        refundStartedAt: veryOldTimestamp,
      });

      let duplicateTelegramCallOnExpiredLock = 0;
      await assert.rejects(
        async () => {
          await serviceNodeB.executeOrderRefund({
            orderId: orderStuck.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: async () => {
              duplicateTelegramCallOnExpiredLock++;
            },
          });
        },
        /уже выполняется параллельным запросом/,
      );
      assert.equal(duplicateTelegramCallOnExpiredLock, 0);

      await serviceNodeB.recoverPendingRefunds({
        quarantineStaleInProgress: true,
      });
      const quarantined = await OrderService.getOrderById(orderStuck.orderId);
      assert.equal(
        quarantined?.refundState,
        'refund_failed_needs_reconciliation',
      );
      assert.equal(quarantined?.needsManualReconciliation, true);

      return 'Распределённая блокировка в Firestore между node-A и node-B предотвратила двойной вызов (calls=1).';
    },
  );

  await runTest(
    'A-06',
    'Payments',
    'AUD-016: Устойчивое восстановление после сбоя Firestore вслед за подтверждённым историческим возвратом',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 2,
      });
      await seedLegacyPaidXtrOrderForRefundTest(order, 'chg_a06_tg_ok_db_fail');

      const userBeforeRefund = await UserService.getUserByTelegramId(buyer1.id);
      assert.ok(userBeforeRefund);
      const ordersBefore = userBeforeRefund.totalOrders;
      const spentBefore = userBeforeRefund.totalSpentStars;

      const paymentService = new PaymentService('node-recovery');
      let telegramRefundCalls = 0;

      await assert.rejects(
        async () => {
          await paymentService.executeOrderRefund({
            orderId: order.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: async () => {
              telegramRefundCalls++;
              firestoreRepo.setSimulatedFailure({
                writeError:
                  'Simulated Firestore UNAVAILABLE right after Telegram refundStarPayment succeeded',
              });
            },
          });
        },
        /Simulated Firestore UNAVAILABLE right after Telegram refundStarPayment succeeded/,
      );

      firestoreRepo.setSimulatedFailure({});
      assert.equal(telegramRefundCalls, 1);

      const orderMidCrash = await OrderService.getOrderById(order.orderId);
      assert.equal(orderMidCrash?.refundState, 'refund_in_progress');

      const recoveredOrders = await paymentService.recoverPendingRefunds();
      assert.ok(recoveredOrders.some((o) => o.orderId === order.orderId));

      const orderAfterRecovery = await OrderService.getOrderById(order.orderId);
      assert.equal(orderAfterRecovery?.paymentStatus, 'refunded');
      assert.equal(orderAfterRecovery?.fulfillmentStatus, 'refunded');
      assert.equal(orderAfterRecovery?.refundState, 'refunded');
      assert.equal(orderAfterRecovery?.refundStatsAdjusted, true);

      const retryAfterRecovery = await paymentService.executeOrderRefund({
        orderId: order.orderId,
        adminTelegramId: 777000111,
        callTelegramRefund: async () => {
          telegramRefundCalls++;
        },
      });
      assert.equal(retryAfterRecovery.alreadyRefunded, true);
      assert.equal(telegramRefundCalls, 1);

      const userAfterRecovery = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(userAfterRecovery?.totalOrders, ordersBefore - 1);
      assert.equal(
        userAfterRecovery?.totalSpentStars,
        spentBefore - order.totalPrice,
      );

      return 'После сбоя Firestore вслед за успешным ответом заказ, платёж и статистика консистентно восстановлены в refunded.';
    },
  );

  await runTest(
    'A-07',
    'Payments',
    'AUD-003: Корректное уменьшение статистики пользователя (totalOrders, totalSpentUsdCents) при возврате на баланс без двойного вычитания',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();

      // Зачислим $20.00 на внутренний баланс через seed
      await firestoreRepo.runTransaction(async (tx) => {
        const u = await tx.get<StoreUser>('users', `tg_${buyer1.id}`);
        const now = new Date().toISOString();
        tx.set<StoreUser>('users', `tg_${buyer1.id}`, {
          ...(u || {
            userId: `tg_${buyer1.id}`,
            telegramId: buyer1.id,
            firstName: buyer1.first_name,
            isBlocked: false,
            totalOrders: 0,
            totalSpentStars: 0,
            createdAt: now,
          }),
          balanceUsdCents: 2000,
          balance: 20,
          totalOrders: 0,
          totalSpentUsdCents: 0,
          updatedAt: now,
        });
      });

      const p1 = await bs.purchaseWithInternalBalance({
        telegramId: buyer1.id,
        productId: 'stars_pack_50', // $0.90 x 2 = $1.80 (180 cents)
        quantity: 2,
      });
      const p2 = await bs.purchaseWithInternalBalance({
        telegramId: buyer1.id,
        productId: 'stars_pack_250', // $4.20 (420 cents)
        quantity: 1,
      });

      const userAfterPayments = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(userAfterPayments?.totalOrders, 2);
      assert.equal(userAfterPayments?.totalSpentUsdCents, 600);

      await bs.refundOrderToInternalBalance({
        orderId: p2.order.orderId,
        reason: 'Тест уменьшения статистики USD',
        adminTelegramId: 777000111,
      });

      const userAfterFirstRefund = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(userAfterFirstRefund?.totalOrders, 1);
      assert.equal(userAfterFirstRefund?.totalSpentUsdCents, 180);

      // Повторный возврат НЕ должен уменьшать статистику повторно
      await bs.refundOrderToInternalBalance({
        orderId: p2.order.orderId,
        reason: 'Повтор',
        adminTelegramId: 777000111,
      });

      const userAfterDup = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(userAfterDup?.totalOrders, 1);
      assert.equal(userAfterDup?.totalSpentUsdCents, 180);

      void p1;
      return 'Статистика пользователя корректно уменьшена после возврата на баланс (2 -> 1 заказ, $6.00 -> $1.80), повторные вызовы не дублируют списание.';
    },
  );

  await runTest(
    'A-08',
    'Database',
    'AUD-007: Сохранение статистики пользователя (totalOrders, totalSpentUsdCents, isBlocked) при параллельном обновлении профиля и оплатах/возврате',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();

      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 10000,
        balance: 100,
      });

      // 4 параллельные покупки по $0.90 (90 cents) = $3.60 (360 cents) + 6 параллельных upsertFromTelegram
      const orders = await Promise.all(
        Array.from({ length: 4 }, (_, idx) =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_pack_50',
            quantity: 1,
            orderId: `ord_a08_conc_${idx}`,
          }),
        ),
      );
      await Promise.all(
        Array.from({ length: 6 }, (_, idx) =>
          UserService.upsertFromTelegram({
            id: buyer1.id,
            username: `buyer_one_updated_${idx}`,
            first_name: `Alex_${idx}`,
            last_name: 'Concurrent',
            language_code: 'ru',
          }),
        ),
      );

      const userAfterConcurrentWrites = await UserService.getUserByTelegramId(
        buyer1.id,
      );
      assert.ok(userAfterConcurrentWrites);
      assert.equal(userAfterConcurrentWrites.totalOrders, 4);
      assert.equal(userAfterConcurrentWrites.totalSpentUsdCents, 360);
      assert.ok(
        userAfterConcurrentWrites.username?.startsWith('buyer_one_updated_'),
      );

      await Promise.all([
        bs.refundOrderToInternalBalance({
          orderId: orders[0].order.orderId,
          reason: 'A08 refund',
          adminTelegramId: 777000111,
        }),
        UserService.setUserBlocked(buyer1.id, true),
        UserService.upsertFromTelegram({
          id: buyer1.id,
          username: 'buyer_one_final',
          first_name: 'AlexFinal',
          last_name: 'Concurrent',
          language_code: 'ru',
        }),
      ]);

      const userFinal = await UserService.getUserByTelegramId(buyer1.id);
      assert.ok(userFinal);
      assert.equal(userFinal.totalOrders, 3);
      assert.equal(userFinal.totalSpentUsdCents, 270);
      assert.equal(userFinal.isBlocked, true);
      assert.equal(userFinal.username, 'buyer_one_final');

      return 'Транзакционное обновление профиля сохранило 100% начислений и списаний (3 заказа, $2.70, isBlocked=true).';
    },
  );

  // ===========================================================================
  // 7. STAGE 3.2: BALANCE TOP-UP SYSTEM & PAYMENT PROVIDERS TESTS (B-01..B-15)
  // ===========================================================================
  const mockCreds = TEST_MOCK_CREDS;

  await runTest(
    'B-01',
    'Payments',
    'Проверка комиссий в USD (CryptoBot 3%, xRocket 2%), копеечной точности и минималистичного 3-шагового интерфейса пополнения без пресетов',
    async () => {
      const cb100 = calculateTopUpCommission(100, 'cryptobot');
      assert.equal(cb100.amountPaid, 100);
      assert.equal(cb100.feePercent, 3);
      assert.equal(cb100.feeAmount, 3);
      assert.equal(cb100.amountCredited, 97);

      const xr100 = calculateTopUpCommission(100, 'xrocket');
      assert.equal(xr100.amountPaid, 100);
      assert.equal(xr100.feePercent, 2);
      assert.equal(xr100.feeAmount, 2);
      assert.equal(xr100.amountCredited, 98);

      // Проверка дробных сумм без ошибок округления IEEE-754
      const cbFractional = calculateTopUpCommission(250.5, 'cryptobot');
      assert.equal(cbFractional.feeAmount, 7.52);
      assert.equal(cbFractional.amountCredited, 242.98);

      // Проверка кнопки «Пополнить баланс» в профиле пользователя
      const profileKbJson = JSON.stringify(buildUserProfileKeyboard());
      assert.ok(
        profileKbJson.includes('Пополнить баланс') &&
          profileKbJson.includes('menu:topup'),
        'Кнопка «Пополнить баланс» (menu:topup) должна присутствовать в профиле',
      );

      // Проверка каталога провайдеров (ровно 2 поддерживаемых провайдера: cryptobot и xrocket, presetAmounts пуст)
      assert.deepEqual(
        Object.keys(PAYMENT_PROVIDER_CATALOG).sort(),
        ['cryptobot', 'xrocket'],
      );
      assert.equal(PAYMENT_PROVIDER_CATALOG.cryptobot.feePercent, 3);
      assert.equal(PAYMENT_PROVIDER_CATALOG.xrocket.feePercent, 2);
      assert.equal(PAYMENT_PROVIDER_CATALOG.cryptobot.defaultCurrency, 'USD');
      assert.equal(PAYMENT_PROVIDER_CATALOG.xrocket.defaultCurrency, 'USDT');
      assert.deepEqual(PAYMENT_PROVIDER_CATALOG.cryptobot.presetAmounts, []);
      assert.deepEqual(PAYMENT_PROVIDER_CATALOG.xrocket.presetAmounts, []);

      // Проверка 3-шагового минималистичного интерфейса
      const step1Kb = JSON.stringify(buildTopUpStep1ProviderKeyboard());
      assert.ok(step1Kb.includes('CryptoBot [3%]'));
      assert.ok(step1Kb.includes('xRocket [2%]'));

      const step2Kb = JSON.stringify(
        buildTopUpStep2AmountKeyboard('xrocket', 100, 'USDT'),
      );
      assert.ok(step2Kb.includes('topup:xr_curr:100'));

      const step3XrKb = JSON.stringify(
        buildTopUpStep3XRocketCurrencyKeyboard(100),
      );
      assert.ok(step3XrKb.includes('USDT (TON)'));
      assert.ok(step3XrKb.includes('BTC (Bitcoin)'));

      return 'Комиссии провайдеров в USD проверены: CryptoBot $100.00 -> $97.00 (3%), xRocket $100.00 -> $98.00 (2%), пресеты удалены.';
    },
  );

  await runTest(
    'B-02',
    'Payments',
    'Успешное пополнение баланса в USD через CryptoBot (создание счёта -> подписанный webhook -> серверная проверка API -> атомарное зачисление)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 910001,
                status: 'active',
                amount: body.amount,
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=IV910001',
                payload: body.payload,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices') && req.method === 'GET') {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 910001,
                    status: 'paid',
                    amount: '100.00',
                    fiat: 'USD',
                    currency_type: 'fiat',
                    payload: created.paymentId,
                    paid_at: new Date().toISOString(),
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const created = await service.createTopUp({
        telegramId: buyer1.id,
        username: buyer1.username,
        firstName: buyer1.first_name,
        provider: 'cryptobot',
        amountPaid: 100,
        currency: 'USD',
      });

      assert.equal(created.paymentStatus, 'pending');
      assert.equal(created.amountPaid, 100);
      assert.equal(created.amountUsd, 100);
      assert.equal(created.feePercent, 3);
      assert.equal(created.feeAmount, 3);
      assert.equal(created.amountCredited, 97);
      assert.equal(await service.getBalance(buyer1.id), 0);

      // Проверка минималистичной клавиатуры созданного счёта (3 кнопки)
      const invKb = JSON.stringify(buildTopUpInvoiceKeyboard(created));
      assert.ok(invKb.includes('Оплатить'));
      assert.ok(invKb.includes('Проверить оплату'));
      assert.ok(invKb.includes('Назад'));

      const webhookBody = JSON.stringify({
        update_id: 5001,
        update_type: 'invoice_paid',
        payload: {
          invoice_id: 910001,
          status: 'paid',
          amount: '100.00',
          fiat: 'USD',
          currency_type: 'fiat',
          payload: created.paymentId,
        },
      });
      const validSignature = computeCryptoBotWebhookSignature(
        webhookBody,
        mockCreds.cryptobotApiToken,
      );

      const res = await service.processWebhook({
        provider: 'cryptobot',
        rawBody: webhookBody,
        headers: { 'crypto-pay-api-signature': validSignature },
      });

      assert.equal(res.ok, true);
      assert.equal(res.duplicate, false);
      assert.equal(res.status, 'paid');
      assert.equal(res.newBalance, 97);
      assert.equal(await service.getBalance(buyer1.id), 97);

      const savedTopUp = await service.getTopUpById(created.paymentId);
      assert.equal(savedTopUp?.paymentStatus, 'paid');
      assert.ok(savedTopUp?.paidAt);

      return `Счёт ${created.paymentId} на $100.00 USD успешно подтверждён через серверный API CryptoBot, зачислено $97.00 (комиссия 3%).`;
    },
  );

  await runTest(
    'B-03',
    'Security',
    'Отклонение вебхука с неверной подписью (CryptoBot, xRocket) без зачисления средств',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let verifyApiCalled = 0;
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 910002,
                status: 'active',
                amount: body.amount,
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=IV910002',
                payload: body.payload,
              },
            },
          };
        }
        verifyApiCalled++;
        throw new Error('Verify API must not be called when webhook signature is invalid');
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const created = await service.createTopUp({
        telegramId: buyer1.id,
        username: buyer1.username,
        provider: 'cryptobot',
        amountPaid: 500,
        currency: 'USD',
      });

      const forgedRawBody = JSON.stringify({
        update_type: 'invoice_paid',
        payload: {
          invoice_id: 910002,
          status: 'paid',
          amount: '500.00',
          fiat: 'USD',
          currency_type: 'fiat',
          payload: created.paymentId,
        },
      });

      const forgedCrypto = await service.processWebhook({
        provider: 'cryptobot',
        rawBody: forgedRawBody,
        headers: { 'crypto-pay-api-signature': 'deadbeef0000invalid' },
      });
      assert.equal(forgedCrypto.ok, false);
      assert.equal(forgedCrypto.reason, 'INVALID_WEBHOOK_SIGNATURE');

      const forgedXRocket = await service.processWebhook({
        provider: 'xrocket',
        rawBody: forgedRawBody,
        headers: { 'rocket-pay-signature': 'bad_xrocket_sig' },
      });
      assert.equal(forgedXRocket.ok, false);
      assert.equal(forgedXRocket.reason, 'INVALID_WEBHOOK_SIGNATURE');

      assert.equal(verifyApiCalled, 0);
      assert.equal(await service.getBalance(buyer1.id), 0);

      return 'Поддельные вебхуки CryptoBot и xRocket отклонены с INVALID_WEBHOOK_SIGNATURE, баланс остался $0.00.';
    },
  );

  await runTest(
    'B-04',
    'Payments',
    'xRocket Pay REST API v1 (POST /api/v1/invoices, Bearer Auth, HTTP 201 Created, GET /api/v1/invoices?ids=..., защита от дублирования /api/v1 и идемпотентность)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      // Проверка buildXRocketApiV1Url: отсутствие двойного /api/v1/api/v1
      assert.equal(
        buildXRocketApiV1Url(
          'https://pay.api.testnet.xrocket.exchange',
          '/invoices',
        ),
        'https://pay.api.testnet.xrocket.exchange/api/v1/invoices',
      );
      assert.equal(
        buildXRocketApiV1Url(
          'https://pay.api.testnet.xrocket.exchange/api/v1/',
          '/invoices',
        ),
        'https://pay.api.testnet.xrocket.exchange/api/v1/invoices',
      );

      let currentTopUpId = '';
      let capturedCreateRequest: HttpTransportRequest | null = null;

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'USDT', networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { USDT: '1.00', TON: '5.00' } },
          };
        }
        if (
          req.url === 'https://pay.api.testnet.xrocket.exchange/api/v1/invoices' &&
          req.method === 'POST'
        ) {
          capturedCreateRequest = req;
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_inv_v1_404',
              priceAmount: String(body.priceAmount),
              priceCurrency: String(body.priceCurrency),
              payCurrencies: body.payCurrencies,
              clientInvoiceId: body.clientInvoiceId,
              status: 'PENDING',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
              links: {
                telegramBotLink: 'https://t.me/xrocket?start=inv_xr_inv_v1_404',
              },
            },
          };
        }
        if (
          req.url ===
            'https://pay.api.testnet.xrocket.exchange/api/v1/invoices?ids=xr_inv_v1_404' &&
          req.method === 'GET'
        ) {
          assert.equal(
            req.headers.Authorization,
            `Bearer ${mockCreds.xrocketApiKey}`,
          );
          return {
            status: 200,
            ok: true,
            json: [
              {
                id: 'xr_inv_v1_404',
                priceAmount: '100.00',
                priceCurrency: 'USDT',
                clientInvoiceId: currentTopUpId,
                status: 'PAID',
                paidAt: new Date().toISOString(),
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        username: buyer1.username,
        provider: 'xrocket',
        amountPaid: 100,
        currency: 'USDT',
        network: 'TON',
      });
      currentTopUpId = topUp.paymentId;

      assert.ok(capturedCreateRequest, 'Запрос POST /api/v1/invoices должен быть выполнен');
      const sentReq = capturedCreateRequest as HttpTransportRequest;
      assert.equal(
        sentReq.headers.Authorization,
        `Bearer ${mockCreds.xrocketApiKey}`,
        'Должен использоваться заголовок Authorization: Bearer <TOKEN>',
      );
      const parsedSentBody = JSON.parse(sentReq.body || '{}') as Record<
        string,
        unknown
      >;
      assert.equal(parsedSentBody.priceAmount, '100.00');
      assert.equal(parsedSentBody.priceCurrency, 'USDT');
      assert.deepEqual(parsedSentBody.payCurrencies, ['USDT']);
      assert.equal(parsedSentBody.clientInvoiceId, topUp.paymentId);
      assert.equal(parsedSentBody.expiresIn, 1800000);
      assert.equal(
        topUp.payUrl,
        'https://t.me/xrocket?start=inv_xr_inv_v1_404',
      );
      assert.equal(topUp.network, 'TON');

      const rawBody = JSON.stringify({
        type: 'invoicePay',
        data: {
          id: 'xr_inv_v1_404',
          priceAmount: '100.00',
          priceCurrency: 'USDT',
          status: 'PAID',
          clientInvoiceId: topUp.paymentId,
        },
      });
      const sig = computeXRocketWebhookSignature(rawBody, mockCreds.xrocketApiKey);

      // Отправляем 3 одинаковых вебхука и 2 ручные проверки параллельно
      const results = await Promise.all([
        service.processWebhook({
          provider: 'xrocket',
          rawBody,
          headers: { 'rocket-pay-signature': sig },
        }),
        service.processWebhook({
          provider: 'xrocket',
          rawBody,
          headers: { 'rocket-pay-signature': sig },
        }),
        service.processWebhook({
          provider: 'xrocket',
          rawBody,
          headers: { 'rocket-pay-signature': sig },
        }),
        service.verifyAndProcessTopUp(topUp.paymentId),
        service.verifyAndProcessTopUp(topUp.paymentId),
      ]);

      const firstTimeCredits = results.filter((r) => r.ok && !r.duplicate);
      const duplicateCredits = results.filter((r) => r.ok && r.duplicate);

      assert.equal(
        firstTimeCredits.length,
        1,
        'Ровно 1 вызов должен выполнить первичное зачисление',
      );
      assert.equal(
        duplicateCredits.length,
        4,
        'Остальные 4 вызова должны идемпотентно вернуть duplicate=true',
      );
      assert.equal(
        await service.getBalance(buyer1.id),
        98,
        'Баланс должен быть пополнен ровно 1 раз на $98.00 (xRocket комиссия 2%)',
      );

      return 'xRocket Pay REST API v1 (POST /api/v1/invoices, Bearer Auth, HTTP 201 Created, links.telegramBotLink) проверен; из 5 параллельных вызовов баланс пополнен ровно 1 раз на $98.00.';
    },
  );

  await runTest(
    'B-05',
    'Security',
    'Диагностика структурированной ошибки xRocket Pay REST API v1 (HTTP 404 Problem Details: status, type, title, detail, instance, kind) и отклонение INVALID_AMOUNT',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      // 1. Проверка парсинга HTTP 404 Problem Details от xRocket Pay REST API v1
      const errorTransport = async (): Promise<HttpTransportResponse> => ({
        status: 404,
        ok: false,
        json: {
          status: 404,
          type: 'https://pay.api.xrocket.exchange/errors/not-found',
          title: 'Not Found',
          detail: 'Merchant app or endpoint was not found in xRocket Pay',
          instance: '/api/v1/invoices',
          kind: 'NOT_FOUND',
        },
      });
      const errorGateway = new PaymentProviderGateway(errorTransport, mockCreds);

      let caughtError: unknown = null;
      try {
        await errorGateway.createInvoice({
          provider: 'xrocket',
          paymentId: 'topup_404_check',
          amountPaid: 100,
          currency: 'USDT',
          description: 'Test 404 Problem Details',
        });
      } catch (err) {
        caughtError = err;
      }

      assert.ok(
        caughtError instanceof XRocketApiError,
        'Ошибка xRocket HTTP 404 должна быть экземпляром XRocketApiError со структурированными полями Problem Details',
      );
      assert.equal(caughtError.httpStatus, 404);
      assert.equal(caughtError.problemDetails.status, 404);
      assert.equal(caughtError.problemDetails.title, 'Not Found');
      assert.equal(
        caughtError.problemDetails.detail,
        'Merchant app or endpoint was not found in xRocket Pay',
      );
      assert.equal(caughtError.problemDetails.instance, '/api/v1/invoices');
      assert.equal(caughtError.problemDetails.kind, 'NOT_FOUND');

      // 2. Проверка отклонения платежа с меньшей суммой (INVALID_AMOUNT)
      let currentTopUpId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 55001,
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                status: 'active',
                bot_invoice_url: 'https://t.me/CryptoBot?start=IV55001',
                payload: body.payload,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices') && req.method === 'GET') {
          // Провайдер возвращает меньшую сумму (50 вместо 200)
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 55001,
                    payload: currentTopUpId,
                    amount: '50.00',
                    fiat: 'USD',
                    currency_type: 'fiat',
                    status: 'paid',
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        provider: 'cryptobot',
        amountPaid: 200,
        currency: 'USD',
      });
      currentTopUpId = topUp.paymentId;

      const check = await service.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(check.ok, false);
      assert.equal(check.status, 'underpaid');
      assert.equal(check.reason, 'UNDERPAID');
      assert.equal(await service.getBalance(buyer1.id), 0);

      const updated = await service.getTopUpById(topUp.paymentId);
      assert.equal(updated?.paymentStatus, 'underpaid');

      return 'Структурированный ответ xRocket HTTP 404 (status, type, title, detail, instance, kind) сохраняется в XRocketApiError; недоплата заблокирована со статусом underpaid (UNDERPAID).';
    },
  );

  await runTest(
    'B-06',
    'Security',
    'Отклонение платежа с неверной валютой (INVALID_CURRENCY)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let currentTopUpId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'USDT', networks: ['TON', 'TRC-20'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { USDT: '1.00' } },
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_curr_606',
              priceAmount: String(body.priceAmount),
              priceCurrency: 'USDT',
              status: 'PENDING',
              clientInvoiceId: body.clientInvoiceId,
              links: {
                telegramBotLink: 'https://t.me/xrocket?start=xr_curr_606',
              },
            },
          };
        }
        if (
          req.url.includes('/api/v1/invoices?ids=xr_curr_606') &&
          req.method === 'GET'
        ) {
          // Провайдер возвращает TRX вместо ожидаемого USDT
          return {
            status: 200,
            ok: true,
            json: [
              {
                id: 'xr_curr_606',
                priceAmount: '100.00',
                priceCurrency: 'TRX',
                status: 'PAID',
                clientInvoiceId: currentTopUpId,
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        provider: 'xrocket',
        amountPaid: 100,
        currency: 'USDT',
      });
      currentTopUpId = topUp.paymentId;

      const check = await service.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(check.ok, false);
      assert.equal(check.status, 'failed');
      assert.equal(check.reason, 'INVALID_CURRENCY');
      assert.equal(await service.getBalance(buyer1.id), 0);

      return 'Несовпадение валюты (ожидалась USDT, получена TRX) заблокировано с кодом INVALID_CURRENCY.';
    },
  );

  await runTest(
    'B-07',
    'Payments',
    'Обработка просроченного счёта (INVOICE_EXPIRED)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let currentTopUpId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 910007,
                status: 'active',
                amount: body.amount,
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=IV910007',
                payload: body.payload,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 910007,
                    status: 'expired',
                    amount: '100.00',
                    fiat: 'USD',
                    currency_type: 'fiat',
                    payload: currentTopUpId,
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        provider: 'cryptobot',
        amountPaid: 100,
        currency: 'USD',
      });
      currentTopUpId = topUp.paymentId;

      const check = await service.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(check.ok, false);
      assert.equal(check.status, 'expired');
      assert.equal(check.reason, 'INVOICE_EXPIRED');
      assert.equal(await service.getBalance(buyer1.id), 0);

      const saved = await service.getTopUpById(topUp.paymentId);
      assert.equal(saved?.paymentStatus, 'expired');

      return 'Просроченный счёт переведён в статус expired (INVOICE_EXPIRED), средства не зачислены.';
    },
  );

  await runTest(
    'B-08',
    'Database',
    'Одновременные пополнения баланса одного пользователя через CryptoBot и xRocket (атомарность транзакций без потери начислений)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      const invoicesByExtId = new Map<
        string,
        { paymentId: string; amount: number; currency: string }
      >();
      let seq = 1;

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: [
                { source: 'USDT', target: 'USD', rate: '1.00', is_valid: true },
                { source: 'TON', target: 'USD', rate: '5.00', is_valid: true },
              ],
            },
          };
        }
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'USDT', networks: ['TON', 'TRC-20'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { USDT: '1.00', TON: '5.00' } },
          };
        }
        if (req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          const extId = `ext_conc_${seq++}`;
          const paymentId = String(body.payload ?? body.clientInvoiceId ?? '');
          const amount = Number(body.amount ?? body.priceAmount ?? 100);

          if (req.url.includes('crypt.bot')) {
            const curr = String(body.fiat ?? body.asset ?? 'USD');
            invoicesByExtId.set(extId, { paymentId, amount, currency: curr });
            return {
              status: 200,
              ok: true,
              json: {
                ok: true,
                result: {
                  invoice_id: extId,
                  status: 'active',
                  amount: String(amount),
                  fiat: curr,
                  asset: curr,
                  currency_type: body.currency_type ?? 'fiat',
                  bot_invoice_url: `https://t.me/CryptoBot?start=${extId}`,
                },
              },
            };
          }
          if (req.url.includes('xrocket.exchange')) {
            invoicesByExtId.set(extId, { paymentId, amount, currency: 'USDT' });
            return {
              status: 201,
              ok: true,
              json: {
                id: extId,
                priceAmount: amount.toFixed(2),
                priceCurrency: 'USDT',
                clientInvoiceId: paymentId,
                status: 'PENDING',
                links: {
                  telegramBotLink: `https://t.me/xrocket?start=${extId}`,
                },
              },
            };
          }
        }

        // GET status verification
        for (const [extId, info] of invoicesByExtId.entries()) {
          if (req.url.includes(extId)) {
            if (req.url.includes('crypt.bot')) {
              return {
                status: 200,
                ok: true,
                json: {
                  ok: true,
                  result: {
                    items: [
                      {
                        invoice_id: extId,
                        status: 'paid',
                        amount: String(info.amount),
                        fiat: info.currency,
                        asset: info.currency,
                        currency_type: info.currency === 'USD' ? 'fiat' : 'crypto',
                        payload: info.paymentId,
                      },
                    ],
                  },
                },
              };
            }
            if (req.url.includes('xrocket.exchange')) {
              return {
                status: 200,
                ok: true,
                json: [
                  {
                    id: extId,
                    priceAmount: info.amount.toFixed(2),
                    priceCurrency: info.currency,
                    status: 'PAID',
                    clientInvoiceId: info.paymentId,
                  },
                ],
              };
            }
          }
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      // Создаём 3 счёта по $100.00:
      // CryptoBot #1 (3% -> +$97.00), CryptoBot #2 (3% -> +$97.00), xRocket (2% -> +$98.00). Итого: 97 + 97 + 98 = $292.00.
      const [tCrypto1, tCrypto2, tXRocket] = await Promise.all([
        service.createTopUp({
          telegramId: buyer1.id,
          provider: 'cryptobot',
          amountPaid: 100,
          currency: 'USD',
        }),
        service.createTopUp({
          telegramId: buyer1.id,
          provider: 'cryptobot',
          amountPaid: 100,
          currency: 'USDT',
        }),
        service.createTopUp({
          telegramId: buyer1.id,
          provider: 'xrocket',
          amountPaid: 100,
          currency: 'USDT',
        }),
      ]);

      // Одновременно подтверждаем все 3 пополнения
      const settled = await Promise.all([
        service.verifyAndProcessTopUp(tCrypto1.paymentId),
        service.verifyAndProcessTopUp(tCrypto2.paymentId),
        service.verifyAndProcessTopUp(tXRocket.paymentId),
      ]);

      assert.ok(settled.every((s) => s.ok && !s.duplicate));
      const finalBalance = await service.getBalance(buyer1.id);
      assert.equal(
        finalBalance,
        292,
        'Сумма параллельных зачислений ($97.00 + $97.00 + $98.00) должна составить ровно $292.00 без потери обновлений',
      );

      return 'Три параллельных пополнения через CryptoBot (+$97.00, +$97.00) и xRocket (+$98.00) атомарно зачислены: итоговый баланс $292.00.';
    },
  );

  await runTest(
    'B-09',
    'Payments',
    'Защита от двойного списания внутреннего баланса при параллельной оплате заказа ($4.20)',
    async () => {
      // На балансе buyer1 сейчас $292.00 (29200 cents) после теста B-08.
      // Покупаем товар stars_pack_250 ($4.20 = 420 cents) двумя параллельными запросами с одним orderId.
      const service = new BalanceService();
      const sharedOrderId = 'ord_bal_concurrent_b09';

      const [attempt1, attempt2] = await Promise.all([
        service.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          username: buyer1.username,
          firstName: buyer1.first_name,
          productId: 'stars_pack_250', // $4.20 = 420 cents
          quantity: 1,
          orderId: sharedOrderId,
        }),
        service.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          username: buyer1.username,
          firstName: buyer1.first_name,
          productId: 'stars_pack_250', // $4.20 = 420 cents
          quantity: 1,
          orderId: sharedOrderId,
        }),
      ]);

      const firstCalls = [attempt1, attempt2].filter((a) => !a.duplicate);
      const dupCalls = [attempt1, attempt2].filter((a) => a.duplicate);

      assert.equal(firstCalls.length, 1, 'Ровно один вызов должен списать баланс');
      assert.equal(dupCalls.length, 1, 'Второй параллельный вызов должен вернуть duplicate=true');
      assert.equal(
        await service.getBalanceUsdCents(buyer1.id),
        28780,
        'С баланса $292.00 должно списаться ровно $4.20 один раз (остаток $287.80)',
      );
      assert.equal(await service.getBalance(buyer1.id), 287.8);

      const userProfile = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(
        userProfile?.totalSpentStars,
        0,
        'Оплата с внутреннего баланса НЕ должна затрагивать legacy totalSpentStars',
      );
      assert.equal(userProfile?.totalSpentUsdCents, 420);

      return 'При параллельной оплате одного заказа баланс списан ровно 1 раз ($292.00 -> $287.80), повторный запрос вернул duplicate=true.';
    },
  );

  await runTest(
    'B-10',
    'Security',
    'Отказ при недостаточном внутреннем балансе и запрет ухода баланса в минус',
    async () => {
      const service = new BalanceService();
      assert.equal(await service.getBalanceUsdCents(buyer2.id), 0);

      await assert.rejects(
        async () => {
          await service.purchaseWithInternalBalance({
            telegramId: buyer2.id,
            username: buyer2.username,
            firstName: buyer2.first_name,
            productId: 'stars_pack_50',
            quantity: 1,
            orderId: 'ord_bal_insufficient_b10',
          });
        },
        /Недостаточно средств на внутреннем балансе/,
      );

      assert.equal(await service.getBalanceUsdCents(buyer2.id), 0);
      const nonExistentOrder = await OrderService.getOrderById(
        'ord_bal_insufficient_b10',
      );
      assert.equal(nonExistentOrder, null);

      return 'Попытка покупки при недостаточном балансе отклонена, заказ не создан, баланс остался $0.00.';
    },
  );

  await runTest(
    'B-11',
    'Payments',
    'Безопасный возврат заказа на внутренний баланс (refundOrderToInternalBalance) и защита от повторного возврата',
    async () => {
      const service = new BalanceService();
      const balanceBeforeCents = await service.getBalanceUsdCents(buyer1.id);
      assert.equal(balanceBeforeCents, 28780);

      const [ref1, ref2] = await Promise.all([
        service.refundOrderToInternalBalance({
          orderId: 'ord_bal_concurrent_b09',
          reason: 'Тестовый возврат на внутренний баланс',
          adminTelegramId: 777000111,
        }),
        service.refundOrderToInternalBalance({
          orderId: 'ord_bal_concurrent_b09',
          reason: 'Повторный параллельный запрос возврата',
          adminTelegramId: 777000111,
        }),
      ]);

      const primaryRefunds = [ref1, ref2].filter((r) => !r.alreadyRefunded);
      const duplicateRefunds = [ref1, ref2].filter((r) => r.alreadyRefunded);

      assert.equal(primaryRefunds.length, 1);
      assert.equal(duplicateRefunds.length, 1);

      const balanceAfterCents = await service.getBalanceUsdCents(buyer1.id);
      assert.equal(
        balanceAfterCents,
        29200,
        'После возврата заказа на $4.20 баланс должен восстановиться с $287.80 до $292.00 ровно 1 раз',
      );

      const refundedOrder = await OrderService.getOrderById(
        'ord_bal_concurrent_b09',
      );
      assert.equal(refundedOrder?.paymentStatus, 'refunded');
      assert.equal(refundedOrder?.fulfillmentStatus, 'refunded');
      assert.equal(refundedOrder?.balanceRefunded, true);

      return 'Возврат заказа на внутренний баланс выполнен атомарно ($287.80 -> $292.00), повторный вызов идемпотентно заблокирован.';
    },
  );

  await runTest(
    'B-12',
    'Security',
    'Свободный ввод суммы пополнения в USD ($0.50 – $50,000.00): полное удаление фиксированных пресетов и серверная валидация лимитов',
    async () => {
      assert.equal(MIN_TOPUP_AMOUNT_USD, 0.5);
      assert.equal(MAX_TOPUP_AMOUNT_USD, 50000);

      // 1. Полное отсутствие предложенных фиксированных сумм (100, 250, 500, 1000, 2500, 5000)
      assert.deepEqual(PAYMENT_PROVIDER_CATALOG.cryptobot.presetAmounts, []);
      assert.deepEqual(PAYMENT_PROVIDER_CATALOG.xrocket.presetAmounts, []);

      const emptyStep2Kb = JSON.stringify(
        buildTopUpStep2AmountKeyboard('cryptobot', undefined, 'USD'),
      );
      for (const preset of ['100', '250', '500', '1000', '2500', '5000']) {
        assert.equal(
          emptyStep2Kb.includes(`topup:amt:cryptobot:USD:${preset}`),
          false,
          `Кнопка фиксированной суммы ${preset} не должна присутствовать в клавиатуре Шага 2`,
        );
      }

      // 2. Валидация корректных сумм в USD (с поддержкой "$", точки и запятой)
      assert.equal(validateTopUpAmountUsd('0.50'), 0.5);
      assert.equal(validateTopUpAmountUsd('$10.00'), 10);
      assert.equal(validateTopUpAmountUsd('19,99'), 19.99);
      assert.equal(validateTopUpAmountUsd('100'), 100);
      assert.equal(validateTopUpAmountUsd('50000.00'), 50000);

      // 3. Серверный отказ для некорректных сумм (< $0.50, > $50,000.00, <= 0, текст, > 2 знаков после запятой)
      assert.throws(() => validateTopUpAmountUsd('0.49'), /Минимальная сумма пополнения: \$0\.50/);
      assert.throws(() => validateTopUpAmountUsd('0'), /положительным числом/);
      assert.throws(() => validateTopUpAmountUsd(-25), /положительным числом/);
      assert.throws(() => validateTopUpAmountUsd('50000.01'), /Максимальная сумма пополнения за одну операцию: \$50000\.00/);
      assert.throws(() => validateTopUpAmountUsd(10.999), /более 2 знаков после запятой/);
      assert.throws(() => validateTopUpAmountUsd('10.999'), /Введите корректную сумму в USD/);
      assert.throws(() => validateTopUpAmountUsd('abc'), /Введите корректную сумму в USD/);

      return 'Фиксированные пресеты сумм полностью удалены; серверная валидация USD ($0.50 – $50,000.00, не более 2 знаков) работает корректно.';
    },
  );

  await runTest(
    'B-13',
    'Payments',
    'Точный расчёт удержания комиссии в USD ($10.00, $19.99, $100.00) для CryptoBot (3%) и xRocket (2%) и автоматический пересчёт при смене способа оплаты',
    async () => {
      // CryptoBot 3% (зачисление = сумма * 0.97)
      const cb10 = calculateTopUpCommission(10.0, 'cryptobot');
      assert.equal(formatUsd(cb10.amountPaid), '$10.00');
      assert.equal(formatUsd(cb10.feeAmount), '$0.30');
      assert.equal(formatUsd(cb10.amountCredited), '$9.70');

      const cb1999 = calculateTopUpCommission(19.99, 'cryptobot');
      assert.equal(formatUsd(cb1999.amountPaid), '$19.99');
      assert.equal(formatUsd(cb1999.feeAmount), '$0.60');
      assert.equal(formatUsd(cb1999.amountCredited), '$19.39');

      const cb100 = calculateTopUpCommission(100.0, 'cryptobot');
      assert.equal(formatUsd(cb100.amountPaid), '$100.00');
      assert.equal(formatUsd(cb100.feeAmount), '$3.00');
      assert.equal(formatUsd(cb100.amountCredited), '$97.00');

      // xRocket 2% (зачисление = сумма * 0.98)
      const xr10 = calculateTopUpCommission(10.0, 'xrocket');
      assert.equal(formatUsd(xr10.amountPaid), '$10.00');
      assert.equal(formatUsd(xr10.feeAmount), '$0.20');
      assert.equal(formatUsd(xr10.amountCredited), '$9.80');

      const xr1999 = calculateTopUpCommission(19.99, 'xrocket');
      assert.equal(formatUsd(xr1999.amountPaid), '$19.99');
      assert.equal(formatUsd(xr1999.feeAmount), '$0.40');
      assert.equal(formatUsd(xr1999.amountCredited), '$19.59');

      const xr100 = calculateTopUpCommission(100.0, 'xrocket');
      assert.equal(formatUsd(xr100.amountPaid), '$100.00');
      assert.equal(formatUsd(xr100.feeAmount), '$2.00');
      assert.equal(formatUsd(xr100.amountCredited), '$98.00');

      // Автоматический пересчёт при переключении провайдера на Шаге 2
      const msgCrypto = formatTopUpStep2AmountMessage({
        provider: 'cryptobot',
        amountPaid: 100,
        currency: 'USD',
        providerConfigured: true,
      });
      assert.ok(msgCrypto.includes('$100.00'));
      assert.ok(msgCrypto.includes('−$3.00') || msgCrypto.includes('-$3.00'));
      assert.ok(msgCrypto.includes('+$97.00'));

      const msgXRocket = formatTopUpStep2AmountMessage({
        provider: 'xrocket',
        amountPaid: 100,
        currency: 'USDT',
        providerConfigured: true,
      });
      assert.ok(msgXRocket.includes('$100.00'));
      assert.ok(msgXRocket.includes('−$2.00') || msgXRocket.includes('-$2.00'));
      assert.ok(msgXRocket.includes('+$98.00'));

      return 'Расчёт комиссий в USD ($10.00, $19.99, $100.00) для CryptoBot (3%) и xRocket (2%) и автоматический пересчёт проверены.';
    },
  );

  await runTest(
    'B-14',
    'Payments',
    'Конвертация суммы из USD в криптовалюту провайдера (TON) по живому курсу с фиксацией и неизменной суммой зачисления в USD',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let currentTopUpId = '';
      let currentAmountToPay = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'TON', networks: ['TON'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { TON: '5.50' } },
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          currentAmountToPay = String(body.priceAmount);
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_ton_conv_1',
              priceAmount: currentAmountToPay,
              priceCurrency: 'TON',
              status: 'PENDING',
              clientInvoiceId: body.clientInvoiceId,
              links: {
                telegramBotLink: 'https://t.me/xrocket?start=xr_ton_conv_1',
              },
            },
          };
        }
        if (
          req.url.includes('/api/v1/invoices?ids=xr_ton_conv_1') &&
          req.method === 'GET'
        ) {
          return {
            status: 200,
            ok: true,
            json: [
              {
                id: 'xr_ton_conv_1',
                priceAmount: currentAmountToPay,
                priceCurrency: 'TON',
                status: 'PAID',
                clientInvoiceId: currentTopUpId,
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      // Проверка конвертации USD центов -> TON (10000 cents = $100.00 при 1 TON = $5.50 -> 18.1819 TON с точностью 4 знака)
      const tonConv = await gateway.getLiveUsdConversion({
        provider: 'xrocket',
        amountUsdCents: 10000,
        targetCurrency: 'TON',
        network: 'TON',
      });
      assert.equal(tonConv.amountUsdCents, 10000);
      assert.equal(tonConv.targetCurrency, 'TON');
      assert.equal(tonConv.exchangeRateUsdStr, '5.50');
      assert.equal(tonConv.convertedAmountStr, '18.1819');

      // Пользователь вводит $100.00 USD и выбирает оплату в TON через xRocket (комиссия 2% -> к зачислению $98.00)
      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        username: buyer1.username,
        provider: 'xrocket',
        amountUsdCents: 10000,
        currency: 'TON',
        network: 'TON',
      });
      currentTopUpId = topUp.paymentId;

      assert.equal(topUp.amountUsdCents, 10000);
      assert.equal(topUp.feeUsdCents, 200);
      assert.equal(topUp.amountCreditedUsdCents, 9800);
      assert.equal(topUp.currency, 'TON');
      assert.equal(topUp.exchangeRateUsdStr, '5.50');
      assert.equal(topUp.expectedAmountStr, '18.1819');

      // Карточка счёта уведомляет пользователя о курсе конвертации и фиксированной сумме зачисления в USD
      const invoiceCardHtml = formatTopUpInvoiceCardMessage(topUp);
      assert.ok(invoiceCardHtml.includes('$100.00'));
      assert.ok(invoiceCardHtml.includes('18.1819 TON'));
      assert.ok(invoiceCardHtml.includes('1 TON = $5.50'));
      assert.ok(invoiceCardHtml.includes('+$98.00'));

      // Проверяем подтверждение оплаты и зачисление строго зафиксированной суммы $98.00 USD (9800 cents)
      const verified = await service.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(verified.ok, true);
      assert.equal(verified.status, 'paid');
      assert.equal(verified.newBalanceUsdCents, 9800);
      assert.equal(await service.getBalanceUsdCents(buyer1.id), 9800);

      // История пополнений сохраняет и отображает исходную валюту оплаты (TON) и сумму в USD ($100.00 -> +$98.00)
      const historyHtml = formatUserTopUpHistoryMessage([verified.topUp], 98);
      assert.ok(historyHtml.includes('$100.00'));
      assert.ok(historyHtml.includes('+$98.00'));
      assert.ok(historyHtml.includes('TON'));

      return 'Живая конвертация $100.00 USD -> 18.1819 TON по курсу $5.50 проверена; на баланс зачислено ровно +$98.00 USD.';
    },
  );

  await runTest(
    'B-15',
    'Fulfillment',
    'Визуальный стиль OutlineEmoji во всех разделах бота и веб-интерфейса с брендом QuizyStars',
    async () => {
      // 1. Все иконки реестра OutlineEmoji формируют валидный тег <tg-emoji emoji-id="...">fallback</tg-emoji> и SVG
      const keys = Object.keys(OUTLINE_EMOJI_REGISTRY) as Array<
        keyof typeof OUTLINE_EMOJI_REGISTRY
      >;
      assert.ok(keys.length >= 30);
      for (const k of keys) {
        const tag = oe(k);
        assert.match(tag, /^<tg-emoji emoji-id="\d+">.+<\/tg-emoji>$/);
        assert.ok(oeBtn(k).length > 0);
        assert.ok(oeSvg(k, 18, 'oe-icon').includes('class="oe-icon"'));
      }

      // 2. Сообщения всех разделов используют <tg-emoji> и бренд QuizyStars (без Stars Shop)
      const welcomeHtml = formatWelcomeMessage('Alex', true);
      assert.ok(welcomeHtml.includes('QuizyStars'));
      assert.ok(!welcomeHtml.includes('Stars Shop'));
      assert.ok(welcomeHtml.includes('<tg-emoji emoji-id='));

      const userRecord = await UserService.getUserByTelegramId(buyer1.id);
      assert.ok(userRecord);
      const profileHtml = formatUserProfileMessage(userRecord, false);
      assert.ok(profileHtml.includes('<tg-emoji emoji-id='));
      assert.ok(profileHtml.includes('$98.00'));

      const catalogHtml = formatCatalogOverviewMessage();
      assert.ok(catalogHtml.includes('QuizyStars'));
      assert.ok(catalogHtml.includes('<tg-emoji emoji-id='));

      const termsHtml = formatTermsMessage();
      assert.ok(termsHtml.includes('QuizyStars'));
      assert.ok(termsHtml.includes('<tg-emoji emoji-id='));

      const helpHtml = formatHelpMessage();
      assert.ok(helpHtml.includes('QuizyStars'));
      assert.ok(helpHtml.includes('<tg-emoji emoji-id='));

      // 3. Проверка index.html на наличие мобильной числовой клавиатуры (inputmode="decimal") и бренда QUIZYSTARS
      const indexHtml = fs.readFileSync(
        path.resolve(process.cwd(), 'index.html'),
        'utf-8',
      );
      assert.ok(indexHtml.includes('inputmode="decimal"'));
      assert.ok(indexHtml.includes('QUIZYSTARS'));
      assert.ok(indexHtml.includes('oe-icon'));

      return `Набор OutlineEmoji (${keys.length} иконок <tg-emoji> и SVG) и бренд QuizyStars применены во всех разделах бота и веб-интерфейса.`;
    },
  );

  // ===========================================================================
  // 8. STAGE 3.3: ADMIN-ONLY KEY GENERATOR & AUTOMATIC DIGITAL KEY FULFILLMENT (K-01..K-08)
  // ===========================================================================
  const ownerTelegramId = 999000999;
  const nonOwnerAdminTelegramId = 777000111;
  process.env.OWNER_TELEGRAM_ID = String(ownerTelegramId);

  await runTest(
    'K-01',
    'Security',
    'Обычный пользователь (покупатель) не может открыть или использовать генератор и склад ключей',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let deniedReply = '';
      const buyerCtx = {
        from: { id: buyer1.id, first_name: 'Buyer' },
        reply: async (text: string) => {
          deniedReply = text;
        },
      } as unknown as Context;

      const allowed = await ensureOwner(buyerCtx);
      assert.equal(allowed, false);
      assert.ok(deniedReply.includes('OWNER_TELEGRAM_ID'));

      await assert.rejects(
        async () => {
          await DigitalKeyService.addKeys({
            actorTelegramId: buyer1.id,
            productId: 'gift_star_box',
            keys: ['GIFT-BUYER-UNAUTHORIZED-01'],
          });
        },
        (err) => err instanceof OwnerAccessDeniedError,
      );

      await assert.rejects(
        async () => {
          await DigitalKeyService.generateKeys({
            actorTelegramId: buyer1.id,
            productId: 'gift_star_box',
            count: 1,
          });
        },
        (err) => err instanceof OwnerAccessDeniedError,
      );

      return 'Доступ обычного пользователя к ensureOwner, addKeys и generateKeys заблокирован на сервере (OwnerAccessDeniedError).';
    },
  );

  await runTest(
    'K-02',
    'Security',
    'Другой администратор из ADMIN_IDS (не являющийся OWNER_TELEGRAM_ID) не имеет доступа к генератору и складу ключей',
    async () => {
      // nonOwnerAdminTelegramId (777000111) входит в ADMIN_IDS, но НЕ равен OWNER_TELEGRAM_ID (999000999)
      const isRegularAdmin = await UserService.isAdmin(nonOwnerAdminTelegramId);
      assert.equal(isRegularAdmin, true);

      let callbackAlert = '';
      const adminCtx = {
        from: { id: nonOwnerAdminTelegramId, first_name: 'RegularAdmin' },
        callbackQuery: { id: 'cb_non_owner_1', data: 'own:keys:home' },
        answerCbQuery: async (text: string) => {
          callbackAlert = text;
        },
      } as unknown as Context;

      const allowed = await ensureOwner(adminCtx);
      assert.equal(allowed, false);
      assert.ok(callbackAlert.includes('OWNER_TELEGRAM_ID'));

      const nonOwnerAdminKb = JSON.stringify(buildAdminMainKeyboard(false));
      const ownerAdminKb = JSON.stringify(buildAdminMainKeyboard(true));
      assert.equal(nonOwnerAdminKb.includes('own:keys:home'), false);
      assert.equal(ownerAdminKb.includes('own:keys:home'), true);

      await assert.rejects(
        async () => {
          await DigitalKeyService.getProductStockSummary({
            actorTelegramId: nonOwnerAdminTelegramId,
            productId: 'gift_star_box',
          });
        },
        (err) => err instanceof OwnerAccessDeniedError,
      );

      return 'Обычный администратор из ADMIN_IDS (777000111) отклонён при попытке вызова ensureOwner и DigitalKeyService (OwnerAccessDeniedError).';
    },
  );

  await runTest(
    'K-03',
    'Fulfillment',
    'Владелец бота (OWNER_TELEGRAM_ID) может добавлять ключи вручную, генерировать ключи по алгоритму и отключать ключи',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      // 1. Ручное добавление 2 ключей владельцем
      const manualKeys = await DigitalKeyService.addKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'stars_pack_50',
        keys: ['STARS50-MANUAL-KEY-0001', 'STARS50-MANUAL-KEY-0002'],
      });
      assert.equal(manualKeys.length, 2);
      assert.equal(manualKeys[0].status, 'available');

      // 2. Генерация 3 ключей для товара с заданным алгоритмом (gift_star_box -> gift_voucher_v1)
      const generatedKeys = await DigitalKeyService.generateKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        count: 3,
      });
      assert.equal(generatedKeys.length, 3);
      for (const gk of generatedKeys) {
        assert.match(
          gk.keyValue,
          /^STARS-GIFT-GIFT-[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{4}-[A-F0-9]{4}$/,
        );
        assert.equal(gk.status, 'available');
      }

      // 3. Попытка автогенерации для товара без внутреннего алгоритма (stars_pack_50) должна отклоняться
      await assert.rejects(
        async () => {
          await DigitalKeyService.generateKeys({
            actorTelegramId: ownerTelegramId,
            productId: 'stars_pack_50',
            count: 1,
          });
        },
        (err) => err instanceof UnsupportedKeyGeneratorError,
      );

      // 4. Отключение одного неиспользованного ключа владельцем
      const disabled = await DigitalKeyService.disableKey({
        actorTelegramId: ownerTelegramId,
        keyId: manualKeys[1].keyId,
      });
      assert.equal(disabled.status, 'disabled');

      const summary = await DigitalKeyService.getProductStockSummary({
        actorTelegramId: ownerTelegramId,
        productId: 'stars_pack_50',
      });
      assert.equal(summary.available, 1);
      assert.equal(summary.disabled, 1);

      return 'Владелец успешно добавил ключи вручную, сгенерировал 3 ключа по алгоритму gift_voucher_v1, отключил 1 ключ; генерация без алгоритма запрещена.';
    },
  );

  await runTest(
    'K-04',
    'Security',
    'Дубликаты ключей отклоняются как внутри одной пачки, так и при повторной загрузке существующего ключа',
    async () => {
      // Попытка загрузить дубликат уже существующего на складе ключа STARS50-MANUAL-KEY-0001
      await assert.rejects(
        async () => {
          await DigitalKeyService.addKeys({
            actorTelegramId: ownerTelegramId,
            productId: 'stars_pack_50',
            keys: ['STARS50-MANUAL-KEY-0001'],
          });
        },
        (err) => err instanceof DuplicateDigitalKeyError,
      );

      // Попытка загрузить пачку с одинаковыми ключами внутри одного запроса
      await assert.rejects(
        async () => {
          await DigitalKeyService.addKeys({
            actorTelegramId: ownerTelegramId,
            productId: 'stars_pack_50',
            keys: ['UNIQUE-BATCH-KEY-99', 'unique-batch-key-99'],
          });
        },
        (err) => err instanceof DuplicateDigitalKeyError,
      );

      return 'Повторная загрузка существующего ключа и дубликаты внутри одной пачки отклонены с DuplicateDigitalKeyError.';
    },
  );

  await runTest(
    'K-05',
    'Database',
    'Два одновременных заказа на один и тот же товар гарантированно получают разные ключи (отсутствие двойной выдачи)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      await DigitalKeyService.addKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        keys: ['GIFT-CONC-UNIQUE-KEY-A', 'GIFT-CONC-UNIQUE-KEY-B'],
      });

      const orderA = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      const orderB = await OrderService.createOrder({
        telegramUser: buyer2,
        productId: 'gift_star_box',
        quantity: 1,
      });

      const paidA = await payOrderViaCryptoForTest(orderA, 'cryptobot', 'USD');
      const paidB = await payOrderViaCryptoForTest(orderB, 'cryptobot', 'USD');

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      // Запускаем выдачу обоих заказов одновременно
      const [resA, resB] = await Promise.all([
        FulfillmentService.initiateFulfillment(paidA.order, mockBot),
        FulfillmentService.initiateFulfillment(paidB.order, mockBot),
      ]);

      assert.equal(resA.fulfillmentStatus, 'completed');
      assert.equal(resB.fulfillmentStatus, 'completed');
      assert.equal(resA.deliveredKeyValues?.length, 1);
      assert.equal(resB.deliveredKeyValues?.length, 1);
      assert.notEqual(
        resA.deliveredKeyValues?.[0],
        resB.deliveredKeyValues?.[0],
        'Два параллельных заказа не должны получить один и тот же цифровой ключ',
      );
      assert.notEqual(resA.assignedKeyIds?.[0], resB.assignedKeyIds?.[0]);

      const stock = await DigitalKeyService.getProductStockSummary({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
      });
      assert.equal(stock.available, 0);
      assert.equal(stock.delivered, 2);

      return `Два параллельных заказа атомарно получили разные ключи (${resA.deliveredKeyValues?.[0]} и ${resB.deliveredKeyValues?.[0]}), остаток на складе: 0.`;
    },
  );

  await runTest(
    'K-06',
    'Fulfillment',
    'Повторный webhook или повторный вызов выдачи для того же заказа идемпотентен и не выдаёт второй ключ',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      await DigitalKeyService.addKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        keys: ['GIFT-IDEMPOTENT-KEY-1', 'GIFT-IDEMPOTENT-KEY-2'],
      });

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      const firstFulfill = await FulfillmentService.initiateFulfillment(
        paid.order,
        mockBot,
      );
      const secondFulfill = await DigitalKeyService.fulfillOrderWithDigitalKey(
        paid.order,
        mockBot,
      );

      assert.equal(firstFulfill.fulfillmentStatus, 'completed');
      assert.equal(secondFulfill.duplicate, true);
      assert.deepEqual(
        firstFulfill.assignedKeyIds,
        secondFulfill.order.assignedKeyIds,
      );
      assert.deepEqual(
        firstFulfill.deliveredKeyValues,
        secondFulfill.order.deliveredKeyValues,
      );

      const stock = await DigitalKeyService.getProductStockSummary({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
      });
      assert.equal(stock.available, 1);
      assert.equal(stock.delivered, 1);

      return 'Повторный вызов выдачи вернул duplicate=true с тем же ключом; второй ключ на складе остался доступным.';
    },
  );

  await runTest(
    'K-07',
    'Fulfillment',
    'Оплаченный заказ без доступных ключей НЕ помечается как выданный (остаётся processing + awaitingKeyStock=true) и уведомляет владельца',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      const res = await DigitalKeyService.fulfillOrderWithDigitalKey(
        paid.order,
        mockBot,
      );

      assert.equal(res.fulfilled, false);
      assert.equal(res.awaitingStock, true);
      assert.notEqual(res.order.fulfillmentStatus, 'completed');
      assert.equal(res.order.fulfillmentStatus, 'processing');
      assert.equal(res.order.awaitingKeyStock, true);

      const ownerNotice = sentMessages.find(
        (m) => Number(m.chatId) === ownerTelegramId,
      );
      assert.ok(
        ownerNotice &&
          ownerNotice.text.includes('НЕХВАТКА ЦИФРОВЫХ КЛЮЧЕЙ НА СКЛАДЕ'),
      );

      return 'Оплаченный заказ при пустом складе переведён в processing (awaitingKeyStock=true), владельцу отправлено уведомление.';
    },
  );

  await runTest(
    'K-08',
    'Fulfillment',
    'Ошибка отправки сообщения Telegram не приводит к потере выданного ключа (ключ остаётся привязанным к заказу в БД)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      await DigitalKeyService.addKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        keys: ['GIFT-RESILIENT-KEY-777'],
      });

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const failingBot = createMockBot([], true);

      const fulfilled = await FulfillmentService.initiateFulfillment(
        paid.order,
        failingBot,
      );

      assert.equal(fulfilled.fulfillmentStatus, 'completed');
      assert.deepEqual(fulfilled.deliveredKeyValues, ['GIFT-RESILIENT-KEY-777']);
      assert.equal(fulfilled.assignedKeyIds?.length, 1);

      const savedOrder = await OrderService.getOrderById(order.orderId);
      assert.deepEqual(savedOrder?.deliveredKeyValues, ['GIFT-RESILIENT-KEY-777']);

      const deliveredKeys = await DigitalKeyService.listKeysForProduct({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        status: 'delivered',
      });
      assert.equal(deliveredKeys.length, 1);
      assert.equal(deliveredKeys[0].deliveredOrderId, order.orderId);
      assert.equal(deliveredKeys[0].deliveredUserTelegramId, buyer1.id);

      return 'При сбое Telegram API (502) выданный ключ GIFT-RESILIENT-KEY-777 сохранён в заказе и имеет статус delivered.';
    },
  );

  // ===========================================================================
  // 9. STAGE 4.2: PAYMENT INFRASTRUCTURE & FINANCIAL FOUNDATION TESTS (S42-01..S42-17)
  // ===========================================================================
  await runTest(
    'S42-01',
    'Payments',
    'CryptoBot: живой курс GET /getExchangeRates и повторное использование активного pending-счёта заказа',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let createCalls = 0;

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: [
                { source: 'TON', target: 'USD', rate: '5.50', is_valid: true },
                { source: 'USDT', target: 'USD', rate: '1.00', is_valid: true },
              ],
            },
          };
        }
        if (req.url.endsWith('/createInvoice')) {
          createCalls++;
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: `cb_reuse_${createCalls}`,
                status: 'active',
                amount: String(body.amount),
                asset: 'TON',
                currency_type: 'crypto',
                bot_invoice_url: 'https://t.me/CryptoBot?start=cb_reuse_1',
                payload: body.payload,
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-01', gateway);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m', // $13.90 = 1390 cents
        quantity: 1,
        recipientUsername: '@QuizyBuyer',
      });

      const first = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'TON',
      });
      assert.equal(first.reused, false);
      assert.equal(first.payment.expectedUsdCents, 1390);
      assert.equal(first.payment.exchangeRateUsdStr, '5.50');
      // $13.90 / $5.50 = 2.527272... -> ceil at 4 decimals = 2.5273 TON
      assert.equal(first.payment.expectedAmountStr, '2.5273');

      const second = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'TON',
      });
      assert.equal(second.reused, true);
      assert.equal(second.payment.paymentId, first.payment.paymentId);
      assert.equal(createCalls, 1);

      return 'CryptoBot /getExchangeRates пересчитал $13.90 -> 2.5273 TON (курс 5.50); повторный вызов переиспользовал активный счёт без дубля /createInvoice.';
    },
  );

  await runTest(
    'S42-02',
    'Payments',
    'xRocket: живые курсы /api/v1/rates, валидация сетей /api/v1/currencies и формат вебхука InvoiceWebhookDto',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let currentPaymentId = '';
      let expectedPayAmount = '';

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [
              { currency: 'USDT', networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'] },
              { currency: 'TON', networks: ['TON'] },
            ],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { USDT: '1.00', TON: '5.00' } },
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          currentPaymentId = String(body.clientInvoiceId);
          expectedPayAmount = String(body.priceAmount);
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_s42_02_dto',
              priceAmount: expectedPayAmount,
              priceCurrency: 'USDT',
              status: 'PENDING',
              clientInvoiceId: currentPaymentId,
              links: { telegramBotLink: 'https://t.me/xrocket?start=xr_s42_02_dto' },
            },
          };
        }
        if (req.url.includes('/api/v1/invoices?ids=xr_s42_02_dto')) {
          return {
            status: 200,
            ok: true,
            json: [
              {
                id: 'xr_s42_02_dto',
                priceAmount: expectedPayAmount,
                priceCurrency: 'USDT',
                network: 'TRC-20',
                status: 'PAID',
                clientInvoiceId: currentPaymentId,
                payment: {
                  amount: expectedPayAmount,
                  currency: 'USDT',
                  network: 'TRC-20',
                  feeInUsd: '0.15',
                },
              },
            ],
          };
        }
        throw new Error(`Unexpected: ${req.method} ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-02', gateway);

      // Несовместимая сеть (TON в сети TRC-20) должна отклоняться
      await assert.rejects(
        async () => {
          await gateway.validateCurrencyAndNetwork('xrocket', 'TON', 'TRC-20');
        },
        /Сеть TRC-20 не поддерживается для TON/,
      );

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_6m', // $19.90 = 1990 cents
        quantity: 1,
        recipientUsername: 'valid_user_99',
      });

      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'xrocket',
        currency: 'USDT',
        network: 'TRC-20',
      });
      assert.equal(created.payment.network, 'TRC-20');
      assert.equal(created.payment.expectedAmountStr, '19.90');

      const webhookRaw = JSON.stringify({
        type: 'invoice',
        timestamp: new Date().toISOString(),
        data: {
          event: 'invoice.paid',
          invoice: {
            id: 'xr_s42_02_dto',
            priceAmount: '19.90',
            priceCurrency: 'USDT',
            clientInvoiceId: created.payment.paymentId,
            status: 'PAID',
          },
          payment: {
            amount: '19.90',
            currency: 'USDT',
            network: 'TRC-20',
            feeInUsd: '0.15',
          },
        },
      });
      const sig = computeXRocketWebhookSignature(
        webhookRaw,
        TEST_MOCK_CREDS.xrocketApiKey,
      );

      const processed = await ps.processOrderWebhook({
        provider: 'xrocket',
        rawBody: webhookRaw,
        headers: { 'rocket-pay-signature': sig },
      });
      assert.equal(processed.ok, true);
      assert.equal(processed.order?.paymentStatus, 'paid');
      assert.equal(processed.order?.providerFeeUsdCents, 15);
      assert.equal(processed.order?.grossRevenueUsdCents, 1990);

      return 'xRocket /api/v1/currencies, /api/v1/rates, валидация сетей и официальный формат InvoiceWebhookDto проверены.';
    },
  );

  await runTest(
    'S42-03',
    'Security',
    'Нулевой статический fallback курсов: ошибка живого API выбрасывает ExchangeRateUnavailableError (HTTP 503)',
    async () => {
      const failingTransport = async (): Promise<HttpTransportResponse> => ({
        status: 503,
        ok: false,
        json: { error: { name: 'SERVICE_UNAVAILABLE' } },
      });
      const gw = new PaymentProviderGateway(failingTransport, TEST_MOCK_CREDS);

      await assert.rejects(
        async () => {
          await gw.getLiveUsdConversion({
            provider: 'cryptobot',
            amountUsdCents: 1000,
            targetCurrency: 'TON',
          });
        },
        (err) =>
          err instanceof ExchangeRateUnavailableError &&
          err.code === 'EXCHANGE_RATE_UNAVAILABLE',
      );

      const { res, getStatus, getJson } = createMockExpressRes();
      const fakeReq = {
        body: { provider: 'xrocket', amountUsd: '10.00', currency: 'TON', network: 'TON' },
      } as unknown as Request;
      await handleTopUpCalculateRequest(fakeReq, res, { gateway: gw });
      assert.equal(getStatus(), 503);
      assert.equal(
        (getJson() as { code?: string })?.code,
        'EXCHANGE_RATE_UNAVAILABLE',
      );

      return 'При недоступности курсов провайдеров статические курсы не используются; выбрасывается ExchangeRateUnavailableError (HTTP 503).';
    },
  );

  await runTest(
    'S42-04',
    'Payments',
    'Точная целочисленная арифметика центов USD ($0.50, $19.99, $100.00) без ошибок IEEE-754',
    async () => {
      assert.equal(usdInputToCents('$0.50'), 50);
      assert.equal(usdInputToCents('19,99'), 1999);
      assert.equal(usdInputToCents('100.00'), 10000);
      assert.equal(formatUsdCents(1999), '$19.99');
      assert.equal(centsToUsdString(50), '0.50');

      const cb050 = calculateTopUpCommissionCents(50, 'cryptobot');
      assert.equal(cb050.feeUsdCents, 2);
      assert.equal(cb050.amountCreditedUsdCents, 48);

      const cb1999 = calculateTopUpCommissionCents(1999, 'cryptobot');
      assert.equal(cb1999.feeUsdCents, 60);
      assert.equal(cb1999.amountCreditedUsdCents, 1939);

      const xr1999 = calculateTopUpCommissionCents(1999, 'xrocket');
      assert.equal(xr1999.feeUsdCents, 40);
      assert.equal(xr1999.amountCreditedUsdCents, 1959);

      const rawBps = bpsFeeAndNetCents(10000, 300);
      assert.equal(rawBps.feeCents, 300);
      assert.equal(rawBps.netCents, 9700);

      assert.equal(validateTopUpAmountUsdCents('0.50'), 50);
      assert.equal(validateTopUpAmountUsdCents('50000.00'), 5_000_000);

      const conv = convertUsdCentsToCryptoScaled({
        amountUsdCents: 1999,
        rateUsdStr: '5.50',
        targetCurrency: 'TON',
      });
      assert.equal(compareScaledDecimal(conv.amountStr, '3.6346'), 0);

      return 'Все суммы и комиссии в центах USD и BigInt 10^18 вычислены точно без погрешностей float.';
    },
  );

  await runTest(
    'S42-05',
    'Security',
    'Недоплата (partially_paid / сумма < expectedAmountStr): заказ остаётся pending, баланс не пополняется',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/rates')) {
          return { status: 200, ok: true, json: { data: { TON: '5.00' } } };
        }
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'TON', networks: ['TON'] }],
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.clientInvoiceId);
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_underpaid_1',
              priceAmount: String(body.priceAmount), // 2.78 TON for $13.90 @ 5.00
              priceCurrency: 'TON',
              status: 'PENDING',
              clientInvoiceId: paymentId,
              links: { telegramBotLink: 'https://t.me/xrocket?start=xr_underpaid_1' },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: [
            {
              id: 'xr_underpaid_1',
              priceAmount: '2.78',
              paidAmount: '1.50',
              priceCurrency: 'TON',
              status: 'partially_paid',
              clientInvoiceId: paymentId,
            },
          ],
        };
      };

      const gw = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-05', gw);
      const bs = new BalanceService(gw);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m',
        quantity: 1,
      });
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'xrocket',
        currency: 'TON',
        network: 'TON',
      });
      const res = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'underpaid');
      assert.equal(res.reason, 'UNDERPAID');

      const savedOrder = await OrderService.getOrderById(order.orderId);
      assert.equal(savedOrder?.paymentStatus, 'pending');
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 0);

      return 'Частичная оплата (1.50 вместо 2.78 TON) заблокирована со статусом underpaid, заказ не активирован.';
    },
  );

  await runTest(
    'S42-06',
    'Payments',
    'Переплата (paidAmount > expectedAmountStr): пополнение/заказ закрываются строго на контрактную сумму USD',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let topupId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: { ok: true, result: [{ source: 'TON', target: 'USD', rate: '5.00', is_valid: true }] },
          };
        }
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          topupId = String(body.payload);
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'cb_over_1',
                status: 'active',
                amount: '2.00',
                asset: 'TON',
                currency_type: 'crypto',
                bot_invoice_url: 'https://t.me/CryptoBot?start=cb_over_1',
                payload: topupId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'cb_over_1',
                  status: 'paid',
                  amount: '2.00',
                  paid_amount: '3.50', // покупатель прислал больше TON
                  asset: 'TON',
                  paid_asset: 'TON',
                  currency_type: 'crypto',
                  payload: topupId,
                },
              ],
            },
          },
        };
      };

      const bs = new BalanceService(new PaymentProviderGateway(transport, TEST_MOCK_CREDS));
      const topUp = await bs.createTopUp({
        telegramId: buyer1.id,
        provider: 'cryptobot',
        amountUsdCents: 1000, // $10.00 -> после 3% комиссии $9.70 (970 cents)
        currency: 'TON',
      });
      const verified = await bs.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(verified.ok, true);
      assert.equal(verified.status, 'overpaid');
      assert.equal(
        verified.newBalanceUsdCents,
        970,
        'При переплате в криптовалюте зачисляется строго оговорённые $9.70 (970 центов)',
      );

      return 'Переплата зафиксирована статусом overpaid; баланс пополнен строго на контрактные 970 центов ($9.70).';
    },
  );

  await runTest(
    'S42-07',
    'Payments',
    'Просроченный счёт заказа (expired / expiresAt в прошлом) отклоняется без закрытия заказа',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.payload);
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'cb_exp_ord_1',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=cb_exp_ord_1',
                payload: paymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'cb_exp_ord_1',
                  status: 'expired',
                  amount: '0.90',
                  fiat: 'USD',
                  currency_type: 'fiat',
                  payload: paymentId,
                },
              ],
            },
          },
        };
      };

      const ps = new PaymentService('s42-07', new PaymentProviderGateway(transport, TEST_MOCK_CREDS));
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });
      const res = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'expired');
      assert.equal(res.reason, 'INVOICE_EXPIRED');

      const unchanged = await OrderService.getOrderById(order.orderId);
      assert.equal(unchanged?.paymentStatus, 'pending');

      return 'Просроченный инвойс по заказу переведён в expired (INVOICE_EXPIRED), заказ остался pending.';
    },
  );

  await runTest(
    'S42-08',
    'Security',
    'Несоответствие валюты или сети в ответе провайдера (INVALID_NETWORK) блокирует зачисление',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let topupId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'USDT', networks: ['TON', 'ERC-20', 'TRC-20'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return { status: 200, ok: true, json: { data: { USDT: '1.00' } } };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          topupId = String(body.clientInvoiceId);
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_bad_net_1',
              priceAmount: String(body.priceAmount),
              priceCurrency: 'USDT',
              status: 'PENDING',
              clientInvoiceId: topupId,
              links: { telegramBotLink: 'https://t.me/xrocket?start=xr_bad_net_1' },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: [
            {
              id: 'xr_bad_net_1',
              priceAmount: '10.00',
              priceCurrency: 'USDT',
              network: 'ERC-20', // ожидалась TON
              status: 'PAID',
              clientInvoiceId: topupId,
            },
          ],
        };
      };

      const bs = new BalanceService(new PaymentProviderGateway(transport, TEST_MOCK_CREDS));
      const topUp = await bs.createTopUp({
        telegramId: buyer1.id,
        provider: 'xrocket',
        amountUsdCents: 1000,
        currency: 'USDT',
        network: 'TON',
      });
      const res = await bs.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'failed');
      assert.equal(res.reason, 'INVALID_NETWORK');
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 0);

      return 'Подмена сети (ERC-20 вместо TON) отклонена с кодом INVALID_NETWORK.';
    },
  );

  await runTest(
    'S42-09',
    'Security',
    'Неверная подпись HMAC-SHA256 вебхука заказа отклоняется ДО любых исходящих HTTP-запросов (HTTP 401)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let outboundApiCalls = 0;
      const transport = async (): Promise<HttpTransportResponse> => {
        outboundApiCalls++;
        throw new Error('Must never make outbound API calls on forged signature');
      };

      const gw = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-09', gw);
      const bs = new BalanceService(gw);

      const forgedRaw = JSON.stringify({
        update_type: 'invoice_paid',
        payload: { invoice_id: 'cb_fake_99', status: 'paid', payload: 'ordpay_fake' },
      });

      const directOrderRes = await ps.processOrderWebhook({
        provider: 'cryptobot',
        rawBody: forgedRaw,
        headers: { 'crypto-pay-api-signature': '0000bad_signature' },
      });
      assert.equal(directOrderRes.ok, false);
      assert.equal(directOrderRes.reason, 'INVALID_WEBHOOK_SIGNATURE');

      const { res, getStatus } = createMockExpressRes();
      const fakeReq = {
        rawBody: forgedRaw,
        body: JSON.parse(forgedRaw),
        headers: { 'rocket-pay-signature': 'forged_xr_sig' },
      } as unknown as Request;
      await handleProviderWebhookRequest('xrocket', fakeReq, res, {
        balanceSvc: bs,
        paymentSvc: ps,
      });
      assert.equal(getStatus(), 401);
      assert.equal(outboundApiCalls, 0);

      return 'Невалидные HMAC-подписи вебхуков отклонены со статусом 401 с нулём исходящих API-вызовов.';
    },
  );

  await runTest(
    'S42-10',
    'Database',
    'Атомарный захват payment_locks: защита от конкурентных вебхуков и повторного использования одного externalInvoiceId в другом заказе',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const sharedExtId = 'cb_shared_ext_lock_777';
      let currentPaymentId = '';

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          currentPaymentId = String(body.payload);
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: sharedExtId,
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: `https://t.me/CryptoBot?start=${sharedExtId}`,
                payload: currentPaymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: sharedExtId,
                  status: 'paid',
                  amount: '0.90',
                  fiat: 'USD',
                  currency_type: 'fiat',
                  payload: currentPaymentId,
                },
              ],
            },
          },
        };
      };

      const gw = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-10', gw);

      const order1 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const inv1 = await ps.createOrReuseOrderPayment({
        orderId: order1.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });

      const [r1, r2, r3] = await Promise.all([
        ps.verifyAndProcessOrderPayment(inv1.payment.paymentId),
        ps.verifyAndProcessOrderPayment(inv1.payment.paymentId),
        ps.verifyAndProcessOrderPayment(inv1.payment.paymentId),
      ]);
      assert.equal([r1, r2, r3].filter((r) => r.ok && !r.duplicate).length, 1);

      // Пробуем привязать тот же externalInvoiceId ко второму заказу
      const order2 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const inv2 = await ps.createOrReuseOrderPayment({
        orderId: order2.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });
      await assert.rejects(
        async () => {
          await ps.verifyAndProcessOrderPayment(inv2.payment.paymentId);
        },
        /PAYMENT_LOCK_CONFLICT/,
      );

      return 'Уникальная блокировка payment_locks/ext_cryptobot_* гарантировала однократную оплату заказа и заблокировала конфликт другого заказа (PAYMENT_LOCK_CONFLICT).';
    },
  );

  await runTest(
    'S42-11',
    'Payments',
    'Внутренний баланс USD: покупка ($100.00 - $13.90 = $86.10), отказ при нехватке и защита от двойного клика',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();
      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 10000,
        balance: 100,
      });

      const [a, b] = await Promise.all([
        bs.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          productId: 'premium_3m', // 1390 cents
          quantity: 1,
          orderId: 'ord_s42_11_shared',
          recipientUsername: '@QuizyReceiver',
        }),
        bs.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          productId: 'premium_3m',
          quantity: 1,
          orderId: 'ord_s42_11_shared',
          recipientUsername: '@QuizyReceiver',
        }),
      ]);

      assert.equal([a, b].filter((x) => !x.duplicate).length, 1);
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 8610);

      await assert.rejects(
        async () => {
          await bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_custom',
            quantity: 5000, // 10000 > 8610
            recipientUsername: '@QuizyReceiver',
          });
        },
        /Недостаточно средств/,
      );
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 8610);

      return 'Покупка с внутреннего баланса списала ровно 1390 центов (остаток 8610), защита от двойного клика и отрицательного баланса подтверждена.';
    },
  );

  await runTest(
    'S42-12',
    'Payments',
    'Возврат на внутренний баланс USD и запрет автоматического возврата внешних крипто-заказов',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();
      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 5000,
        balance: 50,
      });

      const paidBal = await bs.purchaseWithInternalBalance({
        telegramId: buyer1.id,
        productId: 'premium_6m', // $19.90 = 1990 cents
        quantity: 1,
      });
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 3010);

      const refunded = await bs.refundOrderToInternalBalance({
        orderId: paidBal.order.orderId,
        reason: 'Возврат теста S42-12',
        adminTelegramId: 777000111,
      });
      assert.equal(refunded.alreadyRefunded, false);
      assert.equal(refunded.newBalanceUsdCents, 5000);

      const dupRefund = await bs.refundOrderToInternalBalance({
        orderId: paidBal.order.orderId,
        reason: 'Повтор',
      });
      assert.equal(dupRefund.alreadyRefunded, true);
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 5000);

      // Крипто-заказ нельзя вернуть через автовозврат на внутренний баланс
      const cryptoOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      await payOrderViaCryptoForTest(cryptoOrder, 'cryptobot', 'USD');
      await assert.rejects(
        async () => {
          await bs.refundOrderToInternalBalance({
            orderId: cryptoOrder.orderId,
            reason: 'Попытка автовозврата крипты',
          });
        },
        /Автоматический возврат криптовалютных платежей не поддерживается/,
      );

      return 'Возврат на баланс идемпотентно восстановил 5000 центов; крипто-заказ защищён от автовозврата.';
    },
  );

  await runTest(
    'S42-13',
    'Payments',
    'Каталог QuizyStars: stars_custom (50..100000 @ $0.02), Premium 3/6/12 мес и нормализация @recipientUsername',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      const customProd = await ProductService.getProductById('stars_custom');
      const p3 = await ProductService.getProductById('premium_3m');
      const p6 = await ProductService.getProductById('premium_6m');
      const p12 = await ProductService.getProductById('premium_12m');
      assert.ok(customProd && p3 && p6 && p12);
      assert.equal(p3.priceUsdCents, 1390);
      assert.equal(p6.priceUsdCents, 1990);
      assert.equal(p12.priceUsdCents, 3490);

      const orderCustom = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_custom',
        quantity: 150,
        recipientUsername: '@QuizyStars_Recipient',
      });
      assert.equal(orderCustom.totalPriceUsdCents, 300); // 150 * 2 cents = $3.00
      assert.equal(orderCustom.recipientUsername, 'quizystars_recipient');

      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 49,
          }),
        /допустимо от 50 до 100000/,
      );
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 100001,
          }),
        /допустимо от 50 до 100000/,
      );

      assert.equal(normalizeRecipientUsername('  @Alice_Test '), 'alice_test');
      assert.throws(() => normalizeRecipientUsername('ab'), /Некорректный @username/);

      return 'Проверены цены stars_custom (150 шт = $3.00, лимит 50..100000), Premium ($13.90/$19.90/$34.90) и валидация @username.';
    },
  );

  await runTest(
    'S42-14',
    'Database',
    'Подготовка P&L и MyStars FaaS полей заказа (mystarsPaymentCurrency = usdt_ton, без HTTP-вызовов к api.mystars.tg)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const cfg = getEnvConfig();
      assert.equal(cfg.mystarsPaymentCurrency, 'usdt_ton');

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_12m',
        quantity: 1,
        recipientUsername: 'mystars_target',
      });
      assert.equal(order.grossRevenueUsdCents, 3490);
      assert.equal(order.mystarsCurrency, 'usdt_ton');

      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');
      assert.equal(paid.order.grossRevenueUsdCents, 3490);
      assert.equal(paid.order.providerFeeUsdCents, 3);
      assert.equal(paid.order.mystarsCurrency, 'usdt_ton');

      return 'Поля P&L и mystarsCurrency=usdt_ton корректно инициализированы и обновлены на заказе без реальных запросов к MyStars.';
    },
  );

  await runTest(
    'S42-15',
    'Security',
    'Полное отключение Telegram Stars (XTR) как способа оплаты в сервисах, клавиатурах и сообщениях',
    async () => {
      const pre = await PaymentService.validatePreCheckout({
        invoicePayload: 'ord_any',
        telegramUserId: buyer1.id,
        currency: 'XTR',
        totalAmount: 10,
      });
      assert.equal(pre.ok, false);
      assert.ok(pre.errorMessage?.includes('отключена'));

      await assert.rejects(
        () =>
          PaymentService.processSuccessfulPayment({
            telegramUserId: buyer1.id,
            invoicePayload: 'ord_any',
            currency: 'XTR',
            totalAmount: 10,
            telegramPaymentChargeId: 'chg_xtr_blocked',
          }),
        /XTR_CHECKOUT_DISABLED/,
      );

      const sampleOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const checkoutKb = JSON.stringify(
        buildOrderCheckoutChooserKeyboard(sampleOrder, 0),
      );
      assert.equal(checkoutKb.includes('XTR'), false);
      assert.equal(checkoutKb.includes('pay_ord_prov:'), true);

      const cryptoKb = JSON.stringify(
        buildOrderCryptoCurrencyKeyboard(sampleOrder.orderId, 'xrocket', [
          {
            code: 'USDT',
            networks: ['TON'],
            conversion: {
              provider: 'xrocket',
              amountUsdCents: 90,
              targetCurrency: 'USDT',
              network: 'TON',
              exchangeRateUsdStr: '1',
              convertedAmountStr: '0.90',
              convertedAmount: 0.9,
              scaled1e18: 900_000_000_000_000_000n,
              requiresConversionNotice: false,
            },
          },
        ]),
      );
      assert.equal(cryptoKb.includes('USDT:TON'), true);

      const checkoutMsg = formatOrderCheckoutChooserMessage(sampleOrder, 0);
      assert.ok(checkoutMsg.includes('$0.90'));

      return 'XTR checkout полностью заблокирован в PaymentService и удалён из пользовательских клавиатур оплаты.';
    },
  );

  await runTest(
    'S42-16',
    'Payments',
    'Server routes (server.ts): диспетчеризация вебхука заказа (ordpay_*), живой /api/topup/calculate и статус сервера QUIZYSTARS',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let currentPaymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: { ok: true, result: [{ source: 'TON', target: 'USD', rate: '5.00', is_valid: true }] },
          };
        }
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          currentPaymentId = String(body.payload);
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'cb_srv_order_1',
                status: 'active',
                amount: String(body.amount),
                asset: 'TON',
                currency_type: 'crypto',
                bot_invoice_url: 'https://t.me/CryptoBot?start=cb_srv_order_1',
                payload: currentPaymentId,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 'cb_srv_order_1',
                    status: 'paid',
                    amount: '2.78',
                    asset: 'TON',
                    paid_asset: 'TON',
                    currency_type: 'crypto',
                    payload: currentPaymentId,
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected: ${req.method} ${req.url}`);
      };

      const gw = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const bs = new BalanceService(gw);
      const ps = new PaymentService('s42-16', gw);

      // 1. Тест /api/topup/calculate
      const calcRes = createMockExpressRes();
      await handleTopUpCalculateRequest(
        { body: { provider: 'cryptobot', amountUsd: '10.00', currency: 'TON' } } as unknown as Request,
        calcRes.res,
        { gateway: gw },
      );
      assert.equal(calcRes.getStatus(), 200);
      const calcJson = calcRes.getJson() as {
        ok: boolean;
        amountUsdCents: number;
        feeUsdCents: number;
        amountCreditedUsdCents: number;
        amountToPayInCurrencyStr: string;
        exchangeRateUsdStr: string;
      };
      assert.equal(calcJson.ok, true);
      assert.equal(calcJson.amountUsdCents, 1000);
      assert.equal(calcJson.feeUsdCents, 30);
      assert.equal(calcJson.amountCreditedUsdCents, 970);
      assert.equal(calcJson.amountToPayInCurrencyStr, '2.00');
      assert.equal(calcJson.exchangeRateUsdStr, '5.00');

      // 2. Тест маршрутизации вебхука в Order через server.ts
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m', // $13.90 -> 2.78 TON @ 5.00
        quantity: 1,
      });
      const inv = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'TON',
      });

      const rawWh = JSON.stringify({
        update_type: 'invoice_paid',
        payload: {
          invoice_id: 'cb_srv_order_1',
          status: 'paid',
          paid_amount: '2.78',
          paid_asset: 'TON',
          currency_type: 'crypto',
          payload: inv.payment.paymentId,
        },
      });
      const sig = computeCryptoBotWebhookSignature(
        rawWh,
        TEST_MOCK_CREDS.cryptobotApiToken,
      );
      const whRes = createMockExpressRes();
      await handleProviderWebhookRequest(
        'cryptobot',
        {
          rawBody: rawWh,
          body: JSON.parse(rawWh),
          headers: { 'crypto-pay-api-signature': sig },
        } as unknown as Request,
        whRes.res,
        { balanceSvc: bs, paymentSvc: ps, gateway: gw },
      );
      assert.equal(whRes.getStatus(), 200);
      const whJson = whRes.getJson() as { ok: boolean; kind: string; status: string };
      assert.equal(whJson.ok, true);
      assert.equal(whJson.kind, 'order');
      assert.equal(whJson.status, 'paid');

      // 3. Проверка баннера статуса сервера
      const statusText = renderPlainTextStatus();
      assert.ok(statusText.includes('=== QUIZYSTARS STORE SERVER ==='));
      assert.ok(statusText.includes('Валюта расчётов MyStars: usdt_ton'));

      return 'Серверные хендлеры /api/topup/calculate, диспетчер order/topup вебхуков и статус QUIZYSTARS работают корректно.';
    },
  );

  await runTest(
    'S42-17',
    'Security',
    'Маскировка всех чувствительных ключей (CryptoBot, xRocket, Telegram Bot, MyStars API key) в логах и ошибках',
    async () => {
      const prevCb = process.env.CRYPTOBOT_API_TOKEN;
      const prevXr = process.env.XROCKET_API_KEY;
      const prevMs = process.env.MYSTARS_API_KEY;
      const prevTg = process.env.TELEGRAM_BOT_TOKEN;

      try {
        process.env.CRYPTOBOT_API_TOKEN = 'secret_cb_token_998877';
        process.env.XROCKET_API_KEY = 'secret_xr_key_665544';
        process.env.MYSTARS_API_KEY = 'secret_ms_key_332211';
        process.env.TELEGRAM_BOT_TOKEN = '123456:secret_tg_bot_token';

        const leakSample =
          'Err connecting with cb=secret_cb_token_998877 xr=secret_xr_key_665544 ms=secret_ms_key_332211 tg=123456:secret_tg_bot_token';
        const sanitized1 = redactSecretsFromText(leakSample);
        const sanitized2 = maskSecretsInText(leakSample, [
          process.env.CRYPTOBOT_API_TOKEN,
          process.env.XROCKET_API_KEY,
          process.env.MYSTARS_API_KEY,
          process.env.TELEGRAM_BOT_TOKEN,
        ]);

        assert.ok(sanitized1.includes('***'));
        assert.ok(sanitized2.includes('[REDACTED_SECRET]'));
        for (const text of [sanitized1, sanitized2]) {
          assert.equal(text.includes('secret_cb_token_998877'), false);
          assert.equal(text.includes('secret_xr_key_665544'), false);
          assert.equal(text.includes('secret_ms_key_332211'), false);
          assert.equal(text.includes('123456:secret_tg_bot_token'), false);
        }
      } finally {
        process.env.CRYPTOBOT_API_TOKEN = prevCb;
        process.env.XROCKET_API_KEY = prevXr;
        process.env.MYSTARS_API_KEY = prevMs;
        process.env.TELEGRAM_BOT_TOKEN = prevTg;
      }

      return 'Все 4 секретных токена (CryptoBot, xRocket, MyStars, Telegram Bot) надёжно маскируются перед логированием.';
    },
  );

  await runTest(
    'S421-01',
    'Payments',
    'Stage 4.2.1: Строгая валидация Telegram @username (5..32 символов, правила символов/пробелов/@, запрет пустых значений)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      // Допустимые форматы по официальной документации Telegram (5..32 символов: a-z, 0-9, _)
      assert.equal(normalizeRecipientUsername('abcde'), 'abcde');
      assert.equal(normalizeRecipientUsername('@AbC_1'), 'abc_1');
      assert.equal(normalizeRecipientUsername('  @QuizyStars_5 '), 'quizystars_5');
      assert.equal(normalizeRecipientUsername('al__ice'), 'al__ice');
      assert.equal(normalizeRecipientUsername('alice_'), 'alice_');
      const max32 = 'a' + 'b'.repeat(31);
      assert.equal(normalizeRecipientUsername(`@${max32}`), max32);

      // Недопустимая длина, символы, пробелы, лишние @ и пустые значения
      const invalidUsernames = [
        'abcd',
        '@abcd',
        'a' + 'b'.repeat(32), // 33 символа
        '@@alice',
        'alice@bot',
        'alice test',
        '@ alice',
        'alice\ttest',
        'user!name',
        'alice-test',
        'иван_тест',
        '',
        '   ',
        '@',
      ];
      for (const bad of invalidUsernames) {
        assert.throws(
          () => normalizeRecipientUsername(bad),
          /(@username|Некорректный|Укажите)/,
          `Ожидался отказ для username=${JSON.stringify(bad)}`,
        );
      }

      // Неопределённый (undefined) допускается только если поле не передано
      assert.equal(normalizeRecipientUsername(undefined), undefined);

      // Проверка интеграции в OrderService.createOrder и setOrderRecipientUsername
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 50,
            recipientUsername: 'abcd',
          }),
        /от 5 до 32/,
      );
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 50,
            recipientUsername: '   ',
          }),
        /не может быть пустым/,
      );

      const created = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      assert.equal(created.recipientUsername, undefined);

      await assert.rejects(
        () => OrderService.setOrderRecipientUsername(created.orderId, buyer1.id, '@@alice'),
        /Некорректный @username/,
      );
      const updatedOrder = await OrderService.setOrderRecipientUsername(
        created.orderId,
        buyer1.id,
        '@Quizy_User5',
      );
      assert.equal(updatedOrder.recipientUsername, 'quizy_user5');

      return 'Проверены 5..32 символа, нормализация @, запрет пробелов/спецсимволов/@@/пустых строк и интеграция с OrderService.';
    },
  );

  await runTest(
    'S421-02',
    'Payments',
    'Stage 4.2.1: Строгая целочисленная валидация количества Stars (без Math.round, отказ для дробных/<=0/NaN/Infinity/строк)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();

      const starsCustom = await ProductService.getProductById('stars_custom');
      const stars100 = await ProductService.getProductById('stars_pack_100');
      const prem3 = await ProductService.getProductById('premium_3m');
      assert.ok(starsCustom && stars100 && prem3);

      // Граничные корректные значения stars_custom (50..100000 @ $0.02 = 2 цента/шт)
      const minCalc = ProductService.calculateOrderPriceUsdCents(starsCustom, 50);
      assert.deepEqual(minCalc, {
        quantity: 50,
        unitPriceUsdCents: 2,
        totalPriceUsdCents: 100,
      });
      const minStrCalc = ProductService.calculateOrderPriceUsdCents(starsCustom, ' 50 ');
      assert.equal(minStrCalc.quantity, 50);
      assert.equal(minStrCalc.totalPriceUsdCents, 100);

      const maxCalc = ProductService.calculateOrderPriceUsdCents(starsCustom, 100000);
      assert.deepEqual(maxCalc, {
        quantity: 100000,
        unitPriceUsdCents: 2,
        totalPriceUsdCents: 200000,
      });

      // Цены каталога не изменились
      assert.equal(ProductService.calculateOrderPriceUsdCents(stars100, 1).totalPriceUsdCents, 175);
      assert.equal(ProductService.calculateOrderPriceUsdCents(prem3, 1).totalPriceUsdCents, 1390);

      // Некорректные количества (включая дробные, которые ранее округлял Math.round)
      const invalidQuantities: Array<number | string> = [
        49,
        100001,
        50.4,
        50.9,
        100.1,
        '50.5',
        '50,5',
        0,
        '0',
        -1,
        -50,
        '-50',
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        '',
        '   ',
        'abc',
        '50stars',
        '5e1',
        '+50',
        null as unknown as number,
      ];

      for (const badQty of invalidQuantities) {
        assert.throws(
          () => ProductService.calculateOrderPriceUsdCents(starsCustom, badQty),
          /Некорректное количество/,
          `Ожидался отказ для quantity=${String(badQty)}`,
        );
      }

      // Проверка отказа на уровне OrderService.createOrder и BalanceService.purchaseWithInternalBalance
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 50.4,
            recipientUsername: '@alice_ok',
          }),
        /Некорректное количество/,
      );

      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_custom',
            quantity: 50.9,
            recipientUsername: '@alice_ok',
          }),
        /Некорректное количество/,
      );

      return 'Дробные, <=0, NaN, Infinity, нечисловые и граничные значения валидируются строго без округления на всех точках входа.';
    },
  );

  await runTest(
    'S421-03',
    'Security',
    'Stage 4.2.1: Согласованность серверной валидации в BalanceService, PaymentService и ProductService.createProduct',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();
      const ps = new PaymentService('s421-03');

      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 10000,
        balance: 100,
      });

      // Искусственно повреждённый заказ с дробным количеством не должен пройти ни через BalanceService, ни через PaymentService
      const orderBadQty = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_custom',
        quantity: 50,
        recipientUsername: 'valid_user5',
      });
      await firestoreRepo.updateDoc('orders', orderBadQty.orderId, {
        quantity: 50.5,
      });

      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_custom',
            orderId: orderBadQty.orderId,
          }),
        /Некорректное количество/,
      );

      await assert.rejects(
        () =>
          ps.createOrReuseOrderPayment({
            orderId: orderBadQty.orderId,
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USD',
          }),
        /Некорректное количество/,
      );

      // Повреждённый recipientUsername в существующем заказе тоже блокируется
      const orderBadUser = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_custom',
        quantity: 50,
        recipientUsername: 'valid_user5',
      });
      await firestoreRepo.updateDoc('orders', orderBadUser.orderId, {
        recipientUsername: 'abcd',
      });

      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_custom',
            orderId: orderBadUser.orderId,
          }),
        /Некорректный @username/,
      );

      await assert.rejects(
        () =>
          ps.createOrReuseOrderPayment({
            orderId: orderBadUser.orderId,
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USD',
          }),
        /Некорректный @username/,
      );

      // Админское создание товара отклоняет некорректные minQuantity/maxQuantity
      await assert.rejects(
        () =>
          ProductService.createProduct({
            name: 'Invalid Stars Pack',
            description: 'Bad bounds',
            category: 'stars',
            price: 100,
            minQuantity: 10.5,
            fulfillmentType: 'manual',
          }),
        /minQuantity/,
      );
      await assert.rejects(
        () =>
          ProductService.createProduct({
            name: 'Invalid Stars Bounds',
            description: 'min > max',
            category: 'stars',
            price: 100,
            minQuantity: 20,
            maxQuantity: 10,
            fulfillmentType: 'manual',
          }),
        /maxQuantity/,
      );

      return 'Единая серверная валидация подтверждена во всех платёжных и каталожных точках входа.';
    },
  );

  await runTest(
    'S422-01',
    'Security',
    'Stage 4.2.2: Удаление Gifts из пользовательского UI, 6 кнопок главного меню и сохранение исторических записей Gifts в БД',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);

      // 1. Главное меню покупателя содержит ровно 6 кнопок без Gifts и админ-кнопки (7 с админом)
      const buyerMenu = buildMainMenuKeyboard(false);
      const buyerButtons = buyerMenu.reply_markup.inline_keyboard.flat();
      assert.equal(buyerButtons.length, 6);
      assert.deepEqual(
        buyerButtons.map((b) => (b as { callback_data?: string }).callback_data),
        ['cat:stars', 'cat:premium', 'menu:orders', 'menu:profile', 'menu:topup', 'menu:support'],
      );
      assert.equal(JSON.stringify(buyerMenu).toLowerCase().includes('gift'), false);

      const adminMenu = buildMainMenuKeyboard(true);
      const adminButtons = adminMenu.reply_markup.inline_keyboard.flat();
      assert.equal(adminButtons.length, 7);

      // 2. Категории, приветствие, справка, правила и покупательский каталог не содержат Gifts
      const catKb = JSON.stringify(buildCatalogCategoriesKeyboard());
      assert.equal(catKb.includes('cat:gifts'), false);
      assert.equal(catKb.includes('cat:stars'), true);
      assert.equal(catKb.includes('cat:premium'), true);

      for (const text of [
        formatWelcomeMessage('Buyer', false),
        formatCatalogOverviewMessage(),
        formatHelpMessage(),
        formatTermsMessage(),
      ]) {
        assert.equal(/gift|подар/i.test(text), false, `Обнаружено упоминание Gifts в тексте: ${text}`);
      }

      const buyerProducts = await ProductService.getBuyerCatalogProducts();
      assert.deepEqual(
        buyerProducts.map((p) => p.id).sort(),
        ['premium_12m', 'premium_3m', 'premium_6m', 'stars_custom'],
      );

      // 3. Создаём исторический заказ Gifts в БД (имитация старой записи) и проверяем, что он читается и виден админу, но недоступен покупателю через UI
      const historicalGift = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      assert.equal(historicalGift.category, 'gifts');
      const loadedHistorical = await OrderService.getOrderById(historicalGift.orderId);
      assert.ok(loadedHistorical);
      assert.ok(formatAdminOrderCard(loadedHistorical).includes(historicalGift.orderId));

      const harness = createWiredBotHarness();
      await harness.sendCallback(buyer1, 'cat:gifts');
      assert.equal(harness.lastAnswer()?.text?.includes('отключён'), true);
      assert.equal(harness.lastUiCall()?.callbacks.includes('cat:gifts'), false);
      assert.equal(harness.lastUiCall()?.callbacks.length, 6);

      await harness.sendCallback(buyer1, 'prod:gift_star_box');
      assert.equal(harness.lastAnswer()?.text?.includes('больше не доступен'), true);
      assert.equal(harness.lastUiCall()?.callbacks.length, 6);

      await harness.sendCallback(buyer1, 'buy_bal:gift_star_box');
      assert.equal(harness.lastAnswer()?.text?.includes('отключена'), true);
      const ordersCountAfterGiftBlocked = (await OrderService.getUserOrders(buyer1.id)).length;
      assert.equal(ordersCountAfterGiftBlocked, 1); // Только исходный исторический заказ

      return 'Gifts полностью убран из меню и сценариев покупателя (6 кнопок в главном меню), исторические записи Gifts в БД сохранены.';
    },
  );

  await runTest(
    'S422-02',
    'Payments',
    'Stage 4.2.2: Покупка Stars (произвольное целое количество 50..100000, без пакетов, подтверждение до создания заказа, идемпотентность)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();

      // 1. Нажатие «⭐ Купить Stars» сразу запрашивает произвольное количество без показа пакетов 50/100/250/500/1000
      await harness.sendCallback(buyer1, 'cat:stars');
      const qtyPrompt = harness.lastUiCall()!;
      assert.ok(qtyPrompt.text.includes('Введите количество Stars'));
      assert.equal(qtyPrompt.callbacks.some((c) => c.startsWith('prod:stars_pack_')), false);
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      // 2. Отклонение невалидных количеств без округления и без создания Order
      for (const badInput of ['49', '100001', '50.5', '0', '-100', 'abc']) {
        await harness.sendText(buyer1, badInput);
        const errReply = harness.lastUiCall()!;
        assert.ok(
          errReply.text.includes('Некорректное количество'),
          `Ожидалась ошибка для "${badInput}", получено: ${errReply.text}`,
        );
        assert.equal(getUserCheckoutSession(buyer1.id)?.mode, 'stars_qty');
        assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);
      }

      // 3. Ввод 1000 Stars -> итог $20.00 -> запрос @username с кнопкой «Купить себе»
      await harness.sendText(buyer1, '1000');
      const rcptPrompt = harness.lastUiCall()!;
      assert.ok(rcptPrompt.text.includes('1000 ⭐'));
      assert.ok(rcptPrompt.text.includes('$20.00'));
      assert.ok(rcptPrompt.callbacks.includes('rcpt_self'));
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      // 4. Выбор себя -> отображается карточка подтверждения, заказ в БД ЕЩЁ НЕ создан!
      await harness.sendCallback(buyer1, 'rcpt_self');
      const confirmUi = harness.lastUiCall()!;
      assert.ok(confirmUi.text.includes('Подтверждение заказа'));
      assert.ok(confirmUi.text.includes('1000 ⭐'));
      assert.ok(confirmUi.text.includes(`@${buyer1.username!.toLowerCase()}`));
      assert.ok(confirmUi.text.includes('$20.00'));
      assert.deepEqual(confirmUi.callbacks, [
        'checkout:proceed',
        'checkout:edit_qty',
        'checkout:edit_recipient',
        'checkout:cancel',
      ]);
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      // 5. Двойное нажатие «Перейти к оплате» создаёт строго 1 заказ и открывает единый экран оплаты
      await Promise.all([
        harness.sendCallback(buyer1, 'checkout:proceed'),
        harness.sendCallback(buyer1, 'checkout:proceed'),
      ]);
      const createdOrders = await OrderService.getUserOrders(buyer1.id);
      assert.equal(createdOrders.length, 1);
      const order = createdOrders[0];
      assert.equal(order.productId, 'stars_custom');
      assert.equal(order.quantity, 1000);
      assert.equal(order.unitPriceUsdCents, 2);
      assert.equal(order.totalPriceUsdCents, 2000);
      assert.equal(order.recipientUsername, buyer1.username!.toLowerCase());
      assert.equal(getUserCheckoutSession(buyer1.id), undefined);

      const chooserUi = harness.lastUiCall()!;
      assert.ok(chooserUi.text.includes('Оплата заказа'));
      assert.ok(chooserUi.text.includes('1. Внутренний USD-баланс'));
      assert.ok(chooserUi.text.includes('2. CryptoBot'));
      assert.ok(chooserUi.text.includes('3. xRocket'));

      return 'Stars flow проверен end-to-end: свободное количество 50..100000 ($0.02), отказ невалидного ввода, подтверждение до БД и защита от дублей.';
    },
  );

  await runTest(
    'S422-03',
    'Payments',
    'Stage 4.2.2: Покупка Telegram Premium (ровно 3 тарифа: 3/6/12 мес., фиксированное quantity=1, защита сроков)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();

      // 1. Категория Premium показывает ровно 3 фиксированных тарифа
      await harness.sendCallback(buyer1, 'cat:premium');
      const tariffsUi = harness.lastUiCall()!;
      assert.deepEqual(tariffsUi.callbacks, [
        'prem:select:premium_3m',
        'prem:select:premium_6m',
        'prem:select:premium_12m',
        'menu:home',
      ]);
      assert.ok(tariffsUi.text.includes('$13.90'));
      assert.ok(tariffsUi.text.includes('$19.90'));
      assert.ok(tariffsUi.text.includes('$34.90'));

      // 2. Выбор 6 месяцев ($19.90) сразу запрашивает получателя (минуя ввод количества)
      await harness.sendCallback(buyer1, 'prem:select:premium_6m');
      const rcptUi = harness.lastUiCall()!;
      assert.ok(rcptUi.text.includes('Telegram Premium — 6 мес.'));
      assert.ok(rcptUi.text.includes('$19.90'));

      // 3. Ввод другого @username -> карточка подтверждения БЕЗ кнопки изменения количества
      await harness.sendText(buyer1, '@Target_User6');
      const confirmUi = harness.lastUiCall()!;
      assert.ok(confirmUi.text.includes('Подтверждение заказа'));
      assert.ok(confirmUi.text.includes('6 мес.'));
      assert.ok(confirmUi.text.includes('@target_user6'));
      assert.ok(confirmUi.text.includes('$19.90'));
      assert.deepEqual(confirmUi.callbacks, [
        'checkout:proceed',
        'cat:premium',
        'checkout:edit_recipient',
        'checkout:cancel',
      ]);
      assert.equal(confirmUi.callbacks.includes('checkout:edit_qty'), false);
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      // Попытка вручную вызвать checkout:edit_qty на Premium отклоняется
      await harness.sendCallback(buyer1, 'checkout:edit_qty');
      assert.ok(harness.lastAnswer()?.text?.includes('только при покупке Telegram Stars'));

      // 4. Подтверждение создаёт 1 заказ Premium с durationMonths=6 и quantity=1
      await harness.sendCallback(buyer1, 'checkout:proceed');
      const orders = await OrderService.getUserOrders(buyer1.id);
      assert.equal(orders.length, 1);
      assert.equal(orders[0].productId, 'premium_6m');
      assert.equal(orders[0].durationMonths, 6);
      assert.equal(orders[0].quantity, 1);
      assert.equal(orders[0].totalPriceUsdCents, 1990);
      assert.equal(orders[0].recipientUsername, 'target_user6');

      // 5. Защита от произвольных сроков и quantity != 1 в сервисах
      await assert.rejects(
        () =>
          ProductService.createProduct({
            name: 'Premium 9 Months Invalid',
            description: 'Unsupported',
            category: 'premium',
            priceUsdCents: 2500,
            durationMonths: 9 as unknown as 3,
          }),
        /только 3, 6 или 12 месяцев/,
      );
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'premium_3m',
            quantity: 2,
            recipientUsername: '@valid_user5',
          }),
        /количество всегда равно 1/,
      );

      return 'Premium flow проверен: ровно 3 тарифа ($13.90/$19.90/$34.90), quantity=1, редактирование срока, запрет произвольных сроков.';
    },
  );

  await runTest(
    'S422-04',
    'Payments',
    'Stage 4.2.2: Единый экран оплаты (Баланс USD, CryptoBot, xRocket), нехватка баланса и защита от подмены/отмены/пропуска получателя',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();
      const bs = new BalanceService();

      await UserService.upsertFromTelegram(buyer1);
      // Баланс $0.50 (50 центов) — недостаточно для заказа за $13.90
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 50,
        balance: 0.5,
      });

      const order1 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m',
        quantity: 1,
        recipientUsername: '@buyer_one',
        requireRecipient: true,
      });

      await harness.sendCallback(buyer1, `ordpay_menu:${order1.orderId}`);
      const lowBalChooser = harness.lastUiCall()!;
      assert.ok(lowBalChooser.text.includes('1. Внутренний USD-баланс'));
      assert.ok(lowBalChooser.text.includes('2. CryptoBot'));
      assert.ok(lowBalChooser.text.includes('3. xRocket'));
      assert.equal(lowBalChooser.text.includes('XTR'), false);
      assert.ok(lowBalChooser.callbacks.includes(`pay_bal_insuff:${order1.orderId}`));
      assert.ok(lowBalChooser.callbacks.includes(`pay_ord_prov:cryptobot:${order1.orderId}`));
      assert.ok(lowBalChooser.callbacks.includes(`pay_ord_prov:xrocket:${order1.orderId}`));

      // Нажатие при недостатке средств показывает точный дефицит и кнопку пополнения; баланс не меняется
      await harness.sendCallback(buyer1, `pay_bal_insuff:${order1.orderId}`);
      assert.ok(harness.lastAnswer()?.text?.includes('Не хватает $13.40'));
      assert.ok(harness.lastUiCall()?.callbacks.includes('menu:topup'));
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 50);

      // Пополняем баланс до $25.00 и проверяем атомарную оплату + защиту от двойного списания
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 2500,
        balance: 25,
      });
      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, `ordpay_menu:${order1.orderId}`);
      assert.ok(harness.lastUiCall()?.callbacks.includes(`pay_bal:${order1.orderId}`));

      await Promise.all([
        harness.sendCallback(buyer1, `pay_bal:${order1.orderId}`),
        harness.sendCallback(buyer1, `pay_bal:${order1.orderId}`),
      ]);
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 1110); // 2500 - 1390
      const paidOrder1 = await OrderService.getOrderById(order1.orderId);
      assert.equal(paidOrder1?.paymentStatus, 'paid');

      // CryptoBot и xRocket для второго заказа + запрет изменения получателя/цены после создания инвойса
      const order2 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_custom',
        quantity: 100, // $2.00
        recipientUsername: '@target_crypto',
        requireRecipient: true,
      });
      let createdInvoiceNum = 0;
      const transport = async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: [
                { source: 'USDT', target: 'USD', rate: '1.00', is_valid: true },
                { source: 'TON', target: 'USD', rate: '5.50', is_valid: true },
              ],
            },
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: {
              data: { USDT: '1.00', TON: '5.50' },
            },
          };
        }
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [
              { currency: 'USDT', networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'] },
              { currency: 'TON', networks: ['TON'] },
            ],
          };
        }
        if (req.url.endsWith('/createInvoice')) {
          createdInvoiceNum += 1;
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: `inv_s422_${createdInvoiceNum}`,
                status: 'active',
                amount: String(body.amount),
                asset: 'USDT',
                bot_invoice_url: `https://t.me/CryptoBot?start=s422_${createdInvoiceNum}`,
                payload: String(body.payload),
              },
            },
          };
        }
        if (req.url.includes('/getInvoices')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 'inv_s422_1',
                    status: 'paid',
                    amount: '2.00',
                    asset: 'USDT',
                    paid_asset: 'USDT',
                    payload: '',
                  },
                ],
              },
            },
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_s422_1',
              priceAmount: String(body.priceAmount || '2.00'),
              priceCurrency: String(body.priceCurrency || 'USDT'),
              clientInvoiceId: String(body.clientInvoiceId || ''),
              status: 'PENDING',
              links: {
                telegramBotLink: 'https://t.me/xrocket?start=xr_s422_1',
              },
            },
          };
        }
        throw new Error(`Unexpected call: ${req.url}`);
      };
      const ps = new PaymentService('s422-04', new PaymentProviderGateway(transport, TEST_MOCK_CREDS));
      const invCb = await ps.createOrReuseOrderPayment({
        orderId: order2.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USDT',
        requireRecipient: true,
      });
      assert.equal(invCb.payment.expectedUsdCents, 200);

      // После выставления счёта менять получателя запрещено
      await assert.rejects(
        () => OrderService.setOrderRecipientUsername(order2.orderId, buyer1.id, '@another_user'),
        /после выставления счёта/,
      );

      // Подмена суммы в заказе после создания счёта блокируется при проверке платежа
      await firestoreRepo.updateDoc<Order>('orders', order2.orderId, {
        totalPriceUsdCents: 9999,
        totalPrice: 9999,
      });
      await assert.rejects(
        () => ps.verifyAndProcessOrderPayment(invCb.payment.paymentId),
        /Нарушение целостности суммы заказа/,
      );

      // Переиспользование xRocket на новом заказе
      const order3 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_custom',
        quantity: 100,
        recipientUsername: '@target_xr',
        requireRecipient: true,
      });
      const invXr = await ps.createOrReuseOrderPayment({
        orderId: order3.orderId,
        callerTelegramId: buyer1.id,
        provider: 'xrocket',
        currency: 'USDT',
        network: 'TON',
        requireRecipient: true,
      });
      assert.equal(invXr.payment.provider, 'xrocket');

      // Отмена заказа и запрет его оплаты всеми способами
      await harness.sendCallback(buyer1, `ucancel:${order3.orderId}`);
      const cancelledOrder3 = await OrderService.getOrderById(order3.orderId);
      assert.equal(cancelledOrder3?.paymentStatus, 'cancelled');
      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: order3.productId,
            quantity: order3.quantity,
            orderId: order3.orderId,
            recipientUsername: order3.recipientUsername,
            requireRecipient: true,
          }),
        /(отменён|оплачен)/,
      );
      await assert.rejects(
        () =>
          ps.createOrReuseOrderPayment({
            orderId: order3.orderId,
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USDT',
            requireRecipient: true,
          }),
        /(cancelled|не может быть оплачен)/,
      );

      // Заказ без @recipient блокируется при попытке оплаты
      const orderNoRcpt = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m',
        quantity: 1,
      });
      await assert.rejects(
        () =>
          ps.createOrReuseOrderPayment({
            orderId: orderNoRcpt.orderId,
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USDT',
            requireRecipient: true,
          }),
        /получателя/,
      );

      return 'Единый экран оплаты (Баланс USD/CryptoBot/xRocket), нехватка баланса, отмена заказа, защита от подмены цены и отсутствия получателя подтверждены.';
    },
  );

  await runTest(
    'S422-05',
    'Security',
    'Stage 4.2.2: Валидация @username получателя и условный показ кнопки «Купить себе»',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();

      const validCases: Array<[string, string]> = [
        ['abcde', 'abcde'],
        ['@Alice_5', 'alice_5'],
        ['a_b_c_1', 'a_b_c_1'],
        ['al__ice5', 'al__ice5'],
        ['alice5_', 'alice5_'],
        ['a' + '1_2'.repeat(10) + 'z', 'a' + '1_2'.repeat(10) + 'z'], // 32 chars
      ];
      for (const [raw, expected] of validCases) {
        assert.equal(normalizeRecipientUsername(raw), expected);
        assert.equal(canUseTelegramUsernameAsRecipient(raw), expected);
      }

      const invalidCases = [
        'abcd',
        '@ab_c',
        'a' + 'b'.repeat(32), // 33 chars
        'alice test',
        '@@alice5',
        'alice@bot',
        'alice-test',
        'иван_55',
        '',
        '   ',
        '@',
      ];
      for (const bad of invalidCases) {
        assert.throws(() => normalizeRecipientUsername(bad));
        assert.equal(canUseTelegramUsernameAsRecipient(bad), null);
      }
      assert.equal(canUseTelegramUsernameAsRecipient(undefined), null);

      // Кнопка «Купить себе» отображается ТОЛЬКО если username валиден
      const kbWithSelf = buildPromptRecipientKeyboard('stars', canUseTelegramUsernameAsRecipient('ValidUser5'));
      const cbWithSelf = kbWithSelf.reply_markup.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data);
      assert.equal(cbWithSelf.includes('rcpt_self'), true);

      const kbWithoutSelf = buildPromptRecipientKeyboard('stars', canUseTelegramUsernameAsRecipient(undefined));
      const cbWithoutSelf = kbWithoutSelf.reply_markup.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data);
      assert.equal(cbWithoutSelf.includes('rcpt_self'), false);

      const kbShortUser = buildPromptRecipientKeyboard('premium', canUseTelegramUsernameAsRecipient('abc'));
      const cbShortUser = kbShortUser.reply_markup.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data);
      assert.equal(cbShortUser.includes('rcpt_self'), false);

      // В живом боте пользователь без username не видит rcpt_self и получает отказ при прямой отправке callback rcpt_self
      const noUsernameBuyer = { id: 888999001, first_name: 'NoHandle' };
      const harness = createWiredBotHarness();
      await harness.sendCallback(noUsernameBuyer, 'cat:premium');
      await harness.sendCallback(noUsernameBuyer, 'prem:select:premium_3m');
      assert.equal(harness.lastUiCall()?.callbacks.includes('rcpt_self'), false);

      await harness.sendCallback(noUsernameBuyer, 'rcpt_self');
      assert.ok(harness.lastAnswer()?.text?.includes('не задан корректный @username'));

      return 'Правила Telegram @username (5..32 символов: a-z, 0-9, _) и условный показ «Купить себе» полностью подтверждены.';
    },
  );

  await runTest(
    'S422-06',
    'Fulfillment',
    'Stage 4.2.2: Редактирование количества/получателя/тарифа, возврат Назад и чистая отмена без утечек в БД',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();

      // 1. Ввод Stars -> получатель -> изменение количества сохраняет получателя и пересчитывает итог
      await harness.sendCallback(buyer1, 'cat:stars');
      await harness.sendText(buyer1, '100');
      await harness.sendText(buyer1, '@First_User');
      assert.ok(harness.lastUiCall()?.text.includes('$2.00'));
      assert.ok(harness.lastUiCall()?.text.includes('@first_user'));

      await harness.sendCallback(buyer1, 'checkout:edit_qty');
      assert.ok(harness.lastUiCall()?.callbacks.includes('checkout:back_confirm'));
      await harness.sendText(buyer1, '250');
      assert.ok(harness.lastUiCall()?.text.includes('250 ⭐'));
      assert.ok(harness.lastUiCall()?.text.includes('$5.00'));
      assert.ok(harness.lastUiCall()?.text.includes('@first_user'));

      // 2. Изменение получателя: Назад возвращает старого, ввод нового обновляет
      await harness.sendCallback(buyer1, 'checkout:edit_recipient');
      await harness.sendCallback(buyer1, 'checkout:back_confirm');
      assert.ok(harness.lastUiCall()?.text.includes('@first_user'));

      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'checkout:edit_recipient');
      await harness.sendText(buyer1, '@Second_User');
      assert.ok(harness.lastUiCall()?.text.includes('@second_user'));
      assert.ok(harness.lastUiCall()?.text.includes('250 ⭐'));
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      // 3. Отмена до подтверждения очищает сессию и возвращает в главное меню без создания Order
      await harness.sendCallback(buyer1, 'checkout:cancel');
      assert.equal(getUserCheckoutSession(buyer1.id), undefined);
      assert.equal(harness.lastUiCall()?.callbacks.length, 6);
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      // 4. Команда /start посреди сценария чисто сбрасывает сессию
      await harness.sendCallback(buyer1, 'cat:stars');
      assert.equal(getUserCheckoutSession(buyer1.id)?.mode, 'stars_qty');
      await harness.sendText(buyer1, '/start');
      assert.equal(getUserCheckoutSession(buyer1.id), undefined);

      return 'Навигация редактирования (количество/получатель/назад) и чистая отмена сессии без мусорных заказов подтверждены.';
    },
  );

  // =========================================================================
  // STAGE 4.2.3: FINAL VALIDATION & EDGE CASE FIXES
  // =========================================================================

  await runTest(
    'S423-01',
    'Security',
    'Stage 4.2.3: Premium-товар без durationMonths отклоняется при создании, заказе и оплате',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();

      // 1. Создание Premium-товара без durationMonths (undefined или null) отклоняется
      await assert.rejects(
        () =>
          ProductService.createProduct({
            name: 'Premium Missing Duration',
            description: 'Missing durationMonths',
            category: 'premium',
            priceUsdCents: 1390,
          }),
        /обязательно укажите 3, 6 или 12/,
      );
      await assert.rejects(
        () =>
          ProductService.createProduct({
            name: 'Premium Null Duration',
            description: 'Null durationMonths',
            category: 'premium',
            priceUsdCents: 1390,
            durationMonths: null as unknown as 3,
          }),
        /обязательно укажите 3, 6 или 12/,
      );

      // 2. Искусственно добавленный неканонический Premium-товар без durationMonths отклоняется во всех сервисах
      const now = new Date().toISOString();
      await firestoreRepo.setDoc<Product>('products', 'premium_custom_nodur', {
        id: 'premium_custom_nodur',
        name: 'Custom Premium No Duration',
        category: 'premium',
        description: 'Corrupted custom premium',
        priceUsdCents: 1390,
        price: 1390,
        currency: 'USD',
        minQuantity: 1,
        maxQuantity: 1,
        imageUrl: '',
        isActive: true,
        fulfillmentType: 'mystars',
        createdAt: now,
        updatedAt: now,
      });

      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'premium_custom_nodur',
            quantity: 1,
            recipientUsername: '@valid_user5',
          }),
        /не указан обязательный срок подписки/,
      );
      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'premium_custom_nodur',
            quantity: 1,
            recipientUsername: '@valid_user5',
          }),
        /не указан обязательный срок подписки/,
      );

      // 3. Совместимость с историческим Premium-товаром без поля durationMonths в БД для канонического ID (без мутации БД)
      const existingP3 = await ProductService.getProductById('premium_3m');
      assert.ok(existingP3);
      const { durationMonths: _omitted, ...legacyP3 } = existingP3;
      void _omitted;
      assert.equal(ProductService.resolvePremiumDurationMonths(legacyP3 as Product), 3);

      return 'Создание и использование кастомного Premium без durationMonths заблокировано; совместимость с каноническим товаром в БД сохранена.';
    },
  );

  await runTest(
    'S423-02',
    'Security',
    'Stage 4.2.3: Premium с недопустимым сроком и quantity != 1 отклоняется при создании, заказе, оплате и переиспользовании заказа',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();
      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 10000,
        balance: 100,
      });

      // 1. Все некорректные сроки при создании товара отклоняются
      const badDurations: unknown[] = [undefined, null, 0, -3, 1, 2, 3.5, 6.25, 9, 24, '3', NaN, Infinity];
      for (const bad of badDurations) {
        await assert.rejects(
          () =>
            ProductService.createProduct({
              name: `Bad Premium ${String(bad)}`,
              description: 'Invalid duration test',
              category: 'premium',
              priceUsdCents: 1390,
              durationMonths: bad as 3,
            }),
          /3, 6 или 12/,
        );
      }

      // 2. Повреждённый срок (0, -6, 3.5, 9, null) на существующем товаре отклоняется в каталоге и при создании/оплате заказа
      const now = new Date().toISOString();
      await firestoreRepo.updateDoc<Product>('products', 'premium_6m', {
        durationMonths: 9 as unknown as 6,
      });
      assert.equal(
        ProductService.isValidBuyerPremiumProduct(await ProductService.getProductById('premium_6m')),
        false,
      );
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'premium_6m',
            quantity: 1,
            recipientUsername: '@target_user5',
          }),
        /(обязательно укажите 3, 6 или 12|Некорректный срок|допустимы только 3, 6 или 12)/,
      );

      // Восстанавливаем premium_6m для дальнейших проверок
      await firestoreRepo.updateDoc<Product>('products', 'premium_6m', {
        durationMonths: 6,
      });

      // 3. Попытка заказать quantity != 1 или оплатить с другим quantity при переиспользовании заказа отклоняется
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'premium_3m',
            quantity: 2,
            recipientUsername: '@target_user5',
          }),
        /количество всегда равно 1/,
      );

      const validOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m',
        quantity: 1,
        recipientUsername: '@target_user5',
        requireRecipient: true,
      });

      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'premium_3m',
            quantity: 2,
            orderId: validOrder.orderId,
            recipientUsername: '@target_user5',
          }),
        /Количество при оплате существующего заказа изменить нельзя/,
      );

      // Искусственно повреждаем quantity в уже сохранённом заказе -> отклоняется и баланс, и внешний провайдер
      await firestoreRepo.setDoc<Order>('orders', 'ord_tampered_prem_qty', {
        ...validOrder,
        orderId: 'ord_tampered_prem_qty',
        quantity: 2,
        updatedAt: now,
      });
      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'premium_3m',
            orderId: 'ord_tampered_prem_qty',
            recipientUsername: '@target_user5',
          }),
        /количество всегда равно 1/,
      );
      const ps = new PaymentService('s423-02', new PaymentProviderGateway(async () => {
        throw new Error('Should not reach HTTP');
      }, TEST_MOCK_CREDS));
      await assert.rejects(
        () =>
          ps.createOrReuseOrderPayment({
            orderId: 'ord_tampered_prem_qty',
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USDT',
            requireRecipient: true,
          }),
        /количество всегда равно 1/,
      );

      return 'Недопустимые сроки Premium и quantity != 1 блокируются при создании товара/заказа, оплате и переиспользовании заказа.';
    },
  );

  await runTest(
    'S423-03',
    'Fulfillment',
    'Stage 4.2.3: Отсутствующий/неактивный/повреждённый Premium-тариф не отображается как доступный и блокируется в callback',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();

      // Отключаем premium_6m (или удаляем его / портим цену)
      await firestoreRepo.updateDoc<Product>('products', 'premium_6m', {
        isActive: false,
      });

      await harness.sendCallback(buyer1, 'cat:premium');
      const uiWhenMissing = harness.lastUiCall()!;
      assert.ok(uiWhenMissing.text.includes('временно недоступен'));
      assert.equal(uiWhenMissing.text.includes('$19.90'), false);
      assert.equal(uiWhenMissing.text.includes('6 месяцев'), false);
      assert.equal(uiWhenMissing.callbacks.some((c) => c.startsWith('prem:select:')), false);
      assert.deepEqual(uiWhenMissing.callbacks, ['menu:home']);

      // Попытка нажать устаревшую кнопку prem:select:premium_6m или prem:select:premium_3m при неполном каталоге отклоняется
      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'prem:select:premium_6m');
      assert.ok(harness.lastAnswer()?.text?.includes('временно недоступен'));

      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'prem:select:premium_3m');
      assert.ok(harness.lastAnswer()?.text?.includes('временно недоступен'));

      // Восстанавливаем активность, но ломаем цену (вместо $19.90 ставим $15.00 = 1500) -> тоже отклоняется
      await firestoreRepo.updateDoc<Product>('products', 'premium_6m', {
        isActive: true,
        priceUsdCents: 1500,
        price: 1500,
      });
      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'cat:premium');
      const uiWrongPrice = harness.lastUiCall()!;
      assert.ok(uiWrongPrice.text.includes('временно недоступен'));
      assert.equal(uiWrongPrice.callbacks.some((c) => c.startsWith('prem:select:')), false);

      return 'При отсутствии, отключении или неверной цене обязательного Premium-тарифа раздел показывает недоступность без фиктивных тарифов и кнопок.';
    },
  );

  await runTest(
    'S423-04',
    'Fulfillment',
    'Stage 4.2.3: Текст Premium-каталога и клавиатура всегда используют один и тот же список доступных тарифов',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const p3 = (await ProductService.getProductById('premium_3m'))!;
      const p6 = (await ProductService.getProductById('premium_6m'))!;
      const p12 = (await ProductService.getProductById('premium_12m'))!;

      // 1. Полный корректный список (даже в обратном порядке и с дублем) -> ровно 3 тарифа в тексте и кнопках в порядке 3 -> 6 -> 12
      const msgFull = formatPremiumTariffsMessage([p12, p3, p6, p3]);
      const kbFull = buildPremiumTariffsKeyboard([p12, p3, p6, p3]);
      const cbFull = kbFull.reply_markup.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data);
      assert.deepEqual(cbFull, [
        'prem:select:premium_3m',
        'prem:select:premium_6m',
        'prem:select:premium_12m',
        'menu:home',
      ]);
      assert.ok(msgFull.includes('3 месяца') && msgFull.includes('$13.90'));
      assert.ok(msgFull.includes('6 месяцев') && msgFull.includes('$19.90'));
      assert.ok(msgFull.includes('12 месяцев') && msgFull.includes('$34.90'));

      // 2. Пустой массив -> сообщение о недоступности (БЕЗ фиктивных $13.90/$19.90/$34.90!) и 0 кнопок покупки
      const msgEmpty = formatPremiumTariffsMessage([]);
      const kbEmpty = buildPremiumTariffsKeyboard([]);
      const cbEmpty = kbEmpty.reply_markup.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data);
      assert.ok(msgEmpty.includes('временно недоступен'));
      assert.equal(msgEmpty.includes('$13.90'), false);
      assert.equal(msgEmpty.includes('$19.90'), false);
      assert.equal(msgEmpty.includes('$34.90'), false);
      assert.deepEqual(cbEmpty, ['menu:home']);

      // 3. Неполный список (нет premium_12m) -> единое состояние недоступности и в тексте, и в кнопках
      const msgPartial = formatPremiumTariffsMessage([p3, p6]);
      const kbPartial = buildPremiumTariffsKeyboard([p3, p6]);
      const cbPartial = kbPartial.reply_markup.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data);
      assert.ok(msgPartial.includes('временно недоступен'));
      assert.equal(msgPartial.includes('12 месяцев'), false);
      assert.equal(msgPartial.includes('$34.90'), false);
      assert.deepEqual(cbPartial, ['menu:home']);

      return 'Полное соответствие текста и клавиатуры Premium подтверждено для полного, пустого и неполного наборов товаров.';
    },
  );

  await runTest(
    'S423-05',
    'Security',
    'Stage 4.2.3: Проверка корректных и некорректных @username строго по документированным правилам Telegram (без неподтверждённых запретов)',
    async () => {
      // Допустимые по официальной документации Telegram (5..32 символа: a-z, 0-9, _)
      const validPairs: Array<[string, string]> = [
        ['abcde', 'abcde'],
        ['@Alice_5', 'alice_5'],
        ['al__ice', 'al__ice'],
        ['@alice_', 'alice_'],
        ['_alice5', '_alice5'],
        ['1alice5', '1alice5'],
        ['  @My__Name_2025_  ', 'my__name_2025_'],
        ['a'.repeat(32), 'a'.repeat(32)],
      ];
      for (const [input, expected] of validPairs) {
        assert.equal(normalizeRecipientUsername(input), expected);
        assert.equal(canUseTelegramUsernameAsRecipient(input), expected);
      }

      // Недопустимые по документированным правилам (длина <5 / >32, недопустимые символы, пробелы, лишние @, пустые)
      const invalidInputs = [
        'a',
        'abcd',
        '@abcd',
        'a'.repeat(33),
        '@@alice',
        'alice@bot',
        'alice test',
        '@ alice',
        'alice\nbot',
        'alice-test',
        'alice.test',
        'иван_55',
        '',
        '   ',
        '@',
      ];
      for (const bad of invalidInputs) {
        assert.throws(
          () => normalizeRecipientUsername(bad),
          /(Некорректный|Укажите)/,
          `Ожидался отказ для ${JSON.stringify(bad)}`,
        );
        assert.equal(canUseTelegramUsernameAsRecipient(bad), null);
      }

      return 'Валидация @username соответствует документированным правилам Telegram (5..32 символов, a-z/0-9/_, без неподтверждённых запретов).';
    },
  );

  await runTest(
    'S423-06',
    'Security',
    'Stage 4.2.3: Защита кнопки «Купить себе» (rcpt_self) при отсутствии/невалидности и валидности username',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      const harness = createWiredBotHarness();

      // 1. Пользователь без username -> кнопка не показывается, прямой callback rcpt_self отклоняется
      const noUser = { id: 889000111, first_name: 'NoUser' };
      clearAllUserInteractiveSessions(noUser.id);
      await harness.sendCallback(noUser, 'cat:stars');
      await harness.sendText(noUser, '100');
      assert.equal(harness.lastUiCall()?.callbacks.includes('rcpt_self'), false);

      await harness.sendCallback(noUser, 'rcpt_self');
      assert.ok(harness.lastAnswer()?.text?.includes('не задан корректный @username'));

      // 2. Пользователь со слишком коротким или некорректным username -> кнопка скрыта и callback отклонён
      const shortUser = { id: 889000222, first_name: 'Short', username: 'ab_1' };
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(shortUser.id);
      await harness.sendCallback(shortUser, 'cat:premium');
      await harness.sendCallback(shortUser, 'prem:select:premium_3m');
      assert.equal(harness.lastUiCall()?.callbacks.includes('rcpt_self'), false);

      await harness.sendCallback(shortUser, 'rcpt_self');
      assert.ok(harness.lastAnswer()?.text?.includes('не задан корректный @username'));

      // 3. Пользователь с корректным username (в том числе содержащим "__" или "_" в конце) -> кнопка есть и работает без создания заказа до proceed
      const validUnderscoreUser = { id: 889000333, first_name: 'Valid', username: 'Dev__User_' };
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(validUnderscoreUser.id);
      await harness.sendCallback(validUnderscoreUser, 'cat:premium');
      await harness.sendCallback(validUnderscoreUser, 'prem:select:premium_3m');
      const promptUi = harness.lastUiCall()!;
      assert.equal(promptUi.callbacks.includes('rcpt_self'), true);

      await harness.sendCallback(validUnderscoreUser, 'rcpt_self');
      const confirmUi = harness.lastUiCall()!;
      assert.ok(confirmUi.text.includes('Подтверждение заказа'));
      assert.ok(confirmUi.text.includes('@dev__user_'));
      assert.equal((await OrderService.getUserOrders(validUnderscoreUser.id)).length, 0);

      return 'Защита rcpt_self подтверждена для отсутствующих, коротких и корректных Telegram username.';
    },
  );

  await runTest(
    'S423-07',
    'Payments',
    'Stage 4.2.3: Полная регрессия Stage 4.2.2 (меню, Stars $0.02, 3 тарифа Premium, единый экран оплаты, отмена, сохранность Gifts в БД)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();
      const bs = new BalanceService();

      // Пополняем баланс до $40.00
      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 4000,
        balance: 40,
      });

      // Главное меню: ровно 6 кнопок, без Gifts
      await harness.sendText(buyer1, '/start');
      const menuUi = harness.lastUiCall()!;
      assert.deepEqual(menuUi.callbacks, [
        'cat:stars',
        'cat:premium',
        'menu:orders',
        'menu:profile',
        'menu:topup',
        'menu:support',
      ]);
      assert.equal(menuUi.text.toLowerCase().includes('gift'), false);

      // Историческая запись Gifts остаётся в БД нетронутой
      const histGift = await ProductService.getProductById('gift_star_box');
      assert.ok(histGift && histGift.category === 'gifts');

      // Stars 75 шт ($1.50 = 150 cents) -> изменение получателя -> подтверждение -> единый экран оплаты -> баланс
      await harness.sendCallback(buyer1, 'cat:stars');
      await harness.sendText(buyer1, '75');
      await harness.sendText(buyer1, '@alpha_five');
      await harness.sendCallback(buyer1, 'checkout:edit_recipient');
      await harness.sendText(buyer1, '@Beta_Six6');
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      await harness.sendCallback(buyer1, 'checkout:proceed');
      const chooser = harness.lastUiCall()!;
      assert.ok(chooser.text.includes('1. Внутренний USD-баланс'));
      assert.ok(chooser.text.includes('2. CryptoBot'));
      assert.ok(chooser.text.includes('3. xRocket'));
      assert.equal(chooser.text.includes('XTR'), false);

      const ordersAfterProceed = await OrderService.getUserOrders(buyer1.id);
      assert.equal(ordersAfterProceed.length, 1);
      assert.equal(ordersAfterProceed[0].totalPriceUsdCents, 150);
      assert.equal(ordersAfterProceed[0].recipientUsername, 'beta_six6');

      await harness.sendCallback(buyer1, `pay_bal:${ordersAfterProceed[0].orderId}`);
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 3850); // 4000 - 150
      const paidStars = await OrderService.getOrderById(ordersAfterProceed[0].orderId);
      assert.equal(paidStars?.paymentStatus, 'paid');

      // Все 3 тарифа Premium доступны с прежними ценами ($13.90 / $19.90 / $34.90), оформление и отмена второго заказа
      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'cat:premium');
      const premUi = harness.lastUiCall()!;
      assert.deepEqual(premUi.callbacks, [
        'prem:select:premium_3m',
        'prem:select:premium_6m',
        'prem:select:premium_12m',
        'menu:home',
      ]);
      assert.ok(premUi.text.includes('$13.90') && premUi.text.includes('$19.90') && premUi.text.includes('$34.90'));

      await harness.sendCallback(buyer1, 'prem:select:premium_12m');
      await harness.sendCallback(buyer1, 'rcpt_self');
      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'checkout:proceed');
      const allOrders = await OrderService.getUserOrders(buyer1.id);
      assert.equal(allOrders.length, 2);
      const prem12Order = allOrders.find((o) => o.productId === 'premium_12m')!;
      assert.equal(prem12Order.totalPriceUsdCents, 3490);
      assert.equal(prem12Order.durationMonths, 12);
      assert.equal(prem12Order.quantity, 1);

      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, `ucancel:${prem12Order.orderId}`);
      assert.equal((await OrderService.getOrderById(prem12Order.orderId))?.paymentStatus, 'cancelled');

      return 'Регрессия Stage 4.2.2 пройдена: меню, Stars ($0.02), Premium ($13.90/$19.90/$34.90), единый экран оплаты, отмена и БД-совместимость без сбоев.';
    },
  );

  // =========================================================================
  // STAGE 4.2.4: STARS & PREMIUM UX + SAFE FIRESTORE MIGRATION + /paysupport
  // =========================================================================

  await runTest(
    'S424-01',
    'Payments',
    'Выбор Stars: только ручной ввод 50..100000 без быстрых пресетов, $0.02/Star, авторасчёт (750 -> $15.00) и защита ввода',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();

      // 1. Экран выбора Stars показывает $0.02, диапазон 50..100 000 и ТОЛЬКО навигационные кнопки (без быстрых пресетов)
      await harness.sendCallback(buyer1, 'cat:stars');
      const qtyPrompt = harness.lastUiCall()!;
      assert.ok(qtyPrompt.text.includes('Введите количество Telegram Stars'));
      assert.ok(qtyPrompt.text.includes('Введите количество Stars'));
      assert.ok(qtyPrompt.text.includes('$0.02'));
      assert.ok(qtyPrompt.text.includes('50'));
      assert.ok(qtyPrompt.text.includes('100 000'));
      assert.equal(qtyPrompt.callbacks.some((c) => c.startsWith('stars:qty:')), false);
      assert.equal(qtyPrompt.callbacks.some((c) => c.startsWith('prod:stars_pack_')), false);
      assert.deepEqual(qtyPrompt.callbacks, ['menu:home', 'checkout:cancel']);

      // 2. Отклонение невалидных значений (включая 49, 100001, 0, -50, дроби, запятую, буквы и текст с числами)
      for (const bad of ['49', '100001', '0', '-50', '50.5', '50,5', 'abc', '100 stars']) {
        await harness.sendText(buyer1, bad);
        assert.ok(
          harness.lastUiCall()!.text.includes('Некорректное количество'),
          `Ожидался отказ для ввода ${JSON.stringify(bad)}`,
        );
        assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);
      }

      // 3. Ручной ввод 750 Stars -> автоматический расчёт $15.00 (750 * $0.02) и выбор получателя
      await harness.sendText(buyer1, '750');
      const rcptPrompt = harness.lastUiCall()!;
      assert.ok(rcptPrompt.text.includes('Покупка Telegram Stars'));
      assert.ok(rcptPrompt.text.includes('Количество: <b>750 ⭐</b>'));
      assert.ok(rcptPrompt.text.includes('Цена за 1 ⭐: <code>$0.02</code>'));
      assert.ok(rcptPrompt.text.includes('$15.00'));
      assert.ok(rcptPrompt.text.includes('Выберите получателя'));
      assert.ok(rcptPrompt.callbacks.includes('rcpt_self'));

      await harness.sendText(buyer1, '@Friend_Star');
      const confirmCard = harness.lastUiCall()!;
      assert.ok(confirmCard.text.includes('Подтверждение заказа'));
      assert.ok(confirmCard.text.includes('750 ⭐'));
      assert.ok(confirmCard.text.includes('$0.02'));
      assert.ok(confirmCard.text.includes('@friend_star'));
      assert.ok(confirmCard.text.includes('$15.00'));

      // 4. Граничные значения при редактировании: минимум 50 ($1.00) и максимум 100000 ($2000.00)
      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'checkout:edit_qty');
      assert.deepEqual(harness.lastUiCall()!.callbacks, ['checkout:back_confirm', 'checkout:cancel']);
      await harness.sendText(buyer1, '50');
      const confirmMin = harness.lastUiCall()!;
      assert.ok(confirmMin.text.includes('50 ⭐'));
      assert.ok(confirmMin.text.includes('$1.00'));
      assert.ok(confirmMin.text.includes('@friend_star'));

      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'checkout:edit_qty');
      await harness.sendText(buyer1, '100000');
      const confirmMax = harness.lastUiCall()!;
      assert.ok(confirmMax.text.includes('100000 ⭐'));
      assert.ok(confirmMax.text.includes('$2000.00'));

      // 5. Устаревший callback пресета stars:qty:250 больше не обрабатывается и не создаёт заказ
      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'stars:qty:250');
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      return 'Удаление быстрых пресетов, ручной ввод 50..100000 ($0.02/Star), расчёт 750->$15.00 и граничные проверки подтверждены.';
    },
  );

  await runTest(
    'S424-02',
    'Payments',
    'Улучшенный выбор Telegram Premium: 3 тарифа, quantity=1, покупка себе/другому, отказ некорректных сроков',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();

      await harness.sendCallback(buyer1, 'cat:premium');
      const premList = harness.lastUiCall()!;
      assert.ok(premList.text.includes('3 месяца') && premList.text.includes('$13.90'));
      assert.ok(premList.text.includes('6 месяцев') && premList.text.includes('$19.90'));
      assert.ok(premList.text.includes('12 месяцев') && premList.text.includes('$34.90'));

      // Выбор 3 месяца ($13.90) -> явно показывает срок, quantity=1, сумму и кнопки «Купить себе» / Назад
      await harness.sendCallback(buyer1, 'prem:select:premium_3m');
      const rcptUi = harness.lastUiCall()!;
      assert.ok(rcptUi.text.includes('Telegram Premium — 3 мес.'));
      assert.ok(rcptUi.text.includes('Количество: <b>1</b>'));
      assert.ok(rcptUi.text.includes('$13.90'));
      assert.ok(rcptUi.callbacks.includes('rcpt_self'));

      await harness.sendCallback(buyer1, 'rcpt_self');
      const confirmUi = harness.lastUiCall()!;
      assert.ok(confirmUi.text.includes('Подтверждение заказа'));
      assert.ok(confirmUi.text.includes('3 мес.'));
      assert.ok(confirmUi.text.includes('Количество: <b>1</b>'));
      assert.ok(confirmUi.text.includes('$13.90'));
      assert.ok(confirmUi.text.includes(`@${buyer1.username!.toLowerCase()}`));
      assert.equal((await OrderService.getUserOrders(buyer1.id)).length, 0);

      // Попытка выбрать несуществующие/некорректные сроки отклоняется
      for (const badId of ['prem:select:premium_9m', 'prem:select:premium_24m', 'prem:select:gift_star_box']) {
        clearCallbackDebounceMap();
        await harness.sendCallback(buyer1, badId);
        assert.ok(harness.lastAnswer()?.text?.includes('временно недоступен'));
      }

      return 'Выбор 3/6/12 месяцев Premium ($13.90/$19.90/$34.90), quantity=1 и блокировка некорректных сроков подтверждены.';
    },
  );

  await runTest(
    'S424-03',
    'Database',
    'Безопасная неперезаписывающая миграция Firestore при непустом каталоге и диагностика/восстановление в админке',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);

      // 1. Симулируем живую БД с уже существующими старыми товарами, где отсутствуют premium_3m/6m/12m и stars_custom
      await firestoreRepo.deleteDoc('products', 'stars_custom');
      await firestoreRepo.deleteDoc('products', 'premium_3m');
      await firestoreRepo.deleteDoc('products', 'premium_6m');
      await firestoreRepo.deleteDoc('products', 'premium_12m');
      await firestoreRepo.updateDoc<Product>('products', 'stars_pack_50', {
        name: 'Legacy Custom Pack 50',
        priceUsdCents: 111,
        price: 111,
      });
      const legacySnapshotBefore = await ProductService.getProductById('stars_pack_50');

      const buyerHarness = createWiredBotHarness(false);
      await buyerHarness.sendCallback(buyer1, 'cat:premium');
      assert.ok(buyerHarness.lastUiCall()!.text.includes('временно недоступен'));

      // 2. Запуск безопасной миграции создаёт ТОЛЬКО отсутствующие канонические товары и НЕ трогает legacy товары
      const migrationRes = await firestoreRepo.ensureMissingCanonicalCatalogProducts();
      assert.deepEqual(migrationRes.createdIds, [
        'stars_custom',
        'premium_3m',
        'premium_6m',
        'premium_12m',
      ]);
      const legacySnapshotAfter = await ProductService.getProductById('stars_pack_50');
      assert.equal(legacySnapshotAfter?.name, 'Legacy Custom Pack 50');
      assert.equal(legacySnapshotAfter?.priceUsdCents, 111);
      assert.equal(legacySnapshotAfter?.updatedAt, legacySnapshotBefore?.updatedAt);

      // Теперь Premium у покупателя сразу работает!
      clearCallbackDebounceMap();
      await buyerHarness.sendCallback(buyer1, 'cat:premium');
      const premActiveUi = buyerHarness.lastUiCall()!;
      assert.deepEqual(premActiveUi.callbacks, [
        'prem:select:premium_3m',
        'prem:select:premium_6m',
        'prem:select:premium_12m',
        'menu:home',
      ]);

      // 3. Проверка админ-панели: если один тариф отключён (isActive=false), а другой удалён:
      //    adm:restore_canonical создаёт ТОЛЬКО удалённый документ и НЕ перезаписывает существующий отключённый!
      await firestoreRepo.updateDoc<Product>('products', 'premium_6m', { isActive: false });
      await firestoreRepo.deleteDoc('products', 'premium_12m');

      const adminUser = { id: 777000111, username: 'quizystars_admin', first_name: 'Admin' };
      const adminHarness = createWiredBotHarness(true);
      await adminHarness.sendCallback(adminUser, 'adm:products');
      const admProductsUi = adminHarness.lastUiCall()!;
      assert.ok(admProductsUi.callbacks.includes('adm:restore_canonical'));
      assert.ok(admProductsUi.text.includes('premium_6m'));
      assert.ok(admProductsUi.text.includes('premium_12m'));

      clearCallbackDebounceMap();
      await adminHarness.sendCallback(adminUser, 'adm:restore_canonical');
      const restored12 = await ProductService.getProductById('premium_12m');
      const untouched6 = await ProductService.getProductById('premium_6m');
      assert.ok(restored12 && restored12.isActive && restored12.durationMonths === 12 && restored12.priceUsdCents === 3490);
      assert.equal(untouched6?.isActive, false); // Не перезаписан!

      // Включаем premium_6m в админ-панели через adm:prod -> adm:ptoggle -> покупатель снова видит все 3 тарифа
      clearCallbackDebounceMap();
      await adminHarness.sendCallback(adminUser, 'adm:prod:premium_6m');
      assert.ok(adminHarness.lastUiCall()!.text.includes('Предупреждение каталога'));
      clearCallbackDebounceMap();
      await adminHarness.sendCallback(adminUser, 'adm:ptoggle:premium_6m');
      assert.equal((await ProductService.getProductById('premium_6m'))?.isActive, true);

      clearCallbackDebounceMap();
      await buyerHarness.sendCallback(buyer1, 'cat:premium');
      assert.deepEqual(buyerHarness.lastUiCall()!.callbacks, [
        'prem:select:premium_3m',
        'prem:select:premium_6m',
        'prem:select:premium_12m',
        'menu:home',
      ]);

      // 4. Создание нового Premium-товара через админский мастер с выбором фиксированного срока
      clearCallbackDebounceMap();
      await adminHarness.sendCallback(adminUser, 'adm:addcat:premium');
      assert.deepEqual(adminHarness.lastUiCall()!.callbacks, [
        'adm:addprem_dur:3',
        'adm:addprem_dur:6',
        'adm:addprem_dur:12',
        'adm:products',
      ]);
      await adminHarness.sendCallback(adminUser, 'adm:addprem_dur:6');
      await adminHarness.sendText(adminUser, 'Promo Premium 6M');
      await adminHarness.sendText(adminUser, 'Описание промо тарифа');
      await adminHarness.sendText(adminUser, '19.90');
      assert.ok(adminHarness.lastUiCall()!.text.includes('Promo Premium 6M'));
      assert.ok(adminHarness.lastUiCall()!.text.includes('6 мес.'));

      return 'Безопасная миграция отсутствующих документов, сохранение существующих товаров/цен, админ-диагностика и мастер создания Premium подтверждены.';
    },
  );

  await runTest(
    'S424-04',
    'Fulfillment',
    'Команда /paysupport и кнопка menu:paysupport открывают поддержку по платежам и сбрасывают активные сессии',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      clearAllUserInteractiveSessions(buyer1.id);
      const harness = createWiredBotHarness();

      await harness.sendCallback(buyer1, 'cat:stars');
      assert.equal(getUserCheckoutSession(buyer1.id)?.mode, 'stars_qty');

      await harness.sendText(buyer1, '/paysupport');
      assert.equal(getUserCheckoutSession(buyer1.id), undefined);
      const supportUi = harness.lastUiCall()!;
      assert.ok(supportUi.text.includes('Поддержка по платежам QuizyStars'));
      assert.ok(supportUi.text.includes('/orders'));
      assert.deepEqual(supportUi.callbacks, ['menu:orders', 'menu:home']);

      // Переход через меню «Поддержка» -> «Поддержка по платежам»
      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'menu:support');
      assert.deepEqual(harness.lastUiCall()!.callbacks, ['menu:paysupport', 'menu:home']);

      clearCallbackDebounceMap();
      await harness.sendCallback(buyer1, 'menu:paysupport');
      assert.ok(harness.lastUiCall()!.text.includes('Поддержка по платежам QuizyStars'));
      assert.deepEqual(harness.lastUiCall()!.callbacks, ['menu:orders', 'menu:home']);

      // Активная админская текстовая сессия также сбрасывается при /paysupport
      const adminUser = { id: 777000111, username: 'quizystars_admin', first_name: 'Admin' };
      const adminHarness = createWiredBotHarness(true);
      clearCallbackDebounceMap();
      await adminHarness.sendCallback(adminUser, 'adm:pprice:premium_3m');
      await adminHarness.sendText(adminUser, '/paysupport');
      assert.ok(adminHarness.lastUiCall()!.text.includes('Поддержка по платежам QuizyStars'));

      return 'Команда /paysupport и переход menu:support -> menu:paysupport открывают поддержку и корректно сбрасывают пользовательскую и админскую сессии.';
    },
  );

  await runTest(
    'S44-01',
    'Fulfillment',
    'MyStars FaaS v1: нормализация URL, валидация параметров, GET /v1/pricing и pre-check получателя (POST /v1/recipients/check) перед созданием заказа, счёта и списанием баланса',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      assert.equal(buildMyStarsApiV1Url('https://api.mystars.tg', '/orders'), 'https://api.mystars.tg/v1/orders');
      assert.equal(buildMyStarsApiV1Url('https://api.mystars.tg/v1/', 'pricing?type=stars&quantity=50'), 'https://api.mystars.tg/v1/pricing?type=stars&quantity=50');
      assert.equal(validateMyStarsUsername('  @Alice_Test99  '), 'alice_test99');
      assert.throws(() => validateMyStarsUsername('ab'), /Некорректный формат Telegram @username/);
      assert.equal(validateMyStarsQuantity(250), 250);
      assert.throws(() => validateMyStarsQuantity(49), /от 50 до 100000/);
      assert.throws(() => validateMyStarsQuantity(100001), /от 50 до 100000/);
      assert.equal(validateMyStarsMonths(6), 6);
      assert.throws(() => validateMyStarsMonths(1), /3, 6 или 12/);
      assert.equal(usdtDecimalToUsdCents('0.685'), 69);
      assert.equal(usdtDecimalToUsdCents('12.50'), 1250);

      const capturedRequests: HttpTransportRequest[] = [];
      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_live_test_key_4401',
        apiBaseUrl: 'https://api.mystars.tg',
      });

      try {
        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          capturedRequests.push(req);
          assert.equal(req.headers['X-Api-Key'], 'ms_live_test_key_4401');

          if (req.url.includes('/v1/pricing')) {
            return {
              status: 200,
              ok: true,
              json: {
                type: 'stars',
                quantity: 100,
                amount: '1.37',
                currency: 'usdt_ton',
                fee: {
                  subtotal: '1.35',
                  processing_fee: '0.02',
                  total: '1.37',
                  description: 'TON swap + network fee',
                  currency: 'usdt_ton',
                  kind: 'swap',
                },
                usdt_per_ton: '5.37',
              },
            };
          }

          if (req.url.endsWith('/v1/recipients/check')) {
            const payload = JSON.parse(req.body || '{}');
            const targetUser = payload.recipient?.username || payload.username;
            if (targetUser === 'nonexistent_user') {
              return {
                status: 200,
                ok: true,
                json: {
                  username: 'nonexistent_user',
                  type: payload.type,
                  resolved: false,
                  eligible: false,
                  reason: 'not_found',
                },
              };
            }
            if (targetUser === 'already_prem_user' && payload.type === 'premium') {
              return {
                status: 200,
                ok: true,
                json: {
                  username: 'already_prem_user',
                  type: 'premium',
                  resolved: true,
                  eligible: false,
                  reason: 'already_subscribed',
                  recipient_name: 'Already Prem',
                },
              };
            }
            if (targetUser === 'indeterminate_user') {
              return {
                status: 200,
                ok: true,
                json: {
                  username: 'indeterminate_user',
                  type: payload.type,
                  resolved: false,
                  eligible: false,
                  indeterminate: true,
                  reason: 'fragment_timeout',
                },
              };
            }
            return {
              status: 200,
              ok: true,
              json: {
                username: targetUser,
                type: payload.type,
                resolved: true,
                eligible: true,
                recipient_name: 'Valid Buyer',
              },
            };
          }

          throw new Error(`Unexpected URL in S44-01: ${req.url}`);
        });

        const quote = await myStarsClient.getPricing({ type: 'stars', quantity: 100 });
        assert.equal(quote.amount, '1.37');
        assert.equal(quote.fee?.total, '1.37');

        // 1. Несуществующий получатель блокируется ДО создания заказа в OrderService.createOrder
        await assert.rejects(
          () =>
            OrderService.createOrder({
              telegramUser: buyer1,
              recipientUsername: 'nonexistent_user',
              productId: 'stars_custom',
              quantity: 100,
            }),
          (err: unknown) =>
            err instanceof MyStarsRecipientIneligibleError &&
            err.message.includes('@nonexistent_user не найден'),
        );

        // 2. Получатель с уже активным Premium блокируется ДО списания внутреннего баланса
        const bs = new BalanceService(new PaymentProviderGateway());
        await UserService.upsertFromTelegram(buyer2);
        await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer2.id}`, {
          balanceUsdCents: 5000,
          balance: 50,
        });

        await assert.rejects(
          () =>
            bs.purchaseWithInternalBalance({
              telegramId: buyer2.id,
              recipientUsername: 'already_prem_user',
              productId: 'premium_3m',
            }),
          (err: unknown) =>
            err instanceof MyStarsRecipientIneligibleError &&
            err.message.includes('уже активна подписка Telegram Premium'),
        );
        // Баланс не списан!
        assert.equal(await bs.getBalanceUsdCents(buyer2.id), 5000);

        // 3. При indeterminate: true pre-check fail-open разрешает создание заказа
        const indeterminateOrder = await OrderService.createOrder({
          telegramUser: buyer1,
          recipientUsername: 'indeterminate_user',
          productId: 'stars_custom',
          quantity: 75,
        });
        assert.equal(indeterminateOrder.recipientUsername, 'indeterminate_user');
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
      }

      return `MyStars FaaS v1 pre-check и pricing протестированы (${capturedRequests.length} HTTP-вызовов, баланс защищён от списания при ineligible получателе).`;
    },
  );

  await runTest(
    'S44-02',
    'Fulfillment',
    'Автовыдача Telegram Stars и Telegram Premium через MyStarsFulfillmentAdapter: delivered с расчётом оптовой себестоимости P&L и awaiting_payment без дубликатов',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      FulfillmentService.resetAdapterToDefault();

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      const orderCalls: Array<{ idempotencyKey: string; body: Record<string, unknown> }> = [];
      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_live_test_key_4402',
        apiBaseUrl: 'https://api.mystars.tg/v1',
      });
      assert.equal(myStarsClient.isConfigured(), true);
      assert.equal(myStarsClient.getStatusSummary().mode, 'polling');

      try {
        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          if (req.url.endsWith('/v1/recipients/check')) {
            const body = JSON.parse(req.body || '{}');
            const targetUser = body.recipient?.username || body.username;
            return {
              status: 200,
              ok: true,
              json: {
                username: targetUser,
                type: body.type,
                resolved: true,
                eligible: true,
              },
            };
          }

          if (req.url.endsWith('/v1/orders') && req.method === 'POST') {
            const body = JSON.parse(req.body || '{}');
            const targetUser = body.recipient?.username || body.recipient_username;
            orderCalls.push({
              idempotencyKey: req.headers['Idempotency-Key'] || '',
              body,
            });

            if (body.type === 'stars') {
              return {
                status: 200,
                ok: true,
                json: {
                  id: 'ms_ord_stars_delivered_1',
                  type: 'stars',
                  recipient_username: targetUser,
                  quantity: body.quantity,
                  months: null,
                  currency: 'usdt_ton',
                  fragment_cost_ton: '0.26',
                  fragment_cost_usdt: '1.38',
                  service_fee_usdt: '0.02',
                  payment_amount: '1.40',
                  pay_to_address: 'UQMyStarsPoolAddress111',
                  payment_memo: 'MS-STARS-1',
                  status: 'delivered',
                  purchase_tx: 'tx_hash_stars_delivered_001',
                  created_at: new Date().toISOString(),
                },
              };
            }

            // Premium returns awaiting_payment first
            return {
              status: 200,
              ok: true,
              json: {
                id: 'ms_ord_prem_awaiting_1',
                type: 'premium',
                recipient_username: targetUser,
                quantity: null,
                months: body.months,
                currency: 'usdt_ton',
                fragment_cost_ton: '2.10',
                fragment_cost_usdt: '11.20',
                service_fee_usdt: '0.15',
                payment_amount: '11.35',
                pay_to_address: 'UQMyStarsPoolAddress222',
                payment_memo: 'MS-PREM-2',
                status: 'awaiting_payment',
                expires_at: new Date(Date.now() + 900_000).toISOString(),
                created_at: new Date().toISOString(),
              },
            };
          }

          if (req.url.endsWith('/v1/orders/ms_ord_prem_awaiting_1') && req.method === 'GET') {
            return {
              status: 200,
              ok: true,
              json: {
                id: 'ms_ord_prem_awaiting_1',
                type: 'premium',
                recipient_username: 'prem_buyer',
                months: 3,
                currency: 'usdt_ton',
                payment_amount: '11.35',
                pay_to_address: 'UQMyStarsPoolAddress222',
                payment_memo: 'MS-PREM-2',
                status: 'purchasing',
                created_at: new Date().toISOString(),
              },
            };
          }

          throw new Error(`Unexpected MyStars request in S44-02: ${req.method} ${req.url}`);
        });

        // 1. Покупка 100 Stars с внутреннего баланса -> MyStars мгновенно возвращает status: "delivered"
        const bs = new BalanceService(new PaymentProviderGateway());
        await UserService.upsertFromTelegram(buyer1);
        await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
          balanceUsdCents: 5000,
          balance: 50,
        });

        const starsPurchase = await bs.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          recipientUsername: 'stars_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });

        await FulfillmentService.initiateFulfillment(starsPurchase.order, mockBot);
        const completedStarsOrder = (await OrderService.getOrderById(starsPurchase.order.orderId))!;
        assert.equal(completedStarsOrder.fulfillmentStatus, 'completed');
        assert.equal(completedStarsOrder.mystarsOrderId, 'ms_ord_stars_delivered_1');
        assert.equal(completedStarsOrder.mystarsOrderStatus, 'delivered');
        assert.equal(completedStarsOrder.mystarsPurchaseTx, 'tx_hash_stars_delivered_001');
        assert.equal(completedStarsOrder.mystarsWholesaleCostUsdt, '1.40');
        assert.equal(completedStarsOrder.mystarsCostUsdCents, 140);
        // Retail 100 * $0.02 = $2.00 (200 cents) - Wholesale $1.40 (140 cents) = +$0.60 (60 cents) net profit
        assert.equal(completedStarsOrder.totalPriceUsdCents, 200);
        assert.equal(completedStarsOrder.netProfitUsdCents, 60);
        assert.equal(orderCalls[0].idempotencyKey, `fulfill_${completedStarsOrder.orderId}`);
        // В режиме Polling-Only callback_url не передаётся в POST /v1/orders
        assert.equal('callback_url' in orderCalls[0].body, false);

        // 2. Покупка Premium 3 мес. -> MyStars возвращает status: "awaiting_payment" -> заказ остаётся в processing
        const premPurchase = await bs.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          recipientUsername: 'prem_buyer',
          productId: 'premium_3m',
        });

        await FulfillmentService.initiateFulfillment(premPurchase.order, mockBot);
        const processingPremOrder = (await OrderService.getOrderById(premPurchase.order.orderId))!;
        assert.equal(processingPremOrder.fulfillmentStatus, 'processing');
        assert.equal(processingPremOrder.mystarsOrderId, 'ms_ord_prem_awaiting_1');
        assert.equal(processingPremOrder.mystarsOrderStatus, 'awaiting_payment');
        assert.equal(processingPremOrder.mystarsPayToAddress, 'UQMyStarsPoolAddress222');
        assert.equal(processingPremOrder.mystarsPaymentMemo, 'MS-PREM-2');
        assert.equal(processingPremOrder.mystarsPaymentAmountUsdt, '11.35');
        assert.equal(processingPremOrder.mystarsCostUsdCents, 1135);

        // Повторный вызов адаптера с уже существующим mystarsOrderId делает GET /v1/orders/{id}, а НЕ создаёт дубль POST /v1/orders
        const postCallsBefore = orderCalls.length;
        const adapter = new MyStarsFulfillmentAdapter(myStarsClient);
        const recheckRes = await adapter.requestFulfillment(processingPremOrder);
        assert.equal(orderCalls.length, postCallsBefore);
        assert.equal(recheckRes.handledAutomatically, false);
        assert.equal((await OrderService.getOrderById(processingPremOrder.orderId))?.mystarsOrderStatus, 'purchasing');
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
      }

      return 'Автовыдача Stars (delivered + расчёт P&L) и Premium (awaiting_payment -> purchasing без дублирования POST /v1/orders) подтверждены.';
    },
  );

  await runTest(
    'S44-03',
    'Fulfillment',
    'MyStars FaaS v1 (Polling-Only): работа без MYSTARS_WEBHOOK_SECRET и MYSTARS_CALLBACK_URL, автопроверка статусов GET /v1/orders/{id}, защита от дублей и продолжение polling после перезапуска',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      FulfillmentService.resetAdapterToDefault();
      FulfillmentService.resetMyStarsPollingState();

      const prevWebhookSecret = process.env.MYSTARS_WEBHOOK_SECRET;
      const prevCallbackUrl = process.env.MYSTARS_CALLBACK_URL;
      delete process.env.MYSTARS_WEBHOOK_SECRET;
      delete process.env.MYSTARS_CALLBACK_URL;

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      // Проверка, что конфигурация и статус сервера не зависят от MYSTARS_WEBHOOK_SECRET и MYSTARS_CALLBACK_URL
      const envCfg = getEnvConfig();
      assert.equal(envCfg.mystarsWebhookSecret, undefined);
      assert.equal(envCfg.mystarsCallbackUrl, undefined);

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_live_test_key_4403',
        apiBaseUrl: 'https://api.mystars.tg/v1',
      });
      const prevRetries = myStarsClient.maxTransientGetRetries;
      myStarsClient.maxTransientGetRetries = 0;

      let order1PollCount = 0;
      let order2PollCount = 0;
      let order3PollCount = 0;

      try {
        const statusText = renderPlainTextStatus();
        assert.ok(statusText.includes('MyStars FaaS v1 (Polling)'));
        assert.equal(statusText.includes('/webhook/mystars'), false);

        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          if (req.url.endsWith('/v1/recipients/check')) {
            return {
              status: 200,
              ok: true,
              json: { username: 'poll_buyer', type: 'premium', resolved: true, eligible: true },
            };
          }
          if (req.url.endsWith('/v1/orders/ms_ord_poll_1') && req.method === 'GET') {
            order1PollCount += 1;
            const currentStatus =
              order1PollCount === 1
                ? 'purchasing'
                : 'delivered';
            return {
              status: 200,
              ok: true,
              json: {
                id: 'ms_ord_poll_1',
                type: 'premium',
                recipient_username: 'poll_buyer',
                months: 6,
                currency: 'usdt_ton',
                payment_amount: '18.50',
                status: currentStatus,
                purchase_tx: currentStatus === 'delivered' ? 'tx_poll_delivered_777' : null,
                created_at: new Date().toISOString(),
              },
            };
          }
          if (req.url.endsWith('/v1/orders/ms_ord_poll_fail_2') && req.method === 'GET') {
            order2PollCount += 1;
            return {
              status: 200,
              ok: true,
              json: {
                id: 'ms_ord_poll_fail_2',
                type: 'stars',
                recipient_username: 'poll_buyer',
                quantity: 500,
                currency: 'usdt_ton',
                payment_amount: '6.80',
                status: 'reversed',
                failure_reason: 'payment_reversed_by_fragment',
                created_at: new Date().toISOString(),
              },
            };
          }
          if (req.url.endsWith('/v1/orders/ms_ord_restart_3') && req.method === 'GET') {
            order3PollCount += 1;
            return {
              status: 200,
              ok: true,
              json: {
                id: 'ms_ord_restart_3',
                type: 'stars',
                recipient_username: 'poll_buyer',
                quantity: 100,
                currency: 'usdt_ton',
                payment_amount: '1.36',
                status: 'delivered',
                purchase_tx: 'tx_after_restart_333',
                created_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected URL in S44-03: ${req.method} ${req.url}`);
        });

        // 1. Заказ 1 (awaiting_payment -> purchasing -> delivered)
        const order1 = await OrderService.createOrder({
          telegramUser: buyer1,
          recipientUsername: 'poll_buyer',
          productId: 'premium_6m',
        });
        await firestoreRepo.updateDoc<Order>('orders', order1.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          mystarsOrderId: 'ms_ord_poll_1',
          mystarsOrderStatus: 'awaiting_payment',
        });

        // Первый проход polling: статус обновился на purchasing, заказ всё ещё processing
        const pass1 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(pass1.polled, 1);
        assert.equal(pass1.stillProcessing, 1);
        assert.equal(pass1.completed, 0);
        const midOrder1 = (await OrderService.getOrderById(order1.orderId))!;
        assert.equal(midOrder1.fulfillmentStatus, 'processing');
        assert.equal(midOrder1.mystarsOrderStatus, 'purchasing');
        assert.ok(midOrder1.mystarsLastPolledAt);
        assert.equal(midOrder1.mystarsPollAttempts, 1);

        // Второй проход polling: статус стал delivered -> завершение, расчёт P&L и уведомление покупателю
        const pass2 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(pass2.polled, 1);
        assert.equal(pass2.completed, 1);
        const completedOrder1 = (await OrderService.getOrderById(order1.orderId))!;
        assert.equal(completedOrder1.fulfillmentStatus, 'completed');
        assert.equal(completedOrder1.mystarsOrderStatus, 'delivered');
        assert.equal(completedOrder1.mystarsPurchaseTx, 'tx_poll_delivered_777');
        assert.equal(completedOrder1.mystarsCostUsdCents, 1850);
        assert.equal(
          completedOrder1.netProfitUsdCents,
          (completedOrder1.totalPriceUsdCents ?? completedOrder1.totalPrice) - 1850,
        );
        const buyerMsgsAfterFirstComplete = sentMessages.filter(
          (m) => Number(m.chatId) === buyer1.id && m.text.includes('выполнен!'),
        ).length;
        assert.equal(buyerMsgsAfterFirstComplete, 1);

        // Третий проход polling + повторный completeOrder: защита от повторной обработки и повторной выдачи
        const pollCountBeforeDup = order1PollCount;
        const pass3 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(pass3.polled, 0);
        assert.equal(order1PollCount, pollCountBeforeDup);
        await FulfillmentService.completeOrder({ orderId: order1.orderId, bot: mockBot });
        const buyerMsgsAfterDup = sentMessages.filter(
          (m) => Number(m.chatId) === buyer1.id && m.text.includes('выполнен!'),
        ).length;
        assert.equal(buyerMsgsAfterDup, 1);

        // 2. Заказ 2 (терминальный статус reversed -> failed + needsManualReconciliation + алерт админу 1 раз)
        const order2 = await OrderService.createOrder({
          telegramUser: buyer2,
          recipientUsername: 'poll_buyer',
          productId: 'stars_custom',
          quantity: 500,
        });
        await firestoreRepo.updateDoc<Order>('orders', order2.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          mystarsOrderId: 'ms_ord_poll_fail_2',
          mystarsOrderStatus: 'fulfilling',
        });

        const failPass = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(failPass.failed, 1);
        const failedOrder2 = (await OrderService.getOrderById(order2.orderId))!;
        assert.equal(failedOrder2.fulfillmentStatus, 'failed');
        assert.equal(failedOrder2.needsManualReconciliation, true);
        assert.equal(failedOrder2.mystarsOrderStatus, 'reversed');
        const adminAlerts = sentMessages.filter(
          (m) => String(m.chatId) === '777000111' && m.text.includes('СБОЙ АВТОВЫДАЧИ MYSTARS'),
        );
        assert.equal(adminAlerts.length, 1);

        // Повторный проход не обрабатывает failed заказ повторно
        await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(order2PollCount, 1);

        // 3. Имитация перезапуска бота: в БД остался незавершённый заказ в processing,
        // внутренние in-memory состояния воркера сброшены -> стартовый проход recoverPendingFulfillments завершает заказ
        const order3 = await OrderService.createOrder({
          telegramUser: buyer2,
          recipientUsername: 'poll_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', order3.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          mystarsOrderId: 'ms_ord_restart_3',
          mystarsOrderStatus: 'awaiting_payment',
        });

        FulfillmentService.stopRecoveryWorker();
        FulfillmentService.resetMyStarsPollingState();

        const recoveredAfterRestart = await FulfillmentService.recoverPendingFulfillments(mockBot);
        assert.ok(recoveredAfterRestart.some((o) => o.orderId === order3.orderId));
        assert.equal(order3PollCount, 1);
        const finalOrder3 = (await OrderService.getOrderById(order3.orderId))!;
        assert.equal(finalOrder3.fulfillmentStatus, 'completed');
        assert.equal(finalOrder3.mystarsOrderStatus, 'delivered');
        assert.equal(finalOrder3.mystarsPurchaseTx, 'tx_after_restart_333');
      } finally {
        myStarsClient.maxTransientGetRetries = prevRetries;
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
        if (prevWebhookSecret !== undefined) process.env.MYSTARS_WEBHOOK_SECRET = prevWebhookSecret;
        if (prevCallbackUrl !== undefined) process.env.MYSTARS_CALLBACK_URL = prevCallbackUrl;
      }

      return 'MyStars Polling-Only: работа без webhook-переменных, многошаговый polling, анти-дубликат и продолжение после перезапуска подтверждены.';
    },
  );

  await runTest(
    'S44-04',
    'Fulfillment',
    'Устойчивость MyStars Polling: обработка 429 (general с Retry-After cooldown vs order_cap), таймаутов сети и HTTP 5xx без потери заказа',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      FulfillmentService.resetAdapterToDefault();
      FulfillmentService.resetMyStarsPollingState();

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      // Проверка парсера Retry-After (секунды и HTTP-date)
      assert.equal(parseRetryAfterSeconds('12'), 12);
      assert.equal(parseRetryAfterSeconds('0.05'), 0.05);
      const futureHttpDate = new Date(Date.now() + 10_000).toUTCString();
      const parsedDateSec = parseRetryAfterSeconds(futureHttpDate);
      assert.ok(parsedDateSec !== undefined && parsedDateSec >= 8 && parsedDateSec <= 12);

      let postAttempt = 0;
      let pollGetAttempt = 0;
      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_live_test_key_4404',
        apiBaseUrl: 'https://api.mystars.tg/v1',
      });
      const prevRetries = myStarsClient.maxTransientGetRetries;
      myStarsClient.maxTransientGetRetries = 0;

      try {
        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          if (req.url.endsWith('/v1/recipients/check')) {
            return {
              status: 200,
              ok: true,
              json: { username: 'cap_buyer', type: 'stars', resolved: true, eligible: true },
            };
          }
          if (req.url.endsWith('/v1/orders') && req.method === 'POST') {
            postAttempt += 1;
            if (postAttempt === 1) {
              // 429 general rate limit -> retryable
              return {
                status: 429,
                ok: false,
                headers: { 'retry-after': '0.02' },
                json: {
                  error: 'rate limit exceeded',
                  limit_type: 'general',
                  retry_after: 0.02,
                },
              };
            }
            // 429 order_cap (10 active unpaid orders) -> non-retryable permanent error
            return {
              status: 429,
              ok: false,
              json: {
                error: 'too many unpaid orders (max 10)',
                limit_type: 'order_cap',
                retry_after: 60,
              },
            };
          }
          if (req.url.endsWith('/v1/orders/ms_ord_resilient_poll_1') && req.method === 'GET') {
            pollGetAttempt += 1;
            if (pollGetAttempt === 1) {
              // 1-я попытка polling: сетевой таймаут
              throw new MyStarsTransportError('Таймаут запроса к MyStars API (15000 мс)', true);
            }
            if (pollGetAttempt === 2) {
              // 2-я попытка polling: временная ошибка сервера 503
              return {
                status: 503,
                ok: false,
                json: { error: 'upstream temporarily unavailable' },
              };
            }
            if (pollGetAttempt === 3) {
              // 3-я попытка polling: 429 general с Retry-After 0.06с -> включает cooldown
              return {
                status: 429,
                ok: false,
                headers: { 'retry-after': '0.06' },
                json: {
                  error: 'too many requests',
                  limit_type: 'general',
                  retry_after: 0.06,
                },
              };
            }
            // 4-я попытка после окончания cooldown: заказ успешно доставлен
            return {
              status: 200,
              ok: true,
              json: {
                id: 'ms_ord_resilient_poll_1',
                type: 'stars',
                recipient_username: 'cap_buyer',
                quantity: 100,
                currency: 'usdt_ton',
                payment_amount: '1.38',
                status: 'delivered',
                purchase_tx: 'tx_resilient_poll_recovered_999',
                created_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected URL in S44-04: ${req.method} ${req.url}`);
        });

        // 1. Проверка 429 general (retryable) -> затем 429 order_cap (non-retryable) при POST /v1/orders
        const capOrder = await OrderService.createOrder({
          telegramUser: buyer1,
          recipientUsername: 'cap_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', capOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        });

        await assert.rejects(
          () => FulfillmentService.initiateFulfillment(capOrder, mockBot),
          (err: unknown) => err instanceof MyStarsRateLimitError && err.kind === 'general' && err.retryable === true,
        );
        const afterGeneral429 = (await OrderService.getOrderById(capOrder.orderId))!;
        assert.equal(afterGeneral429.needsManualReconciliation, false);
        assert.ok(afterGeneral429.fulfillmentNextRetryAt);

        // Повторный вызов после короткого backoff получает 429 order_cap (retryable: false)
        await firestoreRepo.updateDoc<Order>('orders', capOrder.orderId, {
          fulfillmentNextRetryAt: new Date(Date.now() - 1000).toISOString(),
        });
        await assert.rejects(
          () => FulfillmentService.initiateFulfillment(afterGeneral429, mockBot),
          (err: unknown) => err instanceof MyStarsRateLimitError && err.kind === 'order_cap' && err.retryable === false,
        );
        assert.equal(postAttempt, 2);
        const failedCapOrder = (await OrderService.getOrderById(capOrder.orderId))!;
        assert.equal(failedCapOrder.fulfillmentStatus, 'failed');
        assert.equal(failedCapOrder.needsManualReconciliation, true);
        assert.ok(failedCapOrder.fulfillmentLastError?.includes('order_cap'));

        // 2. Проверка устойчивости polling к таймауту, HTTP 503 и 429 general с Retry-After cooldown
        const resilientOrder = await OrderService.createOrder({
          telegramUser: buyer2,
          recipientUsername: 'cap_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', resilientOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          mystarsOrderId: 'ms_ord_resilient_poll_1',
          mystarsOrderStatus: 'fulfilling',
        });

        // Попытка 1: таймаут -> заказ НЕ падает, остаётся в processing
        const timeoutPass = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(timeoutPass.transientErrors, 1);
        assert.equal((await OrderService.getOrderById(resilientOrder.orderId))?.fulfillmentStatus, 'processing');
        assert.ok((await OrderService.getOrderById(resilientOrder.orderId))?.mystarsLastPollError?.includes('Таймаут'));

        // Попытка 2: HTTP 503 -> заказ остаётся в processing
        const serverErrPass = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(serverErrPass.transientErrors, 1);
        assert.equal((await OrderService.getOrderById(resilientOrder.orderId))?.fulfillmentStatus, 'processing');

        // Попытка 3: 429 general -> включает глобальный cooldown, заказ остаётся в processing
        const rateLimitPass = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(rateLimitPass.rateLimited, true);
        assert.equal(FulfillmentService.getMyStarsPollingStatus().cooldownActive, true);
        assert.equal((await OrderService.getOrderById(resilientOrder.orderId))?.fulfillmentStatus, 'processing');

        // Немедленный повторный вызов во время cooldown НЕ бьёт в API
        const deferredPass = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(deferredPass.deferredByCooldown, true);
        assert.equal(deferredPass.polled, 0);
        assert.equal(pollGetAttempt, 3);

        // Ждём истечения Retry-After (70ms) -> polling возобновляется и завершает заказ
        await new Promise((resolve) => setTimeout(resolve, 80));
        const finalPass = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(finalPass.completed, 1);
        assert.equal(pollGetAttempt, 4);

        const recoveredOrder = (await OrderService.getOrderById(resilientOrder.orderId))!;
        assert.equal(recoveredOrder.fulfillmentStatus, 'completed');
        assert.equal(recoveredOrder.mystarsOrderStatus, 'delivered');
        assert.equal(recoveredOrder.mystarsPurchaseTx, 'tx_resilient_poll_recovered_999');
        assert.equal(recoveredOrder.mystarsLastPollError, undefined);
      } finally {
        myStarsClient.maxTransientGetRetries = prevRetries;
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Устойчивость MyStars Polling к 429 (Retry-After cooldown vs order_cap), таймаутам и HTTP 503 подтверждена.';
    },
  );

  await runTest(
    'S44-05',
    'Payments',
    'Production Go-Live CryptoBot и xRocket: фоновая сверка pending-платежей/пополнений, автовыдача MyStars и админ-компенсация на внутренний баланс с защитой от двойного возврата',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      FulfillmentService.resetAdapterToDefault();

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      let cbPayload = '';
      let cbAmount = '1.00';
      let xrClientInvoiceId = '';
      let xrAmount = '10.00';

      const gateway = new PaymentProviderGateway(
        async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          if (req.url.endsWith('/getExchangeRates')) {
            return {
              status: 200,
              ok: true,
              json: {
                ok: true,
                result: [
                  { source: 'USDT', target: 'USD', rate: '1.00', is_valid: true },
                  { source: 'TON', target: 'USD', rate: '5.50', is_valid: true },
                ],
              },
            };
          }
          if (req.url.endsWith('/api/v1/rates')) {
            return {
              status: 200,
              ok: true,
              json: { data: { USDT: '1.00', TON: '5.50' } },
            };
          }
          if (req.url.endsWith('/api/v1/currencies')) {
            return {
              status: 200,
              ok: true,
              json: [
                { currency: 'USDT', networks: ['TON', 'TRC-20'] },
                { currency: 'TON', networks: ['TON'] },
              ],
            };
          }
          if (req.url.endsWith('/createInvoice')) {
            const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
            cbPayload = String(body.payload || '');
            cbAmount = String(body.amount || '1.00');
            return {
              status: 200,
              ok: true,
              json: {
                ok: true,
                result: {
                  invoice_id: '99004405',
                  status: 'active',
                  amount: cbAmount,
                  asset: 'USDT',
                  currency_type: 'crypto',
                  bot_invoice_url: 'https://t.me/CryptoBot?start=IV99004405',
                  payload: cbPayload,
                },
              },
            };
          }
          if (req.url.includes('/getInvoices')) {
            return {
              status: 200,
              ok: true,
              json: {
                ok: true,
                result: {
                  items: [
                    {
                      invoice_id: '99004405',
                      status: 'paid',
                      amount: cbAmount,
                      paid_asset: 'USDT',
                      currency_type: 'crypto',
                      payload: cbPayload,
                      fee_in_usd: '0.03',
                      paid_at: new Date().toISOString(),
                    },
                  ],
                },
              },
            };
          }
          if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
            const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
            xrClientInvoiceId = String(body.clientInvoiceId || '');
            xrAmount = String(body.priceAmount || '10.00');
            return {
              status: 201,
              ok: true,
              json: {
                id: '88004405',
                priceAmount: xrAmount,
                priceCurrency: 'USDT',
                clientInvoiceId: xrClientInvoiceId,
                status: 'PENDING',
                links: {
                  telegramBotLink: 'https://t.me/xrocket?start=inv_88004405',
                },
              },
            };
          }
          if (req.url.includes('/api/v1/invoices?ids=')) {
            return {
              status: 200,
              ok: true,
              json: [
                {
                  id: '88004405',
                  priceAmount: xrAmount,
                  priceCurrency: 'USDT',
                  clientInvoiceId: xrClientInvoiceId,
                  status: 'PAID',
                  paidAt: new Date().toISOString(),
                },
              ],
            };
          }
          throw new Error(`Unexpected payment gateway URL in S44-05: ${req.url}`);
        },
        TEST_MOCK_CREDS,
      );

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_live_test_key_4405',
        apiBaseUrl: 'https://api.mystars.tg/v1',
      });

      try {
        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          if (req.url.endsWith('/v1/recipients/check')) {
            return {
              status: 200,
              ok: true,
              json: { username: 'live_crypto_buyer', type: 'stars', resolved: true, eligible: true },
            };
          }
          if (req.url.endsWith('/v1/orders') && req.method === 'POST') {
            return {
              status: 200,
              ok: true,
              json: {
                id: 'ms_ord_cryptobot_4405',
                type: 'stars',
                recipient_username: 'live_crypto_buyer',
                quantity: 50,
                currency: 'usdt_ton',
                payment_amount: '0.68',
                status: 'delivered',
                purchase_tx: 'tx_cb_mystars_4405',
                created_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected MyStars URL in S44-05: ${req.url}`);
        });

        const ps = new PaymentService('test-s44-05', gateway);
        const bs = new BalanceService(gateway);

        // 1. Прямой заказ через CryptoBot ($1.00 за 50 Stars) -> фоновая сверка reconcilePendingOrderPayments обнаруживает оплату и запускает MyStars
        const cbOrder = await OrderService.createOrder({
          telegramUser: buyer1,
          recipientUsername: 'live_crypto_buyer',
          productId: 'stars_custom',
          quantity: 50,
        });
        await ps.createOrReuseOrderPayment({
          orderId: cbOrder.orderId,
          callerTelegramId: buyer1.id,
          provider: 'cryptobot',
          currency: 'USDT',
        });

        const reconciledOrders = await ps.reconcilePendingOrderPayments();
        assert.equal(reconciledOrders.length, 1);
        assert.equal(reconciledOrders[0].ok, true);

        const paidCbOrder = (await OrderService.getOrderById(cbOrder.orderId))!;
        await FulfillmentService.initiateFulfillment(paidCbOrder, mockBot);
        const completedCbOrder = (await OrderService.getOrderById(cbOrder.orderId))!;
        assert.equal(completedCbOrder.paymentStatus, 'completed');
        assert.equal(completedCbOrder.fulfillmentStatus, 'completed');
        assert.equal(completedCbOrder.mystarsOrderId, 'ms_ord_cryptobot_4405');
        assert.equal(completedCbOrder.mystarsPurchaseTx, 'tx_cb_mystars_4405');

        // 2. Пополнение баланса через xRocket ($10.00, комиссия 2% = $0.20, к зачислению $9.80 = 980 центов) -> фоновая сверка reconcilePendingTopUps
        const topUpRecord = await bs.createTopUp({
          telegramId: buyer2.id,
          provider: 'xrocket',
          amountUsdCents: 1000,
          currency: 'USDT',
          network: 'TON',
        });
        assert.equal(topUpRecord.feePercent, 2);
        assert.equal(topUpRecord.amountCreditedUsdCents, 980);

        const reconciledTopUps = await bs.reconcilePendingTopUps();
        assert.equal(reconciledTopUps.length, 1);
        assert.equal(reconciledTopUps[0].ok, true);
        assert.equal(await bs.getBalanceUsdCents(buyer2.id), 980);

        // 3. Если крипто-заказ упал при выдаче, админ может компенсировать его на внутренний баланс с флагом allowExternalGatewayCompensation: true
        const failedCryptoOrder = await OrderService.createOrder({
          telegramUser: buyer1,
          recipientUsername: 'live_crypto_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', failedCryptoOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'failed',
          paymentMethod: 'xrocket',
          fulfillmentLastError: 'MyStars temporary failure',
          needsManualReconciliation: true,
        });

        const refundRes = await bs.refundOrderToInternalBalance({
          orderId: failedCryptoOrder.orderId,
          adminTelegramId: 777000111,
          reason: 'Компенсация крипто-заказа на баланс',
          allowExternalGatewayCompensation: true,
        });
        assert.equal(refundRes.alreadyRefunded, false);
        assert.equal(refundRes.newBalanceUsdCents, 200);
        assert.equal((await OrderService.getOrderById(failedCryptoOrder.orderId))?.balanceRefunded, true);

        // Повторный возврат того же заказа идемпотентен (alreadyRefunded: true, баланс не удваивается)
        const dupRefundRes = await bs.refundOrderToInternalBalance({
          orderId: failedCryptoOrder.orderId,
          adminTelegramId: 777000111,
          reason: 'Повторная попытка возврата',
          allowExternalGatewayCompensation: true,
        });
        assert.equal(dupRefundRes.alreadyRefunded, true);
        assert.equal(await bs.getBalanceUsdCents(buyer1.id), 200);
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
      }

      return 'Фоновая сверка CryptoBot/xRocket, автовыдача MyStars и админ-компенсация на внутренний баланс с защитой от двойного возврата подтверждены.';
    },
  );

  // =========================================================================
  // STAGE 4.4.1: MyStars Polling Deep Audit, Critical Fixes & Production Readiness
  // =========================================================================

  await runTest(
    'S441-01',
    'Fulfillment',
    'Stage 4.4.1: awaiting_payment lifecycle, показ реквизитов поставщика админу и переход до delivered без автоперевода крипты',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 441001, username: 's441_await_buyer', first_name: 'AwaitBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      const pollSequence = ['awaiting_payment', 'paid', 'purchasing', 'delivered'];
      let pollIdx = 0;

      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s441_await_key',
        paymentCurrency: 'usdt_ton',
      });
      myStarsClient.setHttpTransport(async (req) => {
        if (req.method === 'POST' && req.url.endsWith('/v1/recipients/check')) {
          return {
            status: 200,
            ok: true,
            json: { resolved: true, eligible: true, recipient_name: 'Await Buyer' },
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/v1/orders')) {
          return {
            status: 200,
            ok: true,
            json: {
              order_id: 'ord_s441_await_1',
              status: 'awaiting_payment',
              type: 'stars',
              quantity: 100,
              payment: {
                currency: 'usdt_ton',
                chain: 'ton',
                pay_to_address: 'UQSupplierPayAddressTON441',
                memo: 'MEMO_S441_001',
                amount: '1.42',
                amount_units: '1420000',
                fee: {
                  subtotal: '1.37',
                  processing_fee: '0.05',
                  total: '1.42',
                  description: 'TON network + swap',
                  currency: 'usdt_ton',
                },
              },
              expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
            },
          };
        }
        if (req.method === 'GET' && req.url.endsWith('/v1/orders/ord_s441_await_1')) {
          const st = pollSequence[Math.min(pollIdx++, pollSequence.length - 1)];
          return {
            status: 200,
            ok: true,
            json: {
              order_id: 'ord_s441_await_1',
              status: st,
              type: 'stars',
              recipient_username: 's441_await_buyer',
              quantity: 100,
              payment_tx: st !== 'awaiting_payment' ? 'tx_ton_pay_s441' : null,
              purchase_tx: st === 'delivered' ? 'tx_frag_purchase_s441' : null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          };
        }
        throw new Error(`Unexpected URL in S441-01: ${req.method} ${req.url}`);
      });

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();

        const order = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's441_await_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        });

        await FulfillmentService.initiateFulfillment(
          (await OrderService.getOrderById(order.orderId))!,
          mockBot,
        );

        const afterCreate = (await OrderService.getOrderById(order.orderId))!;
        assert.equal(afterCreate.fulfillmentStatus, 'processing');
        assert.equal(afterCreate.mystarsOrderId, 'ord_s441_await_1');
        assert.equal(afterCreate.mystarsOrderStatus, 'awaiting_payment');
        assert.equal(afterCreate.mystarsPayToAddress, 'UQSupplierPayAddressTON441');
        assert.equal(afterCreate.mystarsPaymentMemo, 'MEMO_S441_001');
        assert.equal(afterCreate.mystarsPaymentAmountUsdt, '1.42');

        // Карточка админа содержит реквизиты оплаты поставщику
        const adminCard = formatAdminOrderCard(afterCreate);
        assert.ok(adminCard.includes('UQSupplierPayAddressTON441'));
        assert.ok(adminCard.includes('MEMO_S441_001'));
        assert.ok(adminCard.includes('1.42'));

        // Покупателю НЕ отправлено уведомление о завершении пока заказ в awaiting_payment
        assert.equal(sentMessages.filter((m) => m.chatId === buyer.id).length, 0);

        // Тики polling: awaiting_payment -> paid -> purchasing -> delivered
        const p1 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(p1.stillProcessing, 1);
        assert.equal((await OrderService.getOrderById(order.orderId))?.fulfillmentStatus, 'processing');

        const p2 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(p2.stillProcessing, 1);
        assert.equal((await OrderService.getOrderById(order.orderId))?.mystarsPaymentTx, 'tx_ton_pay_s441');

        const p3 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(p3.stillProcessing, 1);
        assert.equal((await OrderService.getOrderById(order.orderId))?.mystarsOrderStatus, 'purchasing');

        const p4 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(p4.completed, 1);
        const completed = (await OrderService.getOrderById(order.orderId))!;
        assert.equal(completed.fulfillmentStatus, 'completed');
        assert.equal(completed.mystarsPurchaseTx, 'tx_frag_purchase_s441');
        assert.equal(sentMessages.filter((m) => m.chatId === buyer.id).length, 1);
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Жизненный цикл awaiting_payment -> paid -> purchasing -> delivered и показ реквизитов поставщика админу работают без ложного завершения.';
    },
  );

  await runTest(
    'S441-02',
    'Fulfillment',
    'Stage 4.4.1: Строгая валидация схем MyStars (MyStarsValidationError), безопасная обработка неизвестного статуса и алерт зависания >15 мин',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 441002, username: 's441_schema_buyer', first_name: 'SchemaBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      const prevRetries = myStarsClient.maxTransientGetRetries;
      myStarsClient.maxTransientGetRetries = 0;

      let getMode: 'malformed_null' | 'malformed_html' | 'missing_status' | 'unknown_status' | 'stuck_awaiting' = 'malformed_null';

      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s441_schema_key',
        paymentCurrency: 'usdt_ton',
      });
      myStarsClient.setHttpTransport(async (req) => {
        if (req.method === 'GET' && req.url.includes('/v1/orders/ord_s441_schema_1')) {
          if (getMode === 'malformed_null') {
            return { status: 200, ok: true, json: null };
          }
          if (getMode === 'malformed_html') {
            return { status: 200, ok: true, json: { rawText: '<html>502 Bad Gateway</html>' } };
          }
          if (getMode === 'missing_status') {
            return { status: 200, ok: true, json: { order_id: 'ord_s441_schema_1' } };
          }
          if (getMode === 'unknown_status') {
            return {
              status: 200,
              ok: true,
              json: {
                order_id: 'ord_s441_schema_1',
                status: 'custom_manual_review_v2',
                type: 'stars',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          return {
            status: 200,
            ok: true,
            json: {
              order_id: 'ord_s441_schema_1',
              status: 'awaiting_payment',
              type: 'stars',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          };
        }
        throw new Error(`Unexpected URL in S441-02: ${req.method} ${req.url}`);
      });

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();

        // 1. Прямая проверка MyStarsValidationError на битых 200 OK ответах
        getMode = 'malformed_null';
        await assert.rejects(
          () => myStarsClient.getOrder('ord_s441_schema_1'),
          (err: unknown) => err instanceof MyStarsValidationError && err.retryable === true,
        );
        getMode = 'malformed_html';
        await assert.rejects(
          () => myStarsClient.getOrder('ord_s441_schema_1'),
          (err: unknown) => err instanceof MyStarsValidationError && err.retryable === true,
        );
        getMode = 'missing_status';
        await assert.rejects(
          () => myStarsClient.getOrder('ord_s441_schema_1'),
          (err: unknown) => err instanceof MyStarsValidationError && err.retryable === true,
        );

        // 2. В polling битый ответ оставляет заказ в processing (не завершает и не роняет в failed)
        const ord = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's441_schema_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', ord.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          mystarsOrderId: 'ord_s441_schema_1',
          fulfillmentStartedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        });

        const malformedPoll = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(malformedPoll.transientErrors, 1);
        assert.equal(malformedPoll.completed, 0);
        assert.equal(malformedPoll.failed, 0);
        assert.equal((await OrderService.getOrderById(ord.orderId))?.fulfillmentStatus, 'processing');

        // 3. Неизвестный статус MyStars -> остаётся в processing, сохраняет mystarsUnknownStatusSeen, алертит админа 1 раз
        getMode = 'unknown_status';
        const unknownPoll1 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(unknownPoll1.stillProcessing, 1);
        assert.equal(unknownPoll1.completed, 0);
        assert.equal(unknownPoll1.failed, 0);
        const afterUnknown = (await OrderService.getOrderById(ord.orderId))!;
        assert.equal(afterUnknown.fulfillmentStatus, 'processing');
        assert.equal(afterUnknown.mystarsUnknownStatusSeen, 'custom_manual_review_v2');
        const expectedAdminAlertCount = getEnvConfig().adminIds.length;
        const unknownAlertsAfter1 = sentMessages.filter((m) =>
          m.text.includes('Неизвестный статус MyStars'),
        ).length;
        assert.equal(unknownAlertsAfter1, expectedAdminAlertCount);

        // Повторный polling с тем же неизвестным статусом не спамит админа
        await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(
          sentMessages.filter((m) => m.text.includes('Неизвестный статус MyStars')).length,
          expectedAdminAlertCount,
        );

        // 4. Зависший >15 мин заказ -> отправляет 1 алерт каждому админу и ставит mystarsStuckAlertedAt, продолжая polling
        getMode = 'stuck_awaiting';
        await firestoreRepo.updateDoc<Order>('orders', ord.orderId, {
          fulfillmentStartedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
        });
        const stuckPoll1 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(stuckPoll1.stillProcessing, 1);
        const afterStuck = (await OrderService.getOrderById(ord.orderId))!;
        assert.ok(afterStuck.mystarsStuckAlertedAt);
        assert.equal(afterStuck.fulfillmentStatus, 'processing');
        assert.equal(
          sentMessages.filter((m) => m.text.includes('более 15 минут')).length,
          expectedAdminAlertCount,
        );

        // Второй проход не дублирует алерт зависания
        await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(
          sentMessages.filter((m) => m.text.includes('более 15 минут')).length,
          expectedAdminAlertCount,
        );
      } finally {
        myStarsClient.maxTransientGetRetries = prevRetries;
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'MyStarsValidationError, защита от неизвестных статусов и однократный мониторинг зависания >15 мин подтверждены.';
    },
  );

  await runTest(
    'S441-03',
    'Database',
    'Stage 4.4.1: Справедливый round-robin polling при >50 активных заказах (65 шт.) и legacy-документах без mystarsLastPolledAt',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 441003, username: 's441_fair_buyer', first_name: 'FairBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const mockBot = createMockBot([]);

      const polledIdsPerTick: string[][] = [];
      let currentTickPolled: string[] = [];

      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s441_fair_key',
        paymentCurrency: 'usdt_ton',
      });
      myStarsClient.setHttpTransport(async (req) => {
        const match = req.url.match(/\/v1\/orders\/([^/?]+)/);
        if (req.method === 'GET' && match) {
          const extId = decodeURIComponent(match[1]);
          currentTickPolled.push(extId);
          return {
            status: 200,
            ok: true,
            json: {
              order_id: extId,
              status: 'awaiting_payment',
              type: 'stars',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          };
        }
        throw new Error(`Unexpected URL in S441-03: ${req.method} ${req.url}`);
      });

      const prevBudget = FulfillmentService.pollBatchBudget;
      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.pollBatchBudget = 50;

        const baseMs = Date.now() - 3_600_000;
        const legacyOrderIds: string[] = [];
        const allMyStarsIds: string[] = [];

        // Создаём 65 активных заказов в processing:
        // - #1..#60: с заполненным mystarsLastPolledAt (старые созданы раньше, но недавно опрашивались)
        // - #61..#65: legacy-документы БЕЗ поля mystarsLastPolledAt (созданы позже — за пределами первых 50 по createdAt!)
        for (let i = 1; i <= 65; i++) {
          const ordId = `ord_fair_${String(i).padStart(3, '0')}`;
          const msId = `ms_fair_${String(i).padStart(3, '0')}`;
          allMyStarsIds.push(msId);
          const isLegacyWithoutPollField = i > 60;
          if (isLegacyWithoutPollField) {
            legacyOrderIds.push(msId);
          }

          const orderDoc: Order = {
            orderId: ordId,
            userId: `tg_${buyer.id}`,
            userTelegramId: buyer.id,
            username: buyer.username,
            recipientUsername: buyer.username,
            productId: 'stars_custom',
            productName: 'Telegram Stars',
            category: 'stars',
            quantity: 100,
            totalPriceUsdCents: 200,
            totalPrice: 200,
            currency: 'USD',
            paymentMethod: 'balance',
            paymentStatus: 'paid',
            fulfillmentStatus: 'processing',
            mystarsOrderId: msId,
            mystarsOrderStatus: 'awaiting_payment',
            ...(isLegacyWithoutPollField
              ? {}
              : { mystarsLastPolledAt: new Date(baseMs + i * 1000).toISOString() }),
            createdAt: new Date(baseMs + i * 1000).toISOString(),
            updatedAt: new Date(baseMs + i * 1000).toISOString(),
          };
          await firestoreRepo.setDoc<Order>('orders', ordId, orderDoc);
        }

        // Тик 1: бюджет 50 -> ВСЕ 5 legacy-заказов без mystarsLastPolledAt опрашиваются ПЕРВЫМИ (индекс 0..4),
        // а также 45 самых давно опрашиваемых заказов!
        currentTickPolled = [];
        const tick1 = await FulfillmentService.pollMyStarsOrders(mockBot);
        polledIdsPerTick.push([...currentTickPolled]);
        assert.equal(tick1.polled, 50);

        for (const legacyMsId of legacyOrderIds) {
          assert.ok(
            polledIdsPerTick[0].slice(0, 5).includes(legacyMsId),
            `Legacy-заказ ${legacyMsId} без mystarsLastPolledAt должен иметь высший приоритет в первом тике`,
          );
        }

        // Проверяем, что legacy-документы получили backfill mystarsLastPolledAt
        const migratedLegacy = await OrderService.getOrderById('ord_fair_061');
        assert.ok(migratedLegacy?.mystarsLastPolledAt);

        // Тик 2: оставшиеся 15 заказов (#46..#60) гарантированно попадают в опрос и не голодают!
        currentTickPolled = [];
        const tick2 = await FulfillmentService.pollMyStarsOrders(mockBot);
        polledIdsPerTick.push([...currentTickPolled]);
        assert.equal(tick2.polled, 50);

        const polledAcrossTwoTicks = new Set<string>([
          ...polledIdsPerTick[0],
          ...polledIdsPerTick[1],
        ]);
        assert.equal(
          polledAcrossTwoTicks.size,
          65,
          `Все 65 активных заказов должны быть опрошены за 2 тика (опрошено: ${polledAcrossTwoTicks.size})`,
        );
      } finally {
        FulfillmentService.pollBatchBudget = prevBudget;
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'При 65 активных заказах (включая legacy без mystarsLastPolledAt) 100% заказов опрашиваются за 2 тика без голодания.';
    },
  );

  await runTest(
    'S441-04',
    'Database',
    'Stage 4.4.1: Распределённые Firestore Timestamp leases (acquire/renew/release с проверкой leaseOwner и operationId)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 441004, username: 's441_lease_buyer', first_name: 'LeaseBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const ord = await OrderService.createOrder({
        telegramUser: buyer,
        recipientUsername: 's441_lease_buyer',
        productId: 'stars_custom',
        quantity: 100,
      });
      await firestoreRepo.updateDoc<Order>('orders', ord.orderId, {
        paymentStatus: 'paid',
        fulfillmentStatus: 'processing',
        mystarsOrderId: 'ord_s441_lease_1',
      });

      const t0 = Date.now();
      // 1. Worker A захватывает lease
      const claimA = await FulfillmentService.acquireOrderPollLease({
        orderId: ord.orderId,
        leaseOwner: 'worker-A',
        operationId: 'op-A1',
        ttlMs: 30_000,
        nowMs: t0,
      });
      assert.equal(claimA.acquired, true);
      assert.equal(claimA.lease?.leaseOwner, 'worker-A');
      assert.equal(claimA.lease?.operationId, 'op-A1');
      assert.ok(FulfillmentService.timestampToMillis(claimA.lease?.leaseUntil) === t0 + 30_000);

      // 2. Worker B не может захватить активный lease до истечения TTL
      const claimBBlocked = await FulfillmentService.acquireOrderPollLease({
        orderId: ord.orderId,
        leaseOwner: 'worker-B',
        operationId: 'op-B1',
        ttlMs: 30_000,
        nowMs: t0 + 10_000,
      });
      assert.equal(claimBBlocked.acquired, false);

      // 3. Worker B не может продлить или снять чужой lease
      const wrongRenew = await FulfillmentService.renewOrderPollLease({
        orderId: ord.orderId,
        leaseOwner: 'worker-B',
        operationId: 'op-B1',
        ttlMs: 30_000,
        nowMs: t0 + 10_000,
      });
      assert.equal(wrongRenew, false);

      const wrongRelease = await FulfillmentService.releaseOrderPollLease({
        orderId: ord.orderId,
        leaseOwner: 'worker-B',
        operationId: 'op-A1',
      });
      assert.equal(wrongRelease, false);

      // 4. Worker A продлевает свой lease
      const renewedA = await FulfillmentService.renewOrderPollLease({
        orderId: ord.orderId,
        leaseOwner: 'worker-A',
        operationId: 'op-A1',
        ttlMs: 40_000,
        nowMs: t0 + 15_000,
      });
      assert.equal(renewedA, true);

      // 5. После истечения TTL (t0 + 60_000 > t0 + 55_000) Worker B перехватывает lease
      const claimBSuccess = await FulfillmentService.acquireOrderPollLease({
        orderId: ord.orderId,
        leaseOwner: 'worker-B',
        operationId: 'op-B2',
        ttlMs: 30_000,
        nowMs: t0 + 60_000,
      });
      assert.equal(claimBSuccess.acquired, true);

      // 6. КРИТИЧНО: просроченный Worker A вызывает release — НЕ должен снять новый lease Worker B!
      const staleReleaseA = await FulfillmentService.releaseOrderPollLease({
        orderId: ord.orderId,
        leaseOwner: 'worker-A',
        operationId: 'op-A1',
      });
      assert.equal(staleReleaseA, false);
      const afterStaleRelease = (await OrderService.getOrderById(ord.orderId))!;
      assert.equal(afterStaleRelease.mystarsPollLease?.leaseOwner, 'worker-B');
      assert.equal(afterStaleRelease.mystarsPollLease?.operationId, 'op-B2');

      // 7. Worker B корректно освобождает свой lease
      const releaseB = await FulfillmentService.releaseOrderPollLease({
        orderId: ord.orderId,
        leaseOwner: 'worker-B',
        operationId: 'op-B2',
      });
      assert.equal(releaseB, true);
      assert.equal((await OrderService.getOrderById(ord.orderId))?.mystarsPollLease, undefined);

      return 'Owner-verified Firestore Timestamp leases блокируют параллельный опрос и не позволяют просроченному воркеру снять чужой замок.';
    },
  );

  await runTest(
    'S441-05',
    'Fulfillment',
    'Stage 4.4.1: Устойчивый notification state machine (pending/sending/sent, eventId) и безопасное восстановление после падения в sending',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 441005, username: 's441_notify_buyer', first_name: 'NotifyBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const slowBot = {
        telegram: {
          sendMessage: async (chatId: number | string, text: string) => {
            await new Promise((r) => setTimeout(r, 25));
            sentMessages.push({ chatId, text });
            return { message_id: Date.now() };
          },
        },
      } as unknown as Telegraf;

      const ord1 = await OrderService.createOrder({
        telegramUser: buyer,
        recipientUsername: 's441_notify_buyer',
        productId: 'stars_custom',
        quantity: 100,
      });
      await firestoreRepo.updateDoc<Order>('orders', ord1.orderId, {
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
      });
      const completedOrd1 = (await OrderService.getOrderById(ord1.orderId))!;

      // 1. Два параллельных воркера одновременно вызывают ensureBuyerNotified -> отправляется ровно 1 сообщение
      await Promise.all([
        FulfillmentService.ensureBuyerNotified(completedOrd1, slowBot),
        FulfillmentService.ensureBuyerNotified(completedOrd1, slowBot),
      ]);

      assert.equal(sentMessages.length, 1);
      const afterNotify1 = (await OrderService.getOrderById(ord1.orderId))!;
      assert.equal(afterNotify1.buyerNotificationState?.status, 'sent');
      assert.equal(afterNotify1.buyerNotificationState?.eventId, `evt_buyer_completed_${ord1.orderId}`);
      assert.equal(afterNotify1.buyerNotificationState?.deliveryUncertainAfterCrash, false);
      assert.ok(afterNotify1.buyerNotifiedAt);

      // 2. Сценарий сбоя: процесс упал после отправки в Telegram (статус остался 'sending', leaseUntil истёк, buyerNotifiedAt не записан)
      const ord2 = await OrderService.createOrder({
        telegramUser: buyer,
        recipientUsername: 's441_notify_buyer',
        productId: 'stars_custom',
        quantity: 100,
      });
      await firestoreRepo.updateDoc<Order>('orders', ord2.orderId, {
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
        buyerNotificationState: {
          status: 'sending',
          eventId: `evt_buyer_completed_${ord2.orderId}`,
          operationId: 'crashed_op_1',
          leaseOwner: 'crashed_worker',
          leaseUntil: Timestamp.fromMillis(Date.now() - 10_000),
          attemptCount: 1,
        },
      });
      const crashedOrd2 = (await OrderService.getOrderById(ord2.orderId))!;

      // Выживший воркер обнаруживает истёкший sending-lease -> переводит в delivery_uncertain БЕЗ отметки sent и БЕЗ авто-дубля
      const recoveredOrd2 = await FulfillmentService.ensureBuyerNotified(crashedOrd2, slowBot);
      assert.equal(sentMessages.length, 1, 'Не должно быть повторной отправки при истёкшем sending-lease');
      assert.equal(recoveredOrd2.buyerNotificationState?.status, 'delivery_uncertain');
      assert.equal(recoveredOrd2.buyerNotificationState?.deliveryUncertainAfterCrash, true);
      assert.equal(recoveredOrd2.buyerNotifiedAt, undefined);

      // 3. Явный forceResend от администратора позволяет переотправить уведомление вручную
      await FulfillmentService.ensureBuyerNotified(recoveredOrd2, slowBot, true);
      assert.equal(sentMessages.length, 2);

      return 'Notification state machine (pending/sending/sent/delivery_uncertain + eventId) защищает от параллельных дублей и безопасно восстанавливается после падения в sending.';
    },
  );

  await runTest(
    'S441-06',
    'Fulfillment',
    'Stage 4.4.1: Защита от дублирования при таймауте POST /v1/orders (сверка GET /v1/orders и карантин при неоднозначности)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 441006, username: 's441_ambig_buyer', first_name: 'AmbigBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const mockBot = createMockBot([]);

      let postOrderCalls = 0;
      let listMode: 'single_match' | 'multiple_matches' = 'single_match';
      const seenIdempotencyKeys: string[] = [];

      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s441_ambig_key',
        paymentCurrency: 'usdt_ton',
      });
      myStarsClient.setHttpTransport(async (req) => {
        if (req.method === 'POST' && req.url.endsWith('/v1/recipients/check')) {
          return {
            status: 200,
            ok: true,
            json: { resolved: true, eligible: true, recipient_name: 'Ambig Buyer' },
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/v1/orders')) {
          postOrderCalls += 1;
          const idk = req.headers?.['Idempotency-Key'];
          if (idk) seenIdempotencyKeys.push(idk);
          throw new MyStarsTransportError('Таймаут запроса к MyStars API (15000 мс)', true);
        }
        if (req.method === 'GET' && req.url.includes('/v1/orders?')) {
          if (listMode === 'single_match') {
            return {
              status: 200,
              ok: true,
              json: {
                orders: [
                  {
                    order_id: 'ord_s441_reconciled_unique',
                    status: 'delivered',
                    type: 'stars',
                    recipient_username: 's441_ambig_buyer',
                    quantity: 100,
                    purchase_tx: 'tx_s441_reconciled_999',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                ],
                next_cursor: null,
              },
            };
          }
          return {
            status: 200,
            ok: true,
            json: {
              orders: [
                {
                  order_id: 'ord_s441_dup_a',
                  status: 'awaiting_payment',
                  type: 'stars',
                  recipient_username: 's441_ambig_buyer',
                  quantity: 100,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
                {
                  order_id: 'ord_s441_dup_b',
                  status: 'awaiting_payment',
                  type: 'stars',
                  recipient_username: 's441_ambig_buyer',
                  quantity: 100,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
              next_cursor: null,
            },
          };
        }
        if (req.method === 'GET' && req.url.endsWith('/v1/orders/ord_s441_reconciled_unique')) {
          return {
            status: 200,
            ok: true,
            json: {
              order_id: 'ord_s441_reconciled_unique',
              status: 'delivered',
              type: 'stars',
              recipient_username: 's441_ambig_buyer',
              quantity: 100,
              purchase_tx: 'tx_s441_reconciled_999',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          };
        }
        throw new Error(`Unexpected URL in S441-06: ${req.method} ${req.url}`);
      });

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();

        // Сценарий A: POST /v1/orders упал по таймауту, при повторе GET /v1/orders находит 1 совпадение -> привязывает ID и завершает БЕЗ второго POST!
        const ordA = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's441_ambig_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', ordA.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        });

        await assert.rejects(
          () => FulfillmentService.initiateFulfillment(ordA, mockBot),
          (err: unknown) => err instanceof MyStarsTransportError && err.isTimeout === true,
        );
        assert.equal(postOrderCalls, 1);
        assert.equal(seenIdempotencyKeys[0], `fulfill_${ordA.orderId}`);

        const afterTimeoutA = (await OrderService.getOrderById(ordA.orderId))!;
        assert.ok(afterTimeoutA.mystarsAmbiguousPostAt);
        assert.equal(afterTimeoutA.mystarsCreateInFlight, true);
        assert.equal(afterTimeoutA.fulfillmentIdempotencyKey, `fulfill_${ordA.orderId}`);

        // Повторный запуск находит заказ через GET /v1/orders и завершает его без второго POST
        listMode = 'single_match';
        const reconciledA = await FulfillmentService.initiateFulfillment(afterTimeoutA, mockBot);
        assert.equal(postOrderCalls, 1, 'Повторный POST /v1/orders не должен вызываться, если заказ найден через GET /v1/orders');
        assert.equal(reconciledA.fulfillmentStatus, 'completed');
        assert.equal(reconciledA.mystarsOrderId, 'ord_s441_reconciled_unique');

        // Сценарий B: несколько неоднозначных совпадений -> карантин (needsManualReconciliation: true), повторный POST заблокирован
        const ordB = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's441_ambig_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', ordB.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        });

        await assert.rejects(
          () => FulfillmentService.initiateFulfillment(ordB, mockBot),
          (err: unknown) => err instanceof MyStarsTransportError,
        );
        const postCallsBeforeBRetry = postOrderCalls;
        listMode = 'multiple_matches';
        const afterTimeoutB = (await OrderService.getOrderById(ordB.orderId))!;
        await assert.rejects(
          () => FulfillmentService.initiateFulfillment(afterTimeoutB, mockBot),
          (err: unknown) => err instanceof MyStarsApiError && err.code === 'ambiguous_create_order',
        );
        assert.equal(postOrderCalls, postCallsBeforeBRetry, 'Неоднозначный заказ должен уйти в карантин без повторного POST');
        const quarantinedB = (await OrderService.getOrderById(ordB.orderId))!;
        assert.equal(quarantinedB.fulfillmentStatus, 'failed');
        assert.equal(quarantinedB.needsManualReconciliation, true);
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Защита от дублей при таймауте POST /v1/orders (reconciliation через GET /v1/orders + карантин при неоднозначности) подтверждена.';
    },
  );

  await runTest(
    'S441-07',
    'Payments',
    'Stage 4.4.1: Параллельный возврат средств на внутренний баланс USD (race-safe идемпотентность + tx_bal_refund)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 441007, username: 's441_refund_buyer', first_name: 'RefundBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const bs = new BalanceService();

      const ord = await OrderService.createOrder({
        telegramUser: buyer,
        recipientUsername: 's441_refund_buyer',
        productId: 'stars_custom',
        quantity: 100,
      });
      await firestoreRepo.updateDoc<Order>('orders', ord.orderId, {
        paymentStatus: 'paid',
        fulfillmentStatus: 'failed',
        paymentMethod: 'cryptobot',
        totalPriceUsdCents: 350,
        totalPrice: 350,
      });

      // Два одновременных возврата (имитация двойного клика / двух воркеров)
      const [r1, r2] = await Promise.all([
        bs.refundOrderToInternalBalance({
          orderId: ord.orderId,
          reason: 'Admin refund 1',
          adminTelegramId: 777000111,
          allowExternalGatewayCompensation: true,
        }),
        bs.refundOrderToInternalBalance({
          orderId: ord.orderId,
          reason: 'Admin refund 2',
          adminTelegramId: 777000111,
          allowExternalGatewayCompensation: true,
        }),
      ]);

      const freshRefundCount = [r1, r2].filter((r) => !r.alreadyRefunded).length;
      const dupRefundCount = [r1, r2].filter((r) => r.alreadyRefunded).length;
      assert.equal(freshRefundCount, 1, 'Ровно один вызов должен выполнить начисление');
      assert.equal(dupRefundCount, 1, 'Второй параллельный вызов должен вернуть alreadyRefunded: true');

      const finalBalanceCents = await bs.getBalanceUsdCents(buyer.id);
      assert.equal(finalBalanceCents, 350, 'Баланс покупателя должен увеличиться ровно на сумму заказа (350 центов), без удвоения');

      const ledgerTx = await firestoreRepo.getDoc<StoreTransaction>(
        'transactions',
        `tx_bal_refund_${ord.orderId}`,
      );
      assert.ok(ledgerTx);
      assert.equal(ledgerTx?.amountUsdCents, 350);

      // Кнопка возврата доступна админу для крипто-заказа до возврата и скрывается после возврата
      const beforeKb = buildAdminOrderActionKeyboard({
        ...ord,
        paymentStatus: 'paid',
        fulfillmentStatus: 'failed',
        paymentMethod: 'cryptobot',
      });
      assert.ok(JSON.stringify(beforeKb).includes(`adm:ord_bal_refund:${ord.orderId}`));
      const afterOrder = (await OrderService.getOrderById(ord.orderId))!;
      const afterKb = buildAdminOrderActionKeyboard(afterOrder);
      assert.ok(!JSON.stringify(afterKb).includes(`adm:ord_bal_refund:${ord.orderId}`));

      return 'Параллельный возврат на внутренний баланс USD полностью атомарен и идемпотентен (кредит 1 раз, tx_bal_refund записан 1 раз).';
    },
  );

  await runTest(
    'S441-08',
    'Payments',
    'Stage 4.4.1: Изолированный фикс xRocket GET /api/v1/invoice?invoiceId=...&clientInvoiceId=... (с fallback) и ephemeral Firestore probe',
    async () => {
      const gw = new PaymentProviderGateway();
      gw.setCredentialsOverride({
        xrocketApiKey: 'xr_test_s441_key',
        xrocketApiUrl: 'https://pay.xrocket.tg/api/v1',
      });

      const requestedUrls: string[] = [];
      let simulate404OnSingleEndpoint = false;

      gw.setTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
        requestedUrls.push(req.url);
        if (req.url.includes('/api/v1/invoice?')) {
          if (simulate404OnSingleEndpoint) {
            return {
              status: 404,
              ok: false,
              json: { title: 'Not Found', status: 404 },
            };
          }
          return {
            status: 200,
            ok: true,
            json: {
              id: 'xr_inv_s441_1',
              clientInvoiceId: 'pay_s441_1',
              status: 'PAID',
              priceAmount: '5.00',
              priceCurrency: 'USDT',
              payment: {
                amount: '5.00',
                currency: 'USDT',
                network: 'TON',
                finalizedAt: new Date().toISOString(),
              },
            },
          };
        }
        if (req.url.includes('/api/v1/invoices?ids=')) {
          return {
            status: 200,
            ok: true,
            json: {
              data: [
                {
                  id: 'xr_inv_s441_2',
                  clientInvoiceId: 'pay_s441_2',
                  status: 'PAID',
                  priceAmount: '7.50',
                  priceCurrency: 'USDT',
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected xRocket URL: ${req.url}`);
      });

      // 1. Основной официальный endpoint GET /api/v1/invoice?invoiceId=... (строго один параметр без одновременного clientInvoiceId)
      const verified1 = await gw.verifyInvoiceStatus({
        provider: 'xrocket',
        externalInvoiceId: 'xr_inv_s441_1',
        paymentId: 'pay_s441_1',
      });
      assert.equal(verified1.status, 'paid');
      assert.equal(verified1.externalInvoiceId, 'xr_inv_s441_1');
      assert.equal(verified1.paymentId, 'pay_s441_1');
      assert.ok(requestedUrls[0].includes('/api/v1/invoice?invoiceId=xr_inv_s441_1'));
      assert.equal(requestedUrls[0].includes('clientInvoiceId='), false);

      // 2. Fallback на GET /api/v1/invoice?clientInvoiceId=... и GET /api/v1/invoices?ids=... при 404 на одиночном endpoint
      simulate404OnSingleEndpoint = true;
      const verified2 = await gw.verifyInvoiceStatus({
        provider: 'xrocket',
        externalInvoiceId: 'xr_inv_s441_2',
        paymentId: 'pay_s441_2',
      });
      assert.equal(verified2.status, 'paid');
      assert.equal(verified2.externalInvoiceId, 'xr_inv_s441_2');
      assert.ok(requestedUrls.some((u) => u.includes('/api/v1/invoice?clientInvoiceId=pay_s441_2')));
      assert.ok(requestedUrls.some((u) => u.includes('/api/v1/invoices?ids=xr_inv_s441_2')));

      // 3. Проверка, что firestoreErrorHandler.ts использует изолированный ephemeral app + terminate + deleteApp
      const probeSource = fs.readFileSync(
        path.resolve('src/db/firestoreErrorHandler.ts'),
        'utf8',
      );
      assert.ok(probeSource.includes('startup-probe-'));
      assert.ok(probeSource.includes('terminate(probeDb)'));
      assert.ok(probeSource.includes('deleteApp(probeApp)'));

      return 'Официальный xRocket GET /api/v1/invoice (с раздельным fallback) и ephemeral Firestore probe cleanup подтверждены.';
    },
  );

  // =========================================================================
  // STAGE 4.4.2 TARGETED AUDIT & CRITICAL FIXES TESTS
  // =========================================================================

  await runTest(
    'S442-01',
    'Fulfillment',
    'Stage 4.4.2: Telegram Notification Recovery (delivery_uncertain, сохранение метаданных, ручная проверка/переотправка и защита forceResend от параллельного запуска)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 442001, username: 's442_notify_buyer', first_name: 'NotifyS442' };
      await UserService.upsertFromTelegram(buyer);

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      let sendDelayMs = 35;
      const slowBot = {
        telegram: {
          sendMessage: async (chatId: number | string, text: string) => {
            await new Promise((r) => setTimeout(r, sendDelayMs));
            sentMessages.push({ chatId, text });
            return { message_id: Date.now() };
          },
        },
      } as unknown as Telegraf;

      // 1. Заказ упал в состоянии sending (lease истёк до фиксации sent)
      const ord1 = await OrderService.createOrder({
        telegramUser: buyer,
        recipientUsername: 's442_notify_buyer',
        productId: 'stars_custom',
        quantity: 100,
      });
      const expiredLeaseTs = Timestamp.fromMillis(Date.now() - 15_000);
      await firestoreRepo.updateDoc<Order>('orders', ord1.orderId, {
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
        buyerNotificationState: {
          status: 'sending',
          eventId: `evt_buyer_completed_${ord1.orderId}`,
          operationId: 'op_crash_442_buyer',
          leaseOwner: 'worker_crashed_442',
          leaseUntil: expiredLeaseTs,
          attemptCount: 1,
        },
        adminNotificationState: {
          status: 'sending',
          eventId: `evt_admin_completed_${ord1.orderId}`,
          operationId: 'op_crash_442_admin',
          leaseOwner: 'worker_crashed_442',
          leaseUntil: expiredLeaseTs,
          attemptCount: 2,
        },
      });

      const crashedOrd1 = (await OrderService.getOrderById(ord1.orderId))!;

      // Автоматическое восстановление переводит в delivery_uncertain, НЕ ставит sent/NotifiedAt и сохраняет метаданные
      const afterBuyerRecover = await FulfillmentService.ensureBuyerNotified(crashedOrd1, slowBot);
      const afterAdminRecover = await FulfillmentService.ensureAdminNotified(afterBuyerRecover, slowBot);

      assert.equal(sentMessages.length, 0, 'Неконтролируемой авто-переотправки быть не должно');
      assert.equal(afterAdminRecover.buyerNotifiedAt, undefined);
      assert.equal(afterAdminRecover.adminNotifiedAt, undefined);
      assert.equal(afterAdminRecover.buyerNotificationState?.status, 'delivery_uncertain');
      assert.equal(afterAdminRecover.buyerNotificationState?.eventId, `evt_buyer_completed_${ord1.orderId}`);
      assert.equal(afterAdminRecover.buyerNotificationState?.operationId, 'op_crash_442_buyer');
      assert.equal(afterAdminRecover.buyerNotificationState?.leaseOwner, 'worker_crashed_442');
      assert.equal(afterAdminRecover.buyerNotificationState?.attemptCount, 1);
      assert.ok(afterAdminRecover.buyerNotificationState?.uncertainSince);
      assert.equal(afterAdminRecover.adminNotificationState?.status, 'delivery_uncertain');
      assert.equal(afterAdminRecover.adminNotificationState?.operationId, 'op_crash_442_admin');
      assert.equal(afterAdminRecover.adminNotificationState?.attemptCount, 2);

      // Повторный автоматический вызов НЕ переотправляет сообщение
      await FulfillmentService.ensureBuyerNotified(afterAdminRecover, slowBot);
      await FulfillmentService.ensureAdminNotified(afterAdminRecover, slowBot);
      assert.equal(sentMessages.length, 0);

      // UI администратора показывает предупреждение и кнопки review/resend/ack
      const adminCard = formatAdminOrderCard(afterAdminRecover);
      assert.ok(adminCard.includes('delivery_uncertain'));
      const cardKbJson = JSON.stringify(buildAdminOrderActionKeyboard(afterAdminRecover));
      assert.ok(cardKbJson.includes(`adm:ord_notify_review:${ord1.orderId}`));
      const reviewText = formatAdminNotificationReviewMessage(afterAdminRecover);
      assert.ok(reviewText.includes('delivery_uncertain'));
      assert.ok(reviewText.includes(`evt_buyer_completed_${ord1.orderId}`));
      const reviewKbJson = JSON.stringify(buildAdminNotificationReviewKeyboard(afterAdminRecover));
      assert.ok(reviewKbJson.includes(`adm:ord_notify_resend_buyer:${ord1.orderId}`));
      assert.ok(reviewKbJson.includes(`adm:ord_notify_ack:${ord1.orderId}`));

      // 2. Контролируемая переотправка с защитой от параллельного запуска (два одновременных forceResend -> ровно 1 отправка!)
      const [resendA, resendB] = await Promise.all([
        FulfillmentService.forceResendOrderNotification({
          orderId: ord1.orderId,
          target: 'buyer',
          bot: slowBot,
          adminTelegramId: 777000111,
        }),
        FulfillmentService.forceResendOrderNotification({
          orderId: ord1.orderId,
          target: 'buyer',
          bot: slowBot,
          adminTelegramId: 777000111,
        }),
      ]);

      const sentCount = [resendA.sentBuyer, resendB.sentBuyer].filter(Boolean).length;
      const blockedCount = [resendA.skippedInFlight, resendB.skippedInFlight].filter(Boolean).length;
      assert.equal(sentCount, 1, 'Ровно один из параллельных forceResend должен отправить сообщение');
      assert.equal(blockedCount, 1, 'Второй параллельный forceResend должен быть заблокирован активным lease');
      assert.equal(sentMessages.filter((m) => m.chatId === buyer.id).length, 1);

      const afterResendBuyer = (await OrderService.getOrderById(ord1.orderId))!;
      assert.equal(afterResendBuyer.buyerNotificationState?.status, 'sent');
      assert.ok(afterResendBuyer.buyerNotifiedAt);
      assert.equal(afterResendBuyer.buyerNotificationState?.attemptCount, 2);

      // 3. Подтверждение администратором без переотправки (acknowledgeUncertainNotification для admin)
      sendDelayMs = 5;
      const acked = await FulfillmentService.acknowledgeUncertainNotification({
        orderId: ord1.orderId,
        target: 'admin',
        adminTelegramId: 777000111,
      });
      assert.equal(acked.adminNotificationState?.status, 'sent');
      assert.equal(acked.adminNotificationState?.acknowledgedByAdminId, 777000111);
      assert.ok(acked.adminNotificationState?.acknowledgedAt);
      assert.ok(acked.adminNotifiedAt);
      // После ack сообщение админу не отправлялось
      assert.equal(sentMessages.filter((m) => m.chatId === 777000111).length, 0);

      return 'delivery_uncertain, сохранение метаданных, ручная проверка/ack и блокировка параллельного forceResend подтверждены.';
    },
  );

  await runTest(
    'S442-02',
    'Database',
    'Stage 4.4.2: Fair Polling на 1,500 активных заказах (многостраничный persistent cursor, рестарт процесса, чужие leases и изоляция падающих заказов без голодания)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 442002, username: 's442_scale_buyer', first_name: 'ScaleBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const mockBot = createMockBot([]);

      const TOTAL_ORDERS = 1500;
      const FAILING_ORDER_MS_ID = 'ms_scale_0750';
      const FOREIGN_LEASED_ORDER_ID = 'ord_scale_1200';
      const FOREIGN_LEASED_MS_ID = 'ms_scale_1200';

      const polledCounts = new Map<string, number>();
      let failingAttempts = 0;

      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s442_scale_key',
        paymentCurrency: 'usdt_ton',
      });
      const prevRetries = myStarsClient.maxTransientGetRetries;
      myStarsClient.maxTransientGetRetries = 0;

      myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
        const match = req.url.match(/\/v1\/orders\/([^/?]+)/);
        if (req.method === 'GET' && match) {
          const extId = decodeURIComponent(match[1]);
          polledCounts.set(extId, (polledCounts.get(extId) ?? 0) + 1);
          if (extId === FAILING_ORDER_MS_ID) {
            failingAttempts += 1;
            throw new MyStarsTransportError('Simulated per-order timeout', true);
          }
          return {
            status: 200,
            ok: true,
            json: {
              order_id: extId,
              status: 'awaiting_payment',
              type: 'stars',
              recipient_username: 's442_scale_buyer',
              quantity: 100,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          };
        }
        throw new Error(`Unexpected URL in S442-02: ${req.method} ${req.url}`);
      });

      const prevBudget = FulfillmentService.pollBatchBudget;
      const prevPageSize = FulfillmentService.pollPageSize;
      const prevWorkerId = FulfillmentService.workerInstanceId;
      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
        await FulfillmentService.resetMyStarsPollCheckpoint();
        FulfillmentService.pollBatchBudget = 50;
        FulfillmentService.pollPageSize = 100;

        // Создаём 1,500 активных заказов в processing (значительно больше старого лимита 1,000!)
        // Часть последних заказов (#1451..#1500) — legacy без mystarsLastPolledAt
        const baseMs = Date.now() - 7_200_000;
        for (let i = 1; i <= TOTAL_ORDERS; i++) {
          const ordId = `ord_scale_${String(i).padStart(4, '0')}`;
          const msId = `ms_scale_${String(i).padStart(4, '0')}`;
          const isLegacy = i > 1450;
          const isForeignLeased = ordId === FOREIGN_LEASED_ORDER_ID;
          const orderDoc: Order = {
            orderId: ordId,
            userId: `tg_${buyer.id}`,
            userTelegramId: buyer.id,
            username: buyer.username,
            recipientUsername: buyer.username,
            productId: 'stars_custom',
            productName: 'Telegram Stars',
            category: 'stars',
            quantity: 100,
            totalPriceUsdCents: 200,
            totalPrice: 200,
            currency: 'USD',
            paymentMethod: 'balance',
            paymentStatus: 'paid',
            fulfillmentStatus: 'processing',
            mystarsOrderId: msId,
            mystarsOrderStatus: 'awaiting_payment',
            ...(isLegacy ? {} : { mystarsLastPolledAt: new Date(baseMs + i * 1000).toISOString() }),
            ...(isForeignLeased
              ? {
                  mystarsPollLease: {
                    leaseOwner: 'remote-worker-B',
                    operationId: 'remote-op-B',
                    acquiredAt: Timestamp.fromMillis(Date.now()),
                    leaseUntil: Timestamp.fromMillis(Date.now() + 600_000),
                  },
                }
              : {}),
            createdAt: new Date(baseMs + i * 1000).toISOString(),
            updatedAt: new Date(baseMs + i * 1000).toISOString(),
          };
          await firestoreRepo.setDoc<Order>('orders', ordId, orderDoc);
        }

        // Запускаем 30 тиков по 50 заказов:
        // На тике 15 имитируем рестарт процесса (сброс in-memory состояния + смена workerInstanceId, но Firestore checkpoint сохранён!)
        for (let tick = 1; tick <= 30; tick++) {
          if (tick === 15) {
            // Имитация перезапуска процесса на середине очереди
            FulfillmentService.resetMyStarsPollingState();
            FulfillmentService.workerInstanceId = 'restarted-worker-instance-2';
            const savedCheckpoint = await FulfillmentService.loadMyStarsPollCheckpoint();
            assert.ok(
              savedCheckpoint?.cursorOrderId,
              'Persistent Firestore checkpoint должен сохраняться между рестартами',
            );
          }
          await FulfillmentService.pollMyStarsOrders(mockBot);
        }

        // Чужой активный lease не должен был опрашиваться нашим воркером
        assert.equal(
          polledCounts.get(FOREIGN_LEASED_MS_ID) ?? 0,
          0,
          'Заказ с активным чужим lease не должен опрашиваться другим воркером',
        );

        // Падающий заказ #750 был опрошен и НЕ заблокировал остальные 1,498 заказов
        assert.ok(failingAttempts >= 1, 'Падающий заказ #750 должен был быть опрошен');

        // Все остальные 1,499 заказов (включая #1001..#1500 за пределами старого лимита 1,000 и legacy-документы!) были опрошены!
        assert.equal(
          polledCounts.size,
          TOTAL_ORDERS - 1,
          `Ожидалось покрытие всех ${TOTAL_ORDERS - 1} доступных заказов без голодания, опрошено: ${polledCounts.size}`,
        );
        assert.ok(
          polledCounts.has('ms_scale_1500'),
          'Последний заказ #1500 (legacy за пределами 1000) гарантированно опрошен',
        );
        assert.ok(
          polledCounts.has('ms_scale_1001'),
          'Заказ #1001 (за пределами старого лимита 1000) гарантированно опрошен',
        );

        // Освобождаем чужой lease и делаем ещё 1 тик — #1200 также опрашивается после wrap-around/release
        await firestoreRepo.updateDoc<Order>('orders', FOREIGN_LEASED_ORDER_ID, {
          mystarsPollLease: undefined,
        });
        for (let t = 0; t < 30 && !polledCounts.has(FOREIGN_LEASED_MS_ID); t++) {
          await FulfillmentService.pollMyStarsOrders(mockBot);
        }
        assert.equal(
          polledCounts.size,
          TOTAL_ORDERS,
          `После снятия чужого lease должны быть опрошены все ${TOTAL_ORDERS} заказов`,
        );
      } finally {
        FulfillmentService.pollBatchBudget = prevBudget;
        FulfillmentService.pollPageSize = prevPageSize;
        FulfillmentService.workerInstanceId = prevWorkerId;
        myStarsClient.maxTransientGetRetries = prevRetries;
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return '1,500 активных заказов (15+ страниц) полностью опрошены без голодания, с рестартом по persistent checkpoint, уважением чужих leases и изоляцией сбойных заказов.';
    },
  );

  await runTest(
    'S442-03',
    'Fulfillment',
    'Stage 4.4.2: Полная runtime-валидация всех 7 endpoint-ов MyStars API (валидные варианты, неполные и битые payload -> MyStarsValidationError)',
    async () => {
      const client = new MyStarsClient();
      client.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s442_val_key',
        paymentCurrency: 'usdt_ton',
      });
      client.maxTransientGetRetries = 0;

      const respondWith = (payload: unknown) => {
        client.setHttpTransport(async (): Promise<HttpTransportResponse> => ({
          status: 200,
          ok: true,
          json: payload,
        }));
      };

      const expectValidationError = async (fn: () => Promise<unknown>, expectedEndpoint: string) => {
        await assert.rejects(fn, (err: unknown) => {
          assert.ok(
            err instanceof MyStarsValidationError,
            `Ожидалась MyStarsValidationError для ${expectedEndpoint}, получено: ${String(err)}`,
          );
          assert.ok(
            err.endpoint.includes(expectedEndpoint) && err.message.includes(expectedEndpoint),
            `Endpoint "${expectedEndpoint}" должен присутствовать в ошибке: ${err.endpoint} / ${err.message}`,
          );
          return true;
        });
      };

      // 1. GET /v1/currencies — валидные (массив и { currencies }) + невалидные
      respondWith([{ code: 'usdt_ton', chain: 'ton', name: 'USDT (TON)' }]);
      const cur1 = await client.getCurrencies();
      assert.equal(cur1.length, 1);
      assert.equal(cur1[0].code, 'usdt_ton');

      respondWith({ currencies: [{ code: 'ton', chain: 'ton', name: 'Toncoin' }] });
      const cur2 = await client.getCurrencies();
      assert.equal(cur2[0].code, 'ton');

      respondWith(null);
      await expectValidationError(() => client.getCurrencies(), 'GET /v1/currencies');
      respondWith([{ code: 'usdt_ton', chain: 'ton' }]); // missing name
      await expectValidationError(() => client.getCurrencies(), 'GET /v1/currencies');
      respondWith({ currencies: 'not_an_array' });
      await expectValidationError(() => client.getCurrencies(), 'GET /v1/currencies');

      // 2. GET /v1/products — валидные + невалидные
      respondWith([
        { type: 'stars', name: 'Telegram Stars', parameter: 'quantity', min: 50, max: 1000000, values: null },
        { type: 'premium', name: 'Telegram Premium', parameter: 'months', min: 3, max: 12, values: [3, 6, 12] },
      ]);
      const prods = await client.getProducts();
      assert.equal(prods.length, 2);
      assert.deepEqual(prods[1].values, [3, 6, 12]);

      respondWith([{ type: 'gifts', name: 'Invalid', parameter: 'quantity', min: 1, max: 10 }]);
      await expectValidationError(() => client.getProducts(), 'GET /v1/products');
      respondWith([{ type: 'stars', name: 'Stars', parameter: 'quantity', min: 100, max: 50 }]); // max < min
      await expectValidationError(() => client.getProducts(), 'GET /v1/products');
      respondWith([{ type: 'premium', name: 'Premium', parameter: 'months', min: 3, max: 12, values: ['3'] }]);
      await expectValidationError(() => client.getProducts(), 'GET /v1/products');

      // 3. GET /v1/pricing — валидный (с nested fee) + невалидные
      respondWith({
        type: 'stars',
        quantity: 100,
        amount: '1.42',
        currency: 'usdt_ton',
        fee: {
          subtotal: '1.37',
          processing_fee: '0.05',
          total: '1.42',
          description: 'TON fee',
          currency: 'usdt_ton',
        },
        usdt_per_ton: '5.25',
      });
      const price = await client.getPricing({ type: 'stars', quantity: 100 });
      assert.equal(price.amount, '1.42');
      assert.equal(price.fee?.total, '1.42');

      respondWith({ type: 'stars', amount: 'not_a_number', currency: 'usdt_ton' });
      await expectValidationError(() => client.getPricing({ type: 'stars', quantity: 100 }), 'GET /v1/pricing');
      respondWith({ type: 'stars', amount: '1.42', currency: 'usdt_ton', fee: { subtotal: '1.37' } }); // incomplete nested fee
      await expectValidationError(() => client.getPricing({ type: 'stars', quantity: 100 }), 'GET /v1/pricing');
      respondWith({ amount: '1.42', currency: 'usdt_ton' }); // missing type
      await expectValidationError(() => client.getPricing({ type: 'stars', quantity: 100 }), 'GET /v1/pricing');

      // 4. POST /v1/recipients/check — валидные + невалидные
      respondWith({ resolved: true, eligible: true, recipient_name: 'Valid User' });
      const checkOk = await client.checkRecipient({ type: 'stars', username: 'valid_user' });
      assert.equal(checkOk.eligible, true);

      respondWith({ resolved: 'yes', eligible: true }); // wrong type
      await expectValidationError(
        () => client.checkRecipient({ type: 'stars', username: 'valid_user' }),
        'POST /v1/recipients/check',
      );
      respondWith({ resolved: true, eligible: true, recipient_name: 12345 }); // corrupted nullable string
      await expectValidationError(
        () => client.checkRecipient({ type: 'stars', username: 'valid_user' }),
        'POST /v1/recipients/check',
      );

      // 5. POST /v1/orders — валидные (nested payment + flat variant) + невалидные
      respondWith({
        order_id: 'ord_val_nested_1',
        status: 'awaiting_payment',
        type: 'stars',
        quantity: 100,
        payment: {
          currency: 'usdt_ton',
          chain: 'ton',
          pay_to_address: 'UQAddr1',
          memo: 'MEMO1',
          amount: '1.42',
          amount_units: '1420000',
        },
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      });
      const createdNested = await client.createOrder({ type: 'stars', username: 'valid_user', quantity: 100 });
      assert.equal(createdNested.order_id, 'ord_val_nested_1');
      assert.equal(createdNested.payment.amount, '1.42');

      // Неполный nested payment (без amount_units / chain) -> ошибка валидации
      respondWith({
        order_id: 'ord_val_bad_pay',
        status: 'awaiting_payment',
        type: 'stars',
        payment: { currency: 'usdt_ton', amount: '1.42' },
        expires_at: new Date().toISOString(),
      });
      await expectValidationError(
        () => client.createOrder({ type: 'stars', username: 'valid_user', quantity: 100 }),
        'POST /v1/orders',
      );
      // awaiting_payment без expires_at -> ошибка валидации
      respondWith({
        order_id: 'ord_val_no_exp',
        status: 'awaiting_payment',
        type: 'stars',
        payment: { currency: 'usdt_ton', chain: 'ton', amount: '1.42', amount_units: '1420000' },
      });
      await expectValidationError(
        () => client.createOrder({ type: 'stars', username: 'valid_user', quantity: 100 }),
        'POST /v1/orders',
      );
      // Нет ни payment, ни payment_amount -> ошибка валидации
      respondWith({ order_id: 'ord_val_empty', status: 'delivered', type: 'stars' });
      await expectValidationError(
        () => client.createOrder({ type: 'stars', username: 'valid_user', quantity: 100 }),
        'POST /v1/orders',
      );

      // 6. GET /v1/orders — валидный + невалидный next_cursor + битый элемент
      respondWith({
        orders: [
          {
            order_id: 'ord_list_1',
            status: 'delivered',
            type: 'stars',
            recipient_username: 'valid_user',
            quantity: 100,
            created_at: new Date().toISOString(),
          },
        ],
        next_cursor: 'cur_2',
      });
      const page = await client.listOrders({ limit: 10 });
      assert.equal(page.orders.length, 1);
      assert.equal(page.next_cursor, 'cur_2');

      respondWith({ orders: [], next_cursor: 999 }); // invalid next_cursor type!
      await expectValidationError(() => client.listOrders(), 'GET /v1/orders');
      respondWith({ orders: [{ order_id: 'ord_bad_item', status: 'delivered' }] }); // missing type & created_at
      await expectValidationError(() => client.listOrders(), 'GET /v1/orders');

      // 7. GET /v1/orders/{id} — валидный + невалидные (wrong quantity type, missing created_at, corrupted rawText)
      respondWith({
        order_id: 'ord_get_1',
        status: 'delivered',
        type: 'stars',
        quantity: 100,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const fetched = await client.getOrder('ord_get_1');
      assert.equal(fetched.order_id, 'ord_get_1');

      respondWith({
        order_id: 'ord_get_1',
        status: 'delivered',
        type: 'stars',
        quantity: '100', // must be integer number, not string
        created_at: new Date().toISOString(),
      });
      await expectValidationError(() => client.getOrder('ord_get_1'), 'GET /v1/orders/ord_get_1');

      respondWith({ rawText: '<html>502 Bad Gateway</html>' });
      await expectValidationError(() => client.getOrder('ord_get_1'), 'GET /v1/orders/ord_get_1');

      return 'Все 7 endpoint-ов MyStars API проходят строгую runtime-валидацию и выбрасывают MyStarsValidationError с указанием endpoint при неполных/битых payload.';
    },
  );

  await runTest(
    'S442-04',
    'Fulfillment',
    'Stage 4.4.2: Ambiguous POST Reconciliation (многостраничный next_cursor, строгие сигналы, insufficient_data карантин, сохранение Idempotency-Key)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 442004, username: 's442_recon_buyer', first_name: 'ReconBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const mockBot = createMockBot([]);

      let postOrderCalls = 0;
      const postIdempotencyKeys: string[] = [];
      let listScenario:
        | 'multi_page_page3_match'
        | 'incomplete_missing_username'
        | 'incomplete_missing_quantity'
        | 'clean_not_found' = 'multi_page_page3_match';
      let postShouldFail = true;

      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s442_recon_key',
        paymentCurrency: 'usdt_ton',
      });

      myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
        if (req.method === 'POST' && req.url.endsWith('/v1/recipients/check')) {
          return {
            status: 200,
            ok: true,
            json: { resolved: true, eligible: true, recipient_name: 'Recon Buyer' },
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/v1/orders')) {
          postOrderCalls += 1;
          const idk = req.headers['Idempotency-Key'];
          if (idk) postIdempotencyKeys.push(idk);
          if (postShouldFail) {
            throw new MyStarsTransportError('Simulated POST timeout', true);
          }
          return {
            status: 200,
            ok: true,
            json: {
              order_id: 'ord_s442_retried_clean_1',
              status: 'delivered',
              type: 'stars',
              quantity: 100,
              payment: {
                currency: 'usdt_ton',
                chain: 'ton',
                amount: '1.40',
                amount_units: '1400000',
              },
              purchase_tx: 'tx_clean_retry_442',
            },
          };
        }
        if (req.method === 'GET' && req.url.includes('/v1/orders?')) {
          const urlObj = new URL(req.url);
          const cursor = urlObj.searchParams.get('cursor');
          const nowIso = new Date().toISOString();

          if (listScenario === 'multi_page_page3_match') {
            if (!cursor) {
              return {
                status: 200,
                ok: true,
                json: {
                  orders: [
                    {
                      order_id: 'ord_other_p1',
                      status: 'delivered',
                      type: 'stars',
                      recipient_username: 'someone_else',
                      quantity: 100,
                      created_at: nowIso,
                    },
                  ],
                  next_cursor: 'cur_page_2',
                },
              };
            }
            if (cursor === 'cur_page_2') {
              return {
                status: 200,
                ok: true,
                json: {
                  orders: [
                    {
                      order_id: 'ord_other_p2',
                      status: 'delivered',
                      type: 'stars',
                      recipient_username: 's442_recon_buyer',
                      quantity: 500, // different quantity
                      created_at: nowIso,
                    },
                  ],
                  next_cursor: 'cur_page_3',
                },
              };
            }
            return {
              status: 200,
              ok: true,
              json: {
                orders: [
                  {
                    order_id: 'ord_s442_found_page3',
                    status: 'delivered',
                    type: 'stars',
                    recipient_username: 's442_recon_buyer',
                    quantity: 100,
                    purchase_tx: 'tx_found_page3_442',
                    created_at: nowIso,
                  },
                ],
                next_cursor: null,
              },
            };
          }

          if (listScenario === 'incomplete_missing_username') {
            return {
              status: 200,
              ok: true,
              json: {
                orders: [
                  {
                    order_id: 'ord_s442_no_user',
                    status: 'awaiting_payment',
                    type: 'stars',
                    recipient_username: null, // missing!
                    quantity: 100,
                    created_at: nowIso,
                  },
                ],
                next_cursor: null,
              },
            };
          }

          if (listScenario === 'incomplete_missing_quantity') {
            return {
              status: 200,
              ok: true,
              json: {
                orders: [
                  {
                    order_id: 'ord_s442_no_qty',
                    status: 'awaiting_payment',
                    type: 'stars',
                    recipient_username: 's442_recon_buyer',
                    quantity: null, // missing!
                    created_at: nowIso,
                  },
                ],
                next_cursor: null,
              },
            };
          }

          return {
            status: 200,
            ok: true,
            json: {
              orders: [
                {
                  order_id: 'ord_unrelated_only',
                  status: 'delivered',
                  type: 'stars',
                  recipient_username: 'other_user',
                  quantity: 50,
                  created_at: nowIso,
                },
              ],
              next_cursor: null,
            },
          };
        }
        if (req.method === 'GET' && req.url.endsWith('/v1/orders/ord_s442_found_page3')) {
          return {
            status: 200,
            ok: true,
            json: {
              order_id: 'ord_s442_found_page3',
              status: 'delivered',
              type: 'stars',
              recipient_username: 's442_recon_buyer',
              quantity: 100,
              purchase_tx: 'tx_found_page3_442',
              created_at: new Date().toISOString(),
            },
          };
        }
        throw new Error(`Unexpected URL in S442-04: ${req.method} ${req.url}`);
      });

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();

        // Сценарий 1: совпадение найдено на 3-й странице через next_cursor -> завершает БЕЗ второго POST!
        const ord1 = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's442_recon_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', ord1.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        });
        postShouldFail = true;
        await assert.rejects(() => FulfillmentService.initiateFulfillment(ord1, mockBot));
        assert.equal(postOrderCalls, 1);

        listScenario = 'multi_page_page3_match';
        const after1 = (await OrderService.getOrderById(ord1.orderId))!;
        const done1 = await FulfillmentService.initiateFulfillment(after1, mockBot);
        assert.equal(postOrderCalls, 1, 'Заказ найден на странице 3 — повторного POST быть не должно');
        assert.equal(done1.fulfillmentStatus, 'completed');
        assert.equal(done1.mystarsOrderId, 'ord_s442_found_page3');

        // Сценарий 2: неполные данные (нет recipient_username) -> insufficient_data -> карантин БЕЗ второго POST!
        const ord2 = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's442_recon_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', ord2.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        });
        await assert.rejects(() => FulfillmentService.initiateFulfillment(ord2, mockBot));
        const postCountBefore2 = postOrderCalls;
        listScenario = 'incomplete_missing_username';
        const after2 = (await OrderService.getOrderById(ord2.orderId))!;
        await assert.rejects(
          () => FulfillmentService.initiateFulfillment(after2, mockBot),
          (err: unknown) =>
            err instanceof MyStarsApiError && err.code === 'insufficient_reconciliation_data',
        );
        assert.equal(postOrderCalls, postCountBefore2, 'При отсутствии recipient_username повторный POST заблокирован');
        const q2 = (await OrderService.getOrderById(ord2.orderId))!;
        assert.equal(q2.needsManualReconciliation, true);

        // Сценарий 3: неполные данные (нет quantity) -> insufficient_data -> карантин БЕЗ второго POST!
        const ord3 = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's442_recon_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', ord3.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        });
        await assert.rejects(() => FulfillmentService.initiateFulfillment(ord3, mockBot));
        const postCountBefore3 = postOrderCalls;
        listScenario = 'incomplete_missing_quantity';
        const after3 = (await OrderService.getOrderById(ord3.orderId))!;
        await assert.rejects(
          () => FulfillmentService.initiateFulfillment(after3, mockBot),
          (err: unknown) =>
            err instanceof MyStarsApiError && err.code === 'insufficient_reconciliation_data',
        );
        assert.equal(postOrderCalls, postCountBefore3, 'При отсутствии quantity повторный POST заблокирован');
        assert.equal((await OrderService.getOrderById(ord3.orderId))?.needsManualReconciliation, true);

        // Сценарий 4: чистый not_found -> повторный POST использует ТОТ ЖЕ fulfillmentIdempotencyKey!
        const ord4 = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's442_recon_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', ord4.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        });
        postIdempotencyKeys.length = 0;
        postShouldFail = true;
        await assert.rejects(() => FulfillmentService.initiateFulfillment(ord4, mockBot));
        listScenario = 'clean_not_found';
        postShouldFail = false;
        const after4 = (await OrderService.getOrderById(ord4.orderId))!;
        const done4 = await FulfillmentService.initiateFulfillment(after4, mockBot);
        assert.equal(done4.fulfillmentStatus, 'completed');
        assert.equal(postIdempotencyKeys.length, 2);
        assert.equal(
          postIdempotencyKeys[0],
          postIdempotencyKeys[1],
          'При повторе после clean not_found должен сохраняться исходный fulfillmentIdempotencyKey',
        );
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Многостраничная сверка next_cursor, карантин при insufficient_data (без username/quantity) и сохранение Idempotency-Key подтверждены.';
    },
  );

  await runTest(
    'S442-05',
    'Payments',
    'Stage 4.4.2: xRocket Invoice Verification (раздельные запросы без смешивания параметров, fallback-цепочка, валидация unpaid/amount/currency и защита от двойного зачисления)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 442005, username: 's442_xrocket_buyer', first_name: 'XRocketBuyer' };
      await UserService.upsertFromTelegram(buyer);

      const gw = new PaymentProviderGateway();
      gw.setCredentialsOverride({
        xrocketApiKey: 'xr_test_s442_key',
        xrocketApiUrl: 'https://pay.xrocket.tg/api/v1',
      });

      const urls: string[] = [];
      let mode:
        | 'primary_paid'
        | 'fallback_client_id'
        | 'fallback_batch'
        | 'unpaid_pending'
        | 'wrong_amount'
        | 'wrong_currency'
        | 'missing_currency' = 'primary_paid';

      let createdInvoiceSeq = 0;
      const invoiceToClientId = new Map<string, string>();
      gw.setTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
        urls.push(req.url);

        // КРИТИЧЕСКАЯ ПРОВЕРКА: ни один запрос не смешивает invoiceId и clientInvoiceId!
        assert.equal(
          req.url.includes('invoiceId=') && req.url.includes('clientInvoiceId='),
          false,
          `Запрещено отправлять invoiceId и clientInvoiceId одновременно: ${req.url}`,
        );

        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: {
              data: [
                {
                  currency: 'USDT',
                  name: 'Tether',
                  minTransfer: 0.1,
                  withdrawFees: [{ networkCode: 'TON', feeWithdraw: 0.1 }],
                },
              ],
            },
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: {
              data: { USDT: '1.00', TON: '5.50' },
            },
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}');
          createdInvoiceSeq += 1;
          const invId = `xr_s442_topup_inv_${createdInvoiceSeq}`;
          invoiceToClientId.set(invId, String(body.clientInvoiceId || ''));
          return {
            status: 201,
            ok: true,
            json: {
              id: invId,
              clientInvoiceId: body.clientInvoiceId,
              status: 'PENDING',
              links: { telegramBotLink: `https://t.me/xrocket?start=${invId}` },
            },
          };
        }

        if (mode === 'fallback_client_id') {
          if (req.url.includes('/api/v1/invoice?invoiceId=')) {
            return { status: 404, ok: false, json: { title: 'Not Found', status: 404 } };
          }
          if (req.url.includes('/api/v1/invoice?clientInvoiceId=pay_fb_client')) {
            return {
              status: 200,
              ok: true,
              json: {
                id: 'xr_fb_client_1',
                clientInvoiceId: 'pay_fb_client',
                status: 'PAID',
                payment: { amount: '10.00', currency: 'USDT', network: 'TON' },
              },
            };
          }
        }

        if (mode === 'fallback_batch') {
          if (req.url.includes('/api/v1/invoice?')) {
            return { status: 404, ok: false, json: { title: 'Not Found', status: 404 } };
          }
          if (req.url.includes('/api/v1/invoices?ids=xr_fb_batch_1')) {
            return {
              status: 200,
              ok: true,
              json: {
                data: [
                  {
                    id: 'xr_fb_batch_1',
                    clientInvoiceId: 'pay_fb_batch',
                    status: 'PAID',
                    priceAmount: '12.00',
                    priceCurrency: 'USDT',
                  },
                ],
              },
            };
          }
        }

        // Responses for top-up verification scenarios on xr_s442_topup_inv_*
        const invMatch = req.url.match(/\/api\/v1\/invoice\?invoiceId=(xr_s442_topup_inv_\d+)/);
        if (invMatch) {
          const invId = invMatch[1];
          const clientInvoiceId = invoiceToClientId.get(invId) || '';
          if (mode === 'unpaid_pending') {
            return {
              status: 200,
              ok: true,
              json: {
                id: invId,
                clientInvoiceId,
                status: 'PENDING',
                priceAmount: '10.00',
                priceCurrency: 'USDT',
              },
            };
          }
          if (mode === 'wrong_amount') {
            return {
              status: 200,
              ok: true,
              json: {
                id: invId,
                clientInvoiceId,
                status: 'PAID',
                payment: { amount: '5.00', currency: 'USDT', network: 'TON' }, // underpaid vs 10.00
              },
            };
          }
          if (mode === 'wrong_currency') {
            return {
              status: 200,
              ok: true,
              json: {
                id: invId,
                clientInvoiceId,
                status: 'PAID',
                payment: { amount: '10.00', currency: 'TON', network: 'TON' }, // wrong currency vs USDT
              },
            };
          }
          if (mode === 'missing_currency') {
            return {
              status: 200,
              ok: true,
              json: {
                id: invId,
                clientInvoiceId,
                status: 'PAID',
                payment: { amount: '10.00' }, // missing currency -> MUST NOT default to USDT!
              },
            };
          }
          return {
            status: 200,
            ok: true,
            json: {
              id: invId,
              clientInvoiceId,
              status: 'PAID',
              payment: { amount: '10.00', currency: 'USDT', network: 'TON' },
            },
          };
        }

        throw new Error(`Unexpected xRocket URL in S442-05 (${mode}): ${req.url}`);
      });

      // 1. Fallback 1: invoiceId (404) -> clientInvoiceId (200)
      mode = 'fallback_client_id';
      const fb1 = await gw.verifyInvoiceStatus({
        provider: 'xrocket',
        externalInvoiceId: 'xr_fb_client_1',
        paymentId: 'pay_fb_client',
      });
      assert.equal(fb1.status, 'paid');
      assert.equal(fb1.currency, 'USDT');
      assert.ok(urls.some((u) => u.includes('/api/v1/invoice?invoiceId=xr_fb_client_1')));
      assert.ok(urls.some((u) => u.includes('/api/v1/invoice?clientInvoiceId=pay_fb_client')));

      // 2. Fallback 2: invoiceId (404) -> clientInvoiceId (404) -> /invoices?ids= (200)
      mode = 'fallback_batch';
      const fb2 = await gw.verifyInvoiceStatus({
        provider: 'xrocket',
        externalInvoiceId: 'xr_fb_batch_1',
        paymentId: 'pay_fb_batch',
      });
      assert.equal(fb2.status, 'paid');
      assert.ok(urls.some((u) => u.includes('/api/v1/invoices?ids=xr_fb_batch_1')));

      // 3. Проверка BalanceService с реальными отказами при unpaid / wrong amount / wrong currency / missing currency
      const bs = new BalanceService(gw);

      // 3a. Unpaid (PENDING) -> 0 зачислений
      const topUp1 = await bs.createTopUp({
        telegramId: buyer.id,
        username: buyer.username,
        firstName: buyer.first_name,
        provider: 'xrocket',
        amountUsdCents: 1000,
        currency: 'USDT',
        forceNew: true,
      });
      mode = 'unpaid_pending';
      const resUnpaid = await bs.verifyAndProcessTopUp(topUp1.paymentId);
      assert.equal(resUnpaid.ok, false);
      assert.equal(await bs.getBalanceUsdCents(buyer.id), 0);

      // 3b. Missing currency on HTTP 200 PAID -> XRocketApiError (нет тихого дефолта USDT) и 0 зачислений
      mode = 'missing_currency';
      await assert.rejects(
        () =>
          gw.verifyInvoiceStatus({
            provider: 'xrocket',
            externalInvoiceId: topUp1.externalInvoiceId,
            paymentId: topUp1.paymentId,
          }),
        (err: unknown) =>
          err instanceof XRocketApiError &&
          err.problemDetails?.kind === 'invalid_invoice_payload',
      );
      assert.equal(await bs.getBalanceUsdCents(buyer.id), 0);

      // 3c. Wrong amount (underpaid 5.00 vs 10.00) -> отклонено, 0 зачислений
      const topUpWrongAmt = await bs.createTopUp({
        telegramId: buyer.id,
        username: buyer.username,
        firstName: buyer.first_name,
        provider: 'xrocket',
        amountUsdCents: 1000,
        currency: 'USDT',
        forceNew: true,
      });
      mode = 'wrong_amount';
      const resWrongAmt = await bs.verifyAndProcessTopUp(topUpWrongAmt.paymentId);
      assert.equal(resWrongAmt.ok, false);
      assert.equal(resWrongAmt.status, 'underpaid');
      assert.equal(await bs.getBalanceUsdCents(buyer.id), 0);

      // 3d. Wrong currency (TON vs USDT) -> отклонено, 0 зачислений
      const topUpWrongCur = await bs.createTopUp({
        telegramId: buyer.id,
        username: buyer.username,
        firstName: buyer.first_name,
        provider: 'xrocket',
        amountUsdCents: 1000,
        currency: 'USDT',
        forceNew: true,
      });
      mode = 'wrong_currency';
      const resWrongCur = await bs.verifyAndProcessTopUp(topUpWrongCur.paymentId);
      assert.equal(resWrongCur.ok, false);
      assert.equal(await bs.getBalanceUsdCents(buyer.id), 0);

      // 3e. Valid PAID (10.00 USDT) + повторная/параллельная проверка -> баланс зачислен ровно 1 раз ($9.80 = 980 центов с 2% комиссией)
      const topUpValid = await bs.createTopUp({
        telegramId: buyer.id,
        username: buyer.username,
        firstName: buyer.first_name,
        provider: 'xrocket',
        amountUsdCents: 1000,
        currency: 'USDT',
        forceNew: true,
      });
      mode = 'primary_paid';
      const [ok1, ok2] = await Promise.all([
        bs.verifyAndProcessTopUp(topUpValid.paymentId),
        bs.verifyAndProcessTopUp(topUpValid.paymentId),
      ]);
      assert.equal(ok1.ok, true);
      assert.equal(ok2.ok, true);
      assert.equal(
        await bs.getBalanceUsdCents(buyer.id),
        980,
        'Баланс должен быть зачислен ровно 1 раз (980 центов), без двойного зачисления',
      );

      return 'xRocket verifyInvoiceStatus (раздельные primary/fallback запросы, строгая проверка status/amount/currency без дефолта USDT и защита от двойного зачисления) подтверждён.';
    },
  );

  // =========================================================================
  // STAGE 4.4.3 — FINAL RELIABILITY CORRECTIONS TESTS
  // =========================================================================

  await runTest(
    'S443-01',
    'Fulfillment',
    'Stage 4.4.3: Пустой adminIds не отмечает admin notification как sent и не выставляет adminNotifiedAt (no_recipients + восстановление при настройке админов)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;

      const buyer = { id: 443001, username: 's443_empty_admin_buyer', first_name: 'Buyer443' };
      await UserService.upsertFromTelegram(buyer);
      const order = await OrderService.createOrder({
        telegramUser: buyer,
        recipientUsername: 's443_empty_admin_buyer',
        productId: 'stars_custom',
        quantity: 100,
      });
      await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
        paymentStatus: 'paid',
        fulfillmentStatus: 'processing',
      });
      const paidOrder = (await OrderService.getOrderById(order.orderId))!;

      const deliveredMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(deliveredMessages);

      try {
        // 1. Убираем всех получателей (ADMIN_IDS и OWNER_TELEGRAM_ID пустые)
        process.env.ADMIN_IDS = '';
        process.env.OWNER_TELEGRAM_ID = '';

        const afterEmpty = await FulfillmentService.ensureAdminNotified(paidOrder, mockBot);
        assert.equal(deliveredMessages.length, 0, 'При пустом adminIds ни одно сообщение не должно отправляться');
        assert.equal(
          afterEmpty.adminNotifiedAt,
          undefined,
          'При пустом adminIds поле adminNotifiedAt НЕ должно выставляться',
        );
        assert.equal(
          afterEmpty.adminNotificationState?.status,
          'no_recipients',
          'Статус должен быть no_recipients (не sent!)',
        );
        assert.equal(
          afterEmpty.adminNotificationState?.sentAt,
          undefined,
          'Поле sentAt не должно выставляться при отсутствии получателей',
        );
        assert.equal(afterEmpty.adminNotificationState?.attemptCount, 0);

        // Форматтер и клавиатура честно показывают no_recipients и дают review-кнопку
        const cardText = formatAdminOrderCard(afterEmpty);
        assert.ok(cardText.includes('no_recipients'));
        const cardKb = JSON.stringify(buildAdminOrderActionKeyboard(afterEmpty));
        assert.ok(cardKb.includes(`adm:ord_notify_review:${order.orderId}`));

        // forceResend при пустом adminIds также НЕ выдаёт успех
        const forceEmpty = await FulfillmentService.forceResendOrderNotification({
          orderId: order.orderId,
          target: 'admin',
          bot: mockBot,
        });
        assert.equal(forceEmpty.sentAdmin, false);
        assert.equal(forceEmpty.order.adminNotifiedAt, undefined);
        assert.equal(forceEmpty.order.adminNotificationState?.status, 'no_recipients');

        // 2. После настройки ADMIN_IDS повторный ensureAdminNotified автоматически доставляет уведомление и переводит в sent
        process.env.ADMIN_IDS = '9001001,9001002';
        const afterConfigured = await FulfillmentService.ensureAdminNotified(
          forceEmpty.order,
          mockBot,
        );
        assert.equal(afterConfigured.adminNotificationState?.status, 'sent');
        assert.ok(afterConfigured.adminNotifiedAt);
        assert.equal(deliveredMessages.filter((m) => m.chatId === 9001001).length, 1);
        assert.equal(deliveredMessages.filter((m) => m.chatId === 9001002).length, 1);
      } finally {
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'При пустом adminIds фиксируется status=no_recipients без adminNotifiedAt/sentAt; после настройки админов доставка выполняется корректно.';
    },
  );

  await runTest(
    'S443-02',
    'Fulfillment',
    'Stage 4.4.3: Частичная доставка уведомлений администраторам (все получили, никто не получил, 1 из 3 упал -> partial_sent, повтор без дубля уже получившим)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;

      const buyer = { id: 443002, username: 's443_partial_buyer', first_name: 'PartialBuyer' };
      await UserService.upsertFromTelegram(buyer);

      const ADMIN_A = 9100001;
      const ADMIN_B = 9100002;
      const ADMIN_C = 9100003;

      const makeOrder = async (suffix: string): Promise<Order> => {
        const o = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: `s443_${suffix}`,
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', o.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
        });
        return (await OrderService.getOrderById(o.orderId))!;
      };

      const sentLog: Array<{ chatId: number; text: string }> = [];
      let failingChatIds = new Set<number>();
      const selectiveBot = {
        telegram: {
          sendMessage: async (chatId: number | string, text: string) => {
            const numericChatId = Number(chatId);
            if (failingChatIds.has(numericChatId)) {
              throw new Error(`Simulated Telegram 403 blocked for ${numericChatId}`);
            }
            sentLog.push({ chatId: numericChatId, text });
            return { message_id: sentLog.length };
          },
        },
      } as unknown as Telegraf;

      try {
        process.env.OWNER_TELEGRAM_ID = String(ADMIN_A);
        process.env.ADMIN_IDS = `${ADMIN_B},${ADMIN_C}`;

        // Сценарий 1: Все администраторы получили -> status='sent', adminNotifiedAt установлен
        const ordAll = await makeOrder('all_ok');
        failingChatIds = new Set();
        const resAll = await FulfillmentService.ensureAdminNotified(ordAll, selectiveBot);
        assert.equal(resAll.adminNotificationState?.status, 'sent');
        assert.ok(resAll.adminNotifiedAt);
        assert.equal(resAll.adminNotificationState?.recipientDeliveries?.[String(ADMIN_A)]?.status, 'sent');
        assert.equal(resAll.adminNotificationState?.recipientDeliveries?.[String(ADMIN_B)]?.status, 'sent');
        assert.equal(resAll.adminNotificationState?.recipientDeliveries?.[String(ADMIN_C)]?.status, 'sent');
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_A).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_B).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_C).length, 1);

        // Повторный автоматический вызов НЕ дублирует никому
        await FulfillmentService.ensureAdminNotified(resAll, selectiveBot);
        assert.equal(sentLog.length, 3);

        // Сценарий 2: Никто из администраторов не получил -> status='pending', adminNotifiedAt НЕ установлен
        sentLog.length = 0;
        const ordNone = await makeOrder('none_ok');
        failingChatIds = new Set([ADMIN_A, ADMIN_B, ADMIN_C]);
        const resNone = await FulfillmentService.ensureAdminNotified(ordNone, selectiveBot);
        assert.equal(resNone.adminNotificationState?.status, 'pending');
        assert.equal(resNone.adminNotifiedAt, undefined);
        assert.equal(resNone.adminNotificationState?.sentAt, undefined);
        assert.equal(resNone.adminNotificationState?.recipientDeliveries?.[String(ADMIN_A)]?.status, 'failed');
        assert.equal(resNone.adminNotificationState?.recipientDeliveries?.[String(ADMIN_B)]?.status, 'failed');
        assert.equal(resNone.adminNotificationState?.recipientDeliveries?.[String(ADMIN_C)]?.status, 'failed');
        assert.equal(sentLog.length, 0);

        // Сценарий 3: Один из нескольких (ADMIN_B) не получил -> status='partial_sent', adminNotifiedAt НЕ установлен
        sentLog.length = 0;
        const ordPartial = await makeOrder('partial_ok');
        failingChatIds = new Set([ADMIN_B]);
        const resPartial = await FulfillmentService.ensureAdminNotified(ordPartial, selectiveBot);
        assert.equal(
          resPartial.adminNotificationState?.status,
          'partial_sent',
          'При сбое у 1 из 3 админов статус обязан быть partial_sent, а не sent',
        );
        assert.equal(
          resPartial.adminNotifiedAt,
          undefined,
          'При частичной доставке adminNotifiedAt НЕ должен устанавливаться',
        );
        assert.equal(resPartial.adminNotificationState?.sentAt, undefined);
        assert.equal(resPartial.adminNotificationState?.recipientDeliveries?.[String(ADMIN_A)]?.status, 'sent');
        assert.equal(resPartial.adminNotificationState?.recipientDeliveries?.[String(ADMIN_B)]?.status, 'failed');
        assert.equal(resPartial.adminNotificationState?.recipientDeliveries?.[String(ADMIN_C)]?.status, 'sent');
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_A).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_B).length, 0);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_C).length, 1);

        // Проверка форматирования review-сообщения при partial_sent
        const reviewMsg = formatAdminNotificationReviewMessage(resPartial);
        assert.ok(reviewMsg.includes('partial_sent'));
        assert.ok(reviewMsg.includes(String(ADMIN_B)));

        // Сценарий 4: Повторная попытка (после восстановления связи с ADMIN_B):
        // ADMIN_A и ADMIN_C НЕ получают дубль; доставляется ТОЛЬКО ADMIN_B -> статус становится 'sent' + adminNotifiedAt!
        failingChatIds = new Set();
        const resRetry = await FulfillmentService.ensureAdminNotified(resPartial, selectiveBot);
        assert.equal(resRetry.adminNotificationState?.status, 'sent');
        assert.ok(resRetry.adminNotifiedAt);
        assert.equal(resRetry.adminNotificationState?.recipientDeliveries?.[String(ADMIN_B)]?.status, 'sent');
        assert.equal(resRetry.adminNotificationState?.recipientDeliveries?.[String(ADMIN_B)]?.attemptCount, 2);
        assert.equal(
          sentLog.filter((m) => m.chatId === ADMIN_A).length,
          1,
          'ADMIN_A уже получил уведомление ранее и не должен получить дубль при повторе',
        );
        assert.equal(
          sentLog.filter((m) => m.chatId === ADMIN_C).length,
          1,
          'ADMIN_C уже получил уведомление ранее и не должен получить дубль при повторе',
        );
        assert.equal(
          sentLog.filter((m) => m.chatId === ADMIN_B).length,
          1,
          'ADMIN_B должен получить уведомление при повторной попытке ровно 1 раз',
        );

        // Сценарий 5: Совместимость со старым заказом (есть legacy adminNotifiedAt без recipientDeliveries)
        sentLog.length = 0;
        const ordLegacy = await makeOrder('legacy_compat');
        await firestoreRepo.updateDoc<Order>('orders', ordLegacy.orderId, {
          adminNotifiedAt: new Date().toISOString(),
        });
        const loadedLegacy = (await OrderService.getOrderById(ordLegacy.orderId))!;
        await FulfillmentService.ensureAdminNotified(loadedLegacy, selectiveBot);
        assert.equal(sentLog.length, 0, 'Legacy-заказ с adminNotifiedAt не должен переотправляться автоматически');
      } finally {
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Сценарии all-sent, none-sent, partial_sent (1 из 3 упал), доотправка только недоставленному без дублей и совместимость с legacy-заказами подтверждены.';
    },
  );

  await runTest(
    'S443-03',
    'Database',
    'Stage 4.4.3: Надёжность MyStars polling checkpoint (ошибки чтения/записи Firestore, защита от перезапуска с начала очереди, рестарт и восстановление)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 443003, username: 's443_ckpt_buyer', first_name: 'CkptBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const mockBot = createMockBot([]);

      const TOTAL_ORDERS = 150;
      const polledOrderIdsPerTick: string[][] = [];
      let currentTickPolls: string[] = [];

      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s443_ckpt_key',
        paymentCurrency: 'usdt_ton',
      });
      const prevRetries = myStarsClient.maxTransientGetRetries;
      myStarsClient.maxTransientGetRetries = 0;
      myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
        const match = req.url.match(/\/v1\/orders\/([^/?]+)/);
        if (req.method === 'GET' && match) {
          const extId = decodeURIComponent(match[1]);
          currentTickPolls.push(extId);
          return {
            status: 200,
            ok: true,
            json: {
              order_id: extId,
              status: 'awaiting_payment',
              type: 'stars',
              recipient_username: 's443_ckpt_buyer',
              quantity: 100,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          };
        }
        throw new Error(`Unexpected URL in S443-03: ${req.method} ${req.url}`);
      });

      const prevBudget = FulfillmentService.pollBatchBudget;
      const prevPageSize = FulfillmentService.pollPageSize;
      const prevBackoff = FulfillmentService.checkpointBackoffBaseMs;
      const prevWorkerId = FulfillmentService.workerInstanceId;
      const origGetDoc = firestoreRepo.getDoc.bind(firestoreRepo);
      const origSetDoc = firestoreRepo.setDoc.bind(firestoreRepo);
      const origRunTransaction = firestoreRepo.runTransaction.bind(firestoreRepo);

      let failCheckpointRead = false;
      let failCheckpointWrite = false;

      firestoreRepo.getDoc = (async <T>(collection: string, docId: string): Promise<T | null> => {
        if (collection === 'settings' && docId === 'mystars_poll_cursor' && failCheckpointRead) {
          throw new Error('Simulated Firestore UNAVAILABLE on checkpoint read');
        }
        return origGetDoc<T>(collection as never, docId);
      }) as typeof firestoreRepo.getDoc;

      firestoreRepo.setDoc = (async <T extends object>(collection: string, docId: string, data: T): Promise<void> => {
        if (collection === 'settings' && docId === 'mystars_poll_cursor' && failCheckpointWrite) {
          throw new Error('Simulated Firestore DEADLINE_EXCEEDED on checkpoint write');
        }
        return origSetDoc<T>(collection as never, docId, data);
      }) as typeof firestoreRepo.setDoc;

      firestoreRepo.runTransaction = (async <R>(
        updateFn: (tx: RepoTransaction) => Promise<R>,
      ): Promise<R> => {
        return origRunTransaction(async (tx) => {
          const wrappedTx: RepoTransaction = {
            get: async <T>(collection: StoreCollectionName, docId: string): Promise<T | null> => {
              if (collection === 'settings' && docId === 'mystars_poll_cursor' && failCheckpointRead) {
                throw new Error('Simulated Firestore UNAVAILABLE on checkpoint read');
              }
              return tx.get<T>(collection, docId);
            },
            set: <T extends object>(collection: StoreCollectionName, docId: string, data: T): void => {
              if (collection === 'settings' && docId === 'mystars_poll_cursor' && failCheckpointWrite) {
                throw new Error('Simulated Firestore DEADLINE_EXCEEDED on checkpoint write');
              }
              tx.set<T>(collection, docId, data);
            },
          };
          return updateFn(wrappedTx);
        });
      }) as typeof firestoreRepo.runTransaction;

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.checkpointBackoffBaseMs = 0; // детерминированное тестирование без sleep
        FulfillmentService.pollBatchBudget = 30;
        FulfillmentService.pollPageSize = 50;
        await FulfillmentService.resetMyStarsPollCheckpoint();

        const baseMs = Date.now() - 3_600_000;
        for (let i = 1; i <= TOTAL_ORDERS; i++) {
          const ordId = `ord_ckpt_${String(i).padStart(3, '0')}`;
          const msId = `ms_ckpt_${String(i).padStart(3, '0')}`;
          const orderDoc: Order = {
            orderId: ordId,
            userId: `tg_${buyer.id}`,
            userTelegramId: buyer.id,
            username: buyer.username,
            recipientUsername: buyer.username,
            productId: 'stars_custom',
            productName: 'Telegram Stars',
            category: 'stars',
            quantity: 100,
            totalPriceUsdCents: 200,
            totalPrice: 200,
            currency: 'USD',
            paymentMethod: 'balance',
            paymentStatus: 'paid',
            fulfillmentStatus: 'processing',
            mystarsOrderId: msId,
            mystarsOrderStatus: 'awaiting_payment',
            createdAt: new Date(baseMs + i * 1000).toISOString(),
            updatedAt: new Date(baseMs + i * 1000).toISOString(),
          };
          await origSetDoc<Order>('orders', ordId, orderDoc);
        }

        // Тик 1 (здоровый): опрашивает #001..#030 и сохраняет checkpoint на ord_ckpt_030
        currentTickPolls = [];
        const tick1 = await FulfillmentService.pollMyStarsOrders(mockBot);
        polledOrderIdsPerTick.push([...currentTickPolls]);
        assert.equal(tick1.polled, 30);
        assert.equal(tick1.checkpointSaved, true);
        assert.equal(tick1.checkpointDegraded, false);
        const ckptAfter1 = await FulfillmentService.loadMyStarsPollCheckpoint();
        assert.equal(ckptAfter1?.cursorOrderId, 'ord_ckpt_030');

        // 1. Ошибка ЧТЕНИЯ checkpoint (loadMyStarsPollCheckpoint):
        // Прямой вызов выбрасывает MyStarsCheckpointError('load'), а pollMyStarsOrders явно фиксирует ошибку
        // и НЕ сбрасывает опрос на начало очереди (#001..#030)!
        failCheckpointRead = true;
        await assert.rejects(
          () => FulfillmentService.loadMyStarsPollCheckpoint(),
          (err: unknown) => err instanceof MyStarsCheckpointError && err.operation === 'load',
        );

        currentTickPolls = [];
        const tickReadFail = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickReadFail.polled, 0, 'При отказе чтения checkpoint не должно происходить повторное обслуживание начала очереди');
        assert.equal(tickReadFail.checkpointDegraded, true);
        assert.equal(tickReadFail.checkpointSaved, false);
        assert.ok(tickReadFail.checkpointError?.includes('UNAVAILABLE'));
        assert.equal(FulfillmentService.getMyStarsPollingStatus().checkpointDegraded, true);

        // Восстановление чтения Firestore: следующий тик продолжает ровно с #031..#060!
        failCheckpointRead = false;
        currentTickPolls = [];
        const tickAfterReadRecover = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickAfterReadRecover.polled, 30);
        assert.equal(tickAfterReadRecover.checkpointDegraded, false);
        assert.equal(tickAfterReadRecover.checkpointSaved, true);
        assert.equal(currentTickPolls[0], 'ms_ckpt_031', 'После восстановления чтения опрос должен продолжиться с #031, а не с #001');
        assert.equal(currentTickPolls[29], 'ms_ckpt_060');
        assert.equal((await FulfillmentService.loadMyStarsPollCheckpoint())?.cursorOrderId, 'ord_ckpt_060');

        // 2. Ошибка ЗАПИСИ checkpoint (saveMyStarsPollCheckpoint):
        // Тик опрашивает #061..#090, но запись cursor=#090 падает:
        // - checkpointSaved = false, checkpointDegraded = true, checkpointError заполнен;
        // - в Firestore остаётся подтверждённый cursor=#060 (не продвинут!);
        // - следующий тик, пока запись всё ещё падает, НЕ пересканирует повторно #061..#090 или #001..#030!
        failCheckpointWrite = true;
        currentTickPolls = [];
        const tickWriteFail = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickWriteFail.polled, 30);
        assert.equal(currentTickPolls[0], 'ms_ckpt_061');
        assert.equal(tickWriteFail.checkpointSaved, false);
        assert.equal(tickWriteFail.checkpointDegraded, true);
        assert.ok(tickWriteFail.checkpointError?.includes('DEADLINE_EXCEEDED'));
        assert.equal(FulfillmentService.getMyStarsPollingStatus().hasPendingUnsavedCheckpoint, true);
        assert.equal(
          (await FulfillmentService.loadMyStarsPollCheckpoint())?.cursorOrderId,
          'ord_ckpt_060',
          'Cursor в Firestore не должен быть продвинут при ошибке сохранения',
        );

        // Пока запись всё ещё недоступна, повторный тик пытается дозаписать pending checkpoint и НЕ опрашивает очередь по кругу
        currentTickPolls = [];
        const tickStillFailing = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickStillFailing.polled, 0, 'Пока checkpoint не сохраняется, не должно быть повторного обслуживания тех же заказов');
        assert.equal(tickStillFailing.checkpointDegraded, true);
        assert.equal(tickStillFailing.checkpointSaved, false);

        // 3. Восстановление записи Firestore без рестарта -> дозаписывает pending cursor=#090 и переходит к #091..#120!
        failCheckpointWrite = false;
        currentTickPolls = [];
        const tickAfterWriteRecover = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickAfterWriteRecover.polled, 30);
        assert.equal(tickAfterWriteRecover.checkpointSaved, true);
        assert.equal(tickAfterWriteRecover.checkpointDegraded, false);
        assert.equal(currentTickPolls[0], 'ms_ckpt_091', 'После дозаписи pending checkpoint опрос должен продолжиться с #091');
        assert.equal(currentTickPolls[29], 'ms_ckpt_120');
        assert.equal((await FulfillmentService.loadMyStarsPollCheckpoint())?.cursorOrderId, 'ord_ckpt_120');

        // 4. Ошибка записи checkpoint + РЕСТАРТ процесса:
        // Опрашивает #121..#150, запись падает (cursor в Firestore остаётся #120).
        // После рестарта (resetMyStarsPollingState) процесс восстанавливает Firestore и честно продолжает с последнего подтверждённого cursor=#120!
        failCheckpointWrite = true;
        currentTickPolls = [];
        const tickBeforeRestart = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickBeforeRestart.polled, 30);
        assert.equal(tickBeforeRestart.checkpointSaved, false);
        assert.equal(currentTickPolls[0], 'ms_ckpt_121');

        // Имитируем рестарт процесса + восстановление Firestore
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.workerInstanceId = 'restarted-ckpt-worker';
        failCheckpointWrite = false;

        const ckptOnRestart = await FulfillmentService.loadMyStarsPollCheckpoint();
        assert.equal(
          ckptOnRestart?.cursorOrderId,
          'ord_ckpt_120',
          'После рестарта процесс должен видеть последний реально сохранённый cursor (#120)',
        );
        currentTickPolls = [];
        const tickAfterRestart = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickAfterRestart.polled, 30);
        assert.equal(tickAfterRestart.checkpointSaved, true);
        assert.equal(currentTickPolls[0], 'ms_ckpt_121', 'После рестарта опрос безопасно возобновляется с #121 без потери хвоста очереди');
        assert.equal(currentTickPolls[29], 'ms_ckpt_150');

        // Проверяем, что механизм распределённых leases по-прежнему полностью работает (все leases освобождены после тиков)
        const sampleOrd = await OrderService.getOrderById('ord_ckpt_150');
        assert.equal(sampleOrd?.mystarsPollLease, undefined, 'Распределённый lease должен корректно освобождаться после опроса');
      } finally {
        firestoreRepo.getDoc = origGetDoc;
        firestoreRepo.setDoc = origSetDoc;
        firestoreRepo.runTransaction = origRunTransaction;
        FulfillmentService.pollBatchBudget = prevBudget;
        FulfillmentService.pollPageSize = prevPageSize;
        FulfillmentService.checkpointBackoffBaseMs = prevBackoff;
        FulfillmentService.workerInstanceId = prevWorkerId;
        myStarsClient.maxTransientGetRetries = prevRetries;
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Ошибки чтения/записи MyStars polling checkpoint явно фиксируются, не сбрасывают опрос на начало очереди и безопасно восстанавливаются (включая рестарт).';
    },
  );

  // =========================================================================
  // STAGE 4.4.4 — INDEPENDENT VERIFICATION & REGRESSION AUDIT TESTS
  // =========================================================================

  await runTest(
    'S444-01',
    'Database',
    'Stage 4.4.4: Регрессии MyStars checkpoint (HTTP 429 в середине и на 1-м заказе батча не пропускает заказ, защита от отката checkpoint при multi-worker, восстановление повреждённого документа)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyer = { id: 444001, username: 's444_ckpt_buyer', first_name: 'Buyer444' };
      await UserService.upsertFromTelegram(buyer);
      const mockBot = createMockBot([]);

      const TOTAL_ORDERS = 50;
      let rateLimitTargetExtId: string | null = null;
      let polledThisTick: string[] = [];

      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_s444_key',
        paymentCurrency: 'usdt_ton',
      });
      const prevRetries = myStarsClient.maxTransientGetRetries;
      myStarsClient.maxTransientGetRetries = 0;
      myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
        const match = req.url.match(/\/v1\/orders\/([^/?]+)/);
        if (req.method === 'GET' && match) {
          const extId = decodeURIComponent(match[1]);
          polledThisTick.push(extId);
          if (rateLimitTargetExtId === extId) {
            return {
              status: 429,
              ok: false,
              headers: { 'retry-after': '1' },
              json: { error: 'Too many requests' },
            };
          }
          return {
            status: 200,
            ok: true,
            json: {
              order_id: extId,
              status: 'awaiting_payment',
              type: 'stars',
              recipient_username: 's444_ckpt_buyer',
              quantity: 100,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          };
        }
        throw new Error(`Unexpected URL in S444-01: ${req.method} ${req.url}`);
      });

      const prevBudget = FulfillmentService.pollBatchBudget;
      const prevPageSize = FulfillmentService.pollPageSize;
      const prevBackoff = FulfillmentService.checkpointBackoffBaseMs;
      const origSetDoc = firestoreRepo.setDoc.bind(firestoreRepo);
      const origRunTransaction = firestoreRepo.runTransaction.bind(firestoreRepo);
      let failCheckpointWrite = false;

      firestoreRepo.setDoc = (async <T extends object>(collection: string, docId: string, data: T): Promise<void> => {
        if (collection === 'settings' && docId === 'mystars_poll_cursor' && failCheckpointWrite) {
          throw new Error('Simulated Worker-A checkpoint write failure');
        }
        return origSetDoc<T>(collection as never, docId, data);
      }) as typeof firestoreRepo.setDoc;

      firestoreRepo.runTransaction = (async <R>(
        updateFn: (tx: RepoTransaction) => Promise<R>,
      ): Promise<R> => {
        return origRunTransaction(async (tx) => {
          const wrappedTx: RepoTransaction = {
            get: <T>(collection: StoreCollectionName, docId: string) => tx.get<T>(collection, docId),
            set: <T extends object>(collection: StoreCollectionName, docId: string, data: T): void => {
              if (collection === 'settings' && docId === 'mystars_poll_cursor' && failCheckpointWrite) {
                throw new Error('Simulated Worker-A checkpoint write failure');
              }
              tx.set<T>(collection, docId, data);
            },
          };
          return updateFn(wrappedTx);
        });
      }) as typeof firestoreRepo.runTransaction;

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.checkpointBackoffBaseMs = 0;
        FulfillmentService.pollBatchBudget = 10;
        FulfillmentService.pollPageSize = 15;
        await FulfillmentService.resetMyStarsPollCheckpoint();

        const baseMs = Date.now() - 3_600_000;
        for (let i = 1; i <= TOTAL_ORDERS; i++) {
          const ordId = `ord_s444_${String(i).padStart(3, '0')}`;
          const msId = `ms_s444_${String(i).padStart(3, '0')}`;
          const orderDoc: Order = {
            orderId: ordId,
            userId: `tg_${buyer.id}`,
            userTelegramId: buyer.id,
            username: buyer.username,
            recipientUsername: buyer.username,
            productId: 'stars_custom',
            productName: 'Telegram Stars',
            category: 'stars',
            quantity: 100,
            totalPriceUsdCents: 200,
            totalPrice: 200,
            currency: 'USD',
            paymentMethod: 'balance',
            paymentStatus: 'paid',
            fulfillmentStatus: 'processing',
            mystarsOrderId: msId,
            mystarsOrderStatus: 'awaiting_payment',
            createdAt: new Date(baseMs + i * 1000).toISOString(),
            updatedAt: new Date(baseMs + i * 1000).toISOString(),
          };
          await origSetDoc<Order>('orders', ordId, orderDoc);
        }

        // 1. HTTP 429 в середине батча (на #005): checkpoint должен сохраниться на #004 (последний ЗАВЕРШЁННЫЙ), а НЕ #005!
        rateLimitTargetExtId = 'ms_s444_005';
        polledThisTick = [];
        const tickMid429 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickMid429.rateLimited, true);
        assert.deepEqual(polledThisTick, [
          'ms_s444_001',
          'ms_s444_002',
          'ms_s444_003',
          'ms_s444_004',
          'ms_s444_005',
        ]);
        const ckptMid = await FulfillmentService.loadMyStarsPollCheckpoint();
        assert.equal(
          ckptMid?.cursorOrderId,
          'ord_s444_004',
          'При 429 на #005 курсор обязан остановиться на #004, чтобы не пропустить #005',
        );

        // Сбрасываем cooldown (имитируем окончание Retry-After), но #005 снова получает 429 (первый заказ батча!)
        FulfillmentService.resetMyStarsPollingState();
        polledThisTick = [];
        const tickFirst429 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickFirst429.rateLimited, true);
        assert.deepEqual(polledThisTick, ['ms_s444_005']);
        const ckptFirst = await FulfillmentService.loadMyStarsPollCheckpoint();
        assert.equal(
          ckptFirst?.cursorOrderId,
          'ord_s444_004',
          'При 429 на самом первом заказе батча (#005) курсор обязан остаться на #004, не перескакивая вперёд',
        );

        // Снимаем 429 и cooldown: следующий тик начинает СТРОГО с #005 (0 пропусков!)
        rateLimitTargetExtId = null;
        FulfillmentService.resetMyStarsPollingState();
        polledThisTick = [];
        const tickAfter429 = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickAfter429.rateLimited, false);
        assert.equal(polledThisTick[0], 'ms_s444_005', 'После снятия 429 опрос обязан начаться с #005 без пропуска');
        assert.equal(polledThisTick[9], 'ms_s444_014');
        assert.equal((await FulfillmentService.loadMyStarsPollCheckpoint())?.cursorOrderId, 'ord_s444_014');

        // 2. Multi-worker защита от отката checkpoint назад:
        // Worker A опрашивает #015..#024, запись падает (pendingUnsavedCheckpoint=#024).
        // Тем временем Worker B продвинул Firestore checkpoint до #035.
        // При восстановлении записи Worker A сбрасывает pendingUnsavedCheckpoint — Firestore НЕ откатывается к #024!
        failCheckpointWrite = true;
        polledThisTick = [];
        const tickWorkerAFail = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickWorkerAFail.checkpointSaved, false);
        assert.equal(FulfillmentService.getMyStarsPollingStatus().hasPendingUnsavedCheckpoint, true);

        const ord35 = (await OrderService.getOrderById('ord_s444_035'))!;
        const preWorkerBDoc = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        await origSetDoc('settings', 'mystars_poll_cursor', {
          key: 'mystars_poll_cursor',
          cursorCreatedAt: ord35.createdAt,
          cursorOrderId: ord35.orderId,
          cyclesCompleted: 0,
          lastPolledCount: 10,
          updatedAt: new Date().toISOString(),
          resetEpoch: preWorkerBDoc?.resetEpoch ?? 0,
        });

        failCheckpointWrite = false;
        polledThisTick = [];
        const tickWorkerARecover = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickWorkerARecover.checkpointSaved, true);
        assert.equal(
          polledThisTick[0],
          'ms_s444_036',
          'Worker A обязан принять более свежий checkpoint Worker B (#035) и продолжить с #036, без отката к #024',
        );
        assert.equal((await FulfillmentService.loadMyStarsPollCheckpoint())?.cursorOrderId, 'ord_s444_045');

        // 3. Повреждённый документ checkpoint в Firestore (невалидные поля/полузаполненный курсор/плохая дата)
        const corruptedDocs: Array<Record<string, unknown>> = [
          { key: 'mystars_poll_cursor', cyclesCompleted: 'NaN', cursorOrderId: 'ord_s444_010' },
          { key: 'mystars_poll_cursor', cyclesCompleted: 0, cursorOrderId: 'ord_s444_010' }, // нет cursorCreatedAt
          { key: 'mystars_poll_cursor', cyclesCompleted: 0, cursorOrderId: 'ord_s444_010', cursorCreatedAt: 'not-a-date' },
          { key: 'wrong_key', cyclesCompleted: -5 },
        ];

        for (const badDoc of corruptedDocs) {
          await origSetDoc('settings', 'mystars_poll_cursor', badDoc);
          const loaded = await FulfillmentService.loadMyStarsPollCheckpoint();
          assert.equal(loaded, null, 'Повреждённый checkpoint должен безопасно сбрасываться и возвращать null');
          const repaired = await firestoreRepo.getDoc<Record<string, unknown>>(
            'settings',
            'mystars_poll_cursor',
          );
          assert.equal(repaired?.key, 'mystars_poll_cursor');
          assert.equal(repaired?.cyclesCompleted, 0);
          assert.equal(repaired?.cursorOrderId, undefined);
        }

        // После самовосстановления повреждённого документа polling работает чисто с начала очереди
        polledThisTick = [];
        const tickAfterCorrupt = await FulfillmentService.pollMyStarsOrders(mockBot);
        assert.equal(tickAfterCorrupt.polled, 10);
        assert.equal(polledThisTick[0], 'ms_s444_001');
      } finally {
        firestoreRepo.setDoc = origSetDoc;
        firestoreRepo.runTransaction = origRunTransaction;
        FulfillmentService.pollBatchBudget = prevBudget;
        FulfillmentService.pollPageSize = prevPageSize;
        FulfillmentService.checkpointBackoffBaseMs = prevBackoff;
        myStarsClient.maxTransientGetRetries = prevRetries;
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Регрессии checkpoint устранены и подтверждены: HTTP 429 (середина и 1-й заказ батча), монотонность при multi-worker и самовосстановление повреждённого документа.';
    },
  );

  await runTest(
    'S444-02',
    'Security',
    'Stage 4.4.4: Конкурентные admin notifications, смена ADMIN_IDS при partial_sent, краш при sending, forceResend с пустым ADMIN_IDS и защита admin callbacks',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;

      const buyer = { id: 444002, username: 's444_notif_buyer', first_name: 'Buyer444N' };
      await UserService.upsertFromTelegram(buyer);

      const ADMIN_A = 9444001;
      const ADMIN_B = 9444002;
      const ADMIN_C = 9444003;
      const ADMIN_D = 9444004;

      const makePaidOrder = async (suffix: string): Promise<Order> => {
        const o = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: `s444_${suffix}`,
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', o.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
        });
        return (await OrderService.getOrderById(o.orderId))!;
      };

      const sentLog: Array<{ chatId: number; text: string }> = [];
      let failingChatIds = new Set<number>();
      let artificialDelayMs = 0;

      const selectiveBot = {
        telegram: {
          sendMessage: async (chatId: number | string, text: string) => {
            if (artificialDelayMs > 0) {
              await new Promise((r) => setTimeout(r, artificialDelayMs));
            }
            const numericChatId = Number(chatId);
            if (failingChatIds.has(numericChatId)) {
              throw new Error(`Simulated Telegram failure for ${numericChatId}`);
            }
            sentLog.push({ chatId: numericChatId, text });
            return { message_id: sentLog.length };
          },
        },
      } as unknown as Telegraf;

      try {
        process.env.OWNER_TELEGRAM_ID = String(ADMIN_A);
        process.env.ADMIN_IDS = `${ADMIN_B},${ADMIN_C}`;

        // 1. Параллельный retry partial_sent (два воркера одновременно) -> ADMIN_B получает строго 1 раз, A и C — 0 дублей
        const ordConcurrent = await makePaidOrder('concurrent_partial');
        failingChatIds = new Set([ADMIN_B]);
        const partial1 = await FulfillmentService.ensureAdminNotified(ordConcurrent, selectiveBot);
        assert.equal(partial1.adminNotificationState?.status, 'partial_sent');
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_A).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_C).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_B).length, 0);

        failingChatIds = new Set();
        artificialDelayMs = 25;
        await Promise.all([
          FulfillmentService.ensureAdminNotified(partial1, selectiveBot),
          FulfillmentService.ensureAdminNotified(partial1, selectiveBot),
        ]);
        artificialDelayMs = 0;
        const afterConcurrent = (await OrderService.getOrderById(ordConcurrent.orderId))!;
        assert.equal(afterConcurrent.adminNotificationState?.status, 'sent');
        assert.ok(afterConcurrent.adminNotifiedAt);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_A).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_C).length, 1);
        assert.equal(
          sentLog.filter((m) => m.chatId === ADMIN_B).length,
          1,
          'При параллельном запуске двух воркеров ADMIN_B обязан получить ровно 1 сообщение',
        );

        // 2. Изменение ADMIN_IDS при partial_sent:
        // 2a. Удаление упавшего ADMIN_B -> автоматическая консолидация в 'sent' без спама A и C
        sentLog.length = 0;
        const ordRemovedAdmin = await makePaidOrder('removed_admin');
        failingChatIds = new Set([ADMIN_B]);
        const partialRem = await FulfillmentService.ensureAdminNotified(ordRemovedAdmin, selectiveBot);
        assert.equal(partialRem.adminNotificationState?.status, 'partial_sent');
        assert.equal(sentLog.length, 2);

        process.env.ADMIN_IDS = `${ADMIN_C}`; // ADMIN_B удалён из конфигурации
        const reconciledRem = await FulfillmentService.ensureAdminNotified(partialRem, selectiveBot);
        assert.equal(reconciledRem.adminNotificationState?.status, 'sent');
        assert.ok(reconciledRem.adminNotifiedAt);
        assert.equal(sentLog.length, 2, 'Консолидация после удаления упавшего админа не должна спамить уже получивших');

        // 2b. Добавление нового ADMIN_D при partial_sent -> отправляется ТОЛЬКО B и D (0 дублей A и C)
        sentLog.length = 0;
        process.env.ADMIN_IDS = `${ADMIN_B},${ADMIN_C}`;
        const ordAddedAdmin = await makePaidOrder('added_admin');
        failingChatIds = new Set([ADMIN_B]);
        const partialAdd = await FulfillmentService.ensureAdminNotified(ordAddedAdmin, selectiveBot);
        assert.equal(partialAdd.adminNotificationState?.status, 'partial_sent');
        assert.equal(sentLog.length, 2);

        process.env.ADMIN_IDS = `${ADMIN_B},${ADMIN_C},${ADMIN_D}`;
        failingChatIds = new Set();
        const completedAdd = await FulfillmentService.ensureAdminNotified(partialAdd, selectiveBot);
        assert.equal(completedAdd.adminNotificationState?.status, 'sent');
        assert.ok(completedAdd.adminNotifiedAt);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_A).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_C).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_B).length, 1);
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_D).length, 1);

        // 3. Краш процесса во время sending на partial_sent -> A и C остаются 'sent', только B становится 'delivery_uncertain',
        // а последующий forceResend отправляет ТОЛЬКО B без спама A и C
        sentLog.length = 0;
        process.env.ADMIN_IDS = `${ADMIN_B},${ADMIN_C}`;
        const ordCrashPartial = await makePaidOrder('crash_partial');
        failingChatIds = new Set([ADMIN_B]);
        const partialCrash = await FulfillmentService.ensureAdminNotified(ordCrashPartial, selectiveBot);
        assert.equal(partialCrash.adminNotificationState?.status, 'partial_sent');

        // Имитируем зависший истекший sending-lease во время повторной отправки
        await firestoreRepo.updateDoc<Order>('orders', ordCrashPartial.orderId, {
          adminNotificationState: {
            ...partialCrash.adminNotificationState!,
            status: 'sending',
            leaseUntil: Timestamp.fromMillis(Date.now() - 10_000),
          },
        });
        const stalePartial = (await OrderService.getOrderById(ordCrashPartial.orderId))!;
        const uncertainPartial = await FulfillmentService.ensureAdminNotified(stalePartial, selectiveBot);
        assert.equal(uncertainPartial.adminNotificationState?.status, 'delivery_uncertain');
        assert.equal(uncertainPartial.adminNotificationState?.recipientDeliveries?.[String(ADMIN_A)]?.status, 'sent');
        assert.equal(uncertainPartial.adminNotificationState?.recipientDeliveries?.[String(ADMIN_C)]?.status, 'sent');
        assert.equal(
          uncertainPartial.adminNotificationState?.recipientDeliveries?.[String(ADMIN_B)]?.status,
          'delivery_uncertain',
        );

        failingChatIds = new Set();
        const resendRes = await FulfillmentService.forceResendOrderNotification({
          orderId: ordCrashPartial.orderId,
          target: 'admin',
          bot: selectiveBot,
        });
        assert.equal(resendRes.sentAdmin, true);
        assert.equal(resendRes.order.adminNotificationState?.status, 'sent');
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_A).length, 1, 'A не должен получить дубль при forceResend');
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_C).length, 1, 'C не должен получить дубль при forceResend');
        assert.equal(sentLog.filter((m) => m.chatId === ADMIN_B).length, 1, 'B должен получить сообщение ровно 1 раз');

        // 4. forceResendOrderNotification при пустом ADMIN_IDS на УЖЕ 'sent' заказе не портит статус и возвращает sentAdmin=false
        process.env.OWNER_TELEGRAM_ID = '';
        process.env.ADMIN_IDS = '';
        const emptyResendOnSent = await FulfillmentService.forceResendOrderNotification({
          orderId: ordCrashPartial.orderId,
          target: 'admin',
          bot: selectiveBot,
        });
        assert.equal(emptyResendOnSent.sentAdmin, false);
        assert.equal(
          emptyResendOnSent.order.adminNotificationState?.status,
          'sent',
          'Пустой ADMIN_IDS при forceResend не должен разрушать уже подтверждённый статус sent',
        );

        // 5. Безопасность админ-колбэков: не-админ блокируется ensureAdmin, дублирующийся клик блокируется debounce
        process.env.OWNER_TELEGRAM_ID = String(ADMIN_A);
        process.env.ADMIN_IDS = `${ADMIN_B}`;
        const harness = createWiredBotHarness(true);
        const nonAdminUser = { id: 777666555, username: 'intruder_user', first_name: 'Intruder' };
        await harness.sendCallback(nonAdminUser, `adm:ord_notify_review:${ordCrashPartial.orderId}`);
        assert.ok(
          harness.lastAnswer()?.text?.includes('Доступ разрешён только администраторам'),
          'Не-админ должен получать отказ доступа на adm:ord_notify_review',
        );
        await harness.sendCallback(nonAdminUser, `adm:ord_notify_resend_admin:${ordCrashPartial.orderId}`);
        assert.ok(
          harness.lastAnswer()?.text?.includes('Доступ разрешён только администраторам'),
          'Не-админ должен получать отказ доступа на adm:ord_notify_resend_admin',
        );

        // Дублирующийся клик админа по adm:ord_notify_review блокируется isDuplicateCallbackClick
        const adminUser = { id: ADMIN_A, username: 'owner_admin', first_name: 'Owner' };
        const beforeAdminClicks = harness.calls.length;
        await harness.sendCallback(adminUser, `adm:ord_notify_review:${ordCrashPartial.orderId}`);
        const afterFirstClick = harness.calls.length;
        assert.ok(afterFirstClick > beforeAdminClicks, 'Первый клик админа должен открыть review-карточку');
        await harness.sendCallback(adminUser, `adm:ord_notify_review:${ordCrashPartial.orderId}`);
        assert.equal(
          harness.calls.length,
          afterFirstClick,
          'Повторный мгновенный клик админа должен блокироваться debounce без повторной отрисовки',
        );
      } finally {
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Конкурентная доставка partial_sent, смена ADMIN_IDS, краш с сохранением recipientDeliveries, защита sent от пустого ADMIN_IDS и RBAC админ-колбэков подтверждены.';
    },
  );

  // =========================================================================
  // STAGE 4.5 — ATOMIC CHECKPOINT & MULTI-WORKER INTEGRITY TESTS
  // =========================================================================

  await runTest(
    'S450-01',
    'Database',
    'Stage 4.5: Конкурентная запись checkpoint двумя workers (разные курсоры, смена цикла, tie-breaker по orderId и старый pending checkpoint Worker A после записи Worker B)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevMaxAttempts = FulfillmentService.checkpointTransactionMaxAttempts;
      const prevRetryDelay = FulfillmentService.checkpointConflictRetryDelayMs;
      const prevBackoff = FulfillmentService.checkpointBackoffBaseMs;
      const prevBudget = FulfillmentService.pollBatchBudget;
      const prevPageSize = FulfillmentService.pollPageSize;
      const origRunTransaction = firestoreRepo.runTransaction.bind(firestoreRepo);

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.checkpointBackoffBaseMs = 0;
        FulfillmentService.checkpointConflictRetryDelayMs = 1;
        await FulfillmentService.resetMyStarsPollCheckpoint();

        const baseMs = Date.now() - 3_600_000;
        const makeCkpt = (
          orderNum: number | null,
          cyclesCompleted: number,
          resetEpoch = 1,
          sameTimestampOffsetMs?: number,
        ): MyStarsPollCheckpoint => ({
          key: 'mystars_poll_cursor',
          ...(orderNum !== null
            ? {
                cursorCreatedAt: new Date(
                  baseMs + (sameTimestampOffsetMs ?? orderNum * 1000),
                ).toISOString(),
                cursorOrderId: `ord_s450_${String(orderNum).padStart(3, '0')}`,
              }
            : {}),
          cyclesCompleted,
          lastPolledCount: 10,
          updatedAt: new Date().toISOString(),
          resetEpoch,
        });

        // 1a. Worker A (#020) и Worker B (#050) одновременно сохраняют разные курсоры -> в Firestore строго #050
        await Promise.all([
          FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(20, 0, 1)),
          FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(50, 0, 1)),
        ]);
        const stored1 = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(
          stored1?.cursorOrderId,
          'ord_s450_050',
          'При конкурентной записи #020 и #050 в Firestore обязан победить #050',
        );
        assert.equal(
          FulfillmentService.getMyStarsPollingStatus().lastConfirmedCursorOrderId,
          'ord_s450_050',
        );

        // 1b. Обратный порядок (#080 vs #030) с искусственной задержкой внутри транзакции -> в Firestore строго #080
        await Promise.all([
          FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(80, 0, 1)),
          FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(30, 0, 1)),
        ]);
        const stored2 = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(
          stored2?.cursorOrderId,
          'ord_s450_080',
          'Обратный конкурентный порядок не должен откатывать #080 к #030',
        );

        // 1c. Одинаковый createdAt, разный cursorOrderId (#085 vs #082) -> tie-breaker по cursorOrderId побеждает #085
        await Promise.all([
          FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(82, 0, 1, 90_000)),
          FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(85, 0, 1, 90_000)),
        ]);
        const storedTie = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(storedTie?.cursorOrderId, 'ord_s450_085');

        // 1d. Завершение цикла (cyclesCompleted=1, без курсора) vs старый курсор (cyclesCompleted=0, #099) -> побеждает cycle=1
        await Promise.all([
          FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(99, 0, 1)),
          FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(null, 1, 1)),
        ]);
        const storedWrap = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(storedWrap?.cyclesCompleted, 1);
        assert.equal(storedWrap?.cursorOrderId, undefined);
        assert.equal(storedWrap?.cursorCreatedAt, undefined);

        // 2. Worker A пытается дозаписать старый pendingUnsavedCheckpoint после записи Worker B (полный цикл pollMyStarsOrders)
        const buyer = { id: 450001, username: 's450_buyer', first_name: 'Buyer450' };
        await UserService.upsertFromTelegram(buyer);
        const mockBot = createMockBot([]);
        let polledThisTick: string[] = [];

        myStarsClient.setCredentialsOverride({
          apiBaseUrl: 'https://api.mystars.tg',
          apiKey: 'ms_live_s450_key',
          paymentCurrency: 'usdt_ton',
        });
        const prevRetries = myStarsClient.maxTransientGetRetries;
        myStarsClient.maxTransientGetRetries = 0;
        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          const match = req.url.match(/\/v1\/orders\/([^/?]+)/);
          if (req.method === 'GET' && match) {
            const extId = decodeURIComponent(match[1]);
            polledThisTick.push(extId);
            return {
              status: 200,
              ok: true,
              json: {
                order_id: extId,
                status: 'awaiting_payment',
                type: 'stars',
                recipient_username: 's450_buyer',
                quantity: 100,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected URL in S450-01: ${req.method} ${req.url}`);
        });

        try {
          FulfillmentService.pollBatchBudget = 10;
          FulfillmentService.pollPageSize = 15;
          const resetDoc = await FulfillmentService.resetMyStarsPollCheckpoint();
          const currentEpoch = resetDoc.resetEpoch!;

          for (let i = 1; i <= 50; i++) {
            const ordId = `ord_s450p_${String(i).padStart(3, '0')}`;
            await firestoreRepo.setDoc<Order>('orders', ordId, {
              orderId: ordId,
              userId: `tg_${buyer.id}`,
              userTelegramId: buyer.id,
              username: buyer.username,
              recipientUsername: buyer.username,
              productId: 'stars_custom',
              productName: 'Telegram Stars',
              category: 'stars',
              quantity: 100,
              totalPriceUsdCents: 200,
              totalPrice: 200,
              currency: 'USD',
              paymentMethod: 'balance',
              paymentStatus: 'paid',
              fulfillmentStatus: 'processing',
              mystarsOrderId: `ms_s450p_${String(i).padStart(3, '0')}`,
              mystarsOrderStatus: 'awaiting_payment',
              createdAt: new Date(baseMs + i * 1000).toISOString(),
              updatedAt: new Date(baseMs + i * 1000).toISOString(),
            });
          }

          // Тик 1: успешно доходит до #010
          polledThisTick = [];
          const t1 = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(t1.checkpointSaved, true);
          assert.equal(
            (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
            'ord_s450p_010',
          );

          // Тик 2 (Worker A): опрашивает #011..#020, но транзакция сохранения checkpoint падает
          let failWorkerATx = true;
          firestoreRepo.runTransaction = (async <R>(
            updateFn: (tx: RepoTransaction) => Promise<R>,
          ): Promise<R> => {
            return origRunTransaction(async (tx) => {
              const wrappedTx: RepoTransaction = {
                get: <T>(c: StoreCollectionName, id: string) => tx.get<T>(c, id),
                set: <T extends object>(c: StoreCollectionName, id: string, data: T): void => {
                  if (c === 'settings' && id === 'mystars_poll_cursor' && failWorkerATx) {
                    throw new Error('Simulated Worker-A Firestore transaction error');
                  }
                  tx.set<T>(c, id, data);
                },
              };
              return updateFn(wrappedTx);
            });
          }) as typeof firestoreRepo.runTransaction;

          polledThisTick = [];
          const t2Fail = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(t2Fail.checkpointSaved, false);
          assert.equal(t2Fail.checkpointDegraded, true);
          assert.equal(FulfillmentService.getMyStarsPollingStatus().hasPendingUnsavedCheckpoint, true);
          assert.equal(
            (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
            'ord_s450p_010',
            'После ошибки транзакции Worker A в Firestore обязан остаться #010',
          );

          // Worker B (через реальную транзакцию) продвигает Firestore до #035
          failWorkerATx = false;
          const ord35 = (await OrderService.getOrderById('ord_s450p_035'))!;
          await origRunTransaction(async (tx) => {
            tx.set<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor', {
              key: 'mystars_poll_cursor',
              cursorCreatedAt: ord35.createdAt,
              cursorOrderId: ord35.orderId,
              cyclesCompleted: 0,
              lastPolledCount: 10,
              updatedAt: new Date().toISOString(),
              resetEpoch: currentEpoch,
            });
          });

          // Worker A восстанавливается, сбрасывает старый pending (#020) и НЕ откатывает #035 -> опрашивает #036..#045!
          polledThisTick = [];
          const t3Recover = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(t3Recover.checkpointSaved, true);
          assert.equal(t3Recover.checkpointDegraded, false);
          assert.equal(FulfillmentService.getMyStarsPollingStatus().hasPendingUnsavedCheckpoint, false);
          assert.equal(polledThisTick[0], 'ms_s450p_036');
          assert.equal(
            (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
            'ord_s450p_045',
            'Конечное состояние Firestore обязано продвинуться от #035 к #045 без отката к #020',
          );
        } finally {
          myStarsClient.maxTransientGetRetries = prevRetries;
          myStarsClient.resetHttpTransport();
          myStarsClient.setCredentialsOverride(null);
        }
      } finally {
        firestoreRepo.runTransaction = origRunTransaction;
        FulfillmentService.checkpointTransactionMaxAttempts = prevMaxAttempts;
        FulfillmentService.checkpointConflictRetryDelayMs = prevRetryDelay;
        FulfillmentService.checkpointBackoffBaseMs = prevBackoff;
        FulfillmentService.pollBatchBudget = prevBudget;
        FulfillmentService.pollPageSize = prevPageSize;
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Атомарная монотонность checkpoint при конкурентной записи и сбросе старого pending подтверждена по конечному состоянию Firestore.';
    },
  );

  await runTest(
    'S450-02',
    'Database',
    'Stage 4.5: Атомарное восстановление повреждённого checkpoint двумя workers и конкурентный reset vs сохранение checkpoint',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const origGetDoc = firestoreRepo.getDoc.bind(firestoreRepo);
      const prevRetryDelay = FulfillmentService.checkpointConflictRetryDelayMs;

      try {
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.checkpointConflictRetryDelayMs = 1;

        // 1. Два worker одновременно обнаруживают повреждённый документ -> атомарный ремонт без ошибок и гонок
        await firestoreRepo.setDoc('settings', 'mystars_poll_cursor', {
          key: 'mystars_poll_cursor',
          cyclesCompleted: 'corrupted_value',
          cursorOrderId: 'ord_broken',
        });
        const [loadA, loadB] = await Promise.all([
          FulfillmentService.loadMyStarsPollCheckpoint(),
          FulfillmentService.loadMyStarsPollCheckpoint(),
        ]);
        // Первый возвращает null (выполнил ремонт), второй видит уже отремонтированный валидный документ (cyclesCompleted=0, без курсора)
        assert.equal(loadA === null || loadB === null, true);
        const afterDualRepair = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(afterDualRepair?.key, 'mystars_poll_cursor');
        assert.equal(afterDualRepair?.cyclesCompleted, 0);
        assert.equal(afterDualRepair?.cursorOrderId, undefined);
        assert.equal(afterDualRepair?.cursorCreatedAt, undefined);

        // 2. Гонка: Worker A прочитал повреждённый документ, но до входа в repair-транзакцию
        // Worker B успел сохранить валидный checkpoint #030 -> Worker A НЕ перезаписывает #030!
        await firestoreRepo.setDoc('settings', 'mystars_poll_cursor', {
          key: 'mystars_poll_cursor',
          cyclesCompleted: -7,
          cursorCreatedAt: 'invalid-iso',
          cursorOrderId: 'ord_corrupt',
        });

        const validB: MyStarsPollCheckpoint = {
          key: 'mystars_poll_cursor',
          cursorCreatedAt: new Date(Date.now() - 60_000).toISOString(),
          cursorOrderId: 'ord_s450_valid_030',
          cyclesCompleted: 0,
          lastPolledCount: 15,
          updatedAt: new Date().toISOString(),
          resetEpoch: 0,
        };

        let injectedConcurrentValidWrite = false;
        firestoreRepo.getDoc = (async <T>(collection: string, docId: string): Promise<T | null> => {
          const res = await origGetDoc<T>(collection as never, docId);
          if (
            collection === 'settings' &&
            docId === 'mystars_poll_cursor' &&
            !injectedConcurrentValidWrite
          ) {
            injectedConcurrentValidWrite = true;
            // Имитируем параллельного Worker B, который прямо сейчас сохранил валидный checkpoint #030
            await FulfillmentService.saveMyStarsPollCheckpoint(validB);
          }
          return res;
        }) as typeof firestoreRepo.getDoc;

        const loadedAfterRace = await FulfillmentService.loadMyStarsPollCheckpoint();
        firestoreRepo.getDoc = origGetDoc;

        assert.equal(
          loadedAfterRace?.cursorOrderId,
          'ord_s450_valid_030',
          'Worker A обязан увидеть валидный #030 внутри транзакции ремонта и вернуть его без перезаписи',
        );
        const persistedAfterRace = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(
          persistedAfterRace?.cursorOrderId,
          'ord_s450_valid_030',
          'Восстановление повреждённого документа одним worker НЕ должно перезаписывать валидный checkpoint другого worker',
        );

        // 3. Конкурентный reset vs сохранение checkpoint:
        // 3a. Worker B стартовал ДО reset (resetEpoch=0, cycle=3, cursor=#090), а Admin выполнил reset (resetEpoch -> 1).
        // Попытка Worker B сохранить устаревший pre-reset checkpoint обязана быть отклонена!
        const beforeResetEpoch = persistedAfterRace?.resetEpoch ?? 0;
        const stalePreResetCkpt: MyStarsPollCheckpoint = {
          key: 'mystars_poll_cursor',
          cursorCreatedAt: new Date(Date.now() - 10_000).toISOString(),
          cursorOrderId: 'ord_s450_stale_090',
          cyclesCompleted: 3,
          lastPolledCount: 25,
          updatedAt: new Date().toISOString(),
          resetEpoch: beforeResetEpoch,
        };

        // Запускаем reset и stale-save конкурентно в обоих порядках
        await Promise.all([
          FulfillmentService.resetMyStarsPollCheckpoint(),
          FulfillmentService.saveMyStarsPollCheckpoint(stalePreResetCkpt),
        ]);
        const afterConcurrentReset1 = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(afterConcurrentReset1?.resetEpoch, beforeResetEpoch + 1);
        assert.equal(afterConcurrentReset1?.cyclesCompleted, 0);
        assert.equal(
          afterConcurrentReset1?.cursorOrderId,
          undefined,
          'Pre-reset checkpoint со старым resetEpoch не может отменить явный административный reset',
        );

        // Повторная попытка stale-save ПОСЛЕ reset тоже отклоняется
        await FulfillmentService.saveMyStarsPollCheckpoint(stalePreResetCkpt);
        const afterLateStaleSave = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(afterLateStaleSave?.resetEpoch, beforeResetEpoch + 1);
        assert.equal(afterLateStaleSave?.cyclesCompleted, 0);
        assert.equal(afterLateStaleSave?.cursorOrderId, undefined);

        // 3b. Новый checkpoint ПОСЛЕ reset (с актуальным resetEpoch) сохраняется успешно,
        // а обычная запись с нулевым курсором НЕ может случайно сбросить его назад
        const postResetNewCkpt: MyStarsPollCheckpoint = {
          key: 'mystars_poll_cursor',
          cursorCreatedAt: new Date(Date.now() - 5_000).toISOString(),
          cursorOrderId: 'ord_s450_post_reset_010',
          cyclesCompleted: 0,
          lastPolledCount: 10,
          updatedAt: new Date().toISOString(),
          resetEpoch: afterLateStaleSave!.resetEpoch,
        };
        await FulfillmentService.saveMyStarsPollCheckpoint(postResetNewCkpt);
        const afterPostResetSave = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(afterPostResetSave?.cursorOrderId, 'ord_s450_post_reset_010');

        // Попытка обычной saveMyStarsPollCheckpoint записать «пустой» checkpoint в ту же эпоху не должна сбрасывать курсор
        await FulfillmentService.saveMyStarsPollCheckpoint({
          key: 'mystars_poll_cursor',
          cyclesCompleted: 0,
          lastPolledCount: 0,
          updatedAt: new Date().toISOString(),
          resetEpoch: afterLateStaleSave!.resetEpoch,
        });
        const stillPostReset = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(
          stillPostReset?.cursorOrderId,
          'ord_s450_post_reset_010',
          'Обычный saveMyStarsPollCheckpoint не должен позволять случайный сброс курсора',
        );
      } finally {
        firestoreRepo.getDoc = origGetDoc;
        FulfillmentService.checkpointConflictRetryDelayMs = prevRetryDelay;
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Атомарный ремонт повреждённого checkpoint (без перезаписи валидного курсора другого worker) и изоляция административного reset через resetEpoch подтверждены.';
    },
  );

  await runTest(
    'S450-03',
    'Database',
    'Stage 4.5: Конфликт транзакции Firestore (ABORTED + retry), исчерпание попыток без ложного подтверждения, backoff и рестарт процесса',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const origRunTransaction = firestoreRepo.runTransaction.bind(firestoreRepo);
      const prevMaxAttempts = FulfillmentService.checkpointTransactionMaxAttempts;
      const prevRetryDelay = FulfillmentService.checkpointConflictRetryDelayMs;
      const prevBackoff = FulfillmentService.checkpointBackoffBaseMs;
      const prevBudget = FulfillmentService.pollBatchBudget;
      const prevPageSize = FulfillmentService.pollPageSize;

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.checkpointTransactionMaxAttempts = 4;
        FulfillmentService.checkpointConflictRetryDelayMs = 1;
        FulfillmentService.checkpointBackoffBaseMs = 0;

        const baseMs = Date.now() - 3_600_000;
        const resetDoc = await FulfillmentService.resetMyStarsPollCheckpoint();
        const epoch = resetDoc.resetEpoch!;

        const makeCkpt = (num: number): MyStarsPollCheckpoint => ({
          key: 'mystars_poll_cursor',
          cursorCreatedAt: new Date(baseMs + num * 1000).toISOString(),
          cursorOrderId: `ord_s450tx_${String(num).padStart(3, '0')}`,
          cyclesCompleted: 0,
          lastPolledCount: 10,
          updatedAt: new Date().toISOString(),
          resetEpoch: epoch,
        });

        // 1. Конфликт транзакции Firestore (2 раза ABORTED/contention, на 3-й раз успех):
        // Во время 1-го конфликта другой worker успевает зафиксировать #020.
        // 1a. Наш worker сохраняет #040 (> #020) -> после retry в Firestore #040!
        let conflictAttempts = 0;
        let conflictsRemaining = 2;
        let workerBInjected = false;

        firestoreRepo.runTransaction = (async <R>(
          updateFn: (tx: RepoTransaction) => Promise<R>,
        ): Promise<R> => {
          conflictAttempts += 1;
          if (conflictsRemaining > 0) {
            conflictsRemaining -= 1;
            if (!workerBInjected) {
              workerBInjected = true;
              await origRunTransaction(async (innerTx) => {
                innerTx.set<MyStarsPollCheckpoint>(
                  'settings',
                  'mystars_poll_cursor',
                  makeCkpt(20),
                );
              });
            }
            const conflictErr = new Error('10 ABORTED: Cross-transaction contention on settings/mystars_poll_cursor') as Error & { code?: number };
            conflictErr.code = 10;
            throw conflictErr;
          }
          return origRunTransaction(updateFn);
        }) as typeof firestoreRepo.runTransaction;

        const savedAfterRetry = await FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(40));
        assert.equal(conflictAttempts, 3, 'Транзакция должна автоматически повториться после 2 конфликтов ABORTED');
        assert.equal(savedAfterRetry.cursorOrderId, 'ord_s450tx_040');
        assert.equal(
          (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
          'ord_s450tx_040',
        );

        // 1b. Конфликт при попытке записать более старый #015 (пока в Firestore уже #040) -> retry видит #040 и НЕ откатывает!
        conflictAttempts = 0;
        conflictsRemaining = 1;
        const keptAfterRetry = await FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(15));
        assert.equal(conflictAttempts, 2);
        assert.equal(keptAfterRetry.cursorOrderId, 'ord_s450tx_040');
        assert.equal(
          (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
          'ord_s450tx_040',
        );

        // 2. Исчерпание всех попыток конфликта транзакции -> явная ошибка, НЕТ ложного подтверждения, Firestore не изменён
        conflictAttempts = 0;
        conflictsRemaining = 10;
        await assert.rejects(
          () => FulfillmentService.saveMyStarsPollCheckpoint(makeCkpt(60)),
          (err: unknown) => err instanceof MyStarsCheckpointError && err.operation === 'save',
        );
        assert.equal(
          conflictAttempts,
          FulfillmentService.checkpointTransactionMaxAttempts,
          'Должно выполняться ровно checkpointTransactionMaxAttempts попыток при непрекращающемся конфликте',
        );
        assert.equal(FulfillmentService.getMyStarsPollingStatus().checkpointDegraded, true);
        assert.equal(
          FulfillmentService.getMyStarsPollingStatus().lastConfirmedCursorOrderId,
          'ord_s450tx_040',
          'lastConfirmedCursorOrderId НЕ должен ложно обновляться до #060 при ошибке транзакции',
        );
        assert.equal(
          (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
          'ord_s450tx_040',
          'Документ в Firestore обязан остаться на #040 после провала транзакции',
        );

        // 3. Проверка backoff + рестарт процесса после ошибки транзакции в pollMyStarsOrders
        firestoreRepo.runTransaction = origRunTransaction;
        const buyer = { id: 450003, username: 's450_tx_buyer', first_name: 'Buyer450Tx' };
        await UserService.upsertFromTelegram(buyer);
        const mockBot = createMockBot([]);
        let polledThisTick: string[] = [];

        myStarsClient.setCredentialsOverride({
          apiBaseUrl: 'https://api.mystars.tg',
          apiKey: 'ms_live_s450tx_key',
          paymentCurrency: 'usdt_ton',
        });
        const prevRetries = myStarsClient.maxTransientGetRetries;
        myStarsClient.maxTransientGetRetries = 0;
        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          const match = req.url.match(/\/v1\/orders\/([^/?]+)/);
          if (req.method === 'GET' && match) {
            const extId = decodeURIComponent(match[1]);
            polledThisTick.push(extId);
            return {
              status: 200,
              ok: true,
              json: {
                order_id: extId,
                status: 'awaiting_payment',
                type: 'stars',
                recipient_username: 's450_tx_buyer',
                quantity: 100,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected URL in S450-03: ${req.method} ${req.url}`);
        });

        try {
          FulfillmentService.resetMyStarsPollingState();
          FulfillmentService.pollBatchBudget = 5;
          FulfillmentService.pollPageSize = 10;
          FulfillmentService.checkpointBackoffBaseMs = 5_000;
          await FulfillmentService.resetMyStarsPollCheckpoint();

          for (let i = 1; i <= 20; i++) {
            const ordId = `ord_s450b_${String(i).padStart(3, '0')}`;
            await firestoreRepo.setDoc<Order>('orders', ordId, {
              orderId: ordId,
              userId: `tg_${buyer.id}`,
              userTelegramId: buyer.id,
              username: buyer.username,
              recipientUsername: buyer.username,
              productId: 'stars_custom',
              productName: 'Telegram Stars',
              category: 'stars',
              quantity: 100,
              totalPriceUsdCents: 200,
              totalPrice: 200,
              currency: 'USD',
              paymentMethod: 'balance',
              paymentStatus: 'paid',
              fulfillmentStatus: 'processing',
              mystarsOrderId: `ms_s450b_${String(i).padStart(3, '0')}`,
              mystarsOrderStatus: 'awaiting_payment',
              createdAt: new Date(baseMs + i * 1000).toISOString(),
              updatedAt: new Date(baseMs + i * 1000).toISOString(),
            });
          }

          // Тик 1 успешен (#001..#005 -> checkpoint=#005)
          polledThisTick = [];
          const tOk = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(tOk.checkpointSaved, true);
          assert.equal(
            (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
            'ord_s450b_005',
          );

          // Тик 2: не-конфликтная ошибка транзакции на записи #010 -> ставится backoff и pendingUnsavedCheckpoint
          let failTxNonRetryable = true;
          firestoreRepo.runTransaction = (async <R>(
            updateFn: (tx: RepoTransaction) => Promise<R>,
          ): Promise<R> => {
            return origRunTransaction(async (tx) => {
              const wrappedTx: RepoTransaction = {
                get: <T>(c: StoreCollectionName, id: string) => tx.get<T>(c, id),
                set: <T extends object>(c: StoreCollectionName, id: string, data: T): void => {
                  if (c === 'settings' && id === 'mystars_poll_cursor' && failTxNonRetryable) {
                    throw new Error('4 DEADLINE_EXCEEDED: Firestore commit timed out');
                  }
                  tx.set<T>(c, id, data);
                },
              };
              return updateFn(wrappedTx);
            });
          }) as typeof firestoreRepo.runTransaction;

          polledThisTick = [];
          const tFail = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(tFail.checkpointSaved, false);
          assert.equal(tFail.checkpointDegraded, true);
          assert.equal(FulfillmentService.getMyStarsPollingStatus().hasPendingUnsavedCheckpoint, true);
          assert.equal(
            (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
            'ord_s450b_005',
          );

          // Во время активного backoff тик пропускается без повторного опроса очереди
          polledThisTick = [];
          const tBackoff = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(tBackoff.deferredByCooldown, true);
          assert.equal(tBackoff.polled, 0);
          assert.equal(polledThisTick.length, 0);

          // Рестарт процесса + восстановление Firestore: продолжает с подтверждённого #005 -> опрашивает #006..#010!
          failTxNonRetryable = false;
          FulfillmentService.resetMyStarsPollingState();
          polledThisTick = [];
          const tRestart = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(tRestart.checkpointSaved, true);
          assert.equal(tRestart.checkpointDegraded, false);
          assert.equal(polledThisTick[0], 'ms_s450b_006');
          assert.equal(polledThisTick[4], 'ms_s450b_010');
          assert.equal(
            (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))?.cursorOrderId,
            'ord_s450b_010',
          );
        } finally {
          myStarsClient.maxTransientGetRetries = prevRetries;
          myStarsClient.resetHttpTransport();
          myStarsClient.setCredentialsOverride(null);
        }
      } finally {
        firestoreRepo.runTransaction = origRunTransaction;
        FulfillmentService.checkpointTransactionMaxAttempts = prevMaxAttempts;
        FulfillmentService.checkpointConflictRetryDelayMs = prevRetryDelay;
        FulfillmentService.checkpointBackoffBaseMs = prevBackoff;
        FulfillmentService.pollBatchBudget = prevBudget;
        FulfillmentService.pollPageSize = prevPageSize;
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Повтор транзакции при конфликте ABORTED, защита от ложного подтверждения при исчерпании попыток/ошибке, backoff и рестарт процесса подтверждены.';
    },
  );

  await runTest(
    'S450-04',
    'Database',
    'Stage 4.5 (Reset Epoch Fix): Нормализация отсутствующего resetEpoch к 0, приоритет эпохи над курсором/циклом, защита pending/stale worker после reset и совместимость со старыми документами',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const origRunTransaction = firestoreRepo.runTransaction.bind(firestoreRepo);
      const prevMaxAttempts = FulfillmentService.checkpointTransactionMaxAttempts;
      const prevRetryDelay = FulfillmentService.checkpointConflictRetryDelayMs;
      const prevBackoff = FulfillmentService.checkpointBackoffBaseMs;
      const prevBudget = FulfillmentService.pollBatchBudget;
      const prevPageSize = FulfillmentService.pollPageSize;

      try {
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.checkpointTransactionMaxAttempts = 4;
        FulfillmentService.checkpointConflictRetryDelayMs = 1;
        FulfillmentService.checkpointBackoffBaseMs = 0;

        const baseMs = Date.now() - 3_600_000;
        const makeCkpt = (params: {
          num: number | null;
          cycle: number;
          resetEpoch?: number;
          createdOffsetMs?: number;
        }): MyStarsPollCheckpoint => {
          const doc: MyStarsPollCheckpoint = {
            key: 'mystars_poll_cursor',
            cyclesCompleted: params.cycle,
            lastPolledCount: 10,
            updatedAt: new Date().toISOString(),
          };
          if (params.num !== null) {
            doc.cursorCreatedAt = new Date(
              baseMs + (params.createdOffsetMs ?? params.num * 1000),
            ).toISOString();
            doc.cursorOrderId = `ord_s450ep_${String(params.num).padStart(3, '0')}`;
          }
          if (params.resetEpoch !== undefined) {
            doc.resetEpoch = params.resetEpoch;
          }
          return doc;
        };

        // -----------------------------------------------------------------------
        // Кейс 1: Incoming checkpoint БЕЗ resetEpoch (даже с большим циклом и курсором)
        // против Firestore checkpoint с resetEpoch = 1 -> запись обязана быть ОТКЛОНЕНА!
        // -----------------------------------------------------------------------
        await firestoreRepo.setDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor', {
          key: 'mystars_poll_cursor',
          cyclesCompleted: 0,
          lastPolledCount: 0,
          updatedAt: new Date().toISOString(),
          resetEpoch: 1,
        });
        const incomingNoEpoch = makeCkpt({ num: 99, cycle: 5 }); // resetEpoch отсутствует -> трактуется как 0
        const resCase1 = await FulfillmentService.saveMyStarsPollCheckpoint(incomingNoEpoch);
        assert.equal(resCase1.resetEpoch, 1, 'Effective checkpoint обязан остаться в эпохе 1');
        assert.equal(resCase1.cyclesCompleted, 0);
        assert.equal(resCase1.cursorOrderId, undefined);
        const docCase1 = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(docCase1?.resetEpoch, 1, 'Firestore обязан сохранить resetEpoch=1');
        assert.equal(docCase1?.cyclesCompleted, 0);
        assert.equal(
          docCase1?.cursorOrderId,
          undefined,
          'Incoming без resetEpoch не должен перезаписывать checkpoint эпохи 1',
        );

        // -----------------------------------------------------------------------
        // Кейс 2: Incoming checkpoint с resetEpoch = 0 против Firestore с resetEpoch = 2
        // -> запись обязана быть ОТКЛОНЕНА!
        // -----------------------------------------------------------------------
        await firestoreRepo.setDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
          makeCkpt({ num: 10, cycle: 0, resetEpoch: 2 }),
        );
        const resCase2 = await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: 500, cycle: 9, resetEpoch: 0 }),
        );
        assert.equal(resCase2.resetEpoch, 2);
        assert.equal(resCase2.cursorOrderId, 'ord_s450ep_010');
        const docCase2 = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(docCase2?.resetEpoch, 2);
        assert.equal(
          docCase2?.cursorOrderId,
          'ord_s450ep_010',
          'Incoming с resetEpoch=0 не должен перезаписывать checkpoint с resetEpoch=2',
        );

        // -----------------------------------------------------------------------
        // Кейс 3: Incoming checkpoint с resetEpoch = 2 (cycle=0, без курсора)
        // против Firestore с resetEpoch = 1 (cycle=5, cursor=#090) -> запись РАЗРЕШЕНА!
        // -----------------------------------------------------------------------
        await firestoreRepo.setDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
          makeCkpt({ num: 90, cycle: 5, resetEpoch: 1 }),
        );
        const resCase3 = await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: null, cycle: 0, resetEpoch: 2 }),
        );
        assert.equal(resCase3.resetEpoch, 2);
        assert.equal(resCase3.cyclesCompleted, 0);
        assert.equal(resCase3.cursorOrderId, undefined);
        const docCase3 = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(
          docCase3?.resetEpoch,
          2,
          'Checkpoint более новой эпохи (resetEpoch=2) обязан иметь приоритет над эпохой 1',
        );
        assert.equal(docCase3?.cyclesCompleted, 0);
        assert.equal(docCase3?.cursorOrderId, undefined);

        // -----------------------------------------------------------------------
        // Кейс 4: Одинаковые эпохи -> корректное сравнение циклов, наличия курсора,
        // cursorCreatedAt и tie-breaker по cursorOrderId
        // -----------------------------------------------------------------------
        // 4a. В рамках epoch=2: пустой -> #015 -> попытка отката к пустому и #010 отклонены -> tie-breaker #015 vs #018 -> cycle 1
        await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: 15, cycle: 0, resetEpoch: 2, createdOffsetMs: 50_000 }),
        );
        assert.equal(
          (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))
            ?.cursorOrderId,
          'ord_s450ep_015',
        );
        // Откат к отсутствующему курсору или более раннему курсору в той же эпохе запрещён
        await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: null, cycle: 0, resetEpoch: 2 }),
        );
        await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: 10, cycle: 0, resetEpoch: 2, createdOffsetMs: 40_000 }),
        );
        assert.equal(
          (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))
            ?.cursorOrderId,
          'ord_s450ep_015',
        );
        // Одинаковый cursorCreatedAt: #018 > #015 (tie-breaker по orderId), затем #016 < #018 отклонён
        await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: 18, cycle: 0, resetEpoch: 2, createdOffsetMs: 50_000 }),
        );
        await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: 16, cycle: 0, resetEpoch: 2, createdOffsetMs: 50_000 }),
        );
        assert.equal(
          (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))
            ?.cursorOrderId,
          'ord_s450ep_018',
        );
        // Переход на cycle=1 (без курсора) в той же эпохе 2 разрешён; возврат на cycle=0 #099 запрещён
        await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: null, cycle: 1, resetEpoch: 2 }),
        );
        await FulfillmentService.saveMyStarsPollCheckpoint(
          makeCkpt({ num: 99, cycle: 0, resetEpoch: 2 }),
        );
        const docCase4 = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        assert.equal(docCase4?.resetEpoch, 2);
        assert.equal(docCase4?.cyclesCompleted, 1);
        assert.equal(docCase4?.cursorOrderId, undefined);

        // -----------------------------------------------------------------------
        // Кейс 7 (проверка legacy-документов без resetEpoch до сброса и после рестарта):
        // Старые документы без поля resetEpoch корректно загружаются как эпоха 0 (без repair)
        // -----------------------------------------------------------------------
        const legacyRawWithCursor = {
          key: 'mystars_poll_cursor',
          cursorCreatedAt: new Date(baseMs + 5_000).toISOString(),
          cursorOrderId: 'ord_s450leg_005',
          cyclesCompleted: 0,
          lastPolledCount: 5,
          updatedAt: new Date().toISOString(),
          // resetEpoch намеренно отсутствует (legacy-документ)
        };
        await firestoreRepo.setDoc('settings', 'mystars_poll_cursor', legacyRawWithCursor);
        // Имитация рестарта процесса
        FulfillmentService.resetMyStarsPollingState();

        const loadedLegacy = await FulfillmentService.loadMyStarsPollCheckpoint();
        assert.ok(loadedLegacy !== null, 'Старый документ без resetEpoch НЕ должен считаться повреждённым');
        assert.equal(loadedLegacy?.cursorOrderId, 'ord_s450leg_005');
        assert.equal(loadedLegacy?.cyclesCompleted, 0);
        assert.equal(loadedLegacy?.resetEpoch, 0, 'Отсутствующий resetEpoch должен нормализоваться к 0');

        // Сохранение в эпохе 0 (без resetEpoch) поверх legacy-документа сравнивает курсоры корректно
        await FulfillmentService.saveMyStarsPollCheckpoint({
          key: 'mystars_poll_cursor',
          cursorCreatedAt: new Date(baseMs + 3_000).toISOString(),
          cursorOrderId: 'ord_s450leg_003',
          cyclesCompleted: 0,
          lastPolledCount: 3,
          updatedAt: new Date().toISOString(),
        });
        assert.equal(
          (await firestoreRepo.getDoc<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor'))
            ?.cursorOrderId,
          'ord_s450leg_005',
          'Более старый курсор без resetEpoch не должен откатывать legacy-документ',
        );

        // -----------------------------------------------------------------------
        // Кейсы 5 и 6 (реальный pollMyStarsOrders + pendingUnsavedCheckpoint + stale worker после reset):
        // -----------------------------------------------------------------------
        const buyer = { id: 450004, username: 's450_epoch_buyer', first_name: 'Buyer450Epoch' };
        await UserService.upsertFromTelegram(buyer);
        const mockBot = createMockBot([]);
        let polledThisTick: string[] = [];

        myStarsClient.setCredentialsOverride({
          apiBaseUrl: 'https://api.mystars.tg',
          apiKey: 'ms_live_s450ep_key',
          paymentCurrency: 'usdt_ton',
        });
        const prevRetries = myStarsClient.maxTransientGetRetries;
        myStarsClient.maxTransientGetRetries = 0;
        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          const match = req.url.match(/\/v1\/orders\/([^/?]+)/);
          if (req.method === 'GET' && match) {
            const extId = decodeURIComponent(match[1]);
            polledThisTick.push(extId);
            return {
              status: 200,
              ok: true,
              json: {
                order_id: extId,
                status: 'awaiting_payment',
                type: 'stars',
                recipient_username: 's450_epoch_buyer',
                quantity: 100,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected URL in S450-04: ${req.method} ${req.url}`);
        });

        try {
          FulfillmentService.pollBatchBudget = 5;
          FulfillmentService.pollPageSize = 10;

          for (let i = 1; i <= 25; i++) {
            const ordId = `ord_s450leg_${String(i).padStart(3, '0')}`;
            await firestoreRepo.setDoc<Order>('orders', ordId, {
              orderId: ordId,
              userId: `tg_${buyer.id}`,
              userTelegramId: buyer.id,
              username: buyer.username,
              recipientUsername: buyer.username,
              productId: 'stars_custom',
              productName: 'Telegram Stars',
              category: 'stars',
              quantity: 100,
              totalPriceUsdCents: 200,
              totalPrice: 200,
              currency: 'USD',
              paymentMethod: 'balance',
              paymentStatus: 'paid',
              fulfillmentStatus: 'processing',
              mystarsOrderId: `ms_s450leg_${String(i).padStart(3, '0')}`,
              mystarsOrderStatus: 'awaiting_payment',
              createdAt: new Date(baseMs + i * 1000).toISOString(),
              updatedAt: new Date(baseMs + i * 1000).toISOString(),
            });
          }

          // Кейс 7 (продолжение): после рестарта на legacy-документе #005 (без resetEpoch)
          // pollMyStarsOrders продолжает строго с #006..#010 в эпохе 0!
          await firestoreRepo.setDoc('settings', 'mystars_poll_cursor', legacyRawWithCursor);
          FulfillmentService.resetMyStarsPollingState();
          polledThisTick = [];
          const tickLegacyContinue = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(tickLegacyContinue.checkpointSaved, true);
          assert.equal(polledThisTick[0], 'ms_s450leg_006');
          assert.equal(polledThisTick[4], 'ms_s450leg_010');
          const afterLegacyPoll = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
            'settings',
            'mystars_poll_cursor',
          );
          assert.equal(afterLegacyPoll?.cursorOrderId, 'ord_s450leg_010');
          assert.equal(afterLegacyPoll?.resetEpoch, 0);

          // Кейс 5: Worker A опрашивает #011..#015 (в эпохе 0), но запись падает ->
          // в памяти Worker A остаётся pendingUnsavedCheckpoint (#015, resetEpoch=0).
          let failSave = true;
          firestoreRepo.runTransaction = (async <R>(
            updateFn: (tx: RepoTransaction) => Promise<R>,
          ): Promise<R> => {
            return origRunTransaction(async (tx) => {
              const wrappedTx: RepoTransaction = {
                get: <T>(c: StoreCollectionName, id: string) => tx.get<T>(c, id),
                set: <T extends object>(c: StoreCollectionName, id: string, data: T): void => {
                  if (c === 'settings' && id === 'mystars_poll_cursor' && failSave) {
                    throw new Error('4 DEADLINE_EXCEEDED: Simulated Worker A save failure');
                  }
                  tx.set<T>(c, id, data);
                },
              };
              return updateFn(wrappedTx);
            });
          }) as typeof firestoreRepo.runTransaction;

          polledThisTick = [];
          const tickPendingFail = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(tickPendingFail.checkpointSaved, false);
          assert.equal(FulfillmentService.getMyStarsPollingStatus().hasPendingUnsavedCheckpoint, true);
          assert.equal(polledThisTick[4], 'ms_s450leg_015');

          // Тем временем администратор на другом инстансе/процессе делает reset -> в Firestore теперь resetEpoch=1, cursor=undefined!
          // Записываем reset-документ новой эпохи напрямую через транзакцию, не очищая локальный pendingUnsavedCheckpoint Worker A.
          failSave = false;
          firestoreRepo.runTransaction = origRunTransaction;
          await origRunTransaction(async (tx) => {
            tx.set<MyStarsPollCheckpoint>('settings', 'mystars_poll_cursor', {
              key: 'mystars_poll_cursor',
              cyclesCompleted: 0,
              lastPolledCount: 0,
              updatedAt: new Date().toISOString(),
              resetEpoch: 1,
            });
          });

          // Worker A восстанавливается: сначала пытается сбросить старый pendingUnsavedCheckpoint (#015, epoch=0).
          // Он ОБЯЗАН быть отклонён в пользу эпохи 1, очищен из pending и опрос обязан начаться с начала очереди (#001..#005) в эпохе 1!
          polledThisTick = [];
          const tickAfterEpochBump = await FulfillmentService.pollMyStarsOrders(mockBot);
          assert.equal(tickAfterEpochBump.checkpointSaved, true);
          assert.equal(FulfillmentService.getMyStarsPollingStatus().hasPendingUnsavedCheckpoint, false);
          assert.equal(
            polledThisTick[0],
            'ms_s450leg_001',
            'Старый pending checkpoint (epoch=0, #015) НЕ должен перезаписывать reset (epoch=1) — опрос обязан начаться с #001',
          );
          assert.equal(polledThisTick[4], 'ms_s450leg_005');
          const docAfterPendingFlush = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
            'settings',
            'mystars_poll_cursor',
          );
          assert.equal(docAfterPendingFlush?.resetEpoch, 1);
          assert.equal(docAfterPendingFlush?.cursorOrderId, 'ord_s450leg_005');

          // Кейс 6: Старый воркер после явного resetMyStarsPollCheckpoint() (эпоха 1 -> 2)
          // не может вернуть состояние до сброса ни конкурентно, ни позже (ни с epoch=1, ни с epoch=0, ни без resetEpoch)
          const staleWorkerSnapshotEpoch1: MyStarsPollCheckpoint = {
            key: 'mystars_poll_cursor',
            cursorCreatedAt: new Date(baseMs + 20_000).toISOString(),
            cursorOrderId: 'ord_s450leg_020',
            cyclesCompleted: 4,
            lastPolledCount: 10,
            updatedAt: new Date().toISOString(),
            resetEpoch: 1,
          };
          const staleWorkerSnapshotLegacy: MyStarsPollCheckpoint = {
            key: 'mystars_poll_cursor',
            cursorCreatedAt: new Date(baseMs + 25_000).toISOString(),
            cursorOrderId: 'ord_s450leg_025',
            cyclesCompleted: 7,
            lastPolledCount: 10,
            updatedAt: new Date().toISOString(),
          };

          const [resetResult] = await Promise.all([
            FulfillmentService.resetMyStarsPollCheckpoint(),
            FulfillmentService.saveMyStarsPollCheckpoint(staleWorkerSnapshotEpoch1),
            FulfillmentService.saveMyStarsPollCheckpoint(staleWorkerSnapshotLegacy),
          ]);
          assert.equal(resetResult.resetEpoch, 2);

          // Дополнительные поздние записи от старых воркеров после reset также отклоняются
          await FulfillmentService.saveMyStarsPollCheckpoint(staleWorkerSnapshotEpoch1);
          await FulfillmentService.saveMyStarsPollCheckpoint(staleWorkerSnapshotLegacy);
          const docAfterStaleWorkers = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
            'settings',
            'mystars_poll_cursor',
          );
          assert.equal(docAfterStaleWorkers?.resetEpoch, 2);
          assert.equal(docAfterStaleWorkers?.cyclesCompleted, 0);
          assert.equal(
            docAfterStaleWorkers?.cursorOrderId,
            undefined,
            'Старые воркеры (с epoch=1 или без resetEpoch) не могут откатить состояние после reset (epoch=2)',
          );
        } finally {
          myStarsClient.maxTransientGetRetries = prevRetries;
          myStarsClient.resetHttpTransport();
          myStarsClient.setCredentialsOverride(null);
        }
      } finally {
        firestoreRepo.runTransaction = origRunTransaction;
        FulfillmentService.checkpointTransactionMaxAttempts = prevMaxAttempts;
        FulfillmentService.checkpointConflictRetryDelayMs = prevRetryDelay;
        FulfillmentService.checkpointBackoffBaseMs = prevBackoff;
        FulfillmentService.pollBatchBudget = prevBudget;
        FulfillmentService.pollPageSize = prevPageSize;
        FulfillmentService.resetAdapterToDefault();
        FulfillmentService.resetMyStarsPollingState();
      }

      return 'Нормализация отсутствующего resetEpoch к 0, абсолютный приоритет эпохи, защита pending/stale workers после reset и загрузка legacy-документов без resetEpoch подтверждены.';
    },
  );

  // ===========================================================================
  // STAGE 2.1 — FULFILLMENT NOTIFICATION RECOVERY TESTS
  // ===========================================================================
  await runTest(
    'S21-01',
    'Fulfillment',
    'Stage 2.1: recoverPendingFulfillments восстанавливает pending buyer notification для completed-заказов (включая crash-before-notify и антиголодание >50 заказов)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '777000111';
      process.env.OWNER_TELEGRAM_ID = '999000999';

      let mystarsPostCalls = 0;

      try {
        const buyerPending = { id: 210101, username: 's21_buyer_pending', first_name: 'PendingBuyer' };
        const buyerCrash = { id: 210102, username: 's21_buyer_crash', first_name: 'CrashBuyer' };
        const buyerFiller = { id: 210103, username: 's21_buyer_filler', first_name: 'FillerBuyer' };
        await UserService.upsertFromTelegram(buyerPending);
        await UserService.upsertFromTelegram(buyerCrash);
        await UserService.upsertFromTelegram(buyerFiller);

        // 1. Старый completed-заказ с buyerNotificationState.status='pending' (после >55 более новых completed-заказов)
        const oldPendingOrder = await OrderService.createOrder({
          telegramUser: buyerPending,
          recipientUsername: 's21_buyer_pending',
          productId: 'stars_custom',
          quantity: 100,
        });
        const oldIso = new Date(Date.now() - 3_600_000).toISOString();
        await firestoreRepo.updateDoc<Order>('orders', oldPendingOrder.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: oldIso,
          createdAt: oldIso,
          mystarsOrderId: 'ms_s21_completed_old',
          adminNotifiedAt: oldIso,
          adminNotificationState: {
            status: 'sent',
            eventId: `evt_admin_${oldPendingOrder.orderId}`,
            operationId: 'op_admin_done',
            leaseOwner: 'worker_prev',
            attemptCount: 1,
            sentAt: oldIso,
            deliveryUncertainAfterCrash: false,
          },
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${oldPendingOrder.orderId}`,
            operationId: 'op_buyer_failed_1',
            leaseOwner: 'worker_prev',
            attemptCount: 1,
            lastError: 'Telegram 502 Bad Gateway',
          },
        });

        // 2. Создаём 55 уже уведомлённых более новых completed-заказов (проверка, что dot-path индекс не голодает)
        const nowMs = Date.now();
        for (let i = 0; i < 55; i++) {
          const tsIso = new Date(nowMs - 60_000 + i * 500).toISOString();
          const fillerId = `ord_s21_filler_${String(i).padStart(3, '0')}`;
          await firestoreRepo.setDoc<Order>('orders', fillerId, {
            ...oldPendingOrder,
            orderId: fillerId,
            userId: `tg_${buyerFiller.id}`,
            userTelegramId: buyerFiller.id,
            createdAt: tsIso,
            updatedAt: tsIso,
            completedAt: tsIso,
            buyerNotifiedAt: tsIso,
            buyerNotificationState: {
              status: 'sent',
              eventId: `evt_buyer_completed_${fillerId}`,
              operationId: `op_done_${i}`,
              leaseOwner: 'worker_prev',
              attemptCount: 1,
              sentAt: tsIso,
              deliveryUncertainAfterCrash: false,
            },
          });
        }

        // 3. Недавний completed-заказ после крэша между commit completed и стартом ensureBuyerNotified (нет buyerNotificationState и нет buyerNotifiedAt)
        const crashOrder = await OrderService.createOrder({
          telegramUser: buyerCrash,
          recipientUsername: 's21_buyer_crash',
          productId: 'stars_custom',
          quantity: 50,
        });
        const recentIso = new Date(nowMs + 5_000).toISOString();
        await firestoreRepo.updateDoc<Order>('orders', crashOrder.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: recentIso,
          createdAt: recentIso,
          adminNotifiedAt: recentIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: undefined,
        });

        myStarsClient.setCredentialsOverride({
          apiKey: 'ms_test_s21_01_key_secret',
          apiBaseUrl: 'https://mystars.example.test',
        });
        myStarsClient.setHttpTransport(async (req) => {
          if (req.method === 'POST') mystarsPostCalls++;
          return {
            status: 200,
            ok: true,
            json: { order_id: req.url.split('/').pop(), status: 'completed' },
          };
        });

        const messages: Array<{ chatId: number | string; text: string }> = [];
        const bot = createMockBot(messages);

        const recovered = await FulfillmentService.recoverPendingFulfillments(bot);
        const recoveredIds = new Set(recovered.map((o) => o.orderId));
        assert.ok(
          recoveredIds.has(oldPendingOrder.orderId),
          'Старый completed-заказ с pending buyerNotificationState должен быть восстановлен без голодания',
        );
        assert.ok(
          recoveredIds.has(crashOrder.orderId),
          'Недавний completed-заказ без buyerNotificationState и buyerNotifiedAt должен быть восстановлен',
        );

        const updatedOld = await OrderService.getOrderById(oldPendingOrder.orderId);
        assert.equal(updatedOld?.fulfillmentStatus, 'completed');
        assert.equal(updatedOld?.buyerNotificationState?.status, 'sent');
        assert.ok(updatedOld?.buyerNotifiedAt);
        assert.equal(updatedOld?.buyerNotificationState?.lastError, undefined);

        const updatedCrash = await OrderService.getOrderById(crashOrder.orderId);
        assert.equal(updatedCrash?.fulfillmentStatus, 'completed');
        assert.equal(updatedCrash?.buyerNotificationState?.status, 'sent');
        assert.ok(updatedCrash?.buyerNotifiedAt);

        assert.equal(
          messages.filter((m) => m.chatId === buyerPending.id).length,
          1,
          'Покупателю старого completed-заказа должно уйти ровно 1 сообщение',
        );
        assert.equal(
          messages.filter((m) => m.chatId === buyerCrash.id).length,
          1,
          'Покупателю crash-completed заказа должно уйти ровно 1 сообщение',
        );
        assert.equal(
          messages.filter((m) => m.chatId === buyerFiller.id).length,
          0,
          'Уже уведомлённым completed-заказам не должно отправляться ни одного сообщения',
        );
        assert.equal(
          mystarsPostCalls,
          0,
          'Восстановление уведомлений НЕ должно повторно вызывать MyStars POST /v1/orders',
        );
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Pending и crash-before-notify completed buyer notifications восстановлены без голодания (>55 заказов) и без повторной выдачи.';
    },
  );

  await runTest(
    'S21-02',
    'Fulfillment',
    'Stage 2.1: recoverPendingFulfillments НЕ пересылает уведомление для completed-заказа со статусом sent или legacy buyerNotifiedAt',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const buyerSent = { id: 210201, username: 's21_buyer_sent', first_name: 'SentBuyer' };
      const buyerLegacy = { id: 210202, username: 's21_buyer_legacy', first_name: 'LegacyBuyer' };
      await UserService.upsertFromTelegram(buyerSent);
      await UserService.upsertFromTelegram(buyerLegacy);

      const nowIso = new Date().toISOString();

      // Заказ 1: современный формат (status='sent' + buyerNotifiedAt)
      const orderSent = await OrderService.createOrder({
        telegramUser: buyerSent,
        recipientUsername: 's21_buyer_sent',
        productId: 'stars_custom',
        quantity: 50,
      });
      await firestoreRepo.updateDoc<Order>('orders', orderSent.orderId, {
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
        completedAt: nowIso,
        adminNotifiedAt: nowIso,
        buyerNotifiedAt: nowIso,
        buyerNotificationState: {
          status: 'sent',
          eventId: `evt_buyer_completed_${orderSent.orderId}`,
          operationId: 'op_sent_1',
          leaseOwner: 'worker_1',
          attemptCount: 1,
          sentAt: nowIso,
          deliveryUncertainAfterCrash: false,
        },
      });

      // Заказ 2: legacy-формат (только buyerNotifiedAt без buyerNotificationState)
      const orderLegacy = await OrderService.createOrder({
        telegramUser: buyerLegacy,
        recipientUsername: 's21_buyer_legacy',
        productId: 'stars_custom',
        quantity: 50,
      });
      await firestoreRepo.updateDoc<Order>('orders', orderLegacy.orderId, {
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
        completedAt: nowIso,
        adminNotifiedAt: nowIso,
        buyerNotifiedAt: nowIso,
        buyerNotificationState: undefined,
      });

      // Заказ 3: status='sent', даже если buyerNotifiedAt вдруг отсутствует
      const orderStateSentOnly = await OrderService.createOrder({
        telegramUser: buyerSent,
        recipientUsername: 's21_buyer_sent',
        productId: 'stars_custom',
        quantity: 75,
      });
      await firestoreRepo.updateDoc<Order>('orders', orderStateSentOnly.orderId, {
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
        completedAt: nowIso,
        adminNotifiedAt: nowIso,
        buyerNotifiedAt: undefined,
        buyerNotificationState: {
          status: 'sent',
          eventId: `evt_buyer_completed_${orderStateSentOnly.orderId}`,
          operationId: 'op_sent_only',
          leaseOwner: 'worker_1',
          attemptCount: 1,
          sentAt: nowIso,
          deliveryUncertainAfterCrash: false,
        },
      });

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      const recovered = await FulfillmentService.recoverPendingFulfillments(bot);
      assert.equal(recovered.length, 0, 'Ни один уже отправленный заказ не должен попасть в recovered');
      assert.equal(messages.length, 0, 'Уведомления со статусом sent или buyerNotifiedAt не должны пересылаться');

      return 'Заказы с buyerNotificationState.status=sent и legacy buyerNotifiedAt полностью защищены от повторной отправки (0 сообщений).';
    },
  );

  await runTest(
    'S21-03',
    'Fulfillment',
    'Stage 2.1: recoverPendingFulfillments восстанавливает pending и partial_sent admin notification для processing-заказов с mystarsOrderId без дублей и без повторного MyStars POST',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '777000111,777000222';
      process.env.OWNER_TELEGRAM_ID = '';

      let mystarsPostCalls = 0;
      let mystarsGetCalls = 0;

      try {
        const buyer = { id: 210301, username: 's21_admin_proc_buyer', first_name: 'ProcBuyer' };
        await UserService.upsertFromTelegram(buyer);

        const nowIso = new Date().toISOString();

        // 1. processing-заказ с mystarsOrderId и pending admin notification
        const orderPending = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_admin_proc_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderPending.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s21_proc_pending_01',
          externalExecutionReference: 'mystars:ms_s21_proc_pending_01',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'pending',
            eventId: `evt_admin_fulfillment_${orderPending.orderId}`,
            operationId: 'op_admin_fail_1',
            leaseOwner: 'worker_prev',
            attemptCount: 1,
            lastError: 'Telegram 503 Service Unavailable',
          },
        });

        // 2. processing-заказ с mystarsOrderId и partial_sent (777000111 уже получил, 777000222 нет)
        const orderPartial = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_admin_proc_buyer',
          productId: 'premium_3m',
          quantity: 1,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderPartial.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s21_proc_partial_02',
          externalExecutionReference: 'mystars:ms_s21_proc_partial_02',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'partial_sent',
            eventId: `evt_admin_fulfillment_${orderPartial.orderId}`,
            operationId: 'op_admin_partial_1',
            leaseOwner: 'worker_prev',
            attemptCount: 1,
            lastError: 'Не доставлено 777000222',
            recipientDeliveries: {
              '777000111': {
                adminTelegramId: 777000111,
                status: 'sent',
                attemptCount: 1,
                sentAt: nowIso,
                lastAttemptAt: nowIso,
                operationId: 'op_admin_partial_1',
              },
              '777000222': {
                adminTelegramId: 777000222,
                status: 'failed',
                attemptCount: 1,
                lastAttemptAt: nowIso,
                lastError: 'Telegram timeout',
                operationId: 'op_admin_partial_1',
              },
            },
          },
        });

        myStarsClient.setCredentialsOverride({
          apiKey: 'ms_test_s21_03_key_secret',
          apiBaseUrl: 'https://mystars.example.test',
        });
        myStarsClient.setHttpTransport(async (req) => {
          if (req.method === 'POST') {
            mystarsPostCalls++;
            throw new Error('Unexpected POST /v1/orders during notification recovery');
          }
          mystarsGetCalls++;
          return {
            status: 200,
            ok: true,
            json: {
              order_id: req.url.split('/').pop(),
              status: 'processing',
            },
          };
        });

        const messages: Array<{ chatId: number | string; text: string }> = [];
        const bot = createMockBot(messages);

        const recovered = await FulfillmentService.recoverPendingFulfillments(bot);
        const recoveredIds = new Set(recovered.map((o) => o.orderId));
        assert.ok(recoveredIds.has(orderPending.orderId));
        assert.ok(recoveredIds.has(orderPartial.orderId));

        const afterPending = await OrderService.getOrderById(orderPending.orderId);
        assert.equal(afterPending?.adminNotificationState?.status, 'sent');
        assert.ok(afterPending?.adminNotifiedAt);
        assert.equal(afterPending?.fulfillmentStatus, 'processing');

        const afterPartial = await OrderService.getOrderById(orderPartial.orderId);
        assert.equal(afterPartial?.adminNotificationState?.status, 'sent');
        assert.ok(afterPartial?.adminNotifiedAt);
        assert.equal(afterPartial?.fulfillmentStatus, 'processing');

        // Проверяем точность адресатов:
        // orderPending -> оба админа (777000111 и 777000222)
        const pendingMsgs = messages.filter((m) => m.text.includes(orderPending.orderId));
        assert.equal(pendingMsgs.filter((m) => m.chatId === 777000111).length, 1);
        assert.equal(pendingMsgs.filter((m) => m.chatId === 777000222).length, 1);

        // orderPartial -> ТОЛЬКО 777000222 (777000111 уже получил ранее и не должен получить дубль!)
        const partialMsgs = messages.filter((m) => m.text.includes(orderPartial.orderId));
        assert.equal(
          partialMsgs.filter((m) => m.chatId === 777000111).length,
          0,
          'Админ 777000111, уже получивший уведомление при partial_sent, не должен получить дубль',
        );
        assert.equal(
          partialMsgs.filter((m) => m.chatId === 777000222).length,
          1,
          'Неполучивший админ 777000222 должен получить ровно 1 доотправленное уведомление',
        );

        assert.equal(mystarsPostCalls, 0, 'Повторный POST /v1/orders запрещён');
        assert.ok(mystarsGetCalls >= 2, 'Polling GET /v1/orders продолжает работать штатно');
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Admin notifications для processing-заказов с mystarsOrderId (pending и partial_sent) восстановлены без дублей и без повторного MyStars POST.';
    },
  );

  await runTest(
    'S21-04',
    'Fulfillment',
    'Stage 2.1: Отсутствующий ADMIN_IDS при recovery переводит заказ в no_recipients (без sent/adminNotifiedAt) и автоматически доставляет после настройки ADMIN_IDS',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s21_04_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        process.env.ADMIN_IDS = '';
        process.env.OWNER_TELEGRAM_ID = '';

        const buyer = { id: 210401, username: 's21_no_admin_buyer', first_name: 'NoAdminBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowIso = new Date().toISOString();

        const order = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_no_admin_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s21_noadmin_01',
          externalExecutionReference: 'mystars:ms_s21_noadmin_01',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'pending',
            eventId: `evt_admin_fulfillment_${order.orderId}`,
            operationId: 'op_before_empty',
            leaseOwner: 'worker_prev',
            attemptCount: 0,
          },
        });

        const messages: Array<{ chatId: number | string; text: string }> = [];
        const bot = createMockBot(messages);

        // Проход 1: ADMIN_IDS пуст -> no_recipients, 0 сообщений, adminNotifiedAt отсутствует
        await FulfillmentService.recoverPendingFulfillments(bot);
        const afterEmpty1 = await OrderService.getOrderById(order.orderId);
        assert.equal(messages.length, 0);
        assert.equal(afterEmpty1?.adminNotifiedAt, undefined);
        assert.equal(afterEmpty1?.adminNotificationState?.status, 'no_recipients');
        assert.equal(afterEmpty1?.adminNotificationState?.sentAt, undefined);

        // Проход 2: ADMIN_IDS всё ещё пуст -> не переходит в sent, 0 сообщений, adminNotificationState не перезаписывается
        const adminOpIdBeforeSecondPass = afterEmpty1?.adminNotificationState?.operationId;
        await FulfillmentService.recoverPendingFulfillments(bot);
        const afterEmpty2 = await OrderService.getOrderById(order.orderId);
        assert.equal(messages.length, 0);
        assert.equal(afterEmpty2?.adminNotifiedAt, undefined);
        assert.equal(afterEmpty2?.adminNotificationState?.status, 'no_recipients');
        assert.equal(afterEmpty2?.adminNotificationState?.attemptCount, 0);
        assert.equal(
          afterEmpty2?.adminNotificationState?.operationId,
          adminOpIdBeforeSecondPass,
          'Пока ADMIN_IDS пуст, recovery не должен перезаписывать adminNotificationState лишними транзакциями',
        );

        // Проход 3: ADMIN_IDS настроен -> автоматическое восстановление доставляет сообщение и переводит в sent
        process.env.ADMIN_IDS = '888000111';
        await FulfillmentService.recoverPendingFulfillments(bot);
        const afterConfigured = await OrderService.getOrderById(order.orderId);
        assert.equal(afterConfigured?.adminNotificationState?.status, 'sent');
        assert.ok(afterConfigured?.adminNotifiedAt);
        assert.equal(messages.filter((m) => m.chatId === 888000111).length, 1);
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'При пустом ADMIN_IDS фиксируется no_recipients без ложного sent/adminNotifiedAt, а после настройки ADMIN_IDS recovery автоматически доставляет уведомление.';
    },
  );

  await runTest(
    'S21-05',
    'Fulfillment',
    'Stage 2.1: Активный sending-lease блокирует параллельную отправку, а истёкший sending-lease переводит buyer/admin уведомления в delivery_uncertain без дублей',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '777000111';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s21_05_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 210501, username: 's21_lease_buyer', first_name: 'LeaseBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const futureLease = Timestamp.fromMillis(nowMs + 60_000);
        const expiredLease = Timestamp.fromMillis(nowMs - 60_000);

        // 1. Активный lease на buyer notification (completed)
        const activeBuyerOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_lease_buyer',
          productId: 'stars_custom',
          quantity: 50,
        });
        await firestoreRepo.updateDoc<Order>('orders', activeBuyerOrder.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'sending',
            eventId: `evt_buyer_completed_${activeBuyerOrder.orderId}`,
            operationId: 'op_active_buyer',
            leaseOwner: 'other_worker_1',
            leaseUntil: futureLease,
            attemptCount: 1,
          },
        });

        // 2. Активный lease на admin notification (processing + mystarsOrderId)
        const activeAdminOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_lease_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', activeAdminOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s21_lease_active_admin',
          externalExecutionReference: 'mystars:ms_s21_lease_active_admin',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'sending',
            eventId: `evt_admin_fulfillment_${activeAdminOrder.orderId}`,
            operationId: 'op_active_admin',
            leaseOwner: 'other_worker_1',
            leaseUntil: futureLease,
            attemptCount: 1,
          },
        });

        // 3. Истёкший lease на buyer notification (completed)
        const expiredBuyerOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_lease_buyer',
          productId: 'stars_custom',
          quantity: 50,
        });
        await firestoreRepo.updateDoc<Order>('orders', expiredBuyerOrder.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'sending',
            eventId: `evt_buyer_completed_${expiredBuyerOrder.orderId}`,
            operationId: 'op_expired_buyer',
            leaseOwner: 'crashed_worker_1',
            leaseUntil: expiredLease,
            attemptCount: 1,
          },
        });

        // 4. Истёкший lease на admin notification (processing + mystarsOrderId)
        const expiredAdminOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_lease_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', expiredAdminOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s21_lease_expired_admin',
          externalExecutionReference: 'mystars:ms_s21_lease_expired_admin',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'sending',
            eventId: `evt_admin_fulfillment_${expiredAdminOrder.orderId}`,
            operationId: 'op_expired_admin',
            leaseOwner: 'crashed_worker_1',
            leaseUntil: expiredLease,
            attemptCount: 1,
          },
        });

        const messages: Array<{ chatId: number | string; text: string }> = [];
        const bot = createMockBot(messages);

        await FulfillmentService.recoverPendingFulfillments(bot);

        // Ни одно дублирующее сообщение не должно уйти
        assert.equal(messages.length, 0, 'Ни активный lease, ни истёкший sending-lease не должны отправлять дубли');

        // Активные lease остаются в sending
        const afterActiveBuyer = await OrderService.getOrderById(activeBuyerOrder.orderId);
        assert.equal(afterActiveBuyer?.buyerNotificationState?.status, 'sending');
        assert.equal(afterActiveBuyer?.buyerNotifiedAt, undefined);

        const afterActiveAdmin = await OrderService.getOrderById(activeAdminOrder.orderId);
        assert.equal(afterActiveAdmin?.adminNotificationState?.status, 'sending');
        assert.equal(afterActiveAdmin?.adminNotifiedAt, undefined);

        // Истёкшие lease переходят в delivery_uncertain БЕЗ sent/NotifiedAt
        const afterExpiredBuyer = await OrderService.getOrderById(expiredBuyerOrder.orderId);
        assert.equal(afterExpiredBuyer?.buyerNotificationState?.status, 'delivery_uncertain');
        assert.equal(afterExpiredBuyer?.buyerNotificationState?.deliveryUncertainAfterCrash, true);
        assert.equal(afterExpiredBuyer?.buyerNotifiedAt, undefined);

        const afterExpiredAdmin = await OrderService.getOrderById(expiredAdminOrder.orderId);
        assert.equal(afterExpiredAdmin?.adminNotificationState?.status, 'delivery_uncertain');
        assert.equal(afterExpiredAdmin?.adminNotificationState?.deliveryUncertainAfterCrash, true);
        assert.equal(afterExpiredAdmin?.adminNotifiedAt, undefined);

        // Повторный recovery-проход оставляет delivery_uncertain нетронутыми и отправляет 0 сообщений
        await FulfillmentService.recoverPendingFulfillments(bot);
        assert.equal(messages.length, 0);
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Активные sending-lease защищены от параллельной отправки, истёкшие переведены в delivery_uncertain без дублей и без ложного sent.';
    },
  );

  await runTest(
    'S21-06',
    'Fulfillment',
    'Stage 2.1: Повторные запуски recovery-воркера и имитация рестарта процесса полностью идемпотентны (без дублей уведомлений)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '777000111';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s21_06_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 210601, username: 's21_idem_buyer', first_name: 'IdemBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowIso = new Date().toISOString();

        const completedOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_idem_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', completedOrder.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${completedOrder.orderId}`,
            operationId: 'op_prev_1',
            leaseOwner: 'worker_before_restart',
            attemptCount: 1,
          },
        });

        const processingOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_idem_buyer',
          productId: 'stars_custom',
          quantity: 200,
        });
        await firestoreRepo.updateDoc<Order>('orders', processingOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s21_idem_proc_01',
          externalExecutionReference: 'mystars:ms_s21_idem_proc_01',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'pending',
            eventId: `evt_admin_fulfillment_${processingOrder.orderId}`,
            operationId: 'op_prev_2',
            leaseOwner: 'worker_before_restart',
            attemptCount: 1,
          },
        });

        const messages: Array<{ chatId: number | string; text: string }> = [];
        const bot = createMockBot(messages);

        // Параллельный запуск двух recovery-проходов (mutex isRecoveryPassRunning защищает внутри процесса)
        await Promise.all([
          FulfillmentService.recoverPendingFulfillments(bot),
          FulfillmentService.recoverPendingFulfillments(bot),
        ]);

        // Имитация рестарта процесса (сброс in-memory состояния polling) и ещё 2 повторных recovery-прохода
        FulfillmentService.resetMyStarsPollingState();
        await FulfillmentService.recoverPendingFulfillments(bot);
        FulfillmentService.resetMyStarsPollingState();
        await FulfillmentService.recoverPendingFulfillments(bot);

        assert.equal(
          messages.filter((m) => m.chatId === buyer.id).length,
          1,
          'Покупатель должен получить ровно 1 уведомление за все 4 recovery-вызова',
        );
        assert.equal(
          messages.filter((m) => m.chatId === 777000111).length,
          1,
          'Админ должен получить ровно 1 уведомление за все 4 recovery-вызова',
        );
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Повторные и конкурентные проходы recoverPendingFulfillments (включая рестарт) доставляют ровно по 1 уведомлению покупателю и админу.';
    },
  );

  await runTest(
    'S21-07',
    'Fulfillment',
    'Stage 2.1: Ошибка Telegram API при восстановлении оставляет buyer/admin уведомления в pending с lastError (без NotifiedAt), затем доставляет после восстановления Telegram API',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '777000111';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s21_07_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 210701, username: 's21_tg_err_buyer', first_name: 'TgErrBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowIso = new Date().toISOString();

        const completedOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_tg_err_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', completedOrder.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${completedOrder.orderId}`,
            operationId: 'op_init_buyer',
            leaseOwner: 'worker_1',
            attemptCount: 1,
          },
        });

        const processingOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's21_tg_err_buyer',
          productId: 'stars_custom',
          quantity: 150,
        });
        await firestoreRepo.updateDoc<Order>('orders', processingOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s21_tg_err_proc',
          externalExecutionReference: 'mystars:ms_s21_tg_err_proc',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'pending',
            eventId: `evt_admin_fulfillment_${processingOrder.orderId}`,
            operationId: 'op_init_admin',
            leaseOwner: 'worker_1',
            attemptCount: 1,
          },
        });

        // 1. Временная авария Telegram API -> оба остаются pending, leaseUntil сброшен, attemptCount вырос, lastError заполнен
        const failingBot = createMockBot([], true);
        await FulfillmentService.recoverPendingFulfillments(failingBot);

        const buyerAfterFail = await OrderService.getOrderById(completedOrder.orderId);
        assert.equal(buyerAfterFail?.buyerNotificationState?.status, 'pending');
        assert.equal(buyerAfterFail?.buyerNotifiedAt, undefined);
        assert.equal(buyerAfterFail?.buyerNotificationState?.leaseUntil, undefined);
        assert.equal(buyerAfterFail?.buyerNotificationState?.attemptCount, 2);
        assert.ok(
          buyerAfterFail?.buyerNotificationState?.lastError &&
            buyerAfterFail.buyerNotificationState.lastError.includes('502'),
          'При сбое Telegram API в buyerNotificationState.lastError должна сохраняться реальная ошибка',
        );

        const adminAfterFail = await OrderService.getOrderById(processingOrder.orderId);
        assert.equal(adminAfterFail?.adminNotificationState?.status, 'pending');
        assert.equal(adminAfterFail?.adminNotifiedAt, undefined);
        assert.equal(adminAfterFail?.adminNotificationState?.leaseUntil, undefined);
        assert.equal(adminAfterFail?.adminNotificationState?.attemptCount, 2);
        assert.ok(adminAfterFail?.adminNotificationState?.lastError);

        // 2. Telegram API восстановился -> следующий recovery-проход доставляет оба уведомления
        const deliveredMessages: Array<{ chatId: number | string; text: string }> = [];
        const healthyBot = createMockBot(deliveredMessages, false);
        await FulfillmentService.recoverPendingFulfillments(healthyBot);

        const buyerAfterRecover = await OrderService.getOrderById(completedOrder.orderId);
        assert.equal(buyerAfterRecover?.buyerNotificationState?.status, 'sent');
        assert.ok(buyerAfterRecover?.buyerNotifiedAt);
        assert.equal(buyerAfterRecover?.buyerNotificationState?.lastError, undefined);
        assert.equal(deliveredMessages.filter((m) => m.chatId === buyer.id).length, 1);

        const adminAfterRecover = await OrderService.getOrderById(processingOrder.orderId);
        assert.equal(adminAfterRecover?.adminNotificationState?.status, 'sent');
        assert.ok(adminAfterRecover?.adminNotifiedAt);
        assert.equal(adminAfterRecover?.adminNotificationState?.lastError, undefined);
        assert.equal(deliveredMessages.filter((m) => m.chatId === 777000111).length, 1);
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'При сбое Telegram API уведомления остаются pending с lastError и сброшенным leaseUntil, а после восстановления API успешно доставляются на следующем проходе.';
    },
  );

  // ===========================================================================
  // 15. STAGE 2.2: NOTIFICATION RECOVERY AUDIT & HARDENING TESTS (S22-01..S22-10)
  // ===========================================================================

  await runTest(
    'S22-01',
    'Fulfillment',
    'Stage 2.2: Неопределённый timeout/обрыв сети Telegram API (ETIMEDOUT/504) не повторяется автоматически и сразу переводит buyer/admin в delivery_uncertain',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '9001001,9001002';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_01_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 220101, username: 's22_timeout_buyer', first_name: 'TimeoutBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowIso = new Date().toISOString();

        const buyerOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_timeout_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', buyerOrder.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${buyerOrder.orderId}`,
            operationId: 'op_s22_01_buyer_init',
            leaseOwner: 'worker_init',
            attemptCount: 0,
          },
        });

        const adminOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_timeout_buyer',
          productId: 'stars_custom',
          quantity: 200,
        });
        await firestoreRepo.updateDoc<Order>('orders', adminOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s22_01_admin_timeout',
          externalExecutionReference: 'mystars:ms_s22_01_admin_timeout',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'pending',
            eventId: `evt_admin_fulfillment_${adminOrder.orderId}`,
            operationId: 'op_s22_01_admin_init',
            leaseOwner: 'worker_init',
            attemptCount: 0,
          },
        });

        const attemptsByChat = new Map<number, number>();
        const timeoutBot = {
          telegram: {
            sendMessage: async (chatId: number | string) => {
              const id = Number(chatId);
              attemptsByChat.set(id, (attemptsByChat.get(id) ?? 0) + 1);
              if (id === buyer.id) {
                const err = new Error('request timed out after 10000ms') as Error & { code?: string };
                err.code = 'ETIMEDOUT';
                throw err;
              }
              if (id === 9001001) {
                return { message_id: 7001 };
              }
              if (id === 9001002) {
                throw new Error('504: Gateway Timeout (socket hang up)');
              }
              return { message_id: 7000 };
            },
          },
        } as unknown as Telegraf;

        await FulfillmentService.recoverPendingFulfillments(timeoutBot);

        // Покупатель: ровно 1 попытка (БЕЗ внутреннего retry!), статус delivery_uncertain, buyerNotifiedAt не выставлен
        assert.equal(attemptsByChat.get(buyer.id), 1, 'При ETIMEDOUT не должно быть внутреннего ретрая sendMessage');
        const buyerAfter = await OrderService.getOrderById(buyerOrder.orderId);
        assert.equal(buyerAfter?.buyerNotificationState?.status, 'delivery_uncertain');
        assert.equal(buyerAfter?.buyerNotifiedAt, undefined);
        assert.equal(buyerAfter?.buyerNotificationState?.leaseUntil, undefined);
        assert.ok(buyerAfter?.buyerNotificationState?.lastError?.includes('timed out'));

        // Админы: 9001001 получил (sent), 9001002 поймал 504 (ровно 1 попытка -> delivery_uncertain)
        assert.equal(attemptsByChat.get(9001001), 1);
        assert.equal(attemptsByChat.get(9001002), 1, 'При 504/socket hang up не должно быть внутреннего ретрая');
        const adminAfter = await OrderService.getOrderById(adminOrder.orderId);
        assert.equal(adminAfter?.adminNotificationState?.status, 'delivery_uncertain');
        assert.equal(adminAfter?.adminNotifiedAt, undefined);
        assert.equal(adminAfter?.adminNotificationState?.recipientDeliveries?.['9001001']?.status, 'sent');
        assert.equal(
          adminAfter?.adminNotificationState?.recipientDeliveries?.['9001002']?.status,
          'delivery_uncertain',
        );

        // Повторный автоматический проход НЕ трогает delivery_uncertain и отправляет 0 сообщений
        const healthyMessages: Array<{ chatId: number | string; text: string }> = [];
        await FulfillmentService.recoverPendingFulfillments(createMockBot(healthyMessages));
        assert.equal(healthyMessages.length, 0, 'Автоматический recovery не должен повторно отправлять delivery_uncertain');
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'ETIMEDOUT и 504/socket hang up остановились на 1 попытке и перевели buyer/admin в delivery_uncertain без автодублей (сохранив sent для уже доставленного админа).';
    },
  );

  await runTest(
    'S22-02',
    'Fulfillment',
    'Stage 2.2: Сбой после отправки до записи sent -> delivery_uncertain -> безопасное ручное подтверждение (acknowledge) и ручная переотправка (forceResend, включая сбой без деградации в pending)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '9002001';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_02_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 220201, username: 's22_crash_buyer', first_name: 'CrashBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const expiredLease = Timestamp.fromMillis(nowMs - 45_000);

        // Заказ 1: краш во время sending buyer notification -> затем ручной forceResend (сначала 502, потом успех)
        const orderResend = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_crash_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderResend.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'sending',
            eventId: `evt_buyer_completed_${orderResend.orderId}`,
            operationId: 'op_crashed_before_commit_1',
            leaseOwner: 'dead_worker_1',
            leaseUntil: expiredLease,
            attemptCount: 1,
          },
        });

        // Заказ 2: краш во время sending admin notification -> затем ручной acknowledge без повторной отправки
        const orderAck = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_crash_buyer',
          productId: 'stars_custom',
          quantity: 150,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderAck.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s22_02_ack',
          externalExecutionReference: 'mystars:ms_s22_02_ack',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'sending',
            eventId: `evt_admin_fulfillment_${orderAck.orderId}`,
            operationId: 'op_crashed_before_commit_2',
            leaseOwner: 'dead_worker_2',
            leaseUntil: expiredLease,
            attemptCount: 1,
          },
        });

        const messages: Array<{ chatId: number | string; text: string }> = [];
        const bot = createMockBot(messages);

        // 1. Автоматическое восстановление переводит оба протухших lease в delivery_uncertain без отправки дублей
        await FulfillmentService.recoverPendingFulfillments(bot);
        assert.equal(messages.length, 0);

        const resendUncertain = await OrderService.getOrderById(orderResend.orderId);
        assert.equal(resendUncertain?.buyerNotificationState?.status, 'delivery_uncertain');
        assert.equal(resendUncertain?.buyerNotificationState?.deliveryUncertainAfterCrash, true);

        const ackUncertain = await OrderService.getOrderById(orderAck.orderId);
        assert.equal(ackUncertain?.adminNotificationState?.status, 'delivery_uncertain');
        assert.equal(ackUncertain?.adminNotificationState?.deliveryUncertainAfterCrash, true);

        // 2. Ручной forceResend падает с 502 -> статус ДОЛЖЕН остаться delivery_uncertain (не деградировать в pending!)
        const failingBot = createMockBot([], true);
        const failedResend = await FulfillmentService.forceResendOrderNotification({
          orderId: orderResend.orderId,
          target: 'buyer',
          bot: failingBot,
        });
        assert.equal(failedResend.sentBuyer, false);
        assert.equal(
          failedResend.order?.buyerNotificationState?.status,
          'delivery_uncertain',
          'Сбой ручного forceResend на delivery_uncertain не должен переводить заказ обратно в автоповторяемый pending',
        );

        // Автоматический проход после неуспешного forceResend всё ещё отправляет 0 сообщений
        await FulfillmentService.recoverPendingFulfillments(bot);
        assert.equal(messages.length, 0);

        // 3. Ручной forceResend при работающем Telegram -> доставляет ровно 1 сообщение и переводит в sent
        const okResend = await FulfillmentService.forceResendOrderNotification({
          orderId: orderResend.orderId,
          target: 'buyer',
          bot,
        });
        assert.equal(okResend.sentBuyer, true);
        assert.equal(okResend.order?.buyerNotificationState?.status, 'sent');
        assert.ok(okResend.order?.buyerNotifiedAt);
        assert.equal(messages.filter((m) => m.chatId === buyer.id).length, 1);

        // 4. Ручное подтверждение acknowledgeUncertainNotification -> переводит в sent без отправки Telegram
        const ackOrder = await FulfillmentService.acknowledgeUncertainNotification({
          orderId: orderAck.orderId,
          target: 'admin',
          adminTelegramId: 9002001,
        });
        assert.equal(ackOrder.adminNotificationState?.status, 'sent');
        assert.equal(ackOrder.adminNotificationState?.acknowledgedByAdminId, 9002001);
        assert.ok(ackOrder.adminNotifiedAt);
        assert.equal(messages.filter((m) => m.chatId === 9002001).length, 0);
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Истёкшие sending-lease перешли в delivery_uncertain; сбой forceResend сохранил delivery_uncertain без автоповторов; успешный forceResend и acknowledge корректно финализировали статусы.';
    },
  );

  await runTest(
    'S22-03',
    'Fulfillment',
    'Stage 2.2: Два параллельных recovery-воркера (bypassLocalMutex + разные workerId) конкурируют за один заказ -> атомарный lease допускает ровно 1 отправку',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '9003001';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_03_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 220301, username: 's22_race_buyer', first_name: 'RaceBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowIso = new Date().toISOString();

        const buyerOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_race_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', buyerOrder.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${buyerOrder.orderId}`,
            operationId: 'op_s22_03_buyer',
            leaseOwner: 'old_worker',
            attemptCount: 1,
          },
        });

        const adminOrder = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_race_buyer',
          productId: 'stars_custom',
          quantity: 200,
        });
        await firestoreRepo.updateDoc<Order>('orders', adminOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s22_03_parallel',
          externalExecutionReference: 'mystars:ms_s22_03_parallel',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'pending',
            eventId: `evt_admin_fulfillment_${adminOrder.orderId}`,
            operationId: 'op_s22_03_admin',
            leaseOwner: 'old_worker',
            attemptCount: 1,
          },
        });

        const sentLog: Array<{ chatId: number; text: string }> = [];
        const slowBot = {
          telegram: {
            sendMessage: async (chatId: number | string, text: string) => {
              await new Promise((r) => setTimeout(r, 40));
              sentLog.push({ chatId: Number(chatId), text });
              return { message_id: 8000 + sentLog.length };
            },
          },
        } as unknown as Telegraf;

        // Имитация двух независимых подов/воркеров (обход локального mutex + разные workerId)
        await Promise.all([
          FulfillmentService.recoverPendingFulfillments(slowBot, {
            bypassLocalMutex: true,
            workerId: 'pod_worker_A',
          }),
          FulfillmentService.recoverPendingFulfillments(slowBot, {
            bypassLocalMutex: true,
            workerId: 'pod_worker_B',
          }),
        ]);

        assert.equal(
          sentLog.filter((m) => m.chatId === buyer.id).length,
          1,
          'Два параллельных воркера должны отправить ровно 1 уведомление покупателю',
        );
        assert.equal(
          sentLog.filter((m) => m.chatId === 9003001).length,
          1,
          'Два параллельных воркера должны отправить ровно 1 уведомление админу',
        );

        const finalBuyer = await OrderService.getOrderById(buyerOrder.orderId);
        const finalAdmin = await OrderService.getOrderById(adminOrder.orderId);
        assert.equal(finalBuyer?.buyerNotificationState?.status, 'sent');
        assert.ok(finalBuyer?.buyerNotifiedAt);
        assert.equal(finalAdmin?.adminNotificationState?.status, 'sent');
        assert.ok(finalAdmin?.adminNotifiedAt);
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Два параллельных воркера с разными workerId и bypassLocalMutex доставили ровно по 1 сообщению покупателю и админу благодаря атомарному Firestore lease.';
    },
  );

  await runTest(
    'S22-04',
    'Fulfillment',
    'Stage 2.2: Одновременный запуск ручного forceResend и автоматического recoverPendingFulfillments не вызывает дублей благодаря активному lease',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '9004001';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_04_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 220401, username: 's22_manual_race', first_name: 'ManualRace' };
        await UserService.upsertFromTelegram(buyer);
        const nowIso = new Date().toISOString();

        // Сценарий A: авто-recovery захватывает lease, а в это время админ жмёт forceResend
        const orderA = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_manual_race',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderA.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${orderA.orderId}`,
            operationId: 'op_s22_04_a',
            leaseOwner: 'worker_init',
            attemptCount: 1,
          },
        });

        let releaseSendA!: () => void;
        let sendAStarted!: () => void;
        const sendAStartedPromise = new Promise<void>((r) => {
          sendAStarted = r;
        });
        const sendAGate = new Promise<void>((r) => {
          releaseSendA = r;
        });

        const sentA: number[] = [];
        const gatedBotA = {
          telegram: {
            sendMessage: async (chatId: number | string) => {
              sendAStarted();
              await sendAGate;
              sentA.push(Number(chatId));
              return { message_id: 8401 };
            },
          },
        } as unknown as Telegraf;

        const recoveryPromiseA = FulfillmentService.recoverPendingFulfillments(gatedBotA, {
          bypassLocalMutex: true,
          workerId: 'auto_worker_A',
        });
        await sendAStartedPromise;

        // Пока авто-recovery держит sending-lease, ручной forceResend должен увидеть skippedInFlight=true
        const manualDuringAuto = await FulfillmentService.forceResendOrderNotification({
          orderId: orderA.orderId,
          target: 'buyer',
          bot: gatedBotA,
        });
        assert.equal(manualDuringAuto.skippedInFlight, true);
        assert.equal(manualDuringAuto.sentBuyer, false);

        releaseSendA();
        await recoveryPromiseA;
        assert.equal(sentA.length, 1, 'Сценарий A: должно уйти ровно 1 сообщение');

        // Сценарий B: ручной forceResend захватывает lease, а в это время запускается авто-recovery
        const orderB = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_manual_race',
          productId: 'stars_custom',
          quantity: 150,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderB.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${orderB.orderId}`,
            operationId: 'op_s22_04_b',
            leaseOwner: 'worker_init',
            attemptCount: 1,
          },
        });

        let releaseSendB!: () => void;
        let sendBStarted!: () => void;
        const sendBStartedPromise = new Promise<void>((r) => {
          sendBStarted = r;
        });
        const sendBGate = new Promise<void>((r) => {
          releaseSendB = r;
        });

        const sentB: number[] = [];
        const gatedBotB = {
          telegram: {
            sendMessage: async (chatId: number | string) => {
              sendBStarted();
              await sendBGate;
              sentB.push(Number(chatId));
              return { message_id: 8402 };
            },
          },
        } as unknown as Telegraf;

        const manualPromiseB = FulfillmentService.forceResendOrderNotification({
          orderId: orderB.orderId,
          target: 'buyer',
          bot: gatedBotB,
        });
        await sendBStartedPromise;

        // Авто-recovery в момент активного ручного lease должен пропустить заказ
        await FulfillmentService.recoverPendingFulfillments(gatedBotB, {
          bypassLocalMutex: true,
          workerId: 'auto_worker_B',
        });

        releaseSendB();
        const manualResB = await manualPromiseB;
        assert.equal(manualResB.sentBuyer, true);
        assert.equal(sentB.length, 1, 'Сценарий B: должно уйти ровно 1 сообщение');
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'В обоих направлениях гонки (auto vs manual и manual vs auto) активный sending-lease гарантировал ровно 1 доставку без дублей.';
    },
  );

  await runTest(
    'S22-05',
    'Fulfillment',
    'Stage 2.2: Устаревший медленный воркер после истечения lease / delivery_uncertain / acknowledge / нового forceResend НЕ может перезаписать более новое состояние',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '9005001';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_05_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 220501, username: 's22_stale_buyer', first_name: 'StaleBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowIso = new Date().toISOString();

        // Подсценарий A (Buyer): медленный Worker A подвисает на Telegram -> lease протухает -> Worker B переводит в delivery_uncertain ->
        // затем админ подтверждает acknowledge -> Worker A наконец падает с 502 и НЕ должен перетереть acknowledged 'sent'!
        const orderBuyer = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_stale_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderBuyer.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${orderBuyer.orderId}`,
            operationId: 'op_init_stale_buyer',
            leaseOwner: 'worker_init',
            attemptCount: 0,
          },
        });

        let releaseStaleBuyer!: () => void;
        let staleBuyerStarted!: () => void;
        const staleBuyerStartedP = new Promise<void>((r) => {
          staleBuyerStarted = r;
        });
        const staleBuyerGate = new Promise<void>((r) => {
          releaseStaleBuyer = r;
        });

        const slowFailingBuyerBot = {
          telegram: {
            sendMessage: async () => {
              staleBuyerStarted();
              await staleBuyerGate;
              throw new Error('502: Bad Gateway after long hang');
            },
          },
        } as unknown as Telegraf;

        const staleWorkerA = FulfillmentService.ensureBuyerNotified(
          (await OrderService.getOrderById(orderBuyer.orderId))!,
          slowFailingBuyerBot,
          false,
          'stale_worker_A',
        );
        await staleBuyerStartedP;

        // Имитируем истечение lease у зависшего Worker A
        const midBuyer = (await OrderService.getOrderById(orderBuyer.orderId))!;
        assert.equal(midBuyer.buyerNotificationState?.status, 'sending');
        await firestoreRepo.updateDoc<Order>('orders', orderBuyer.orderId, {
          buyerNotificationState: {
            ...midBuyer.buyerNotificationState!,
            leaseUntil: Timestamp.fromMillis(Date.now() - 10_000),
          },
        });

        // Worker B обнаруживает протухший lease и переводит в delivery_uncertain
        await FulfillmentService.recoverPendingFulfillments(createMockBot([]), {
          bypassLocalMutex: true,
          workerId: 'recovery_worker_B',
        });
        const afterUncertain = await OrderService.getOrderById(orderBuyer.orderId);
        assert.equal(afterUncertain?.buyerNotificationState?.status, 'delivery_uncertain');

        // Админ подтверждает доставку через acknowledge -> статус sent
        const acked = await FulfillmentService.acknowledgeUncertainNotification({
          orderId: orderBuyer.orderId,
          target: 'buyer',
          adminTelegramId: 9005001,
        });
        assert.equal(acked.buyerNotificationState?.status, 'sent');

        // Теперь просыпается старый Worker A и завершается с ошибкой -> НЕ имеет права перезаписать sent!
        releaseStaleBuyer();
        await staleWorkerA;

        const buyerFinal = await OrderService.getOrderById(orderBuyer.orderId);
        assert.equal(
          buyerFinal?.buyerNotificationState?.status,
          'sent',
          'Устаревший Worker A не должен перезаписывать acknowledged sent обратно в pending!',
        );
        assert.equal(buyerFinal?.buyerNotificationState?.acknowledgedByAdminId, 9005001);
        assert.ok(buyerFinal?.buyerNotifiedAt);

        // Подсценарий B (Buyer): проснувшийся Worker A после delivery_uncertain (до acknowledge) НЕ может перезаписать delivery_uncertain обратно в pending!
        const orderUncertainFence = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_stale_buyer',
          productId: 'stars_custom',
          quantity: 120,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderUncertainFence.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_buyer_completed_${orderUncertainFence.orderId}`,
            operationId: 'op_init_fence_2',
            leaseOwner: 'worker_init',
            attemptCount: 0,
          },
        });

        let releaseFence2!: () => void;
        let fence2Started!: () => void;
        const fence2StartedP = new Promise<void>((r) => {
          fence2Started = r;
        });
        const fence2Gate = new Promise<void>((r) => {
          releaseFence2 = r;
        });
        const slowBot2 = {
          telegram: {
            sendMessage: async () => {
              fence2Started();
              await fence2Gate;
              throw new Error('502: Late failure from zombie worker');
            },
          },
        } as unknown as Telegraf;

        const zombieWorker = FulfillmentService.ensureBuyerNotified(
          (await OrderService.getOrderById(orderUncertainFence.orderId))!,
          slowBot2,
          false,
          'zombie_worker_A',
        );
        await fence2StartedP;

        const midFence2 = (await OrderService.getOrderById(orderUncertainFence.orderId))!;
        await firestoreRepo.updateDoc<Order>('orders', orderUncertainFence.orderId, {
          buyerNotificationState: {
            ...midFence2.buyerNotificationState!,
            leaseUntil: Timestamp.fromMillis(Date.now() - 10_000),
          },
        });

        await FulfillmentService.recoverPendingFulfillments(createMockBot([]), {
          bypassLocalMutex: true,
          workerId: 'recovery_worker_B2',
        });

        releaseFence2();
        await zombieWorker;

        const fence2Final = await OrderService.getOrderById(orderUncertainFence.orderId);
        assert.equal(
          fence2Final?.buyerNotificationState?.status,
          'delivery_uncertain',
          'Zombie Worker A не должен откатывать delivery_uncertain в pending!',
        );

        // Подсценарий C (Admin): медленный Worker A завис -> lease истёк -> delivery_uncertain -> админ сделал forceResend (sent) -> Worker A падает -> sent сохранён!
        const orderAdminFence = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_stale_buyer',
          productId: 'stars_custom',
          quantity: 150,
        });
        await firestoreRepo.updateDoc<Order>('orders', orderAdminFence.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_s22_05_admin_fence',
          externalExecutionReference: 'mystars:ms_s22_05_admin_fence',
          adminNotifiedAt: undefined,
          adminNotificationState: {
            status: 'pending',
            eventId: `evt_admin_fulfillment_${orderAdminFence.orderId}`,
            operationId: 'op_init_admin_fence',
            leaseOwner: 'worker_init',
            attemptCount: 0,
          },
        });

        let releaseAdminZombie!: () => void;
        let adminZombieStarted!: () => void;
        const adminZombieStartedP = new Promise<void>((r) => {
          adminZombieStarted = r;
        });
        const adminZombieGate = new Promise<void>((r) => {
          releaseAdminZombie = r;
        });
        const slowAdminBot = {
          telegram: {
            sendMessage: async () => {
              adminZombieStarted();
              await adminZombieGate;
              throw new Error('502: Late admin zombie failure');
            },
          },
        } as unknown as Telegraf;

        const adminZombie = FulfillmentService.ensureAdminNotified(
          (await OrderService.getOrderById(orderAdminFence.orderId))!,
          slowAdminBot,
          false,
          'admin_zombie_A',
        );
        await adminZombieStartedP;

        const midAdmin = (await OrderService.getOrderById(orderAdminFence.orderId))!;
        await firestoreRepo.updateDoc<Order>('orders', orderAdminFence.orderId, {
          adminNotificationState: {
            ...midAdmin.adminNotificationState!,
            leaseUntil: Timestamp.fromMillis(Date.now() - 10_000),
          },
        });

        await FulfillmentService.recoverPendingFulfillments(createMockBot([]), {
          bypassLocalMutex: true,
          workerId: 'recovery_worker_admin_B',
        });

        const adminMsgs: Array<{ chatId: number | string; text: string }> = [];
        const manualAdminResend = await FulfillmentService.forceResendOrderNotification({
          orderId: orderAdminFence.orderId,
          target: 'admin',
          bot: createMockBot(adminMsgs),
        });
        assert.equal(manualAdminResend.sentAdmin, true);

        releaseAdminZombie();
        await adminZombie;

        const finalAdminFence = await OrderService.getOrderById(orderAdminFence.orderId);
        assert.equal(
          finalAdminFence?.adminNotificationState?.status,
          'sent',
          'Zombie Worker A не должен перезаписывать более новый admin sent от forceResend!',
        );
        assert.ok(finalAdminFence?.adminNotifiedAt);
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Строгий fencing (status===sending && operationId && leaseOwner) заблокировал все попытки устаревших воркеров перезаписать delivery_uncertain, acknowledged sent и forceResend sent.';
    },
  );

  await runTest(
    'S22-06',
    'Fulfillment',
    'Stage 2.2: Очередь >100 незавершённых уведомлений (120 buyer, 50 активных sending, 50 падающих 403 перед 60 здоровыми, 110 admin) обрабатывается без голодания (starvation)',
    async () => {
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '9006001';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_06_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        // --- Подсценарий A: 50 активных sending-lease НЕ блокируют 15 pending заказов ---
        firestoreRepo.enableIsolatedTestMode(true);
        FulfillmentService.resetNotificationRecoveryState();
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const activeLease = Timestamp.fromMillis(nowMs + 60_000);

        for (let i = 1; i <= 50; i++) {
          const orderId = `ord_a_sending_${String(i).padStart(3, '0')}`;
          await firestoreRepo.setDoc<Order>('orders', orderId, {
            orderId,
            userId: `tg_${220600 + i}`,
            userTelegramId: 220600 + i,
            recipientUsername: `u_${i}`,
            productId: 'stars_custom',
            productName: '50 Stars',
            category: 'stars',
            quantity: 50,
            totalPriceUsdCents: 100,
            totalPrice: 1,
            currency: 'USD',
            paymentStatus: 'completed',
            fulfillmentStatus: 'completed',
            completedAt: nowIso,
            adminNotifiedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
            buyerNotificationState: {
              status: 'sending',
              eventId: `evt_b_${orderId}`,
              operationId: `op_${orderId}`,
              leaseOwner: 'active_other_pod',
              leaseUntil: activeLease,
              attemptCount: 1,
            },
          });
        }
        for (let i = 1; i <= 15; i++) {
          const orderId = `ord_z_pending_${String(i).padStart(3, '0')}`;
          await firestoreRepo.setDoc<Order>('orders', orderId, {
            orderId,
            userId: `tg_${220700 + i}`,
            userTelegramId: 220700 + i,
            recipientUsername: `p_${i}`,
            productId: 'stars_custom',
            productName: '50 Stars',
            category: 'stars',
            quantity: 50,
            totalPriceUsdCents: 100,
            totalPrice: 1,
            currency: 'USD',
            paymentStatus: 'completed',
            fulfillmentStatus: 'completed',
            completedAt: nowIso,
            adminNotifiedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
            buyerNotificationState: {
              status: 'pending',
              eventId: `evt_b_${orderId}`,
              operationId: `op_${orderId}`,
              leaseOwner: 'prev_worker',
              attemptCount: 1,
            },
          });
        }

        const msgsA: Array<{ chatId: number | string; text: string }> = [];
        await FulfillmentService.recoverPendingFulfillments(createMockBot(msgsA));
        assert.equal(
          msgsA.length,
          15,
          '50 активных sending-lease не должны вытеснять 15 pending-уведомлений из прохода',
        );

        // --- Подсценарий B: 120 pending buyer-уведомлений дренируются за 3 прохода (50 + 50 + 20) ---
        firestoreRepo.enableIsolatedTestMode(true);
        FulfillmentService.resetNotificationRecoveryState();
        for (let i = 1; i <= 120; i++) {
          const orderId = `ord_b_${String(i).padStart(3, '0')}`;
          await firestoreRepo.setDoc<Order>('orders', orderId, {
            orderId,
            userId: `tg_${221000 + i}`,
            userTelegramId: 221000 + i,
            recipientUsername: `b_${i}`,
            productId: 'stars_custom',
            productName: '50 Stars',
            category: 'stars',
            quantity: 50,
            totalPriceUsdCents: 100,
            totalPrice: 1,
            currency: 'USD',
            paymentStatus: 'completed',
            fulfillmentStatus: 'completed',
            completedAt: nowIso,
            adminNotifiedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
            buyerNotificationState: {
              status: 'pending',
              eventId: `evt_b_${orderId}`,
              operationId: `op_${orderId}`,
              leaseOwner: 'prev_worker',
              attemptCount: 1,
            },
          });
        }

        const msgsB: Array<{ chatId: number | string; text: string }> = [];
        const botB = createMockBot(msgsB);
        await FulfillmentService.recoverPendingFulfillments(botB);
        assert.equal(msgsB.length, 50, 'Проход 1 должен обработать батч 50 из 120');
        await FulfillmentService.recoverPendingFulfillments(botB);
        assert.equal(msgsB.length, 100, 'Проход 2 должен обработать следующие 50 (итого 100)');
        await FulfillmentService.recoverPendingFulfillments(botB);
        assert.equal(msgsB.length, 120, 'Проход 3 должен завершить оставшиеся 20 (итого 120)');
        await FulfillmentService.recoverPendingFulfillments(botB);
        assert.equal(msgsB.length, 120, 'Проход 4 не должен отправлять дубликаты');
        const uniqueBuyersB = new Set(msgsB.map((m) => Number(m.chatId)));
        assert.equal(uniqueBuyersB.size, 120, 'Каждый из 120 покупателей должен получить ровно 1 сообщение');

        // --- Подсценарий C: 50 постоянно падающих (403 blocked) заказов в начале очереди НЕ блокируют 60 здоровых позади ---
        firestoreRepo.enableIsolatedTestMode(true);
        FulfillmentService.resetNotificationRecoveryState();
        for (let i = 1; i <= 110; i++) {
          const orderId = `ord_c_${String(i).padStart(3, '0')}`;
          await firestoreRepo.setDoc<Order>('orders', orderId, {
            orderId,
            userId: `tg_${222000 + i}`,
            userTelegramId: 222000 + i,
            recipientUsername: `c_${i}`,
            productId: 'stars_custom',
            productName: '50 Stars',
            category: 'stars',
            quantity: 50,
            totalPriceUsdCents: 100,
            totalPrice: 1,
            currency: 'USD',
            paymentStatus: 'completed',
            fulfillmentStatus: 'completed',
            completedAt: nowIso,
            adminNotifiedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
            buyerNotificationState: {
              status: 'pending',
              eventId: `evt_b_${orderId}`,
              operationId: `op_${orderId}`,
              leaseOwner: 'prev_worker',
              attemptCount: 1,
            },
          });
        }

        const deliveredC = new Set<number>();
        const blockedHeadBot = {
          telegram: {
            sendMessage: async (chatId: number | string) => {
              const id = Number(chatId);
              if (id <= 222050) {
                throw new Error('403: Forbidden: bot was blocked by the user');
              }
              deliveredC.add(id);
              return { message_id: 9000 + deliveredC.size };
            },
          },
        } as unknown as Telegraf;

        await FulfillmentService.recoverPendingFulfillments(blockedHeadBot); // #1..#50 падают, курсор сдвигается на #50
        assert.equal(deliveredC.size, 0);
        await FulfillmentService.recoverPendingFulfillments(blockedHeadBot); // #51..#100 доставляются
        assert.equal(deliveredC.size, 50);
        await FulfillmentService.recoverPendingFulfillments(blockedHeadBot); // #101..#110 доставляются, курсор оборачивается
        assert.equal(deliveredC.size, 60, 'Все 60 здоровых заказов за 50 падающими должны быть доставлены без голодания');

        // --- Подсценарий D: 110 pending admin-уведомлений (на completed-заказах) дренируются за 3 прохода ---
        firestoreRepo.enableIsolatedTestMode(true);
        FulfillmentService.resetNotificationRecoveryState();
        for (let i = 1; i <= 110; i++) {
          const orderId = `ord_d_${String(i).padStart(3, '0')}`;
          await firestoreRepo.setDoc<Order>('orders', orderId, {
            orderId,
            userId: `tg_${223000 + i}`,
            userTelegramId: 223000 + i,
            recipientUsername: `d_${i}`,
            productId: 'stars_custom',
            productName: '50 Stars',
            category: 'stars',
            quantity: 50,
            totalPriceUsdCents: 100,
            totalPrice: 1,
            currency: 'USD',
            paymentStatus: 'completed',
            fulfillmentStatus: 'completed',
            completedAt: nowIso,
            buyerNotifiedAt: nowIso,
            buyerNotificationState: {
              status: 'sent',
              eventId: `evt_b_${orderId}`,
              operationId: `op_b_${orderId}`,
              leaseOwner: 'w',
              attemptCount: 1,
            },
            adminNotifiedAt: undefined,
            adminNotificationState: {
              status: 'pending',
              eventId: `evt_a_${orderId}`,
              operationId: `op_a_${orderId}`,
              leaseOwner: 'w',
              attemptCount: 1,
            },
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }

        const adminMsgsD: Array<{ chatId: number | string; text: string }> = [];
        const botD = createMockBot(adminMsgsD);
        await FulfillmentService.recoverPendingFulfillments(botD);
        assert.equal(adminMsgsD.length, 50);
        await FulfillmentService.recoverPendingFulfillments(botD);
        assert.equal(adminMsgsD.length, 100);
        await FulfillmentService.recoverPendingFulfillments(botD);
        assert.equal(adminMsgsD.length, 110);
        await FulfillmentService.recoverPendingFulfillments(botD);
        assert.equal(adminMsgsD.length, 110);
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Проверено отсутствие starvation: 50 активных sending не блокируют pending, 120 buyer и 110 admin дренируются за 3 прохода, 50 постоянно падающих 403 не блокируют 60 здоровых заказов.';
    },
  );

  await runTest(
    'S22-07',
    'Fulfillment',
    'Stage 2.2: Ошибка обработки одного заказа не прерывает восстановление остальных заказов в том же recovery-проходе',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '9007001';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_07_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const nowIso = new Date().toISOString();
        const buyers = [
          { id: 220701, username: 's22_iso_fail', first_name: 'Fail' },
          { id: 220702, username: 's22_iso_timeout', first_name: 'Timeout' },
          { id: 220703, username: 's22_iso_ok', first_name: 'Ok' },
        ];
        const orderIds: string[] = [];
        for (const b of buyers) {
          await UserService.upsertFromTelegram(b);
          const ord = await OrderService.createOrder({
            telegramUser: b,
            recipientUsername: b.username,
            productId: 'stars_custom',
            quantity: 50,
          });
          await firestoreRepo.updateDoc<Order>('orders', ord.orderId, {
            paymentStatus: 'completed',
            fulfillmentStatus: 'completed',
            completedAt: nowIso,
            adminNotifiedAt: nowIso,
            buyerNotifiedAt: undefined,
            buyerNotificationState: {
              status: 'pending',
              eventId: `evt_b_${ord.orderId}`,
              operationId: `op_${ord.orderId}`,
              leaseOwner: 'w',
              attemptCount: 1,
            },
          });
          orderIds.push(ord.orderId);
        }

        const deliveredChats: number[] = [];
        const mixedBot = {
          telegram: {
            sendMessage: async (chatId: number | string) => {
              const id = Number(chatId);
              if (id === 220701) throw new Error('403: Forbidden: bot was blocked by the user');
              if (id === 220702) {
                const err = new Error('connect ETIMEDOUT') as Error & { code?: string };
                err.code = 'ETIMEDOUT';
                throw err;
              }
              deliveredChats.push(id);
              return { message_id: 9701 };
            },
          },
        } as unknown as Telegraf;

        await FulfillmentService.recoverPendingFulfillments(mixedBot);

        assert.deepEqual(deliveredChats, [220703]);
        assert.equal((await OrderService.getOrderById(orderIds[0]))?.buyerNotificationState?.status, 'pending');
        assert.equal((await OrderService.getOrderById(orderIds[1]))?.buyerNotificationState?.status, 'delivery_uncertain');
        assert.equal((await OrderService.getOrderById(orderIds[2]))?.buyerNotificationState?.status, 'sent');
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Сбой 403 и ETIMEDOUT на первых двух заказах не прервали успешную доставку третьего заказа в том же проходе.';
    },
  );

  await runTest(
    'S22-08',
    'Fulfillment',
    'Stage 2.2: Повторное восстановление после рестарта процесса (смена workerInstanceId и сброс всех in-memory курсоров) идемпотентно',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      const prevWorkerId = FulfillmentService.workerInstanceId;
      process.env.ADMIN_IDS = '9008001';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_08_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const buyer = { id: 220801, username: 's22_restart_buyer', first_name: 'RestartBuyer' };
        await UserService.upsertFromTelegram(buyer);
        const nowIso = new Date().toISOString();

        const ord = await OrderService.createOrder({
          telegramUser: buyer,
          recipientUsername: 's22_restart_buyer',
          productId: 'stars_custom',
          quantity: 100,
        });
        await firestoreRepo.updateDoc<Order>('orders', ord.orderId, {
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          buyerNotifiedAt: undefined,
          adminNotifiedAt: undefined,
          buyerNotificationState: {
            status: 'pending',
            eventId: `evt_b_${ord.orderId}`,
            operationId: 'op_before_restart_b',
            leaseOwner: 'pod_1',
            attemptCount: 1,
          },
          adminNotificationState: {
            status: 'pending',
            eventId: `evt_a_${ord.orderId}`,
            operationId: 'op_before_restart_a',
            leaseOwner: 'pod_1',
            attemptCount: 1,
          },
        });

        const msgs: Array<{ chatId: number | string; text: string }> = [];
        const bot = createMockBot(msgs);

        FulfillmentService.workerInstanceId = 'pod_before_restart';
        await FulfillmentService.recoverPendingFulfillments(bot);
        assert.equal(msgs.filter((m) => m.chatId === buyer.id).length, 1);
        assert.equal(msgs.filter((m) => m.chatId === 9008001).length, 1);

        // Полная имитация рестарта процесса (новый workerInstanceId + сброс всех in-memory состояний)
        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.resetNotificationRecoveryState();
        FulfillmentService.workerInstanceId = 'pod_after_restart_1';
        await FulfillmentService.recoverPendingFulfillments(bot);

        FulfillmentService.resetMyStarsPollingState();
        FulfillmentService.workerInstanceId = 'pod_after_restart_2';
        await FulfillmentService.recoverPendingFulfillments(bot);

        assert.equal(msgs.filter((m) => m.chatId === buyer.id).length, 1);
        assert.equal(msgs.filter((m) => m.chatId === 9008001).length, 1);
      } finally {
        FulfillmentService.workerInstanceId = prevWorkerId;
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'После рестарта процесса и смены workerInstanceId повторные проходы recovery не отправили ни одного дубля.';
    },
  );

  await runTest(
    'S22-09',
    'Database',
    'Stage 2.2: Firestore dot-path запросы (buyerNotificationState.status / adminNotificationState.status) и cursor-пагинация startAfter (включая удалённый курсор)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const nowIso = new Date().toISOString();

      const ids = ['ord_q_05', 'ord_q_01', 'ord_q_04', 'ord_q_02', 'ord_q_03'];
      for (const orderId of ids) {
        await firestoreRepo.setDoc<Order>('orders', orderId, {
          orderId,
          userId: 'tg_1',
          userTelegramId: 1,
          recipientUsername: 'u',
          productId: 'stars_custom',
          productName: '50 Stars',
          category: 'stars',
          quantity: 50,
          totalPriceUsdCents: 100,
          totalPrice: 1,
          currency: 'USD',
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          createdAt: nowIso,
          updatedAt: nowIso,
          buyerNotificationState: {
            status: orderId === 'ord_q_04' ? 'sent' : 'pending',
            eventId: `evt_${orderId}`,
            operationId: `op_${orderId}`,
            leaseOwner: 'w',
            attemptCount: Number(orderId.slice(-2)),
          },
          adminNotificationState: {
            status: orderId === 'ord_q_02' ? 'partial_sent' : 'pending',
            eventId: `evt_a_${orderId}`,
            operationId: `op_a_${orderId}`,
            leaseOwner: 'w',
            attemptCount: 1,
          },
        });
      }

      // 1. Dot-path == с детерминированной сортировкой по documentId и startAfter без orderBy
      const page1 = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'buyerNotificationState.status', op: '==', value: 'pending' }],
        limit: 2,
      });
      assert.deepEqual(
        page1.map((o) => o.orderId),
        ['ord_q_01', 'ord_q_02'],
      );

      const page2 = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'buyerNotificationState.status', op: '==', value: 'pending' }],
        startAfter: page1[page1.length - 1].orderId,
        limit: 2,
      });
      assert.deepEqual(
        page2.map((o) => o.orderId),
        ['ord_q_03', 'ord_q_05'],
      );

      // 2. Fallback после удаления документа-курсора без orderBy
      await firestoreRepo.deleteDoc('orders', 'ord_q_02');
      const afterDeletedCursor = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'buyerNotificationState.status', op: '==', value: 'pending' }],
        startAfter: 'ord_q_02',
        limit: 5,
      });
      assert.deepEqual(
        afterDeletedCursor.map((o) => o.orderId),
        ['ord_q_03', 'ord_q_05'],
      );

      // 3. Nested orderBy (dot-path) + удалённый курсор fallback
      const nestedOrderFallback = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'buyerNotificationState.status', op: '==', value: 'pending' }],
        orderBy: { field: 'buyerNotificationState.attemptCount', direction: 'asc' },
        startAfter: { value: 2, id: 'ord_q_02' },
        limit: 5,
      });
      assert.deepEqual(
        nestedOrderFallback.map((o) => o.orderId),
        ['ord_q_03', 'ord_q_05'],
      );

      // 4. Dot-path 'in' query для adminNotificationState.status
      const inQuery = await firestoreRepo.queryDocs<Order>('orders', {
        where: [
          {
            field: 'adminNotificationState.status',
            op: 'in',
            value: ['pending', 'partial_sent'],
          },
        ],
      });
      assert.deepEqual(
        inQuery.map((o) => o.orderId),
        ['ord_q_01', 'ord_q_03', 'ord_q_04', 'ord_q_05'],
      );

      return 'Dot-path фильтрация (== и in), implicit __name__ сортировка и startAfter-пагинация (включая удалённый курсор и nested orderBy) работают корректно.';
    },
  );

  await runTest(
    'S22-10',
    'Fulfillment',
    'Stage 2.2: Legacy-заказы без buyerNotificationState/adminNotificationState: уже уведомлённые (*NotifiedAt) не шлются повторно, неуведомлённые восстанавливаются ровно 1 раз',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevAdminIds = process.env.ADMIN_IDS;
      const prevOwnerId = process.env.OWNER_TELEGRAM_ID;
      process.env.ADMIN_IDS = '9010001';
      process.env.OWNER_TELEGRAM_ID = '';

      myStarsClient.setCredentialsOverride({
        apiKey: 'ms_test_s22_10_key_secret',
        apiBaseUrl: 'https://mystars.example.test',
      });
      myStarsClient.setHttpTransport(async (req) => ({
        status: 200,
        ok: true,
        json: { order_id: req.url.split('/').pop(), status: 'processing', eligible: true },
      }));

      try {
        const nowIso = new Date().toISOString();

        // 1. Legacy completed С buyerNotifiedAt и БЕЗ buyerNotificationState -> НЕ слать!
        await firestoreRepo.setDoc<Order>('orders', 'legacy_comp_already_notified', {
          orderId: 'legacy_comp_already_notified',
          userId: 'tg_221001',
          userTelegramId: 221001,
          recipientUsername: 'legacy1',
          productId: 'stars_custom',
          productName: '50 Stars',
          category: 'stars',
          quantity: 50,
          totalPriceUsdCents: 100,
          totalPrice: 1,
          currency: 'USD',
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          buyerNotifiedAt: nowIso,
          adminNotifiedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        // 2. Legacy completed БЕЗ buyerNotifiedAt и БЕЗ buyerNotificationState -> восстановить 1 раз!
        await firestoreRepo.setDoc<Order>('orders', 'legacy_comp_missing_notify', {
          orderId: 'legacy_comp_missing_notify',
          userId: 'tg_221002',
          userTelegramId: 221002,
          recipientUsername: 'legacy2',
          productId: 'stars_custom',
          productName: '50 Stars',
          category: 'stars',
          quantity: 50,
          totalPriceUsdCents: 100,
          totalPrice: 1,
          currency: 'USD',
          paymentStatus: 'completed',
          fulfillmentStatus: 'completed',
          completedAt: nowIso,
          adminNotifiedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        // 3. Legacy processing (с mystarsOrderId) С adminNotifiedAt и БЕЗ adminNotificationState -> НЕ слать!
        await firestoreRepo.setDoc<Order>('orders', 'legacy_proc_already_notified', {
          orderId: 'legacy_proc_already_notified',
          userId: 'tg_221003',
          userTelegramId: 221003,
          recipientUsername: 'legacy3',
          productId: 'stars_custom',
          productName: '100 Stars',
          category: 'stars',
          quantity: 100,
          totalPriceUsdCents: 200,
          totalPrice: 2,
          currency: 'USD',
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_legacy_already',
          externalExecutionReference: 'mystars:ms_legacy_already',
          adminNotifiedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        // 4. Legacy processing (с mystarsOrderId) БЕЗ adminNotifiedAt и БЕЗ adminNotificationState -> восстановить 1 раз!
        await firestoreRepo.setDoc<Order>('orders', 'legacy_proc_missing_notify', {
          orderId: 'legacy_proc_missing_notify',
          userId: 'tg_221004',
          userTelegramId: 221004,
          recipientUsername: 'legacy4',
          productId: 'stars_custom',
          productName: '100 Stars',
          category: 'stars',
          quantity: 100,
          totalPriceUsdCents: 200,
          totalPrice: 2,
          currency: 'USD',
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: nowIso,
          mystarsOrderId: 'ms_legacy_missing',
          externalExecutionReference: 'mystars:ms_legacy_missing',
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        const msgs: Array<{ chatId: number | string; text: string }> = [];
        const bot = createMockBot(msgs);

        await FulfillmentService.recoverPendingFulfillments(bot);
        await FulfillmentService.recoverPendingFulfillments(bot);

        // Покупатель legacy1 (уже был buyerNotifiedAt) -> 0 сообщений
        assert.equal(msgs.filter((m) => m.chatId === 221001).length, 0);
        // Покупатель legacy2 (без buyerNotifiedAt) -> ровно 1 сообщение
        assert.equal(msgs.filter((m) => m.chatId === 221002).length, 1);
        const leg2After = await OrderService.getOrderById('legacy_comp_missing_notify');
        assert.equal(leg2After?.buyerNotificationState?.status, 'sent');
        assert.ok(leg2After?.buyerNotifiedAt);

        // Админ получил ровно 1 сообщение (только по legacy_proc_missing_notify, НЕ по legacy_proc_already_notified)
        const adminMsgs = msgs.filter((m) => m.chatId === 9010001);
        assert.equal(adminMsgs.length, 1);
        assert.ok(adminMsgs[0].text.includes('legacy_proc_missing_notify'));
        const leg4After = await OrderService.getOrderById('legacy_proc_missing_notify');
        assert.equal(leg4After?.adminNotificationState?.status, 'sent');
        assert.ok(leg4After?.adminNotifiedAt);
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetMyStarsPollingState();
        if (prevAdminIds === undefined) delete process.env.ADMIN_IDS;
        else process.env.ADMIN_IDS = prevAdminIds;
        if (prevOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwnerId;
      }

      return 'Legacy-заказы без полей *NotificationState обработаны корректно: уже уведомлённые (*NotifiedAt) не дублируются, неуведомлённые восстановлены ровно 1 раз.';
    },
  );

  // =========================================================================
  // STAGE 2.3 — MYSTARS-ONLY CLEANUP & HISTORICAL COMPATIBILITY TESTS
  // =========================================================================

  await runTest(
    'S23-01',
    'Fulfillment',
    'Stage 2.3: MyStars-only маршрутизация поставщика (mystars / unset / manual / unsupported legacy value) без переключения на Fragment',
    async () => {
      const prevProvider = process.env.FULFILLMENT_PROVIDER;
      const prevMyStarsKey = process.env.MYSTARS_API_KEY;
      try {
        FulfillmentService.resetAdapterToDefault();

        // 1. MYSTARS_API_KEY не задан -> безопасный ручной режим при unset и при 'mystars'
        delete process.env.FULFILLMENT_PROVIDER;
        delete process.env.MYSTARS_API_KEY;
        myStarsClient.setCredentialsOverride(null);

        assert.equal(getEnvConfig().fulfillmentProvider, 'mystars');
        assert.equal(getEnvConfig().invalidFulfillmentProvider, undefined);
        assert.equal(resolveActiveSupplierProvider(), 'manual');
        assert.equal(isActiveSupplierConfigured(), false);
        assert.equal(OrderService.resolveOrderFulfillmentProvider('stars'), 'manual');
        assert.ok(FulfillmentService.getActiveAdapter() instanceof ManualAdminFulfillmentAdapter);

        // 2. MYSTARS_API_KEY задан + FULFILLMENT_PROVIDER=mystars (или unset) -> единственный автоматический поставщик 'mystars'
        myStarsClient.setCredentialsOverride({
          apiBaseUrl: 'https://api.mystars.tg',
          apiKey: 'ms_live_s23_test_key',
          paymentCurrency: 'usdt_ton',
        });
        process.env.FULFILLMENT_PROVIDER = 'mystars';
        assert.equal(getEnvConfig().fulfillmentProvider, 'mystars');
        assert.equal(resolveActiveSupplierProvider(), 'mystars');
        assert.equal(isActiveSupplierConfigured(), true);
        assert.equal(OrderService.resolveOrderFulfillmentProvider('stars'), 'mystars');
        assert.equal(OrderService.resolveOrderFulfillmentProvider('premium'), 'mystars');
        assert.equal(OrderService.resolveOrderFulfillmentProvider('gifts'), 'manual');
        assert.ok(FulfillmentService.getActiveAdapter() instanceof MyStarsFulfillmentAdapter);

        // 3. FULFILLMENT_PROVIDER=manual -> принудительный ручной режим даже при настроенном MYSTARS_API_KEY
        process.env.FULFILLMENT_PROVIDER = 'manual';
        assert.equal(getEnvConfig().fulfillmentProvider, 'manual');
        assert.equal(getEnvConfig().invalidFulfillmentProvider, undefined);
        assert.equal(resolveActiveSupplierProvider(), 'manual');
        assert.equal(isActiveSupplierConfigured(), false);
        assert.equal(OrderService.resolveOrderFulfillmentProvider('stars'), 'manual');
        assert.ok(FulfillmentService.getActiveAdapter() instanceof ManualAdminFulfillmentAdapter);

        // 4. Неподдерживаемое/устаревшее значение FULFILLMENT_PROVIDER (например, legacy 'fragment') ->
        // фиксируется invalidFulfillmentProvider и включается безопасный ручной fallback, НЕ Fragment!
        process.env.FULFILLMENT_PROVIDER = 'fragment';
        const cfgInvalid = getEnvConfig();
        assert.equal(cfgInvalid.fulfillmentProvider, 'manual');
        assert.equal(cfgInvalid.invalidFulfillmentProvider, 'fragment');
        assert.equal(resolveActiveSupplierProvider(), 'manual');
        assert.equal(isActiveSupplierConfigured(), false);
        assert.equal(OrderService.resolveOrderFulfillmentProvider('stars'), 'manual');
        assert.ok(FulfillmentService.getActiveAdapter() instanceof ManualAdminFulfillmentAdapter);

        const statusText = renderPlainTextStatus();
        assert.ok(
          statusText.includes('неподдерживаемое значение "fragment"'),
          'renderPlainTextStatus должен явно сигнализировать о неподдерживаемом FULFILLMENT_PROVIDER',
        );
      } finally {
        myStarsClient.setCredentialsOverride(null);
        FulfillmentService.resetAdapterToDefault();
        if (prevProvider === undefined) delete process.env.FULFILLMENT_PROVIDER;
        else process.env.FULFILLMENT_PROVIDER = prevProvider;
        if (prevMyStarsKey === undefined) delete process.env.MYSTARS_API_KEY;
        else process.env.MYSTARS_API_KEY = prevMyStarsKey;
      }

      return 'MyStars подтверждён единственным автоматическим поставщиком; manual и неподдерживаемые значения FULFILLMENT_PROVIDER безопасно откатываются на manual.';
    },
  );

  await runTest(
    'S23-02',
    'Database',
    'Stage 2.3: Совместимость с историческими Firestore-документами заказов (legacy fulfillmentProvider и доп. поля) без ошибок чтения и форматирования',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const nowIso = new Date().toISOString();

      // Имитируем исторический документ заказа из Firestore, сохранивший legacy fulfillmentProvider и старые поля
      const legacyOrderDoc = {
        orderId: 'ord_legacy_hist_2302',
        userId: 'tg_230201',
        userTelegramId: 230201,
        username: 'legacy_buyer',
        recipientUsername: 'legacy_target',
        productId: 'stars_custom',
        productName: '100 Telegram Stars',
        category: 'stars' as const,
        quantity: 100,
        totalPriceUsdCents: 200,
        totalPrice: 200,
        currency: 'USD' as const,
        paymentMethod: 'cryptobot' as const,
        paymentStatus: 'completed' as const,
        fulfillmentStatus: 'completed' as const,
        fulfillmentProvider: 'fragment' as const,
        // Исторические поля, которые могли остаться в старых документах Firestore:
        fragmentOrderId: 'hist_old_123',
        fragmentOrderStatus: 'completed',
        fragmentPriceAmount: '0.42',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await firestoreRepo.setDoc<Order>(
        'orders',
        legacyOrderDoc.orderId,
        legacyOrderDoc as unknown as Order,
      );

      const loaded = await OrderService.getOrderById(legacyOrderDoc.orderId);
      assert.ok(loaded, 'Исторический заказ должен успешно читаться из Firestore');
      assert.equal(loaded.fulfillmentProvider, 'fragment');

      const renderedCard = formatAdminOrderCard(loaded);
      assert.ok(renderedCard.includes('ord_legacy_hist_2302'));
      assert.ok(renderedCard.includes('@legacy_target'));
      assert.ok(
        !renderedCard.includes('Fragment ID:'),
        'Удалённый блок Fragment ID не должен отображаться в карточке заказа',
      );
      assert.ok(
        !renderedCard.includes('Расход Fragment:'),
        'Удалённый блок Расход Fragment не должен отображаться в карточке заказа',
      );

      // Новый заказ всегда получает только 'mystars' или 'manual' (никогда не 'fragment')
      const buyer = { id: 230202, username: 'new_mystars_buyer', first_name: 'NewBuyer' };
      await UserService.upsertFromTelegram(buyer);
      const newOrder = await OrderService.createOrder({
        telegramUser: buyer,
        productId: 'stars_custom',
        quantity: 50,
        recipientUsername: 'new_mystars_buyer',
      });
      assert.ok(
        newOrder.fulfillmentProvider === 'mystars' || newOrder.fulfillmentProvider === 'manual',
        `Новый заказ обязан иметь provider mystars/manual, получено: ${newOrder.fulfillmentProvider}`,
      );

      return 'Исторические документы заказов с legacy-полями безопасно читаются и форматируются без ошибок; новые заказы используют только mystars/manual.';
    },
  );

  await runTest(
    'S23-03',
    'Fulfillment',
    'Stage 2.3: Валидация получателя перед оплатой вызывает исключительно MyStars при активном поставщике и пропускает внешние вызовы в manual-режиме',
    async () => {
      const prevProvider = process.env.FULFILLMENT_PROVIDER;
      let mystarsLookupCalls = 0;

      try {
        myStarsClient.setCredentialsOverride({
          apiBaseUrl: 'https://api.mystars.tg',
          apiKey: 'ms_live_s23_val_key',
          paymentCurrency: 'usdt_ton',
        });
        myStarsClient.setHttpTransport(async (req: HttpTransportRequest): Promise<HttpTransportResponse> => {
          if (req.method === 'POST' && req.url.includes('/v1/recipients/check')) {
            mystarsLookupCalls++;
            return {
              status: 200,
              ok: true,
              json: {
                resolved: true,
                eligible: true,
                recipient_name: 'Valid User',
                indeterminate: false,
              },
            };
          }
          throw new Error(`Unexpected URL in S23-03: ${req.method} ${req.url}`);
        });

        // При активном MyStars -> выполняется проверка через MyStars
        process.env.FULFILLMENT_PROVIDER = 'mystars';
        await validateRecipientWithActiveSupplier({
          category: 'stars',
          recipientUsername: 'valid_stars_user',
        });
        assert.equal(mystarsLookupCalls, 1, 'При активном MyStars валидация получателя должна вызывать MyStars API');

        // При ручном режиме (или неподдерживаемом FULFILLMENT_PROVIDER) -> внешних вызовов нет
        process.env.FULFILLMENT_PROVIDER = 'manual';
        await validateRecipientWithActiveSupplier({
          category: 'stars',
          recipientUsername: 'valid_stars_user',
        });
        assert.equal(mystarsLookupCalls, 1, 'В ручном режиме внешняя валидация поставщика не должна вызываться');

        process.env.FULFILLMENT_PROVIDER = 'fragment';
        await validateRecipientWithActiveSupplier({
          category: 'stars',
          recipientUsername: 'valid_stars_user',
        });
        assert.equal(
          mystarsLookupCalls,
          1,
          'При неподдерживаемом FULFILLMENT_PROVIDER внешняя валидация не должна вызывать ни Fragment, ни MyStars',
        );
      } finally {
        myStarsClient.resetHttpTransport();
        myStarsClient.setCredentialsOverride(null);
        if (prevProvider === undefined) delete process.env.FULFILLMENT_PROVIDER;
        else process.env.FULFILLMENT_PROVIDER = prevProvider;
      }

      return 'Валидация получателя работает строго через MyStars при активном поставщике и безопасно пропускает внешние вызовы в manual-режиме.';
    },
  );

  // =========================================================================
  // STAGE 2.4: FINAL TECHNICAL AUDIT — REGRESSION & SECURITY HARDENING TESTS
  // =========================================================================

  await runTest(
    'S24-01',
    'Security',
    'Stage 2.4: Некорректная percent-кодировка в callback_data (pay_ord / topup:xr_pay) безопасно отклоняется без необработанного URIError',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      clearCallbackDebounceMap();

      const harness = createWiredBotHarness(false);
      await harness.sendCallback(
        { id: 240101, username: 'audit_cb_user1', first_name: 'AuditUser1' },
        'pay_ord:cryptobot:USDT:%E0%A4%A:ord_malformed_1',
      );
      await harness.sendCallback(
        { id: 240102, username: 'audit_cb_user2', first_name: 'AuditUser2' },
        'topup:xr_pay:USDT:%E0%A4%A:10',
      );

      const answers = harness.calls.filter((c) => c.method === 'answerCallbackQuery');
      assert.equal(answers.length, 2, 'Оба некорректных callback должны завершиться безопасным answerCallbackQuery');
      assert.ok(answers[0].showAlert && answers[0].text.includes('Некорректные параметры'));
      assert.ok(answers[1].showAlert && answers[1].text.includes('Некорректные параметры'));

      return 'Некорректная percent-кодировка в callback_data безопасно перехватывается без URIError.';
    },
  );

  await runTest(
    'S24-02',
    'Security',
    'Stage 2.4: HTML-спецсимволы (<, >, &) в названии товара и цифровом ключе корректно экранируются в parse_mode: HTML уведомлениях DigitalKeyService',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const prevOwner = process.env.OWNER_TELEGRAM_ID;
      process.env.OWNER_TELEGRAM_ID = '240200';
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      try {
        const product = await ProductService.createProduct({
          category: 'gifts',
          name: 'Pro <Key> & "Gift"',
          description: 'Test product with HTML chars',
          priceUsdCents: 500,
        });
        const buyer = { id: 240201, username: 's24_html_buyer', first_name: 'HtmlBuyer' };
        await UserService.upsertFromTelegram(buyer);

        // 1. Empty stock alert to owner must escape productName
        const emptyOrder = await OrderService.createOrder({
          telegramUser: buyer,
          productId: product.id,
          quantity: 1,
        });
        const paidEmptyOrder = (await firestoreRepo.updateDoc<Order>('orders', emptyOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        }))!;
        await DigitalKeyService.fulfillOrderWithDigitalKey(paidEmptyOrder, mockBot);
        const ownerNotice = sentMessages.find((m) => Number(m.chatId) === 240200);
        assert.ok(ownerNotice, 'Владелец должен получить уведомление о нехватке ключей');
        assert.ok(
          ownerNotice.text.includes('Pro &lt;Key&gt; &amp; &quot;Gift&quot;'),
          `Название товара должно быть экранировано: ${ownerNotice.text}`,
        );
        assert.ok(!ownerNotice.text.includes('<Key>'), 'Сырые HTML-теги не должны попадать в сообщение');

        // 2. Delivered key with < & > must be HTML-escaped for buyer
        await DigitalKeyService.addKeys({
          actorTelegramId: 240200,
          productId: product.id,
          keys: ['KEY-<A&B>-2402'],
        });
        const fulfilledOrder = await OrderService.createOrder({
          telegramUser: buyer,
          productId: product.id,
          quantity: 1,
        });
        const paidFulfilledOrder = (await firestoreRepo.updateDoc<Order>('orders', fulfilledOrder.orderId, {
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
        }))!;
        await DigitalKeyService.fulfillOrderWithDigitalKey(paidFulfilledOrder, mockBot);
        const buyerNotice = sentMessages.find((m) => Number(m.chatId) === buyer.id);
        assert.ok(buyerNotice, 'Покупатель должен получить сообщение с цифровым ключом');
        assert.ok(
          buyerNotice.text.includes('KEY-&lt;A&amp;B&gt;-2402'),
          `Цифровой ключ обязан быть HTML-экранирован: ${buyerNotice.text}`,
        );
        assert.ok(
          buyerNotice.text.includes('Pro &lt;Key&gt; &amp; &quot;Gift&quot;'),
          'Название товара в письме покупателю обязано быть HTML-экранировано',
        );
      } finally {
        if (prevOwner === undefined) delete process.env.OWNER_TELEGRAM_ID;
        else process.env.OWNER_TELEGRAM_ID = prevOwner;
      }

      return 'HTML-спецсимволы в названии товара и цифровых ключах безопасно экранируются перед отправкой в Telegram.';
    },
  );

  await runTest(
    'S24-03',
    'Security',
    'Stage 2.4: Правило Firestore /settings/{settingKey} ограничивает чтение для не-админов только документом global, а MyStarsService не создаёт циклических импортов',
    async () => {
      const rulesSource = fs.readFileSync(
        path.resolve(process.cwd(), 'firestore.rules'),
        'utf-8',
      );
      assert.ok(
        rulesSource.includes(
          "allow get: if isValidId(settingKey) && (isAdmin() || (isSignedIn() && settingKey == 'global'));",
        ),
        'firestore.rules должен ограничивать чтение /settings/{settingKey} для обычных пользователей только ключом global',
      );

      const mystarsSource = fs.readFileSync(
        path.resolve(process.cwd(), 'src/services/MyStarsService.ts'),
        'utf-8',
      );
      assert.ok(
        !mystarsSource.includes("from './FulfillmentService.ts'"),
        'MyStarsService.ts не должен импортировать FulfillmentService.ts (исключение циклических зависимостей)',
      );

      return 'Доступ к внутренним настройкам /settings/* закрыт от не-админов, а циклический импорт MyStarsService <-> FulfillmentService устранён.';
    },
  );

  await runTest(
    'S24-04',
    'Security',
    'Stage 2.4: Падение фонового polling в bot.ts переводит статус в connected=false и маскирует секреты, а watcher в server.ts отслеживает остановку polling',
    async () => {
      const botSource = fs.readFileSync(
        path.resolve(process.cwd(), 'src/bot/bot.ts'),
        'utf-8',
      );
      assert.ok(
        botSource.includes('this.status.connected = false;\n            this.status.pollingActive = false;'),
        'При ошибке фонового bot.launch() должен сбрасываться this.status.connected = false',
      );

      const serverSource = fs.readFileSync(
        path.resolve(process.cwd(), 'server.ts'),
        'utf-8',
      );
      assert.ok(
        serverSource.includes("currentStatus.mode === 'polling' && !currentStatus.pollingActive"),
        'watcherInterval в server.ts должен перезапускать бота при остановке polling',
      );
      assert.ok(
        serverSource.includes("escapeHtml(order.productName)"),
        'server.ts должен HTML-экранировать динамические поля заказа в уведомлениях Telegram',
      );
      assert.ok(
        serverSource.includes("maskSecretsInText(raw, ["),
        'server.ts должен маскировать секреты в bootstrap().catch',
      );

      const masked = maskSecretsInText('Fail key=PRIVATE_KEY_SECRET_999 token=BOT_TOK_123', [
        'PRIVATE_KEY_SECRET_999',
        'BOT_TOK_123',
      ]);
      assert.ok(!masked.includes('PRIVATE_KEY_SECRET_999'));
      assert.ok(!masked.includes('BOT_TOK_123'));

      return 'Сбой фонового polling корректно сбрасывает connected=false для автоперезапуска, а секреты и HTML-поля защищены.';
    },
  );

  console.log('\n================================================================');
  console.log(`📊 РЕЗУЛЬТАТЫ АВТОТЕСТОВ (${testResults.length}/${testResults.length} PASS):`);
  for (const r of testResults) {
    console.log(
      `✅ [${r.status}] [${r.id}] (${r.category}) ${r.name}\n   └─ Среда: ${r.environment} | Emulator: ${r.emulatorUsed ? 'Да' : 'Нет (Isolated Mock)'}\n   └─ Детали: ${r.details}`,
    );
  }
  console.log('================================================================\n');
}

runFullAuditTestSuite()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ ТЕСТЫ ЗАВЕРШИЛИСЬ С ОШИБКОЙ:', err);
    process.exit(1);
  });
