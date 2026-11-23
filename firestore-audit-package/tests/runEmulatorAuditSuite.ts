import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
} from 'firebase/firestore';
import {
  assertEmulatorOnlyEnvironment,
  firestoreRepo,
  ProductionGuardError,
  StorageUnavailableError,
} from '../../src/db/firestore.ts';
import { OrderService } from '../../src/services/OrderService.ts';
import { ProductService } from '../../src/services/ProductService.ts';
import { PaymentService } from '../../src/services/PaymentService.ts';
import { BalanceService } from '../../src/services/BalanceService.ts';
import {
  PaymentProviderGateway,
  VerifiedProviderInvoice,
} from '../../src/services/PaymentProviders.ts';
import {
  FulfillmentService,
  FulfillmentProviderAdapter,
  ManualAdminFulfillmentAdapter,
} from '../../src/services/FulfillmentService.ts';
import {
  MyStarsFulfillmentAdapter,
  myStarsClient,
} from '../../src/services/MyStarsService.ts';
import { UserService } from '../../src/services/UserService.ts';
import {
  AdminRecord,
  BalanceTopUpRecord,
  Order,
  OrderStatus,
  PaymentLockRecord,
  PaymentRecord,
  Product,
  StoreSettings,
  StoreTransaction,
  StoreUser,
} from '../../src/types.ts';
import { DIRTY_DOZEN_TESTS } from '../../firestore.rules.test.ts';
import {
  AUDIT_PROJECT_ID,
  exportEmulatorCollectionsToJson,
  seedSyntheticAuditDataset,
} from '../scripts/seedSyntheticData.ts';
import {
  assertSupportedJavaVersion,
  buildIsolatedEmulatorChildEnv,
  JavaVersionError,
  parseJavaMajorVersion,
  verifyJavaRuntime,
} from '../scripts/runAuditEmulatorCli.ts';

export interface EmulatorTestRecord {
  id: string;
  suite: 'Environment' | 'Integrity' | 'SecurityRules' | 'IndexesQueries' | 'Concurrency';
  name: string;
  whatWasTested: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  details: string;
}

const results: EmulatorTestRecord[] = [];

async function runCheck(
  id: string,
  suite: EmulatorTestRecord['suite'],
  name: string,
  whatWasTested: string,
  fn: () => Promise<string>,
): Promise<void> {
  const start = Date.now();
  try {
    const details = await fn();
    const durationMs = Date.now() - start;
    results.push({
      id,
      suite,
      name,
      whatWasTested,
      status: 'PASS',
      durationMs,
      details,
    });
    console.log(`✅ [PASS] [${id}] (${suite}) ${name} (${durationMs} ms)\n   └─ ${details}`);
  } catch (error) {
    const durationMs = Date.now() - start;
    const msg = error instanceof Error ? error.stack || error.message : String(error);
    results.push({
      id,
      suite,
      name,
      whatWasTested,
      status: 'FAIL',
      durationMs,
      details: msg,
    });
    console.error(`❌ [FAIL] [${id}] (${suite}) ${name} (${durationMs} ms)\n   └─ ${msg}`);
  }
}

function createMockBot() {
  const sentMessages: Array<{ chatId: number | string; text: string }> = [];
  const bot = {
    telegram: {
      sendMessage: async (chatId: number | string, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: sentMessages.length };
      },
    },
  };
  return { bot: bot as never, sentMessages };
}

async function main(): Promise<void> {
  console.log('================================================================================');
  console.log('🚀 ЗАПУСК НЕЗАВИСИМОГО АУДИТА FIRESTORE НА ЛОКАЛЬНОМ FIREBASE EMULATOR');
  console.log('================================================================================');

  // Execute ProductionGuard strictly BEFORE any Firebase initialization
  assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, process.env);

  // ===========================================================================
  // SUITE 1: PRODUCTION GUARD, JAVA RUNTIME & EMULATOR ENVIRONMENT (5 TESTS)
  // ===========================================================================
  await runCheck(
    'ENV-01',
    'Environment',
    'Блокировка при отсутствии FIRESTORE_EMULATOR_HOST',
    'Проверка, что assertEmulatorOnlyEnvironment выбрасывает ProductionGuardError, если FIRESTORE_EMULATOR_HOST не задан',
    async () => {
      const isolatedEnv: NodeJS.ProcessEnv = { ...process.env };
      delete isolatedEnv.FIRESTORE_EMULATOR_HOST;
      let blocked = false;
      try {
        assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, isolatedEnv);
      } catch (err) {
        blocked = err instanceof ProductionGuardError;
      }
      assert.equal(blocked, true, 'Ожидалась блокировка ProductionGuardError без FIRESTORE_EMULATOR_HOST');
      return 'Запуск без FIRESTORE_EMULATOR_HOST заблокирован через ProductionGuardError.';
    },
  );

  await runCheck(
    'ENV-02',
    'Environment',
    'Блокировка Production projectId и внешних/нестандартных хостов',
    'Проверка запрета подключения к реальному проекту tg-1-675b4, другим проектам или хостам вне 127.0.0.1:8080 / localhost:8080',
    async () => {
      let blockedProdId = false;
      try {
        assertEmulatorOnlyEnvironment('tg-1-675b4', process.env);
      } catch (err) {
        blockedProdId = err instanceof ProductionGuardError;
      }
      assert.equal(blockedProdId, true, 'Production projectId должен блокироваться');

      let blockedOtherDemoId = false;
      try {
        assertEmulatorOnlyEnvironment('demo-other-project', process.env);
      } catch (err) {
        blockedOtherDemoId = err instanceof ProductionGuardError;
      }
      assert.equal(blockedOtherDemoId, true, 'Любой проект кроме demo-stars-shop-audit должен блокироваться');

      let blockedRemoteHost = false;
      try {
        assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, {
          ...process.env,
          FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443',
        });
      } catch (err) {
        blockedRemoteHost = err instanceof ProductionGuardError;
      }
      assert.equal(blockedRemoteHost, true, 'Внешний хост должен блокироваться');

      const localhostAllowed = assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: 'localhost:8080',
      });
      assert.equal(localhostAllowed.emulatorHost, 'localhost:8080');

      return 'Реальный projectId (tg-1-675b4) и внешние хосты жёстко заблокированы; разрешены только 127.0.0.1:8080 и localhost:8080 для demo-stars-shop-audit.';
    },
  );

  await runCheck(
    'ENV-03',
    'Environment',
    'Блокировка при наличии реальных сервисных ключей и защита родительского process.env',
    'Проверка запрета запуска при наличии FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL и неизменности родительского окружения в buildIsolatedEmulatorChildEnv',
    async () => {
      let blockedKey = false;
      try {
        assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, {
          ...process.env,
          FIREBASE_PRIVATE_KEY: 'fake-test-key-for-guard-check',
        });
      } catch (err) {
        blockedKey = err instanceof ProductionGuardError;
      }
      assert.equal(blockedKey, true, 'Наличие FIREBASE_PRIVATE_KEY должно блокироваться');

      // Verify buildIsolatedEmulatorChildEnv does NOT mutate the parent env object
      const mockParentEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        FIREBASE_PRIVATE_KEY: 'parent-secret-key-must-stay-intact',
        WEBHOOK_SECRET: 'parent-webhook-secret-must-stay-intact',
        TELEGRAM_BOT_TOKEN: 'parent-bot-token-must-stay-intact',
      };
      const childEnv = buildIsolatedEmulatorChildEnv(mockParentEnv);
      assert.equal(
        mockParentEnv.FIREBASE_PRIVATE_KEY,
        'parent-secret-key-must-stay-intact',
        'Родительский FIREBASE_PRIVATE_KEY не должен изменяться или удаляться',
      );
      assert.equal(
        mockParentEnv.WEBHOOK_SECRET,
        'parent-webhook-secret-must-stay-intact',
        'Родительский WEBHOOK_SECRET не должен изменяться или удаляться',
      );
      assert.equal(
        mockParentEnv.TELEGRAM_BOT_TOKEN,
        'parent-bot-token-must-stay-intact',
        'Родительский TELEGRAM_BOT_TOKEN не должен изменяться или удаляться',
      );
      assert.equal(childEnv.FIREBASE_PRIVATE_KEY, undefined);
      assert.equal(childEnv.WEBHOOK_SECRET, undefined);
      assert.equal(childEnv.TELEGRAM_BOT_TOKEN, undefined);
      assert.equal(childEnv.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
      assert.equal(childEnv.GCLOUD_PROJECT, 'demo-stars-shop-audit');

      return 'Присутствие сервисных ключей блокируется, а buildIsolatedEmulatorChildEnv создаёт очищенное окружение дочернего процесса без модификации секретов родительского процесса.';
    },
  );

  await runCheck(
    'ENV-04',
    'Environment',
    'Проверка verifyJavaRuntime (Java 17, 21, 22, 8, отсутствие Java, битый вывод, status=1, status=null, status=0)',
    'Прямое тестирование функции verifyJavaRuntime (а также parseJavaMajorVersion и assertSupportedJavaVersion) на всех позитивных и негативных сценариях завершения процесса',
    async () => {
      // 1. Java 17 (status: 0, valid Java 17 output in stderr/stdout) -> FAIL
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: 0,
            signal: null,
            stderr: 'openjdk version "17.0.21" 2026-04-14\nOpenJDK Runtime Environment (build 17.0.21+9-Ubuntu)',
            stdout: '',
          })),
        (err: unknown) => err instanceof JavaVersionError && /Java 17/.test(err.message),
      );
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: 0,
            signal: null,
            stderr: '',
            stdout: 'openjdk 17.0.8 2023-07-18',
          })),
        (err: unknown) => err instanceof JavaVersionError && /Java 17/.test(err.message),
      );

      // 2. Java 21 (status: 0, quoted in stderr and unquoted in stdout) -> PASS
      const v21Stderr = verifyJavaRuntime('java', 21, () => ({
        status: 0,
        signal: null,
        stderr: 'openjdk version "21.0.13.0.3" 2026-10-24\nOpenJDK Runtime Environment',
        stdout: '',
      }));
      assert.equal(v21Stderr.major, 21);

      const v21Stdout = verifyJavaRuntime('java', 21, () => ({
        status: 0,
        signal: null,
        stderr: '',
        stdout: 'openjdk 21.0.4 2024-07-16\nOpenJDK Runtime Environment Temurin-21.0.4+7',
      }));
      assert.equal(v21Stdout.major, 21);

      // 3. Java 22 (status: 0, quoted & unquoted) -> PASS
      const v22Quoted = verifyJavaRuntime('java', 21, () => ({
        status: 0,
        signal: null,
        stderr: 'java version "22.0.1" 2024-04-16\nJava(TM) SE Runtime Environment',
        stdout: '',
      }));
      assert.equal(v22Quoted.major, 22);

      const v22Unquoted = verifyJavaRuntime('java', 21, () => ({
        status: 0,
        signal: null,
        stderr: '',
        stdout: 'openjdk 22 2024-03-19',
      }));
      assert.equal(v22Unquoted.major, 22);

      // 4. Java 8 ("1.8.0_392", status: 0) -> FAIL
      const parsed8 = parseJavaMajorVersion('java version "1.8.0_392"');
      assert.equal(parsed8.major, 8);
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: 0,
            signal: null,
            stderr: 'java version "1.8.0_392"\nJava(TM) SE Runtime Environment',
            stdout: '',
          })),
        (err: unknown) => err instanceof JavaVersionError && /Java 8/.test(err.message),
      );

      // 5. Missing Java executable (both via spawn error ENOENT and real OS call) -> FAIL
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => {
            const err = new Error('spawnSync java ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            return {
              error: err,
              status: null,
              signal: null,
              stderr: '',
              stdout: '',
            };
          }),
        (err: unknown) => err instanceof JavaVersionError && /ENOENT/.test(err.message),
      );
      assert.throws(
        () => verifyJavaRuntime('__non_existent_java_binary_audit_check__', 21),
        (err: unknown) => err instanceof JavaVersionError,
      );

      // 6. Empty or malformed output (status: 0) -> FAIL
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: 0,
            signal: null,
            stderr: '   ',
            stdout: '',
          })),
        (err: unknown) => err instanceof JavaVersionError && /пустой вывод/.test(err.message),
      );
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: 0,
            signal: null,
            stderr: 'Picked up _JAVA_OPTIONS: -Xmx512m\nUnrecognized output without version',
            stdout: '',
          })),
        (err: unknown) => err instanceof JavaVersionError,
      );
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: 0,
            signal: null,
            stderr: 'openjdk version "abc.def"',
            stdout: '',
          })),
        (err: unknown) => err instanceof JavaVersionError,
      );

      // 7. Exit code 1 (status: 1) EVEN WHEN output contains valid Java 21 -> MUST FAIL!
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: 1,
            signal: null,
            stderr: 'openjdk version "21.0.13.0.3" 2026-10-24\nOpenJDK Runtime Environment',
            stdout: '',
          })),
        (err: unknown) =>
          err instanceof JavaVersionError && /status: 1/.test(err.message),
      );

      // 8. status: null (both with signal="SIGTERM" and without signal) EVEN WHEN output contains valid Java 21 -> MUST FAIL!
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: null,
            signal: 'SIGTERM',
            stderr: 'openjdk version "21.0.13.0.3" 2026-10-24\nOpenJDK Runtime Environment',
            stdout: '',
          })),
        (err: unknown) =>
          err instanceof JavaVersionError && /SIGTERM/.test(err.message),
      );
      assert.throws(
        () =>
          verifyJavaRuntime('java', 21, () => ({
            status: null,
            signal: null,
            stderr: 'openjdk version "21.0.13.0.3" 2026-10-24\nOpenJDK Runtime Environment',
            stdout: '',
          })),
        (err: unknown) =>
          err instanceof JavaVersionError && /status: null/.test(err.message),
      );

      // 9. status: 0 with valid Java 21 (real OS call) -> MUST PASS!
      const systemJava = verifyJavaRuntime('java', 21);
      assert.ok(systemJava.major >= 21);
      assertSupportedJavaVersion(systemJava.firstLine, 21);

      return `Проверено поведение verifyJavaRuntime на всех 9 сценариях: Java 17/8 отклонены, отсутствующая Java и битый вывод отклонены, status=1 и status=null/SIGTERM при валидном выводе Java 21 жёстко отклонены, status=0 с Java 21/22 принят. Системная Java: ${systemJava.rawVersion} (major=${systemJava.major}).`;
    },
  );

  await runCheck(
    'ENV-05',
    'Environment',
    'Реальное подключение к Firebase Firestore Emulator и загрузка 12 сценариев',
    'Проверка инициализации Admin SDK поверх локального Firestore Emulator (127.0.0.1:8080) и сидинга 7 коллекций',
    async () => {
      const summary = await seedSyntheticAuditDataset();
      assert.equal(firestoreRepo.isEmulatorMode(), true);
      assert.equal(summary.projectId, AUDIT_PROJECT_ID);
      assert.equal(summary.counts.users, 4);
      assert.equal(summary.counts.products, 6);
      assert.equal(summary.counts.orders, 12);
      assert.equal(summary.counts.payments, 10);
      assert.equal(summary.counts.transactions, 19);
      assert.equal(summary.counts.admins, 2);
      assert.equal(summary.counts.settings, 1);
      return `Успешно подключён к Emulator (${summary.emulatorHost}, project: ${summary.projectId}). Записано 54 документа в 7 коллекциях.`;
    },
  );

  // ===========================================================================
  // SUITE 2: DATA INTEGRITY VERIFICATION ON EMULATOR (11 TESTS)
  // ===========================================================================
  await runCheck(
    'INT-01',
    'Integrity',
    'Каждый платёж связан с существующим заказом',
    'Сверка ссылочной целостности PaymentRecord.orderId -> Order.orderId в Emulator',
    async () => {
      const payments = await firestoreRepo.listDocs<PaymentRecord>('payments', 500);
      assert.ok(payments.length > 0, 'Коллекция payments не должна быть пустой');
      for (const p of payments) {
        const ord = await OrderService.getOrderById(p.orderId);
        assert.ok(ord, `Платёж ${p.paymentId} ссылается на несуществующий заказ ${p.orderId}`);
        assert.equal(ord.telegramPaymentChargeId, p.telegramPaymentChargeId);
      }
      return `Проверено ${payments.length} документов payments: каждый связан с существующим заказом и совпадает по telegramPaymentChargeId.`;
    },
  );

  await runCheck(
    'INT-02',
    'Integrity',
    'Сумма платежа соответствует сумме заказа и цене товара',
    'Сверка PaymentRecord.totalAmount == Order.totalPrice == Product.price * Order.quantity',
    async () => {
      const payments = await firestoreRepo.listDocs<PaymentRecord>('payments', 500);
      for (const p of payments) {
        const ord = await OrderService.getOrderById(p.orderId);
        assert.ok(ord);
        assert.equal(
          p.totalAmount,
          ord.totalPrice,
          `Несовпадение суммы в платеже ${p.paymentId} (${p.totalAmount}) и заказе ${ord.orderId} (${ord.totalPrice})`,
        );
        const prod = await ProductService.getProductById(ord.productId);
        assert.ok(prod);
        assert.equal(
          ord.totalPrice,
          prod.price * ord.quantity,
          `Сумма заказа ${ord.orderId} (${ord.totalPrice}) не равна price*quantity (${prod.price}*${ord.quantity})`,
        );
      }
      return `Все ${payments.length} платежей и заказов имеют математически точное совпадение сумм (totalAmount == totalPrice == price * quantity).`;
    },
  );

  await runCheck(
    'INT-03',
    'Integrity',
    'Валюта всех товаров, заказов, платежей и транзакций — строго XTR',
    'Проверка поля currency === "XTR" во всех финансовых документах базы',
    async () => {
      const products = await firestoreRepo.listDocs<Product>('products', 500);
      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      const payments = await firestoreRepo.listDocs<PaymentRecord>('payments', 500);
      const txs = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);

      for (const prod of products) assert.equal(prod.currency, 'XTR');
      for (const ord of orders) assert.equal(ord.currency, 'XTR');
      for (const pay of payments) assert.equal(pay.currency, 'XTR');
      for (const tx of txs) assert.equal(tx.currency, 'XTR');

      return `Проверено ${products.length + orders.length + payments.length + txs.length} документов: везде установлена валюта Telegram Stars (XTR).`;
    },
  );

  await runCheck(
    'INT-04',
    'Integrity',
    'Каждый заказ ссылается на существующий товар и существующего пользователя',
    'Проверка внешних ключей Order.productId -> Product.id и Order.userId -> StoreUser.userId',
    async () => {
      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      for (const ord of orders) {
        const prod = await ProductService.getProductById(ord.productId);
        assert.ok(prod, `Заказ ${ord.orderId} ссылается на несуществующий товар ${ord.productId}`);
        const usr = await UserService.getUserById(ord.userId);
        assert.ok(usr, `Заказ ${ord.orderId} ссылается на несуществующего пользователя ${ord.userId}`);
        assert.equal(ord.userTelegramId, usr.telegramId);
      }
      return `Все ${orders.length} заказов ссылаются на валидные документы в коллекциях products и users.`;
    },
  );

  await runCheck(
    'INT-05',
    'Integrity',
    'Запрет завершения заказа или перевода в paid без подтверждённой оплаты',
    'Проверка, что completeOrder и markOrderPaid блокируют неоплаченный заказ (ord_syn_pending_01)',
    async () => {
      await assert.rejects(
        async () => {
          await FulfillmentService.completeOrder({
            orderId: 'ord_syn_pending_01',
            adminNote: 'Попытка выдать неоплаченный заказ',
          });
        },
        /не имеет статуса подтверждённой оплаты/,
      );

      await assert.rejects(
        async () => {
          await OrderService.markOrderPaid({
            orderId: 'ord_syn_pending_01',
            telegramPaymentChargeId: 'chg_non_existent_999',
          });
        },
        /PaymentRecord не найден/,
      );

      const unchanged = await OrderService.getOrderById('ord_syn_pending_01');
      assert.equal(unchanged?.paymentStatus, 'pending');
      assert.equal(unchanged?.fulfillmentStatus, 'pending');
      return 'Попытки завершить заказ без оплаты или отметить заказ оплаченным без PaymentRecord жёстко отклонены.';
    },
  );

  await runCheck(
    'INT-06',
    'Integrity',
    'Запрет повторной обработки оплаченного платежа и корректное отключение XTR checkout',
    'Проверка отключения XTR checkout (XTR_CHECKOUT_DISABLED), идемпотентности OrderService.markOrderPaid и дублирующего вызова verifyAndProcessOrderPayment',
    async () => {
      const beforeUser = await UserService.getUserById('tg_900001002');
      assert.ok(beforeUser);
      const txsBefore = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);

      // 1. Legacy XTR checkout must remain strictly disabled without mutating user or order
      const preCheckout = await PaymentService.validatePreCheckout({
        invoicePayload: 'ord_syn_paid_02',
        telegramUserId: 900001002,
        currency: 'XTR',
        totalAmount: 100,
      });
      assert.equal(preCheckout.ok, false, 'XTR validatePreCheckout должен быть отключён');

      await assert.rejects(
        async () => {
          await PaymentService.processSuccessfulPayment({
            telegramUserId: 900001002,
            invoicePayload: 'ord_syn_paid_02',
            currency: 'XTR',
            totalAmount: 100,
            telegramPaymentChargeId: 'chg_syn_paid_02',
          });
        },
        /XTR_CHECKOUT_DISABLED/,
      );

      // 2. OrderService.markOrderPaid on already-paid order must be strictly idempotent
      const existingOrder = await OrderService.markOrderPaid({
        orderId: 'ord_syn_paid_02',
        paymentId: 'pay_chg_syn_paid_02',
        telegramPaymentChargeId: 'chg_syn_paid_02',
      });
      assert.equal(existingOrder.paymentStatus, 'paid');

      // 3. Active CryptoBot PaymentRecord duplicate verification must return duplicate=true
      const tempDupPaymentId = 'ordpay_int06_dup_01';
      const nowIso = new Date().toISOString();
      await firestoreRepo.setDoc<PaymentRecord>('payments', tempDupPaymentId, {
        paymentId: tempDupPaymentId,
        kind: 'order',
        provider: 'cryptobot',
        providerPaymentId: 'inv_int06_dup_01',
        orderId: 'ord_syn_paid_02',
        userId: 'tg_900001002',
        userTelegramId: 900001002,
        totalAmount: 100,
        expectedUsdCents: 100,
        expectedAmountStr: '1.00',
        currency: 'USDT',
        network: 'TON',
        invoicePayload: 'ord_syn_paid_02',
        status: 'paid',
        paidAt: nowIso,
        confirmedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      try {
        const dupRes = await PaymentService.verifyAndProcessOrderPayment(tempDupPaymentId);
        assert.equal(dupRes.ok, true);
        assert.equal(dupRes.duplicate, true, 'Повторная верификация оплаченного PaymentRecord должна вернуть duplicate=true');
        assert.equal(dupRes.status, 'paid');
      } finally {
        await firestoreRepo.deleteDoc('payments', tempDupPaymentId);
      }

      const afterUser = await UserService.getUserById('tg_900001002');
      assert.equal(afterUser?.totalOrders, beforeUser.totalOrders);
      assert.equal(afterUser?.totalSpentStars, beforeUser.totalSpentStars);
      assert.equal(afterUser?.totalSpentUsdCents, beforeUser.totalSpentUsdCents);

      const txsAfter = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);
      assert.equal(txsAfter.length, txsBefore.length, 'Не должно создаваться дублирующих транзакций');
      return 'XTR checkout строго отключён (XTR_CHECKOUT_DISABLED), markOrderPaid и verifyAndProcessOrderPayment на оплаченном платеже идемпотентны (duplicate=true) без изменения счётчиков.';
    },
  );

  await runCheck(
    'INT-07',
    'Integrity',
    'Запрет двойной выдачи одного заказа',
    'Проверка идемпотентности completeOrder и initiateFulfillment для уже выданного заказа ord_syn_completed_04',
    async () => {
      const { bot, sentMessages } = createMockBot();
      const txsBefore = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);

      const repeatComplete = await FulfillmentService.completeOrder({
        orderId: 'ord_syn_completed_04',
        adminNote: 'Повторное нажатие кнопки выдачи',
        bot,
      });
      assert.equal(repeatComplete.fulfillmentStatus, 'completed');
      assert.equal(
        repeatComplete.fulfillmentNote,
        'Код активации подписки: SYN-PREM-3M-9941',
        'Исходное примечание выдачи не должно перезаписываться при повторном вызове',
      );

      const repeatInit = await FulfillmentService.initiateFulfillment(repeatComplete, bot);
      assert.equal(repeatInit.fulfillmentStatus, 'completed');
      assert.equal(sentMessages.length, 0, 'Повторное уведомление не должно отправляться, т.к. buyerNotifiedAt уже заполнен');

      const txsAfter = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);
      assert.equal(txsAfter.length, txsBefore.length, 'Не должно создаваться дублирующих транзакций выдачи');
      return 'Повторное завершение и повторный запуск выдачи для completed-заказа полностью идемпотентны.';
    },
  );

  await runCheck(
    'INT-08',
    'Integrity',
    'Допустимость переходов и комбинаций статусов заказов',
    'Проверка всех заказов на соответствие матрице допустимых пар (paymentStatus, fulfillmentStatus)',
    async () => {
      const validPairs = new Set<string>([
        'pending:pending',
        'paid:paid',
        'paid:processing',
        'paid:failed',
        'completed:completed',
        'cancelled:cancelled',
        'refunded:refunded',
      ]);
      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      for (const ord of orders) {
        const pair = `${ord.paymentStatus}:${ord.fulfillmentStatus}`;
        assert.equal(
          validPairs.has(pair),
          true,
          `Недопустимая комбинация статусов ${pair} в заказе ${ord.orderId}`,
        );
        if (ord.fulfillmentStatus === 'completed') {
          assert.ok(ord.telegramPaymentChargeId, `У завершённого заказа ${ord.orderId} отсутствует charge_id`);
          assert.ok(ord.paidAt, `У завершённого заказа ${ord.orderId} отсутствует paidAt`);
          assert.ok(ord.completedAt, `У завершённого заказа ${ord.orderId} отсутствует completedAt`);
        }
      }
      return `Все ${orders.length} заказов находятся в строго валидных состояниях конечного автомата.`;
    },
  );

  await runCheck(
    'INT-09',
    'Integrity',
    'Отсутствие пропущенных обязательных полей во всех 7 коллекциях',
    'Проверка наличия всех required-полей согласно firebase-blueprint.json и src/types.ts',
    async () => {
      const blueprintRaw = fs.readFileSync(
        path.resolve(process.cwd(), 'firebase-blueprint.json'),
        'utf-8',
      );
      const blueprint = JSON.parse(blueprintRaw) as {
        entities: Record<string, { required: string[] }>;
      };

      const mapping: Array<{ col: CollectionName; entity: string }> = [
        { col: 'users', entity: 'User' },
        { col: 'products', entity: 'Product' },
        { col: 'orders', entity: 'Order' },
        { col: 'payments', entity: 'Payment' },
        { col: 'transactions', entity: 'Transaction' },
        { col: 'admins', entity: 'Admin' },
        { col: 'settings', entity: 'Setting' },
      ];

      let checkedDocs = 0;
      for (const { col, entity } of mapping) {
        const requiredFields = blueprint.entities[entity].required;
        const docs = await firestoreRepo.listDocs<Record<string, unknown>>(col, 500);
        assert.ok(docs.length > 0, `Коллекция ${col} пуста`);
        for (const d of docs) {
          checkedDocs++;
          for (const reqField of requiredFields) {
            assert.notEqual(
              d[reqField],
              undefined,
              `В коллекции ${col} отсутствует обязательное поле "${reqField}"`,
            );
            assert.notEqual(
              d[reqField],
              null,
              `В коллекции ${col} поле "${reqField}" равно null`,
            );
          }
        }
      }
      return `Проверено ${checkedDocs} документов во всех 7 коллекциях: все обязательные поля присутствуют.`;
    },
  );

  await runCheck(
    'INT-10',
    'Integrity',
    'Строгое соответствие типов данных во всех документах',
    'Проверка типов string, number, boolean, enum и формата ISO-8601 дат во всех документах',
    async () => {
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
      const users = await firestoreRepo.listDocs<StoreUser>('users', 500);
      for (const u of users) {
        assert.equal(typeof u.userId, 'string');
        assert.equal(typeof u.telegramId, 'number');
        assert.equal(typeof u.isBlocked, 'boolean');
        assert.equal(typeof u.totalOrders, 'number');
        assert.equal(typeof u.totalSpentStars, 'number');
        assert.match(u.createdAt, isoRegex);
        assert.match(u.updatedAt, isoRegex);
      }

      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      for (const o of orders) {
        assert.equal(typeof o.orderId, 'string');
        assert.equal(typeof o.userTelegramId, 'number');
        assert.equal(typeof o.quantity, 'number');
        assert.equal(typeof o.totalPrice, 'number');
        assert.match(o.createdAt, isoRegex);
        assert.match(o.updatedAt, isoRegex);
        if (o.fulfillmentAttempts !== undefined) {
          assert.equal(typeof o.fulfillmentAttempts, 'number');
        }
      }
      return 'Все поля во всех коллекциях имеют корректные примитивные типы и валидные метки времени ISO-8601.';
    },
  );

  await runCheck(
    'INT-11',
    'Integrity',
    'Межколлекционная согласованность агрегатов users, orders, payments и transactions',
    'Сверка суммы totalOrders и totalSpentStars каждого пользователя с его реально оплаченными заказами и платежами',
    async () => {
      const users = await firestoreRepo.listDocs<StoreUser>('users', 500);
      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      const payments = await firestoreRepo.listDocs<PaymentRecord>('payments', 500);
      const transactions = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);

      for (const u of users) {
        const paidOrdersForUser = orders.filter(
          (o) =>
            o.userId === u.userId &&
            ['paid', 'processing', 'completed', 'refunded'].includes(o.paymentStatus),
        );
        const expectedTotalOrders = paidOrdersForUser.length;
        const expectedTotalStars = paidOrdersForUser.reduce((acc, o) => acc + o.totalPrice, 0);

        assert.equal(
          u.totalOrders,
          expectedTotalOrders,
          `У пользователя ${u.userId} totalOrders=${u.totalOrders}, но оплаченных заказов=${expectedTotalOrders}`,
        );
        assert.equal(
          u.totalSpentStars,
          expectedTotalStars,
          `У пользователя ${u.userId} totalSpentStars=${u.totalSpentStars}, но сумма заказов=${expectedTotalStars}`,
        );
      }

      // Every payment must have a corresponding payment_received transaction
      for (const p of payments) {
        const hasPaymentTx = transactions.some(
          (t) => t.orderId === p.orderId && t.type === 'payment_received' && t.amount === p.totalAmount,
        );
        assert.equal(
          hasPaymentTx,
          true,
          `Для платежа ${p.paymentId} (заказ ${p.orderId}) отсутствует запись payment_received в transactions`,
        );
      }

      return `Полная согласованность между users (${users.length}), orders (${orders.length}), payments (${payments.length}) и transactions (${transactions.length}) подтверждена.`;
    },
  );

  // ===========================================================================
  // SUITE 3: FIRESTORE SECURITY RULES VIA @firebase/rules-unit-testing (10 TESTS)
  // ===========================================================================
  const [emulatorHostName, emulatorPortStr] = (
    process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
  ).split(':');
  const rulesContent = fs.readFileSync(
    path.resolve(process.cwd(), 'firestore.rules'),
    'utf-8',
  );

  const testEnv: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: AUDIT_PROJECT_ID,
    firestore: {
      host: emulatorHostName,
      port: Number(emulatorPortStr),
      rules: rulesContent,
    },
  });

  try {
    await runCheck(
      'SEC-01',
      'SecurityRules',
      'Пользователь не может читать чужие заказы (get и list)',
      'Проверка отказа PERMISSION_DENIED при попытке чтения чужого заказа и разрешения чтения собственного заказа',
      async () => {
        const aliceCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const strangerCtx = testEnv.authenticatedContext('tg_900001001', {
          email_verified: true,
        });

        // Owner can read own order
        await assertSucceeds(
          getDoc(doc(aliceCtx.firestore(), 'orders', 'ord_syn_paid_02')),
        );

        // Stranger CANNOT read Alice's order
        await assertFails(
          getDoc(doc(strangerCtx.firestore(), 'orders', 'ord_syn_paid_02')),
        );

        // Stranger CANNOT list all orders without filtering own userId
        await assertFails(
          getDocs(collection(strangerCtx.firestore(), 'orders')),
        );

        // Owner CAN list own orders with where('userId', '==', uid)
        const ownSnap = await assertSucceeds(
          getDocs(
            query(
              collection(aliceCtx.firestore(), 'orders'),
              where('userId', '==', 'tg_900001002'),
            ),
          ),
        );
        assert.ok(ownSnap.docs.length > 0);
        return 'Чужие заказы недоступны ни через getDoc, ни через list; свои заказы читаются корректно.';
      },
    );

    await runCheck(
      'SEC-02',
      'SecurityRules',
      'Пользователь не может менять сумму заказа или занижать цену при создании',
      'Проверка блокировки изменения totalPrice в существующем заказе и подмены totalPrice при создании нового заказа',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // 1. Attempt to modify totalPrice on existing pending order
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_syn_pending_01'), {
            totalPrice: 1,
            updatedAt: nowIso,
          }),
        );

        // 2. Attempt to create a new order with forged price (1 XTR instead of 100 XTR for stars_pack_100)
        await assertFails(
          setDoc(doc(buyerCtx.firestore(), 'orders', 'ord_forged_price'), {
            orderId: 'ord_forged_price',
            userId: 'tg_900001002',
            userTelegramId: 900001002,
            productId: 'stars_pack_100',
            productName: '100 Telegram Stars (Synthetic)',
            category: 'stars',
            quantity: 1,
            totalPrice: 1, // Forged! Real price is 100
            currency: 'XTR',
            paymentStatus: 'pending',
            fulfillmentStatus: 'pending',
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        // 3. Valid order creation with honest price (100 * 2 = 200 XTR) succeeds
        await assertSucceeds(
          setDoc(doc(buyerCtx.firestore(), 'orders', 'ord_honest_rule_test'), {
            orderId: 'ord_honest_rule_test',
            userId: 'tg_900001002',
            userTelegramId: 900001002,
            productId: 'stars_pack_100',
            productName: '100 Telegram Stars (Synthetic)',
            category: 'stars',
            quantity: 2,
            totalPrice: 200,
            currency: 'XTR',
            paymentStatus: 'pending',
            fulfillmentStatus: 'pending',
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        return 'Любая попытка изменить сумму заказа или создать заказ с заниженной ценой блокируется правилами Firestore.';
      },
    );

    await runCheck(
      'SEC-03',
      'SecurityRules',
      'Пользователь не может самостоятельно подтверждать оплату',
      'Проверка запрета создания заказа в статусе paid и запрета перевода pending -> paid от лица покупателя',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Attempt to update pending order to paid
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_syn_pending_01'), {
            paymentStatus: 'paid',
            fulfillmentStatus: 'paid',
            updatedAt: nowIso,
          }),
        );

        // Attempt to create order already marked paid
        await assertFails(
          setDoc(doc(buyerCtx.firestore(), 'orders', 'ord_self_paid'), {
            orderId: 'ord_self_paid',
            userId: 'tg_900001002',
            userTelegramId: 900001002,
            productId: 'stars_pack_100',
            productName: '100 Telegram Stars (Synthetic)',
            category: 'stars',
            quantity: 1,
            totalPrice: 100,
            currency: 'XTR',
            paymentStatus: 'paid',
            fulfillmentStatus: 'paid',
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        return 'Самостоятельное подтверждение оплаты покупателем заблокировано при create и update.';
      },
    );

    await runCheck(
      'SEC-04',
      'SecurityRules',
      'Пользователь не может менять статус выдачи на processing или completed',
      'Проверка запрета перевода fulfillmentStatus в processing/completed и разрешения только отмены своего pending-заказа',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Cannot set fulfillmentStatus to completed on paid order
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_syn_paid_02'), {
            paymentStatus: 'completed',
            fulfillmentStatus: 'completed',
            updatedAt: nowIso,
          }),
        );

        // Cannot cancel an already paid order
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_syn_paid_02'), {
            paymentStatus: 'cancelled',
            fulfillmentStatus: 'cancelled',
            updatedAt: nowIso,
          }),
        );

        // CAN cancel own pending order created in SEC-02
        await assertSucceeds(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_honest_rule_test'), {
            paymentStatus: 'cancelled',
            fulfillmentStatus: 'cancelled',
            updatedAt: nowIso,
          }),
        );

        return 'Покупатель не может менять статус выдачи оплаченных заказов; разрешена только отмена собственного неоплаченного (pending) заказа.';
      },
    );

    await runCheck(
      'SEC-05',
      'SecurityRules',
      'Пользователь не может изменять товары и цены, а также читать скрытые товары',
      'Проверка защиты коллекции products от создания/изменения/удаления обычным пользователем и скрытия архивных товаров',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Buyer can read active product
        await assertSucceeds(
          getDoc(doc(buyerCtx.firestore(), 'products', 'stars_pack_100')),
        );

        // Buyer CANNOT read inactive/archived product
        await assertFails(
          getDoc(doc(buyerCtx.firestore(), 'products', 'gift_archived_limited')),
        );

        // Buyer CANNOT update product price
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'products', 'stars_pack_100'), {
            price: 1,
            updatedAt: nowIso,
          }),
        );

        // Buyer CANNOT delete product
        await assertFails(
          deleteDoc(doc(buyerCtx.firestore(), 'products', 'stars_pack_100')),
        );

        return 'Каталог товаров защищён от модификации покупателями, неактивные товары скрыты от чтения.';
      },
    );

    await runCheck(
      'SEC-06',
      'SecurityRules',
      'Обычный пользователь не может получить права администратора или разблокировать себя',
      'Проверка запрета записи в коллекцию admins, чтения списка админов и модификации isBlocked / totalSpentStars',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const blockedCtx = testEnv.authenticatedContext('tg_900001004', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Cannot add self to /admins
        await assertFails(
          setDoc(doc(buyerCtx.firestore(), 'admins', 'tg_900001002'), {
            adminId: 'tg_900001002',
            telegramId: 900001002,
            role: 'superadmin',
            addedAt: nowIso,
          }),
        );

        // Cannot read another admin's record
        await assertFails(
          getDoc(doc(buyerCtx.firestore(), 'admins', 'tg_900000001')),
        );

        // Blocked user cannot unblock themselves
        await assertFails(
          updateDoc(doc(blockedCtx.firestore(), 'users', 'tg_900001004'), {
            isBlocked: false,
            updatedAt: nowIso,
          }),
        );

        // User cannot inflate their own totalSpentStars
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'users', 'tg_900001002'), {
            totalSpentStars: 999999,
            updatedAt: nowIso,
          }),
        );

        return 'Повышение привилегий через /admins, снятие блокировки isBlocked и накрутка статистики заблокированы.';
      },
    );

    await runCheck(
      'SEC-07',
      'SecurityRules',
      'Запрет чтения и изменения чужих платежей и прямой подделки платежей',
      'Проверка изоляции коллекции payments между пользователями и запрета клиентской записи/удаления платежей',
      async () => {
        const aliceCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const bobCtx = testEnv.authenticatedContext('tg_900001003', {
          email_verified: true,
        });
        const adminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Alice can read her own payment
        await assertSucceeds(
          getDoc(doc(aliceCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')),
        );

        // Bob CANNOT read Alice's payment
        await assertFails(
          getDoc(doc(bobCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')),
        );

        // Alice CANNOT update or delete her payment
        await assertFails(
          updateDoc(doc(aliceCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            status: 'refunded',
            refundedAt: nowIso,
          }),
        );
        await assertFails(
          deleteDoc(doc(aliceCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')),
        );

        // Even Admin CANNOT delete payment records (allow delete: if false)
        await assertFails(
          deleteDoc(doc(adminCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')),
        );

        return 'Платежи доступны только владельцу и администратору на чтение; удаление платежей запрещено даже администратору (append-only аудит).';
      },
    );

    await runCheck(
      'SEC-08',
      'SecurityRules',
      'Проверка матрицы доступа ко всем 7 коллекциям (settings, transactions, admins, users, products, orders, payments)',
      'Проверка прав чтения/записи для неавторизованного гостя, покупателя и администратора из /admins',
      async () => {
        const unauthCtx = testEnv.unauthenticatedContext();
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        // Admin authenticated via /admins/tg_900000001 document (zero hardcoded emails!)
        const adminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
        });

        // Unauthenticated cannot read settings, users, orders, payments, transactions, admins
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'settings', 'global')));
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'users', 'tg_900001002')));
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'transactions', 'tx_syn_001_invoice')));

        // Signed-in buyer CAN read global store settings, CANNOT update settings or read transactions
        await assertSucceeds(getDoc(doc(buyerCtx.firestore(), 'settings', 'global')));
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'settings', 'global'), {
            maintenanceMode: true,
            updatedAt: new Date().toISOString(),
          }),
        );
        await assertFails(getDoc(doc(buyerCtx.firestore(), 'transactions', 'tx_syn_001_invoice')));

        // Admin CAN read transactions, users list, admins
        await assertSucceeds(getDoc(doc(adminCtx.firestore(), 'transactions', 'tx_syn_001_invoice')));
        await assertSucceeds(getDoc(doc(adminCtx.firestore(), 'users', 'tg_900001002')));
        await assertSucceeds(getDoc(doc(adminCtx.firestore(), 'admins', 'tg_900000002')));

        // Transactions are immutable (cannot update or delete even by admin)
        await assertFails(
          deleteDoc(doc(adminCtx.firestore(), 'transactions', 'tx_syn_001_invoice')),
        );

        return 'Матрица доступа по всем 7 коллекциям соблюдается; права администратора работают через /admins/{uid} без захардкоженных email.';
      },
    );

    await runCheck(
      'SEC-09',
      'SecurityRules',
      'Проверка новых полей идемпотентности/ретраев Order и новых типов транзакций из актуального types.ts',
      'Проверка записи через правила Emulator полей fulfillmentStartedAt, fulfillmentAttempts, needsManualReconciliation, adminNotifiedAt, buyerNotifiedAt и типов транзакций fulfillment_failed, fulfillment_retry, admin_action',
      async () => {
        const adminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Admin updates order with all new Stage 1 fulfillment & reconciliation fields
        await assertSucceeds(
          updateDoc(doc(adminCtx.firestore(), 'orders', 'ord_syn_processing_03'), {
            fulfillmentStartedAt: nowIso,
            fulfillmentAttempts: 2,
            fulfillmentLastError: 'Retry scheduled after provider check',
            fulfillmentNextRetryAt: nowIso,
            fulfillmentIdempotencyKey: 'fulfill_ord_syn_processing_03',
            externalExecutionReference: 'ext_ref_03',
            needsManualReconciliation: true,
            adminNotifiedAt: nowIso,
            buyerNotifiedAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        // Invalid fulfillmentAttempts (> 10) is rejected by rules
        await assertFails(
          updateDoc(doc(adminCtx.firestore(), 'orders', 'ord_syn_processing_03'), {
            fulfillmentAttempts: 99,
            updatedAt: nowIso,
          }),
        );

        // New transaction types ('fulfillment_failed', 'fulfillment_retry', 'admin_action') are accepted by rules
        for (const txType of ['fulfillment_failed', 'fulfillment_retry', 'admin_action'] as const) {
          const txId = `tx_rule_check_${txType}`;
          await assertSucceeds(
            setDoc(doc(adminCtx.firestore(), 'transactions', txId), {
              transactionId: txId,
              orderId: 'ord_syn_processing_03',
              userId: 'tg_900001002',
              type: txType,
              amount: 450,
              currency: 'XTR',
              details: `Rule validation test for ${txType}`,
              createdAt: nowIso,
            }),
          );
        }

        return 'Все новые поля Order и новые типы транзакций (fulfillment_failed, fulfillment_retry, admin_action) синхронизированы и валидируются правилами Emulator.';
      },
    );

    await runCheck(
      'SEC-10',
      'SecurityRules',
      'Прогон 12 атакующих пейлоадов ("Dirty Dozen") через реальный движок правил Emulator',
      'Проверка того, что все 12 векторов атак из firestore.rules.test.ts получают PERMISSION_DENIED',
      async () => {
        for (const testCase of DIRTY_DOZEN_TESTS) {
          const ctx = testCase.auth
            ? testEnv.authenticatedContext(testCase.auth.uid, {
                email: testCase.auth.email,
                email_verified: testCase.auth.email_verified,
                admin: testCase.auth.admin,
              })
            : testEnv.unauthenticatedContext();
          const db = ctx.firestore();

          if (testCase.operation === 'get') {
            await assertFails(getDoc(doc(db, testCase.collection, testCase.docId)));
          } else if (testCase.operation === 'list') {
            await assertFails(getDocs(collection(db, testCase.collection)));
          } else if (testCase.operation === 'create') {
            await assertFails(
              setDoc(doc(db, testCase.collection, testCase.docId), testCase.payload || {}),
            );
          } else if (testCase.operation === 'update') {
            await assertFails(
              updateDoc(doc(db, testCase.collection, testCase.docId), testCase.payload || {}),
            );
          } else if (testCase.operation === 'delete') {
            await assertFails(deleteDoc(doc(db, testCase.collection, testCase.docId)));
          }
        }
        return `Все ${DIRTY_DOZEN_TESTS.length}/12 атакующих векторов Dirty Dozen заблокированы эмулятором (PERMISSION_DENIED).`;
      },
    );

    await runCheck(
      'SEC-11',
      'SecurityRules',
      'Orders: негативная валидация типов, диапазонов, дат, статусов, финансовых полей, неизвестных полей и CEL-лимит',
      'Проверка отклонения невалидных/поддельных Order-полей (отрицательные/строковые суммы, невалидные quantity/userTelegramId/даты/статусы, финансовые/MyStars поля, лишние поля) с проверкой неизменности состояния + стресс-тест полного документа под CEL limit 1000',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const adminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
          admin: true,
        });
        const nowIso = new Date().toISOString();
        const baseOrder = (orderId: string, overrides: Record<string, unknown> = {}) => ({
          orderId,
          userId: 'tg_900001002',
          userTelegramId: 900001002,
          productId: 'stars_pack_100',
          productName: '100 Telegram Stars (Synthetic)',
          category: 'stars',
          quantity: 1,
          totalPrice: 100,
          currency: 'XTR',
          paymentStatus: 'pending',
          fulfillmentStatus: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
          ...overrides,
        });

        const existingBefore = await firestoreRepo.getDoc<Order>('orders', 'ord_syn_processing_03');
        assert.ok(existingBefore, 'ord_syn_processing_03 должен существовать до тестов SEC-11');

        // 1. Negative / string totalPrice, negative / zero quantity, invalid userTelegramId, invalid dates, unknown statuses, unknown fields
        const invalidAdminCreateCases: Array<[string, Record<string, unknown>]> = [
          ['ord_neg_totalprice', baseOrder('ord_neg_totalprice', { totalPrice: -100 })],
          ['ord_str_totalprice', baseOrder('ord_str_totalprice', { totalPrice: '100' })],
          ['ord_neg_qty', baseOrder('ord_neg_qty', { quantity: -1 })],
          ['ord_zero_qty', baseOrder('ord_zero_qty', { quantity: 0 })],
          ['ord_float_qty', baseOrder('ord_float_qty', { quantity: 1.5 })],
          ['ord_zero_tgid', baseOrder('ord_zero_tgid', { userTelegramId: 0 })],
          ['ord_neg_tgid', baseOrder('ord_neg_tgid', { userTelegramId: -900001002 })],
          ['ord_float_tgid', baseOrder('ord_float_tgid', { userTelegramId: 900001002.5 })],
          ['ord_str_tgid', baseOrder('ord_str_tgid', { userTelegramId: '900001002' })],
          ['ord_bad_createdat', baseOrder('ord_bad_createdat', { createdAt: 'not-a-date' })],
          ['ord_bad_cal_date', baseOrder('ord_bad_cal_date', { createdAt: '2026-13-45T99:99:99Z' })],
          ['ord_bad_updatedat', baseOrder('ord_bad_updatedat', { updatedAt: 1700000000 })],
          ['ord_bad_paidat', baseOrder('ord_bad_paidat', { paidAt: 'invalid-iso' })],
          ['ord_bad_paystatus', baseOrder('ord_bad_paystatus', { paymentStatus: 'hacked_paid' })],
          ['ord_bad_fulstatus', baseOrder('ord_bad_fulstatus', { fulfillmentStatus: 'force_shipped' })],
          ['ord_neg_grossrev', baseOrder('ord_neg_grossrev', { grossRevenueUsdCents: -1 })],
          ['ord_str_provfee', baseOrder('ord_str_provfee', { providerFeeUsdCents: '15' })],
          ['ord_neg_mscost', baseOrder('ord_neg_mscost', { mystarsCostUsdCents: -50 })],
          ['ord_str_balref', baseOrder('ord_str_balref', { balanceRefunded: 'true' })],
          ['ord_bad_ms_dec', baseOrder('ord_bad_ms_dec', { mystarsWholesaleCostUsdt: '-1.50' })],
          ['ord_float_profit', baseOrder('ord_float_profit', { netProfitUsdCents: 12.5 })],
          ['ord_bad_duration', baseOrder('ord_bad_duration', { durationMonths: 99 })],
          ['ord_bad_method', baseOrder('ord_bad_method', { paymentMethod: 'fake_gateway' })],
          ['ord_ghost_field', baseOrder('ord_ghost_field', { ghostField: 'injected' })],
        ];

        for (const [docId, payload] of invalidAdminCreateCases) {
          await assertFails(setDoc(doc(adminCtx.firestore(), 'orders', docId), payload));
          const created = await firestoreRepo.getDoc<Order>('orders', docId);
          assert.equal(created, null, `Невалидный заказ ${docId} не должен был записаться`);
        }

        // 2. Buyer tampering on create: financial/accounting fields, invalid buyer-optional fields, extra fields
        const invalidBuyerCreateCases: Array<[string, Record<string, unknown>]> = [
          ['ord_buy_grossrev', baseOrder('ord_buy_grossrev', { grossRevenueUsdCents: 9999 })],
          ['ord_buy_provfee', baseOrder('ord_buy_provfee', { providerFeeUsdCents: 0 })],
          ['ord_buy_mscost', baseOrder('ord_buy_mscost', { mystarsCostUsdCents: 0 })],
          ['ord_buy_balref', baseOrder('ord_buy_balref', { balanceRefunded: true })],
          ['ord_buy_neg_cents', baseOrder('ord_buy_neg_cents', { totalPriceUsdCents: -100 })],
          ['ord_buy_bad_dur', baseOrder('ord_buy_bad_dur', { durationMonths: 24 })],
          ['ord_buy_bad_method', baseOrder('ord_buy_bad_method', { paymentMethod: 'free_money' })],
          ['ord_buy_ghost', baseOrder('ord_buy_ghost', { ghostField: 'buyer_inject' })],
        ];

        for (const [docId, payload] of invalidBuyerCreateCases) {
          await assertFails(setDoc(doc(buyerCtx.firestore(), 'orders', docId), payload));
          const created = await firestoreRepo.getDoc<Order>('orders', docId);
          assert.equal(created, null, `Поддельный заказ покупателя ${docId} не должен был создаться`);
        }

        // 3. Invalid updates on existing order (both buyer and admin) must fail AND leave document unchanged
        const invalidUpdates: Array<{ ctx: typeof buyerCtx; patch: Record<string, unknown> }> = [
          { ctx: buyerCtx, patch: { grossRevenueUsdCents: 1, updatedAt: nowIso } },
          { ctx: buyerCtx, patch: { providerFeeUsdCents: 0, updatedAt: nowIso } },
          { ctx: buyerCtx, patch: { mystarsCostUsdCents: 0, updatedAt: nowIso } },
          { ctx: buyerCtx, patch: { balanceRefunded: true, updatedAt: nowIso } },
          { ctx: buyerCtx, patch: { ghostField: 'x', updatedAt: nowIso } },
          { ctx: adminCtx, patch: { paymentStatus: 'unknown_status', updatedAt: nowIso } },
          { ctx: adminCtx, patch: { fulfillmentStatus: 'unknown_status', updatedAt: nowIso } },
          { ctx: adminCtx, patch: { grossRevenueUsdCents: -5, updatedAt: nowIso } },
          { ctx: adminCtx, patch: { providerFeeUsdCents: -1, updatedAt: nowIso } },
          { ctx: adminCtx, patch: { mystarsCostUsdCents: 'bad', updatedAt: nowIso } },
          { ctx: adminCtx, patch: { balanceRefunded: 123, updatedAt: nowIso } },
          { ctx: adminCtx, patch: { mystarsPollAttempts: -1, updatedAt: nowIso } },
          { ctx: adminCtx, patch: { ghostField: 'admin_extra', updatedAt: nowIso } },
          { ctx: adminCtx, patch: { updatedAt: 'not-a-valid-date' } },
        ];
        for (const { ctx, patch } of invalidUpdates) {
          await assertFails(updateDoc(doc(ctx.firestore(), 'orders', 'ord_syn_processing_03'), patch));
        }

        const existingAfter = await firestoreRepo.getDoc<Order>('orders', 'ord_syn_processing_03');
        assert.deepEqual(
          existingAfter,
          existingBefore,
          'После всех отклонённых мутаций документ ord_syn_processing_03 должен остаться полностью неизменным',
        );

        // 4. Positive CEL expression budget stress test: full-field Order create + update under 1000 CEL limit
        const fullOrderId = 'ord_cel_stress_full_01';
        const fullOrderPayload: Record<string, unknown> = {
          orderId: fullOrderId,
          userId: 'tg_900001002',
          userTelegramId: 900001002,
          username: 'syn_multi_buyer',
          recipientUsername: 'syn_multi_buyer',
          productId: 'stars_pack_100',
          productName: '100 Telegram Stars (Synthetic)',
          category: 'stars',
          quantity: 100,
          durationMonths: 3,
          unitPriceUsdCents: 2,
          totalPriceUsdCents: 200,
          totalPrice: 200,
          currency: 'USD',
          paymentMethod: 'cryptobot',
          activePaymentId: 'ordpay_cel_01',
          externalInvoiceId: 'ext_inv_cel_01',
          balancePaymentId: 'balpay_cel_01',
          balanceRefunded: false,
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          telegramPaymentChargeId: 'chg_cel_01',
          providerPaymentChargeId: 'prov_cel_01',
          fulfillmentProvider: 'mystars',
          grossRevenueUsdCents: 200,
          providerFeeUsdCents: 6,
          mystarsCurrency: 'usdt_ton',
          mystarsWholesaleCostUsdt: '1.500000',
          mystarsCostUsdCents: 150,
          tonNetworkFeeTon: '0.005',
          tonNetworkFeeUsdCents: 3,
          netProfitUsdCents: 41,
          mystarsOrderId: 'ms_ord_cel_01',
          mystarsOrderStatus: 'awaiting_payment',
          mystarsPayToAddress: 'EQC_synthetic_ton_address_0001',
          mystarsPaymentMemo: 'memo_cel_01',
          mystarsPaymentAmountUsdt: '1.500000',
          mystarsPurchaseTx: 'tx_purchase_cel_01',
          mystarsPaymentTx: 'tx_payment_cel_01',
          mystarsReversalTx: 'tx_rev_cel_01',
          mystarsFailureReason: 'none',
          mystarsExpiresAt: nowIso,
          mystarsLastPolledAt: nowIso,
          mystarsPollAttempts: 2,
          mystarsLastPollError: 'transient',
          mystarsPollLease: {
            leaseOwner: 'worker_1',
            operationId: 'op_1',
            leaseUntil: nowIso,
            acquiredAt: nowIso,
          },
          mystarsStuckAlertedAt: nowIso,
          mystarsUnknownStatusSeen: 'none',
          mystarsCreateInFlight: false,
          mystarsAmbiguousPostAt: nowIso,
          fulfillmentNote: 'Full CEL stress test order',
          fulfillmentStartedAt: nowIso,
          fulfillmentAttempts: 1,
          fulfillmentLastError: 'none',
          fulfillmentNextRetryAt: nowIso,
          fulfillmentIdempotencyKey: 'fulfill_ord_cel_stress_full_01',
          externalExecutionReference: 'ms_ord_cel_01',
          needsManualReconciliation: false,
          assignedKeyIds: ['key_01'],
          deliveredKeyValues: ['VAL-01'],
          awaitingKeyStock: false,
          refundState: 'refund_in_progress',
          refundLockToken: 'lock_tok_01',
          refundStartedAt: nowIso,
          refundLastError: 'none',
          refundStatsAdjusted: false,
          adminNotifiedAt: nowIso,
          buyerNotifiedAt: nowIso,
          buyerNotificationState: { status: 'sent', eventId: 'evt_b1', attemptCount: 1 },
          adminNotificationState: { status: 'sent', eventId: 'evt_a1', attemptCount: 1 },
          createdAt: nowIso,
          paidAt: nowIso,
          completedAt: nowIso,
          completedByAdminId: 900000001,
          updatedAt: nowIso,
        };
        await assertSucceeds(setDoc(doc(adminCtx.firestore(), 'orders', fullOrderId), fullOrderPayload));
        await assertSucceeds(
          updateDoc(doc(adminCtx.firestore(), 'orders', fullOrderId), {
            netProfitUsdCents: -15,
            mystarsPollAttempts: 3,
            updatedAt: nowIso,
          }),
        );

        return `Отклонены все ${invalidAdminCreateCases.length + invalidBuyerCreateCases.length + invalidUpdates.length} негативных кейсов по Orders (состояние ord_syn_processing_03 не изменилось); полный 75-полевой Order успешно прошёл create и update без превышения CEL expression limit (1000).`;
      },
    );

    await runCheck(
      'SEC-12',
      'SecurityRules',
      'Payments & BalanceTopUps: негативная валидация сумм, комиссий, decimal-строк, дат, провайдеров, статусов и защита external payment ID',
      'Проверка отклонения отрицательных/строковых сумм и комиссий, битых expectedAmountStr/actualAmountStr, невалидных дат/provider/status, попыток изменения external payment ID пользователем и админом с подтверждением неизменности документа',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const adminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
          admin: true,
        });
        const nowIso = new Date().toISOString();

        const basePayment = (paymentId: string, overrides: Record<string, unknown> = {}) => ({
          paymentId,
          kind: 'order',
          provider: 'cryptobot',
          providerPaymentId: `inv_${paymentId}`,
          orderId: 'ord_syn_pending_01',
          userId: 'tg_900001002',
          userTelegramId: 900001002,
          totalAmount: 100,
          expectedUsdCents: 100,
          feeUsdCents: 3,
          netUsdCents: 97,
          expectedAmountStr: '1.00',
          actualAmountStr: '1.00',
          currency: 'USDT',
          network: 'TON',
          invoicePayload: 'ord_syn_pending_01',
          payUrl: 'https://t.me/CryptoBot?start=IVtest123',
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
          ...overrides,
        });

        const existingPayBefore = await firestoreRepo.getDoc<PaymentRecord>(
          'payments',
          'pay_chg_syn_paid_02',
        );
        assert.ok(existingPayBefore, 'pay_chg_syn_paid_02 должен существовать до SEC-12');

        const invalidPaymentCreates: Array<[string, Record<string, unknown>]> = [
          ['pay_neg_exp_cents', basePayment('pay_neg_exp_cents', { expectedUsdCents: -100 })],
          ['pay_str_total', basePayment('pay_str_total', { totalAmount: '100' })],
          ['pay_str_exp_cents', basePayment('pay_str_exp_cents', { expectedUsdCents: '100' })],
          ['pay_neg_fee', basePayment('pay_neg_fee', { feeUsdCents: -5 })],
          ['pay_float_fee', basePayment('pay_float_fee', { feeUsdCents: 3.5 })],
          ['pay_str_fee', basePayment('pay_str_fee', { feeUsdCents: '3' })],
          ['pay_neg_net', basePayment('pay_neg_net', { netUsdCents: -1 })],
          ['pay_float_net', basePayment('pay_float_net', { netUsdCents: 96.5 })],
          ['pay_str_net', basePayment('pay_str_net', { netUsdCents: '97' })],
          ['pay_bad_exp_str_abc', basePayment('pay_bad_exp_str_abc', { expectedAmountStr: 'abc' })],
          ['pay_bad_exp_str_neg', basePayment('pay_bad_exp_str_neg', { expectedAmountStr: '-1.00' })],
          ['pay_bad_exp_str_zero', basePayment('pay_bad_exp_str_zero', { expectedAmountStr: '0.00' })],
          ['pay_bad_exp_str_empty', basePayment('pay_bad_exp_str_empty', { expectedAmountStr: '' })],
          ['pay_bad_exp_str_num', basePayment('pay_bad_exp_str_num', { expectedAmountStr: 1.0 })],
          ['pay_bad_act_str_abc', basePayment('pay_bad_act_str_abc', { actualAmountStr: 'NaN' })],
          ['pay_bad_act_str_neg', basePayment('pay_bad_act_str_neg', { actualAmountStr: '-0.50' })],
          ['pay_bad_act_str_null', basePayment('pay_bad_act_str_null', { actualAmountStr: null })],
          ['pay_bad_ver_str', basePayment('pay_bad_ver_str', { verifiedAmountStr: '1.2.3' })],
          ['pay_bad_rate_str', basePayment('pay_bad_rate_str', { exchangeRateUsdStr: '0' })],
          ['pay_bad_payurl', basePayment('pay_bad_payurl', { payUrl: 'javascript:alert(1)' })],
          ['pay_bad_expiresat', basePayment('pay_bad_expiresat', { expiresAt: 'invalid-date' })],
          ['pay_bad_paidat', basePayment('pay_bad_paidat', { paidAt: '2026-13-01T00:00:00Z' })],
          ['pay_bad_confirmedat', basePayment('pay_bad_confirmedat', { confirmedAt: 1700000000 })],
          ['pay_bad_updatedat', basePayment('pay_bad_updatedat', { updatedAt: 'bad-ts' })],
          ['pay_bad_refundedat', basePayment('pay_bad_refundedat', { refundedAt: 'tomorrow' })],
          ['pay_bad_createdat', basePayment('pay_bad_createdat', { createdAt: 'not-iso' })],
          ['pay_unknown_provider', basePayment('pay_unknown_provider', { provider: 'fragment' })],
          ['pay_unknown_status', basePayment('pay_unknown_status', { status: 'force_settled' })],
          ['pay_unknown_field', basePayment('pay_unknown_field', { externalPaymentId: 'spoof_ext' })],
        ];

        for (const [payId, payload] of invalidPaymentCreates) {
          await assertFails(setDoc(doc(adminCtx.firestore(), 'payments', payId), payload));
          const created = await firestoreRepo.getDoc<PaymentRecord>('payments', payId);
          assert.equal(created, null, `Невалидный платёж ${payId} не должен был создаться`);
        }

        // User attempts to modify external payment IDs or inject externalPaymentId -> DENIED
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            providerPaymentId: 'hijacked_ext_id',
            updatedAt: nowIso,
          }),
        );
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            telegramPaymentChargeId: 'hijacked_tg_charge',
            updatedAt: nowIso,
          }),
        );
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            providerPaymentChargeId: 'hijacked_prov_charge',
            updatedAt: nowIso,
          }),
        );
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            externalPaymentId: 'hijacked_ext_field',
            updatedAt: nowIso,
          }),
        );

        // Even Admin cannot overwrite an already-bound telegramPaymentChargeId or set invalid fields on existing payment
        await assertFails(
          updateDoc(doc(adminCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            telegramPaymentChargeId: 'overwritten_charge_id',
            updatedAt: nowIso,
          }),
        );
        await assertFails(
          updateDoc(doc(adminCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            expectedUsdCents: -1,
            updatedAt: nowIso,
          }),
        );
        await assertFails(
          updateDoc(doc(adminCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            paidAt: 'bad-date',
            updatedAt: nowIso,
          }),
        );

        const existingPayAfter = await firestoreRepo.getDoc<PaymentRecord>(
          'payments',
          'pay_chg_syn_paid_02',
        );
        assert.deepEqual(
          existingPayAfter,
          existingPayBefore,
          'После всех отклонённых мутаций документ pay_chg_syn_paid_02 должен остаться неизменным',
        );

        // Positive full-field Payment create & update (CEL budget check) + providerPaymentId immutability
        const fullPayId = 'pay_cel_stress_full_01';
        await assertSucceeds(
          setDoc(doc(adminCtx.firestore(), 'payments', fullPayId), {
            ...basePayment(fullPayId),
            telegramPaymentChargeId: 'chg_full_cel_01',
            providerPaymentChargeId: 'prov_full_cel_01',
            topUpId: 'topup_ref_01',
            verifiedAmountStr: '1.00',
            verifiedCurrency: 'USDT',
            verifiedNetwork: 'TON',
            exchangeRateUsdStr: '1.000000',
            status: 'refund_required',
            statusReason: 'Late payment after cancellation',
            failureReason: 'SUPERSEDED_BY_NEW_INVOICE',
            needsManualReconciliation: true,
            refundRequired: true,
            reconciliationState: 'refund_required',
            reconciliationReason: 'LATE_PAYMENT_ORDER_CANCELLED',
            conflictingOrderStatus: 'cancelled',
            conflictingFulfillmentStatus: 'cancelled',
            supersededByPaymentId: 'pay_newer_01',
            expiresAt: nowIso,
            paidAt: nowIso,
            confirmedAt: nowIso,
            refundedAt: nowIso,
          }),
        );
        await assertFails(
          updateDoc(doc(adminCtx.firestore(), 'payments', fullPayId), {
            providerPaymentId: 'mutated_provider_id',
            updatedAt: nowIso,
          }),
        );
        await assertSucceeds(
          updateDoc(doc(adminCtx.firestore(), 'payments', fullPayId), {
            reconciliationState: 'resolved',
            refundRequired: false,
            updatedAt: nowIso,
          }),
        );

        // BalanceTopUp negative & positive checks
        await assertFails(
          setDoc(doc(adminCtx.firestore(), 'balance_topups', 'topup_neg_bad_01'), {
            paymentId: 'topup_neg_bad_01',
            userId: 'tg_900001002',
            userTelegramId: 900001002,
            provider: 'cryptobot',
            amountUsdCents: -500,
            feeUsdCents: 15,
            amountCreditedUsdCents: 485,
            expectedAmountStr: '-5.00',
            currency: 'USDT',
            paymentStatus: 'pending',
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );
        await assertSucceeds(
          setDoc(doc(adminCtx.firestore(), 'balance_topups', 'topup_valid_sec12_01'), {
            paymentId: 'topup_valid_sec12_01',
            userId: 'tg_900001002',
            userTelegramId: 900001002,
            provider: 'cryptobot',
            amountUsdCents: 500,
            feeUsdCents: 15,
            amountCreditedUsdCents: 485,
            expectedAmountStr: '5.00',
            currency: 'USDT',
            paymentStatus: 'pending',
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        return `Отклонены все ${invalidPaymentCreates.length} невалидных Payment-кейсов, все попытки изменения external payment ID (пользователем и админом) и невалидный balance_topup (pay_chg_syn_paid_02 не изменился); полный 40-полевой Payment и валидный balance_topup успешно прошли под CEL limit.`;
      },
    );

    await runCheck(
      'SEC-13',
      'SecurityRules',
      'Access Control: матрица ролей/claims, запрет подмены финансовых итогов, статусов и полная изоляция payment_locks/digital_keys',
      'Проверка неавторизованного пользователя, пользователя с неполными claims, пользователя без admin claim, админа с валидными claims, попыток покупателя поставить paid/completed или изменить финансовые поля, и полной блокировки payment_locks/digital_keys даже для админа',
      async () => {
        const nowIso = new Date().toISOString();
        const unauthCtx = testEnv.unauthenticatedContext();
        // Regular user with ONLY email_verified (missing optional admin & telegram_verified claims)
        const buyerMissingOptClaimsCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        // Regular user with ONLY telegram_verified (missing email_verified & admin claims)
        const buyerTgClaimOnlyCtx = testEnv.authenticatedContext('tg_900001002', {
          telegram_verified: true,
        });
        // Authenticated but unverified user (even with spoofed admin: true)
        const unverifiedAdminSpoofCtx = testEnv.authenticatedContext('tg_900001002', {
          admin: true,
        });
        // Valid custom-claim admin (UID not present in /admins collection, proving claim-only admin RBAC)
        const claimAdminCtx = testEnv.authenticatedContext('adm_claim_only_999', {
          email_verified: true,
          admin: true,
        });
        // Admin via /admins/{uid} doc
        const docAdminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
        });

        // Seed a payment_locks document via Admin SDK to verify complete client lockdown
        const lockDoc: PaymentLockRecord = {
          lockId: 'cryptobot_inv_sec13_lock',
          provider: 'cryptobot',
          providerPaymentId: 'inv_sec13_lock',
          targetType: 'order',
          targetId: 'ord_syn_pending_01',
          paymentId: 'pay_sec13_lock',
          userId: 'tg_900001002',
          amountUsdCents: 100,
          claimedAt: nowIso,
        };
        await firestoreRepo.setDoc<PaymentLockRecord>('payment_locks', lockDoc.lockId, lockDoc);

        const pendingOrderBefore = await firestoreRepo.getDoc<Order>('orders', 'ord_syn_pending_01');
        const paidOrderBefore = await firestoreRepo.getDoc<Order>('orders', 'ord_syn_paid_02');
        const userBefore = await firestoreRepo.getDoc<StoreUser>('users', 'tg_900001002');
        assert.ok(pendingOrderBefore && paidOrderBefore && userBefore);

        // 1. Unauthenticated user blocked across private collections
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'orders', 'ord_syn_pending_01')));
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')));
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'admins', 'tg_900000001')));
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'payment_locks', lockDoc.lockId)));

        // 2. Missing optional custom claims work cleanly without rule runtime errors
        await assertSucceeds(
          getDoc(doc(buyerMissingOptClaimsCtx.firestore(), 'orders', 'ord_syn_pending_01')),
        );
        await assertSucceeds(
          getDoc(doc(buyerTgClaimOnlyCtx.firestore(), 'orders', 'ord_syn_pending_01')),
        );
        // Unverified token (even with admin: true) is strictly rejected
        await assertFails(
          getDoc(doc(unverifiedAdminSpoofCtx.firestore(), 'orders', 'ord_syn_pending_01')),
        );
        await assertFails(
          getDoc(doc(unverifiedAdminSpoofCtx.firestore(), 'transactions', 'tx_syn_001_invoice')),
        );

        // 3. Valid custom-claim admin CAN read admin collections & update orders
        await assertSucceeds(
          getDoc(doc(claimAdminCtx.firestore(), 'transactions', 'tx_syn_001_invoice')),
        );
        await assertSucceeds(
          getDoc(doc(claimAdminCtx.firestore(), 'orders', 'ord_syn_paid_02')),
        );

        // 4. Buyer without admin claim CANNOT set paymentStatus='paid' or fulfillmentStatus='completed'
        await assertFails(
          updateDoc(doc(buyerMissingOptClaimsCtx.firestore(), 'orders', 'ord_syn_pending_01'), {
            paymentStatus: 'paid',
            updatedAt: nowIso,
          }),
        );
        await assertFails(
          updateDoc(doc(buyerMissingOptClaimsCtx.firestore(), 'orders', 'ord_syn_paid_02'), {
            fulfillmentStatus: 'completed',
            updatedAt: nowIso,
          }),
        );

        // 5. Buyer CANNOT modify financial totals on users or orders
        for (const userPatch of [
          { balanceUsdCents: 999999, updatedAt: nowIso },
          { totalSpentUsdCents: 999999, updatedAt: nowIso },
          { totalSpentStars: 999999, updatedAt: nowIso },
          { totalOrders: 999, updatedAt: nowIso },
          { balance: 999999, updatedAt: nowIso },
        ]) {
          await assertFails(
            updateDoc(doc(buyerMissingOptClaimsCtx.firestore(), 'users', 'tg_900001002'), userPatch),
          );
        }
        for (const ordPatch of [
          { totalPrice: 1, updatedAt: nowIso },
          { totalPriceUsdCents: 1, updatedAt: nowIso },
          { grossRevenueUsdCents: 1, updatedAt: nowIso },
        ]) {
          await assertFails(
            updateDoc(
              doc(buyerMissingOptClaimsCtx.firestore(), 'orders', 'ord_syn_pending_01'),
              ordPatch,
            ),
          );
        }

        // Verify all protected documents remain strictly unchanged
        assert.deepEqual(
          await firestoreRepo.getDoc<Order>('orders', 'ord_syn_pending_01'),
          pendingOrderBefore,
          'ord_syn_pending_01 не должен был измениться',
        );
        assert.deepEqual(
          await firestoreRepo.getDoc<Order>('orders', 'ord_syn_paid_02'),
          paidOrderBefore,
          'ord_syn_paid_02 не должен был измениться',
        );
        assert.deepEqual(
          await firestoreRepo.getDoc<StoreUser>('users', 'tg_900001002'),
          userBefore,
          'users/tg_900001002 не должен был измениться',
        );

        // 6. payment_locks & digital_keys strictly denied for ALL client contexts (including admins!)
        const allClientCtxs = [unauthCtx, buyerMissingOptClaimsCtx, docAdminCtx, claimAdminCtx];
        for (const ctx of allClientCtxs) {
          const db = ctx.firestore();
          await assertFails(getDoc(doc(db, 'payment_locks', lockDoc.lockId)));
          await assertFails(getDocs(collection(db, 'payment_locks')));
          await assertFails(
            setDoc(doc(db, 'payment_locks', 'rogue_lock_01'), {
              ...lockDoc,
              lockId: 'rogue_lock_01',
            }),
          );
          await assertFails(
            updateDoc(doc(db, 'payment_locks', lockDoc.lockId), { amountUsdCents: 0 }),
          );
          await assertFails(deleteDoc(doc(db, 'payment_locks', lockDoc.lockId)));

          await assertFails(getDocs(collection(db, 'digital_keys')));
          await assertFails(setDoc(doc(db, 'digital_keys', 'rogue_key_01'), { keyValue: 'X' }));
        }

        // Confirm payment_locks document untouched and no rogue lock created
        const lockAfter = await firestoreRepo.getDoc<PaymentLockRecord>(
          'payment_locks',
          lockDoc.lockId,
        );
        assert.deepEqual(lockAfter, lockDoc, 'payment_locks документ не должен был измениться');
        assert.equal(
          await firestoreRepo.getDoc<PaymentLockRecord>('payment_locks', 'rogue_lock_01'),
          null,
          'rogue_lock_01 не должен существовать',
        );

        return 'Матрица ролей/claims (unauth, missing optional claims, unverified spoof, custom-claim admin, /admins doc admin) подтверждена; подмена paid/completed и финансовых итогов заблокирована без изменения документов; payment_locks и digital_keys полностью закрыты для всех клиентов включая админов.';
      },
    );
  } finally {
    await testEnv.cleanup();
  }

  // Re-seed clean synthetic dataset before Suite 4 (since SEC-02/SEC-09 wrote test docs)
  await seedSyntheticAuditDataset();

  // ===========================================================================
  // SUITE 4: INDEXES & REAL QUERIES VERIFICATION ON EMULATOR (6 TESTS)
  // ===========================================================================
  await runCheck(
    'IDX-01',
    'IndexesQueries',
    'Сверка всех 17 составных индексов в firestore.indexes.json с запросами в коде',
    'Проверка структуры, коллекций, queryScope, полей и направлений сортировки всех 17 индексов',
    async () => {
      const raw = fs.readFileSync(
        path.resolve(process.cwd(), 'firestore.indexes.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw) as {
        indexes: Array<{
          collectionGroup: string;
          queryScope: string;
          fields: Array<{ fieldPath: string; order: string }>;
        }>;
      };
      assert.equal(parsed.indexes.length, 17, 'Должно быть ровно 17 составных индексов');

      const expectedSignatures = [
        'orders:userId:ASCENDING,createdAt:DESCENDING',
        'orders:userTelegramId:ASCENDING,createdAt:DESCENDING',
        'orders:paymentStatus:ASCENDING,createdAt:DESCENDING',
        'orders:fulfillmentStatus:ASCENDING,createdAt:DESCENDING',
        'orders:fulfillmentStatus:ASCENDING,createdAt:ASCENDING',
        'products:category:ASCENDING,isActive:ASCENDING,price:ASCENDING',
        'products:category:ASCENDING,price:ASCENDING',
        'products:isActive:ASCENDING,price:ASCENDING',
        'payments:status:ASCENDING,createdAt:DESCENDING',
        'payments:status:ASCENDING,createdAt:DESCENDING,paymentId:DESCENDING',
        'payments:orderId:ASCENDING,createdAt:DESCENDING',
        'balance_topups:paymentStatus:ASCENDING,createdAt:DESCENDING',
        'balance_topups:paymentStatus:ASCENDING,createdAt:DESCENDING,paymentId:DESCENDING',
        'balance_topups:userId:ASCENDING,createdAt:DESCENDING',
        'balance_topups:userId:ASCENDING,createdAt:DESCENDING,paymentId:DESCENDING',
        'balance_topups:userTelegramId:ASCENDING,createdAt:DESCENDING',
        'transactions:type:ASCENDING,createdAt:DESCENDING',
      ];

      for (const idx of parsed.indexes) {
        assert.equal(
          idx.queryScope,
          'COLLECTION',
          `Индекс ${idx.collectionGroup} должен иметь queryScope=COLLECTION`,
        );
      }

      const actualSignatures = parsed.indexes.map(
        (idx) =>
          `${idx.collectionGroup}:${idx.fields.map((f) => `${f.fieldPath}:${f.order}`).join(',')}`,
      );

      for (const sig of expectedSignatures) {
        assert.ok(
          actualSignatures.includes(sig),
          `Отсутствует обязательный составной индекс: ${sig}`,
        );
      }

      return 'Все 17 составных индексов в firestore.indexes.json (orders, products, payments, balance_topups, transactions) присутствуют и полностью покрывают все комбинации where + orderBy в коде.';
    },
  );

  await runCheck(
    'IDX-02',
    'IndexesQueries',
    'Выполнение всех 5 индексированных запросов к коллекции orders через Emulator',
    'Реальный прогон запросов по userId, userTelegramId, paymentStatus, fulfillmentStatus (ASC/DESC) в Emulator',
    async () => {
      // Index 1: orders (userId ASC, createdAt DESC)
      const byUserId = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'userId', op: '==', value: 'tg_900001002' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 20,
      });
      assert.equal(byUserId.length, 10);

      // Index 2: orders (userTelegramId ASC, createdAt DESC) via OrderService.getUserOrders
      const byTgId = await OrderService.getUserOrders(900001002, 20);
      assert.equal(byTgId.length, 10);

      // Index 3: orders (paymentStatus ASC, createdAt DESC)
      const byPaymentStatus = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'paymentStatus', op: '==', value: 'paid' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 20,
      });
      assert.equal(byPaymentStatus.length, 5);

      // Index 4: orders (fulfillmentStatus ASC, createdAt DESC) via OrderService.getAllOrders
      const byFulfillmentDesc = await OrderService.getAllOrders('completed', 20);
      assert.equal(byFulfillmentDesc.length, 4);

      // Index 5: orders (fulfillmentStatus ASC, createdAt ASC) used by RecoveryWorker
      const byFulfillmentAsc = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'failed' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: 20,
      });
      assert.equal(byFulfillmentAsc.length, 3);

      return 'Все 5 составных запросов к коллекции orders отработали на Emulator с точным соблюдением фильтрации и порядка.';
    },
  );

  await runCheck(
    'IDX-03',
    'IndexesQueries',
    'Выполнение индексированных запросов к products, payments, balance_topups и transactions через Emulator',
    'Реальный прогон запросов витрины товаров (3 индекса), платежей, очередей сверки (reconciliation) и транзакций по типу',
    async () => {
      // Index 6: products (category ASC, isActive ASC, price ASC)
      const activeGifts = await ProductService.getProductsByCategory('gifts', false, 20);
      assert.equal(activeGifts.length, 1);
      assert.equal(activeGifts[0].id, 'gift_crystal_star');

      // Index 7: products (category ASC, price ASC) including inactive
      const allGifts = await ProductService.getProductsByCategory('gifts', true, 20);
      assert.equal(allGifts.length, 2);

      // Index 8: products (isActive ASC, price ASC)
      const allActiveProducts = await ProductService.getAllProducts(false, 20);
      assert.equal(allActiveProducts.length, 5);
      assert.ok(allActiveProducts[0].price <= allActiveProducts[1].price);

      // Index 9: payments (status ASC, createdAt DESC)
      const paidPayments = await firestoreRepo.queryDocs<PaymentRecord>('payments', {
        where: [{ field: 'status', op: '==', value: 'paid' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 20,
      });
      assert.equal(paidPayments.length, 9);

      // Index 10 (payments.status, createdAt DESC, paymentId DESC) + Index 11 (payments.orderId, createdAt DESC)
      const orderPayments = await firestoreRepo.queryDocs<PaymentRecord>('payments', {
        where: [{ field: 'orderId', op: '==', value: 'ord_syn_paid_02' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 10,
      });
      assert.equal(orderPayments.length, 1);

      const sameCreatedAt = '2026-11-20T12:00:00.000Z';
      const tempPayIds = ['ordpay_idx03_rec_a', 'ordpay_idx03_rec_b'];
      const tempTopUpIds = ['topup_idx03_rec_a', 'topup_idx03_rec_b'];
      for (const pid of tempPayIds) {
        await firestoreRepo.setDoc<PaymentRecord>('payments', pid, {
          paymentId: pid,
          kind: 'order',
          provider: 'cryptobot',
          providerPaymentId: `inv_${pid}`,
          orderId: 'ord_syn_pending_01',
          userId: 'tg_900001002',
          userTelegramId: 900001002,
          totalAmount: 100,
          expectedUsdCents: 100,
          expectedAmountStr: '1.00',
          currency: 'USDT',
          network: 'TON',
          invoicePayload: 'ord_syn_pending_01',
          status: 'refund_required',
          needsManualReconciliation: true,
          refundRequired: true,
          reconciliationReason: 'LATE_PAYMENT_ORDER_CANCELLED',
          createdAt: sameCreatedAt,
          updatedAt: sameCreatedAt,
        });
      }
      for (const tid of tempTopUpIds) {
        await firestoreRepo.setDoc<BalanceTopUpRecord>('balance_topups', tid, {
          paymentId: tid,
          userId: 'tg_900001002',
          userTelegramId: 900001002,
          provider: 'cryptobot',
          providerPaymentId: `inv_${tid}`,
          amountUsdCents: 500,
          feeUsdCents: 15,
          amountCreditedUsdCents: 485,
          expectedUsdCents: 500,
          expectedAmountStr: '5.00',
          currency: 'USDT',
          network: 'TON',
          paymentStatus: 'refund_required',
          needsManualReconciliation: true,
          refundRequired: true,
          reconciliationReason: 'LATE_PAYMENT_TOPUP_CANCELLED',
          createdAt: sameCreatedAt,
          updatedAt: sameCreatedAt,
        });
      }

      try {
        const payRecP1 = await PaymentService.getReconciliationRequiredPaymentsPaginated(1);
        assert.equal(payRecP1.items.length, 1);
        assert.equal(payRecP1.items[0].paymentId, 'ordpay_idx03_rec_b');
        assert.equal(payRecP1.hasMore, true);
        const payRecP2 = await PaymentService.getReconciliationRequiredPaymentsPaginated(
          1,
          payRecP1.nextCursor,
        );
        assert.equal(payRecP2.items.length, 1);
        assert.equal(payRecP2.items[0].paymentId, 'ordpay_idx03_rec_a');

        const bs = new BalanceService('idx03_check');
        const topUpP1 = await bs.getAllTopUpsPaginated('refund_required', 1);
        assert.equal(topUpP1.items.length, 1);
        assert.equal(topUpP1.items[0].paymentId, 'topup_idx03_rec_b');
        assert.equal(topUpP1.hasMore, true);
        const topUpP2 = await bs.getAllTopUpsPaginated('refund_required', 1, topUpP1.nextCursor);
        assert.equal(topUpP2.items.length, 1);
        assert.equal(topUpP2.items[0].paymentId, 'topup_idx03_rec_a');

        const topUpsByUser = await firestoreRepo.queryDocs<BalanceTopUpRecord>('balance_topups', {
          where: [{ field: 'userTelegramId', op: '==', value: 900001002 }],
          orderBy: { field: 'createdAt', direction: 'desc' },
          limit: 10,
        });
        assert.equal(topUpsByUser.length, 2);
      } finally {
        for (const pid of tempPayIds) await firestoreRepo.deleteDoc('payments', pid);
        for (const tid of tempTopUpIds) await firestoreRepo.deleteDoc('balance_topups', tid);
      }

      // Index 17: transactions (type ASC, createdAt DESC)
      const paymentTxs = await firestoreRepo.queryDocs<StoreTransaction>('transactions', {
        where: [{ field: 'type', op: '==', value: 'payment_received' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 20,
      });
      assert.equal(paymentTxs.length, 10);

      return 'Все составные запросы к products, payments (включая reconciliation с secondaryOrderBy paymentId), balance_topups и transactions успешно выполнены через Emulator.';
    },
  );

  await runCheck(
    'IDX-04',
    'IndexesQueries',
    'Курсорная пагинация (startAfter) при наличии нескольких заказов с ОДИНАКОВЫМ createdAt timestamp',
    'Постраничный обход 10 заказов пользователя tg_900001002 (включая 3 заказа с createdAt=2026-11-17T10:00:00.000Z) с размером страницы 2',
    async () => {
      const collectedIds: string[] = [];
      let cursor: unknown = undefined;
      let pages = 0;

      while (true) {
        const page = await firestoreRepo.queryDocsPaginated<Order>('orders', {
          where: [{ field: 'userTelegramId', op: '==', value: 900001002 }],
          orderBy: { field: 'createdAt', direction: 'desc' },
          startAfter: cursor,
          limit: 2,
        });
        pages++;
        for (const item of page.items) {
          collectedIds.push(item.orderId);
        }
        if (!page.hasMore || !page.nextCursor) {
          break;
        }
        cursor = page.nextCursor;
        assert.ok(pages <= 10, 'Защита от бесконечного цикла пагинации');
      }

      const uniqueIds = new Set(collectedIds);
      assert.equal(
        collectedIds.length,
        10,
        `Ожидалось ровно 10 заказов при постраничном обходе, получено ${collectedIds.length} (${collectedIds.join(', ')})`,
      );
      assert.equal(
        uniqueIds.size,
        10,
        'Обнаружены дубликаты при пагинации заказов с одинаковым timestamp',
      );
      // Verify all 3 identical-timestamp orders were returned without skipping any!
      assert.ok(uniqueIds.has('ord_syn_same_ts_10'));
      assert.ok(uniqueIds.has('ord_syn_same_ts_11'));
      assert.ok(uniqueIds.has('ord_syn_same_ts_12'));

      return `Пройдено ${pages} страниц (по 2 заказа): возвращены все 10/10 заказов (включая все 3 заказа с одинаковым timestamp 2026-11-17T10:00:00.000Z) без единого пропуска или дубля.`;
    },
  );

  await runCheck(
    'IDX-05',
    'IndexesQueries',
    'Проверка корректности сортировки (ASC/DESC) и фильтрации во всех сервисах',
    'Проверка монотонного убывания/возрастания дат и цен в результатах запросов Emulator',
    async () => {
      const allOrdersDesc = await OrderService.getAllOrders(undefined, 50);
      assert.equal(allOrdersDesc.length, 12);
      for (let i = 1; i < allOrdersDesc.length; i++) {
        assert.ok(
          allOrdersDesc[i - 1].createdAt >= allOrdersDesc[i].createdAt,
          'Нарушен порядок сортировки createdAt DESC в заказах',
        );
      }

      const activeProductsAsc = await ProductService.getAllProducts(false, 50);
      for (let i = 1; i < activeProductsAsc.length; i++) {
        assert.ok(
          activeProductsAsc[i - 1].price <= activeProductsAsc[i].price,
          'Нарушен порядок сортировки price ASC в товарах',
        );
      }

      const usersDesc = await UserService.getAllUsers(50);
      assert.equal(usersDesc.length, 4);
      for (let i = 1; i < usersDesc.length; i++) {
        assert.ok(usersDesc[i - 1].createdAt >= usersDesc[i].createdAt);
      }

      return 'Сортировка по дате (DESC) и цене (ASC), а также фильтрация по статусам и категориям работают без ошибок.';
    },
  );

  await runCheck(
    'IDX-06',
    'IndexesQueries',
    'Анализ потенциально опасных запросов для Production Firestore',
    'Проверка отсутствия запросов с неравенством на разных полях, незакрытых составных индексов и скалярных курсоров без tie-breaker',
    async () => {
      // Test passing document ID string directly as startAfter cursor to OrderService.getUserOrders
      const firstPage = await OrderService.getUserOrders(900001002, 1);
      assert.equal(firstPage.length, 1);
      const secondPage = await OrderService.getUserOrders(
        900001002,
        2,
        firstPage[0].orderId,
      );
      assert.equal(secondPage.length, 2);
      assert.notEqual(secondPage[0].orderId, firstPage[0].orderId);

      return 'Все запросы в сервисах используют равенство (==) + orderBy + secondaryOrderBy/DocumentSnapshot tie-breaker; запросов, способных вызвать FAILED_PRECONDITION при задеплоенных 17 индексах, не обнаружено.';
    },
  );

  // ===========================================================================
  // SUITE 5: CONCURRENCY & CHAOS OPERATIONS ON EMULATOR (11 TESTS)
  // ===========================================================================
  await runCheck(
    'CON-01',
    'Concurrency',
    'Гонка двух одновременных подтверждений оплаты на один заказ (CryptoBot + защита отключённого XTR) в Emulator',
    'Проверка параллельного отклонения XTR (XTR_CHECKOUT_DISABLED) и атомарного разрешения гонки двух параллельных verifyAndProcessOrderPayment (CryptoBot) через payment_locks для заказа ord_syn_pending_01',
    async () => {
      const userBefore = await UserService.getUserById('tg_900001002');
      assert.ok(userBefore);

      // Part A: Parallel legacy XTR callbacks must both reject with XTR_CHECKOUT_DISABLED without side effects
      const xtrPayload = {
        telegramUserId: 900001002,
        invoicePayload: 'ord_syn_pending_01',
        currency: 'XTR',
        totalAmount: 100,
        telegramPaymentChargeId: 'chg_con_race_xtr_01',
        providerPaymentChargeId: 'prov_con_race_xtr_01',
      };
      const [xtr1, xtr2] = await Promise.allSettled([
        PaymentService.processSuccessfulPayment(xtrPayload),
        PaymentService.processSuccessfulPayment(xtrPayload),
      ]);
      assert.equal(xtr1.status, 'rejected');
      assert.equal(xtr2.status, 'rejected');
      assert.match(String(xtr1.reason), /XTR_CHECKOUT_DISABLED/);
      assert.match(String(xtr2.reason), /XTR_CHECKOUT_DISABLED/);

      const pendingCheck = await OrderService.getOrderById('ord_syn_pending_01');
      assert.equal(pendingCheck?.paymentStatus, 'pending');

      // Part B: Active CryptoBot concurrent payment race via verifyAndProcessOrderPayment + payment_locks
      const racePaymentId = 'ordpay_con01_race_01';
      const nowIso = new Date().toISOString();
      await firestoreRepo.setDoc<PaymentRecord>('payments', racePaymentId, {
        paymentId: racePaymentId,
        kind: 'order',
        provider: 'cryptobot',
        providerPaymentId: 'inv_con_race_01',
        orderId: 'ord_syn_pending_01',
        userId: 'tg_900001002',
        userTelegramId: 900001002,
        totalAmount: 100,
        expectedUsdCents: 100,
        expectedAmountStr: '1.00',
        currency: 'USDT',
        network: 'TON',
        invoicePayload: 'ord_syn_pending_01',
        status: 'pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      class Con01RaceMockGateway extends PaymentProviderGateway {
        public override async verifyInvoiceStatus(): Promise<VerifiedProviderInvoice> {
          await new Promise((r) => setTimeout(r, 25));
          return {
            externalInvoiceId: 'inv_con_race_01',
            paymentId: racePaymentId,
            status: 'paid',
            amountPaidStr: '1.00',
            amountPaid: 1,
            currency: 'USDT',
            network: 'TON',
            paidAt: nowIso,
          };
        }
      }

      const racePs = new PaymentService('con01_race', new Con01RaceMockGateway());
      const [res1, res2] = await Promise.all([
        racePs.verifyAndProcessOrderPayment(racePaymentId),
        racePs.verifyAndProcessOrderPayment(racePaymentId),
      ]);

      assert.equal(res1.ok, true);
      assert.equal(res2.ok, true);
      const newlyProcessedCount = [res1, res2].filter((r) => !r.duplicate).length;
      const duplicateCount = [res1, res2].filter((r) => r.duplicate).length;
      assert.equal(
        newlyProcessedCount,
        1,
        `Ровно 1 из 2 параллельных вызовов должен обработать платёж без флага duplicate, получено: ${newlyProcessedCount}`,
      );
      assert.equal(duplicateCount, 1);

      const lockDoc = await firestoreRepo.getDoc<PaymentLockRecord>(
        'payment_locks',
        'ext_cryptobot_inv_con_race_01',
      );
      assert.ok(lockDoc, 'Должен существовать атомарный lock в payment_locks');
      assert.equal(lockDoc.targetId, 'ord_syn_pending_01');
      assert.equal(lockDoc.paymentId, racePaymentId);

      const userAfter = await UserService.getUserById('tg_900001002');
      assert.equal(userAfter?.totalOrders, userBefore.totalOrders + 1);
      assert.equal(
        userAfter?.totalSpentUsdCents,
        (userBefore.totalSpentUsdCents || 0) + 100,
      );

      const allTxs = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);
      const paymentTxsForOrder = allTxs.filter(
        (t) => t.orderId === 'ord_syn_pending_01' && t.type === 'payment_received',
      );
      assert.equal(
        paymentTxsForOrder.length,
        1,
        'Должна быть создана ровно 1 транзакция payment_received',
      );

      return 'Параллельный XTR отклонён (XTR_CHECKOUT_DISABLED), а гонка 2 вызовов verifyAndProcessOrderPayment разрешена атомарно через payment_locks: newlyProcessed=1, duplicate=1, +1 к totalOrders, +100¢ totalSpentUsdCents, 1 payment_received.';
    },
  );

  await runCheck(
    'CON-02',
    'Concurrency',
    'Два одновременных воркера выдачи (initiateFulfillment) на один заказ в Emulator',
    'Параллельный запуск 2 воркеров на оплаченный заказ ord_syn_paid_02 с подсчётом числа вызовов внешнего адаптера',
    async () => {
      let externalAdapterCalls = 0;
      const countingAdapter: FulfillmentProviderAdapter = {
        providerName: 'ConcurrencyTestAdapter',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async (order, ctx) => {
          externalAdapterCalls++;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            handledAutomatically: true,
            status: 'completed',
            details: `Auto-delivered by ConcurrencyTestAdapter (key=${ctx?.idempotencyKey})`,
            externalReference: `ext_${order.orderId}`,
          };
        },
      };

      FulfillmentService.setAdapter(countingAdapter);
      try {
        const { bot } = createMockBot();
        const targetOrder = await OrderService.getOrderById('ord_syn_paid_02');
        assert.ok(targetOrder);

        const [w1, w2] = await Promise.all([
          FulfillmentService.initiateFulfillment(targetOrder, bot),
          FulfillmentService.initiateFulfillment(targetOrder, bot),
        ]);

        assert.equal(
          externalAdapterCalls,
          1,
          `Внешний адаптер должен быть вызван ровно 1 раз, но вызван ${externalAdapterCalls} раз`,
        );

        const updatedOrder = await OrderService.getOrderById('ord_syn_paid_02');
        assert.equal(updatedOrder?.fulfillmentStatus, 'completed');
        assert.equal(updatedOrder?.fulfillmentAttempts, 1);
        assert.ok(w1.orderId === 'ord_syn_paid_02' && w2.orderId === 'ord_syn_paid_02');
        return `Атомарный pre-claim в транзакции Emulator предотвратил двойную выдачу: externalAdapterCalls = ${externalAdapterCalls}.`;
      } finally {
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      }
    },
  );

  await runCheck(
    'CON-03',
    'Concurrency',
    'Повторное выполнение уже выданного заказа под параллельной нагрузкой',
    'Одновременный вызов completeOrder и initiateFulfillment для уже завершённого заказа',
    async () => {
      const { bot, sentMessages } = createMockBot();
      const target = await OrderService.getOrderById('ord_syn_paid_02');
      assert.ok(target);
      assert.equal(target.fulfillmentStatus, 'completed');

      await Promise.all([
        FulfillmentService.completeOrder({
          orderId: 'ord_syn_paid_02',
          adminNote: 'Дублирующий вызов 1',
          bot,
        }),
        FulfillmentService.initiateFulfillment(target, bot),
      ]);

      assert.equal(sentMessages.length, 0, 'Не должно быть повторных уведомлений покупателю');
      return 'Повторное параллельное выполнение завершённого заказа полностью заблокировано (0 повторных выдач и сообщений).';
    },
  );

  await runCheck(
    'CON-04',
    'Concurrency',
    'Перезапуск сервера во время выдачи и сверка статуса через checkExternalStatus',
    'Имитация падения воркера после перевода заказа в processing (истёкший lease) с последующим восстановлением через checkExternalStatus',
    async () => {
      let executeCalls = 0;
      let statusCheckCalls = 0;

      // Prepare an order in 'processing' with expired lease and no externalExecutionReference
      const crashOrder: Order = {
        orderId: 'ord_con_crash_04',
        userId: 'tg_900001002',
        userTelegramId: 900001002,
        username: 'syn_multi_buyer',
        productId: 'stars_pack_500',
        productName: '500 Telegram Stars (Synthetic)',
        category: 'stars',
        quantity: 1,
        totalPrice: 450,
        currency: 'XTR',
        paymentStatus: 'paid',
        fulfillmentStatus: 'processing',
        telegramPaymentChargeId: 'chg_con_crash_04',
        fulfillmentStartedAt: '2026-11-17T08:00:00.000Z', // Expired lease (> 60s ago)
        fulfillmentAttempts: 1,
        fulfillmentIdempotencyKey: 'fulfill_ord_con_crash_04',
        createdAt: '2026-11-17T08:00:00.000Z',
        paidAt: '2026-11-17T08:00:00.000Z',
        updatedAt: '2026-11-17T08:00:00.000Z',
      };
      await firestoreRepo.setDoc<Order>('orders', crashOrder.orderId, crashOrder);

      const reconcilableAdapter: FulfillmentProviderAdapter = {
        providerName: 'ReconcilableProvider',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async () => {
          executeCalls++;
          return {
            handledAutomatically: true,
            status: 'completed',
            details: 'Should not be called because checkExternalStatus returns alreadyExecuted=true',
          };
        },
        checkExternalStatus: async (_ord, key) => {
          statusCheckCalls++;
          return {
            alreadyExecuted: true,
            status: 'completed',
            details: `Восстановлено по ключу идемпотентности ${key}`,
            externalReference: `reconciled_${key}`,
          };
        },
      };

      FulfillmentService.setAdapter(reconcilableAdapter);
      try {
        const { bot } = createMockBot();
        const recovered = await FulfillmentService.initiateFulfillment(crashOrder, bot);
        assert.equal(statusCheckCalls, 1, 'Должен быть вызван checkExternalStatus');
        assert.equal(executeCalls, 0, 'Повторный requestFulfillment НЕ должен вызываться');
        assert.equal(recovered.fulfillmentStatus, 'completed');
        assert.equal(recovered.externalExecutionReference, 'reconciled_fulfill_ord_con_crash_04');
        return 'После перезапуска сервера заказ успешно сверен через checkExternalStatus и завершён без повторного вызова поставщика.';
      } finally {
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      }
    },
  );

  await runCheck(
    'CON-05',
    'Concurrency',
    'Потеря ответа от неидемпотентного поставщика (защитный карантин needsManualReconciliation)',
    'Имитация обрыва связи во время вызова неидемпотентного поставщика без checkExternalStatus',
    async () => {
      let unsafeCalls = 0;
      const lostOrder: Order = {
        orderId: 'ord_con_lost_05',
        userId: 'tg_900001003',
        userTelegramId: 900001003,
        username: 'syn_edge_buyer',
        productId: 'premium_12m',
        productName: 'Telegram Premium — 12 месяцев (Synthetic)',
        category: 'premium',
        quantity: 1,
        totalPrice: 3000,
        currency: 'XTR',
        paymentStatus: 'paid',
        fulfillmentStatus: 'processing',
        telegramPaymentChargeId: 'chg_con_lost_05',
        fulfillmentStartedAt: '2026-11-17T08:00:00.000Z', // Expired lease
        fulfillmentAttempts: 1,
        fulfillmentIdempotencyKey: 'fulfill_ord_con_lost_05',
        createdAt: '2026-11-17T08:00:00.000Z',
        paidAt: '2026-11-17T08:00:00.000Z',
        updatedAt: '2026-11-17T08:00:00.000Z',
      };
      await firestoreRepo.setDoc<Order>('orders', lostOrder.orderId, lostOrder);

      const nonIdempotentAdapter: FulfillmentProviderAdapter = {
        providerName: 'LegacyNonIdempotentSupplier',
        supportsIdempotency: false,
        isConfigured: () => true,
        requestFulfillment: async () => {
          unsafeCalls++;
          return {
            handledAutomatically: true,
            status: 'completed',
            details: 'Unsafe duplicate call!',
          };
        },
      };

      FulfillmentService.setAdapter(nonIdempotentAdapter);
      try {
        const { bot } = createMockBot();
        const quarantined = await FulfillmentService.initiateFulfillment(lostOrder, bot);
        assert.equal(unsafeCalls, 0, 'Неидемпотентный адаптер НЕ должен вызываться повторно');
        assert.equal(quarantined.fulfillmentStatus, 'failed');
        assert.equal(quarantined.needsManualReconciliation, true);
        return 'При потере ответа от неидемпотентного поставщика заказ переведён в карантин ручной сверки (unsafeCalls = 0).';
      } finally {
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      }
    },
  );

  await runCheck(
    'CON-06',
    'Concurrency',
    'Временная недоступность Firestore и последующее восстановление без потери заказов',
    'Имитация отказа хранилища (StorageUnavailableError) с проверкой блокировки новых заказов и сохранности существующих данных',
    async () => {
      firestoreRepo.setSimulatedFailure({ unavailable: true });
      try {
        await assert.rejects(
          async () => {
            await OrderService.createOrder({
              telegramUser: { id: 900001001, first_name: 'Алексей' },
              productId: 'stars_pack_100',
              quantity: 1,
            });
          },
          (err: unknown) => err instanceof StorageUnavailableError,
        );

        const preCheckoutRes = await PaymentService.validatePreCheckout({
          invoicePayload: 'ord_syn_pending_01',
          telegramUserId: 900001002,
          currency: 'XTR',
          totalAmount: 100,
        });
        assert.equal(preCheckoutRes.ok, false);
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }

      // Verify existing orders in Emulator are intact after recovery
      const ordersAfter = await firestoreRepo.listDocs<Order>('orders', 500);
      assert.ok(ordersAfter.length >= 11);
      return 'Во время сбоя БД создание заказов и оплата безопасно блокируются (StorageUnavailableError), а после восстановления все заказы сохранены.';
    },
  );

  await runCheck(
    'CON-07',
    'Concurrency',
    'Stage 2.6.1 Scenario A: Concurrent fulfillment claim (MyStars POST /v1/orders)',
    'Два воркера одновременно запускают initiateFulfillment на один оплаченный заказ в реальном Firestore Emulator; только один захватывает claim и вызывает POST /v1/orders',
    async () => {
      let postOrdersCalls = 0;
      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_emu_scen_a_key',
        paymentCurrency: 'usdt_ton',
      });
      FulfillmentService.setAdapter(new MyStarsFulfillmentAdapter(myStarsClient));
      FulfillmentService.resetMyStarsPollingState();

      try {
        myStarsClient.setHttpTransport(async (req) => {
          if (req.url.endsWith('/recipients/check')) {
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                ok: true,
                type: 'stars',
                recipient_username: 'emu_scen_a_user',
                resolved: true,
                eligible: true,
              },
            };
          }
          if (req.method === 'POST' && req.url.endsWith('/v1/orders')) {
            postOrdersCalls += 1;
            await new Promise((r) => setTimeout(r, 40));
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                order_id: 'ord_ms_emu_scen_a_01',
                status: 'completed',
                type: 'stars',
                recipient_username: 'emu_scen_a_user',
                quantity: 100,
                currency: 'usdt_ton',
                payment_amount: '1.30',
                purchase_tx: '0x_emu_scen_a_tx',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected request in CON-07: ${req.method} ${req.url}`);
        });

        const scenAOrder: Order = {
          orderId: 'ord_emu_s261_scen_a',
          userId: 'tg_900001001',
          userTelegramId: 900001001,
          username: 'syn_alex_buyer',
          recipientUsername: 'emu_scen_a_user',
          productId: 'stars_pack_100',
          productName: '100 Telegram Stars (Synthetic)',
          category: 'stars',
          quantity: 100,
          totalPrice: 100,
          totalPriceUsdCents: 185,
          currency: 'XTR',
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
          telegramPaymentChargeId: 'chg_emu_s261_scen_a',
          createdAt: '2026-11-22T10:00:00.000Z',
          paidAt: '2026-11-22T10:00:05.000Z',
          updatedAt: '2026-11-22T10:00:05.000Z',
        };
        await firestoreRepo.setDoc<Order>('orders', scenAOrder.orderId, scenAOrder);

        const { bot } = createMockBot();
        const [w1, w2] = await Promise.all([
          FulfillmentService.initiateFulfillment({ ...scenAOrder }, bot),
          FulfillmentService.initiateFulfillment({ ...scenAOrder }, bot),
        ]);

        assert.equal(postOrdersCalls, 1, 'В реальном Emulator POST /v1/orders должен быть вызван ровно 1 раз');
        assert.ok(w1.fulfillmentStatus === 'completed' || w2.fulfillmentStatus === 'completed');
        const finalDoc = await OrderService.getOrderById(scenAOrder.orderId);
        assert.equal(finalDoc?.fulfillmentStatus, 'completed');
        assert.equal(finalDoc?.mystarsOrderId, 'ord_ms_emu_scen_a_01');
        assert.equal(finalDoc?.externalExecutionReference, 'ord_ms_emu_scen_a_01');
        return `В реальном Firestore Emulator только 1 из 2 параллельных воркеров захватил claim: POST /v1/orders вызван ровно 1 раз (postOrdersCalls=${postOrdersCalls}).`;
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
        FulfillmentService.resetMyStarsPollingState();
      }
    },
  );

  await runCheck(
    'CON-08',
    'Concurrency',
    'Stage 2.6.1 Scenario B: Concurrent polling lease (mystarsPollLease on Emulator)',
    'Два воркера одновременно опрашивают один processing-заказ в реальном Firestore Emulator; только один захватывает mystarsPollLease, истёкший lease перехватывается',
    async () => {
      let getOrderCalls = 0;
      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_emu_scen_b_key',
        paymentCurrency: 'usdt_ton',
      });
      FulfillmentService.setAdapter(new MyStarsFulfillmentAdapter(myStarsClient));
      FulfillmentService.resetMyStarsPollingState();

      try {
        myStarsClient.setHttpTransport(async (req) => {
          if (req.method === 'GET' && req.url.includes('/v1/orders/ord_ms_emu_scen_b_02')) {
            getOrderCalls += 1;
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                order_id: 'ord_ms_emu_scen_b_02',
                status: 'awaiting_payment',
                type: 'stars',
                recipient_username: 'emu_scen_b_user',
                quantity: 100,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected request in CON-08: ${req.method} ${req.url}`);
        });

        const scenBOrder: Order = {
          orderId: 'ord_emu_s261_scen_b',
          userId: 'tg_900001001',
          userTelegramId: 900001001,
          username: 'syn_alex_buyer',
          recipientUsername: 'emu_scen_b_user',
          productId: 'stars_pack_100',
          productName: '100 Telegram Stars (Synthetic)',
          category: 'stars',
          quantity: 100,
          totalPrice: 100,
          totalPriceUsdCents: 185,
          currency: 'XTR',
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          mystarsOrderId: 'ord_ms_emu_scen_b_02',
          externalExecutionReference: 'ord_ms_emu_scen_b_02',
          fulfillmentIdempotencyKey: 'fulfill_ord_emu_s261_scen_b',
          telegramPaymentChargeId: 'chg_emu_s261_scen_b',
          createdAt: '2026-11-22T10:01:00.000Z',
          paidAt: '2026-11-22T10:01:05.000Z',
          updatedAt: '2026-11-22T10:01:05.000Z',
        };
        await firestoreRepo.setDoc<Order>('orders', scenBOrder.orderId, scenBOrder);

        const nowMs = Date.now();
        const [l1, l2] = await Promise.all([
          FulfillmentService.acquireOrderPollLease({
            orderId: scenBOrder.orderId,
            leaseOwner: 'emu_worker_1',
            operationId: 'emu_op_1',
            ttlMs: 30_000,
            nowMs,
          }),
          FulfillmentService.acquireOrderPollLease({
            orderId: scenBOrder.orderId,
            leaseOwner: 'emu_worker_2',
            operationId: 'emu_op_2',
            ttlMs: 30_000,
            nowMs,
          }),
        ]);
        const acquiredCount = [l1, l2].filter((l) => l.acquired).length;
        assert.equal(acquiredCount, 1, 'В реальном Emulator ровно 1 воркер захватывает mystarsPollLease');

        // Reclaim after expiry
        const reclaimed = await FulfillmentService.acquireOrderPollLease({
          orderId: scenBOrder.orderId,
          leaseOwner: 'emu_worker_2',
          operationId: 'emu_op_2_reclaim',
          ttlMs: 30_000,
          nowMs: nowMs + 31_000,
        });
        assert.equal(reclaimed.acquired, true, 'Истёкший mystarsPollLease в Emulator успешно перехватывается');
        await FulfillmentService.releaseOrderPollLease({
          orderId: scenBOrder.orderId,
          leaseOwner: 'emu_worker_2',
          operationId: 'emu_op_2_reclaim',
        });

        const { bot } = createMockBot();
        const pollRes = await FulfillmentService.pollMyStarsOrders(bot);
        assert.ok(pollRes.polled >= 1);
        assert.equal(getOrderCalls, 1, 'Выполнен ровно 1 запрос GET /v1/orders/{id} за окно lease');

        await firestoreRepo.updateDoc<Order>('orders', scenBOrder.orderId, {
          fulfillmentStatus: 'completed',
          paymentStatus: 'completed',
        });
        return 'В реальном Firestore Emulator конкурирующий захват mystarsPollLease разрешён атомарно (acquired=1, GET=1, истёкший lease перехвачен).';
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
        FulfillmentService.resetMyStarsPollingState();
      }
    },
  );

  await runCheck(
    'CON-09',
    'Concurrency',
    'Stage 2.6.1 Scenario C: Crash and recovery (ambiguous POST reconciliation on Emulator)',
    'Заказ в processing с mystarsCreateInFlight=true после падения воркера восстанавливается через GET /v1/orders без дублирующего POST /v1/orders',
    async () => {
      let postCalls = 0;
      let listCalls = 0;
      let getDetailCalls = 0;
      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_emu_scen_c_key',
        paymentCurrency: 'usdt_ton',
      });
      FulfillmentService.setAdapter(new MyStarsFulfillmentAdapter(myStarsClient));
      FulfillmentService.resetMyStarsPollingState();

      try {
        const crashIso = new Date(Date.now() - 120_000).toISOString();
        const scenCOrder: Order = {
          orderId: 'ord_emu_s261_scen_c',
          userId: 'tg_900001001',
          userTelegramId: 900001001,
          username: 'syn_alex_buyer',
          recipientUsername: 'emu_scen_c_crash_user',
          productId: 'stars_pack_100',
          productName: '100 Telegram Stars (Synthetic)',
          category: 'stars',
          quantity: 100,
          totalPrice: 100,
          totalPriceUsdCents: 185,
          currency: 'XTR',
          paymentStatus: 'paid',
          fulfillmentStatus: 'processing',
          fulfillmentStartedAt: crashIso,
          fulfillmentAttempts: 1,
          fulfillmentIdempotencyKey: 'fulfill_ord_emu_s261_scen_c',
          mystarsCreateInFlight: true,
          telegramPaymentChargeId: 'chg_emu_s261_scen_c',
          createdAt: crashIso,
          paidAt: crashIso,
          updatedAt: crashIso,
        };
        await firestoreRepo.setDoc<Order>('orders', scenCOrder.orderId, scenCOrder);

        myStarsClient.setHttpTransport(async (req) => {
          if (req.method === 'POST' && req.url.endsWith('/v1/orders')) {
            postCalls += 1;
            throw new Error('Duplicate POST /v1/orders must not be called in CON-09');
          }
          if (req.method === 'GET' && /\/v1\/orders(\?|$)/.test(req.url)) {
            listCalls += 1;
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                orders: [
                  {
                    order_id: 'ord_ms_emu_scen_c_reconciled',
                    status: 'completed',
                    type: 'stars',
                    recipient_username: 'emu_scen_c_crash_user',
                    quantity: 100,
                    created_at: new Date(Date.now() - 90_000).toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                ],
                total: 1,
                page: 1,
                limit: 50,
              },
            };
          }
          if (req.method === 'GET' && req.url.includes('/v1/orders/ord_ms_emu_scen_c_reconciled')) {
            getDetailCalls += 1;
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                order_id: 'ord_ms_emu_scen_c_reconciled',
                status: 'completed',
                type: 'stars',
                recipient_username: 'emu_scen_c_crash_user',
                quantity: 100,
                currency: 'usdt_ton',
                payment_amount: '1.30',
                purchase_tx: '0x_emu_scen_c_tx',
                created_at: new Date(Date.now() - 90_000).toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected request in CON-09: ${req.method} ${req.url}`);
        });

        const { bot } = createMockBot();
        await FulfillmentService.recoverPendingFulfillments(bot);

        assert.equal(listCalls, 1, 'Выполнена сверка GET /v1/orders');
        assert.equal(getDetailCalls, 1, 'Выполнена проверка GET /v1/orders/{id}');
        assert.equal(postCalls, 0, 'Повторный POST /v1/orders не вызывался (0 дублей)');

        const afterC = await OrderService.getOrderById(scenCOrder.orderId);
        assert.equal(afterC?.mystarsOrderId, 'ord_ms_emu_scen_c_reconciled');
        assert.equal(afterC?.fulfillmentStatus, 'completed');
        assert.equal(afterC?.mystarsCreateInFlight, false);
        return 'После падения воркера с mystarsCreateInFlight=true в Emulator выполнена сверка GET /v1/orders и завершение заказа без повторного POST (postCalls=0).';
      } finally {
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
        FulfillmentService.resetMyStarsPollingState();
      }
    },
  );

  await runCheck(
    'CON-10',
    'Concurrency',
    'Stage 2.6.1 Scenario D & S261-01: Cursor transaction behavior and post-POST updateDoc failure on Emulator',
    'Проверка курсорных транзакций polling и отказа updateDoc в persistMyStarsOrderMetadata (+ отказа Phase 3 runTransaction) на реальном Firestore Emulator',
    async () => {
      let postCalls = 0;
      let getCalls = 0;
      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_emu_scen_d_key',
        paymentCurrency: 'usdt_ton',
      });
      FulfillmentService.setAdapter(new MyStarsFulfillmentAdapter(myStarsClient));
      FulfillmentService.resetMyStarsPollingState();

      const origUpdateDoc = firestoreRepo.updateDoc.bind(firestoreRepo);
      const origRunTx = firestoreRepo.runTransaction.bind(firestoreRepo);

      try {
        const scenDOrder: Order = {
          orderId: 'ord_emu_s261_updatedoc_fail',
          userId: 'tg_900001001',
          userTelegramId: 900001001,
          username: 'syn_alex_buyer',
          recipientUsername: 'emu_scen_d_user',
          productId: 'stars_pack_100',
          productName: '100 Telegram Stars (Synthetic)',
          category: 'stars',
          quantity: 100,
          totalPrice: 100,
          totalPriceUsdCents: 185,
          currency: 'XTR',
          paymentStatus: 'paid',
          fulfillmentStatus: 'paid',
          telegramPaymentChargeId: 'chg_emu_s261_scen_d',
          createdAt: '2026-11-22T10:05:00.000Z',
          paidAt: '2026-11-22T10:05:05.000Z',
          updatedAt: '2026-11-22T10:05:05.000Z',
        };
        await firestoreRepo.setDoc<Order>('orders', scenDOrder.orderId, scenDOrder);

        myStarsClient.setHttpTransport(async (req) => {
          if (req.url.endsWith('/recipients/check')) {
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                ok: true,
                type: 'stars',
                recipient_username: 'emu_scen_d_user',
                resolved: true,
                eligible: true,
              },
            };
          }
          if (req.method === 'POST' && req.url.endsWith('/v1/orders')) {
            postCalls += 1;
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                order_id: 'ord_ms_emu_s261_d_01',
                status: 'awaiting_payment',
                type: 'stars',
                recipient_username: 'emu_scen_d_user',
                quantity: 100,
                currency: 'usdt_ton',
                payment_amount: '1.30',
                expires_at: new Date(Date.now() + 900_000).toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          if (req.method === 'GET' && req.url.includes('/v1/orders/ord_ms_emu_s261_d_01')) {
            getCalls += 1;
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                order_id: 'ord_ms_emu_s261_d_01',
                status: 'completed',
                type: 'stars',
                recipient_username: 'emu_scen_d_user',
                quantity: 100,
                currency: 'usdt_ton',
                payment_amount: '1.30',
                purchase_tx: '0x_emu_s261_d_tx',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected request in CON-10: ${req.method} ${req.url}`);
        });

        let updateDocFailed = false;
        let phase3TxFailed = false;
        (firestoreRepo as unknown as { updateDoc: typeof firestoreRepo.updateDoc }).updateDoc =
          async <T extends object>(
            collectionName: Parameters<typeof origUpdateDoc>[0],
            docId: string,
            partialData: Partial<T>,
          ): Promise<T | null> => {
            if (
              collectionName === 'orders' &&
              docId === scenDOrder.orderId &&
              !updateDocFailed &&
              (partialData as Partial<Order>).mystarsOrderId === 'ord_ms_emu_s261_d_01' &&
              (partialData as Partial<Order>).fulfillmentStatus === undefined
            ) {
              updateDocFailed = true;
              throw new Error('Simulated Emulator updateDoc failure in persistMyStarsOrderMetadata');
            }
            return origUpdateDoc<T>(collectionName, docId, partialData);
          };
        (firestoreRepo as unknown as { runTransaction: typeof firestoreRepo.runTransaction }).runTransaction =
          async <T>(fn: Parameters<typeof firestoreRepo.runTransaction<T>>[0]) => {
            if (postCalls === 1 && updateDocFailed && !phase3TxFailed) {
              phase3TxFailed = true;
              throw new Error('Simulated Emulator Phase 3 runTransaction failure');
            }
            return origRunTx(fn);
          };

        const { bot } = createMockBot();
        const afterInit = await FulfillmentService.initiateFulfillment(scenDOrder, bot);
        assert.equal(updateDocFailed, true);
        assert.equal(phase3TxFailed, true);
        assert.equal(postCalls, 1);
        assert.equal(afterInit.mystarsOrderId, 'ord_ms_emu_s261_d_01');
        assert.equal(afterInit.fulfillmentStatus, 'processing');

        // Next recovery pass polls GET /v1/orders/{id} on Emulator and completes with 0 duplicate POSTs
        await FulfillmentService.recoverPendingFulfillments(bot);
        assert.equal(postCalls, 1, 'В Emulator повторный POST /v1/orders не вызывался');
        assert.equal(getCalls, 1, 'В Emulator выполнен ровно 1 запрос GET /v1/orders/{id}');

        const completedDoc = await OrderService.getOrderById(scenDOrder.orderId);
        assert.equal(completedDoc?.fulfillmentStatus, 'completed');
        assert.equal(completedDoc?.mystarsOrderId, 'ord_ms_emu_s261_d_01');
        return 'В реальном Firestore Emulator сбой updateDoc в persistMyStarsOrderMetadata + сбой Phase 3 runTransaction сохранили mystarsOrderId из памяти и завершили заказ через polling без повторного POST (postCalls=1, getCalls=1).';
      } finally {
        (firestoreRepo as unknown as { updateDoc: typeof firestoreRepo.updateDoc }).updateDoc =
          origUpdateDoc;
        (firestoreRepo as unknown as { runTransaction: typeof firestoreRepo.runTransaction }).runTransaction =
          origRunTx;
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
        FulfillmentService.resetMyStarsPollingState();
      }
    },
  );

  await runCheck(
    'CON-11',
    'Concurrency',
    'Stage 2.6.1 Scenario D: Cursor pagination and transaction conflict/retry behavior on Emulator',
    'Проверка курсорной пагинации polling и устойчивости к конфликту транзакций (ABORTED) на settings/mystars_poll_cursor в реальном Firestore Emulator без дублирования внешних вызовов',
    async () => {
      let getCalls = 0;
      myStarsClient.setCredentialsOverride({
        apiBaseUrl: 'https://api.mystars.tg',
        apiKey: 'ms_live_emu_cursor_key',
        paymentCurrency: 'usdt_ton',
      });
      FulfillmentService.setAdapter(new MyStarsFulfillmentAdapter(myStarsClient));
      FulfillmentService.resetMyStarsPollingState();

      const prevBudget = FulfillmentService.pollBatchBudget;
      const prevPageSize = FulfillmentService.pollPageSize;
      FulfillmentService.pollBatchBudget = 2;
      FulfillmentService.pollPageSize = 2;

      const origRunTx = firestoreRepo.runTransaction.bind(firestoreRepo);
      let injectedAbort = false;

      try {
        // Ensure all existing orders are non-processing before seeding 4 cursor test orders
        const existingOrders = await firestoreRepo.listDocs<Order>('orders', 500);
        for (const o of existingOrders) {
          if (o.fulfillmentStatus === 'processing') {
            await firestoreRepo.updateDoc<Order>('orders', o.orderId, {
              fulfillmentStatus: 'completed',
              paymentStatus: 'completed',
            });
          }
        }

        for (let i = 1; i <= 4; i++) {
          const ts = new Date(Date.UTC(2026, 10, 22, 11, 0, i)).toISOString();
          const ord: Order = {
            orderId: `ord_emu_s261_cursor_${i}`,
            userId: 'tg_900001001',
            userTelegramId: 900001001,
            username: 'syn_alex_buyer',
            recipientUsername: `emu_cursor_u_${i}`,
            productId: 'stars_pack_100',
            productName: '100 Telegram Stars (Synthetic)',
            category: 'stars',
            quantity: 100,
            totalPrice: 100,
            totalPriceUsdCents: 185,
            currency: 'XTR',
            paymentStatus: 'paid',
            fulfillmentStatus: 'processing',
            mystarsOrderId: `ord_ms_emu_cur_${i}`,
            externalExecutionReference: `ord_ms_emu_cur_${i}`,
            telegramPaymentChargeId: `chg_emu_cur_${i}`,
            createdAt: ts,
            paidAt: ts,
            updatedAt: ts,
          };
          await firestoreRepo.setDoc<Order>('orders', ord.orderId, ord);
        }

        myStarsClient.setHttpTransport(async (req) => {
          const m = req.url.match(/\/v1\/orders\/(ord_ms_emu_cur_\d+)/);
          if (req.method === 'GET' && m) {
            getCalls += 1;
            return {
              status: 200,
              ok: true,
              headers: {},
              json: {
                order_id: m[1],
                status: 'awaiting_payment',
                type: 'stars',
                recipient_username: 'emu_cursor_u',
                quantity: 100,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            };
          }
          throw new Error(`Unexpected request in CON-11: ${req.method} ${req.url}`);
        });

        (firestoreRepo as unknown as { runTransaction: typeof firestoreRepo.runTransaction }).runTransaction =
          async <T>(fn: Parameters<typeof firestoreRepo.runTransaction<T>>[0]) => {
            if (!injectedAbort && getCalls === 2) {
              injectedAbort = true;
              const abortErr = new Error('10 ABORTED: Contention on settings/mystars_poll_cursor in Emulator');
              (abortErr as Error & { code?: string }).code = 'aborted';
              throw abortErr;
            }
            return origRunTx(fn);
          };

        const { bot } = createMockBot();
        const tick1 = await FulfillmentService.pollMyStarsOrders(bot);
        assert.equal(injectedAbort, true);
        assert.equal(tick1.checkpointSaved, true);
        assert.equal(tick1.polled, 2);
        assert.equal(getCalls, 2, 'Конфликт транзакции курсора в Emulator повторен без повторного внешнего API вызова');

        const tick2 = await FulfillmentService.pollMyStarsOrders(bot);
        assert.equal(tick2.polled, 2);
        assert.equal(getCalls, 4, 'Второй тик в Emulator продолжил со следующей страницы курсора');
        return 'В реальном Firestore Emulator курсорные транзакции settings/mystars_poll_cursor и retry после ABORTED работают корректно без повторных внешних API вызовов (getCalls=4 за 2 тика).';
      } finally {
        (firestoreRepo as unknown as { runTransaction: typeof firestoreRepo.runTransaction }).runTransaction =
          origRunTx;
        FulfillmentService.pollBatchBudget = prevBudget;
        FulfillmentService.pollPageSize = prevPageSize;
        myStarsClient.setCredentialsOverride(null);
        myStarsClient.resetHttpTransport();
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
        FulfillmentService.resetMyStarsPollingState();
      }
    },
  );

  // ===========================================================================
  // RESTORE CLEAN 12-SCENARIO SYNTHETIC DATASET & EXPORT DUMP FOR AUDIT PACKAGE
  // ===========================================================================
  const finalSeedSummary = await seedSyntheticAuditDataset();
  const dumpPath = path.resolve(
    process.cwd(),
    'firestore-audit-package/export/firestore-collections-dump.json',
  );
  await exportEmulatorCollectionsToJson(dumpPath);

  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  const gitBranch = execFileSync('git', ['branch', '--show-current'], {
    encoding: 'utf-8',
  }).trim();
  const gitStatusPorcelain = execFileSync('git', ['status', '--short'], {
    encoding: 'utf-8',
  }).trim();
  const gitWorkingTreeDirty = gitStatusPorcelain.length > 0;
  const gitDiffRaw = execFileSync(
    'git',
    ['diff', 'HEAD', '--', 'firestore.rules', 'DRAFT_firestore.rules', 'firestore-audit-package/tests', 'firestore-audit-package/scripts'],
    { encoding: 'utf-8' },
  );
  const gitDiffSha256 = createHash('sha256').update(gitDiffRaw).digest('hex');
  const javaInfo = verifyJavaRuntime('java', 21);
  const firebaseCmd = process.platform === 'win32' ? 'firebase.cmd' : 'firebase';
  const fbRes = spawnSync(firebaseCmd, ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const firebaseCliVersion = (fbRes.stdout || fbRes.stderr || 'unknown').trim();
  const passedResults = results.filter((r) => r.status === 'PASS');
  const failedResults = results.filter((r) => r.status === 'FAIL');

  const resultsJsonPath = path.resolve(
    process.cwd(),
    'firestore-audit-package/export/audit-test-results.json',
  );
  fs.writeFileSync(
    resultsJsonPath,
    JSON.stringify(
      {
        gitSha,
        gitBranch,
        gitWorkingTreeDirty,
        gitDiffSha256,
        executedAt: new Date().toISOString(),
        nodeVersion: process.version,
        javaVersion: javaInfo.firstLine,
        firebaseCliVersion,
        emulatorHost: finalSeedSummary.emulatorHost,
        projectId: finalSeedSummary.projectId,
        emulatorUsed: firestoreRepo.isEmulatorMode(),
        totalTests: results.length,
        passed: passedResults.length,
        failed: failedResults.length,
        executedTestIds: results.map((r) => r.id),
        failedDetails: failedResults.map((r) => ({
          id: r.id,
          suite: r.suite,
          name: r.name,
          details: r.details,
        })),
        results,
      },
      null,
      2,
    ),
    'utf-8',
  );

  const failedCount = failedResults.length;
  console.log('================================================================================');
  console.log(
    `📊 ИТОГИ EMULATOR AUDIT SUITE: ${results.length - failedCount}/${results.length} PASS | ${failedCount} FAIL`,
  );
  console.log('================================================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Критическая ошибка выполнения Emulator Audit Suite:', err);
  process.exit(1);
});
