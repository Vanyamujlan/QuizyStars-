import crypto from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { Telegraf } from 'telegraf';
import { getEnvConfig } from '../config/env.ts';
import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  DistributedLeaseRecord,
  FirestoreTimestampLike,
  NotificationDeliveryState,
  Order,
  StoreTransaction,
} from '../types.ts';
import { OrderService } from './OrderService.ts';
import { PaymentService } from './PaymentService.ts';
import { balanceService } from './BalanceService.ts';
import { DigitalKeyService } from './DigitalKeyService.ts';
import {
  MyStarsApiError,
  MyStarsFulfillmentAdapter,
  MyStarsRateLimitError,
  MyStarsTransportError,
  myStarsClient,
} from './MyStarsService.ts';
import { redactSecretsFromText } from './PaymentProviders.ts';
import { buildAdminOrderActionKeyboard } from '../bot/keyboards.ts';
import { formatAdminOrderCard, formatOrderCompletedUserNotice } from '../bot/formatters.ts';

export interface FulfillmentRequestContext {
  idempotencyKey: string;
  attempt: number;
}

export interface FulfillmentAdapterResult {
  handledAutomatically: boolean;
  status: 'processing' | 'completed';
  details: string;
  externalReference?: string;
}

/**
 * Official Provider Adapter Interface.
 * Ready for future verified supplier integrations without rewriting the store logic.
 * Supports idempotency keys and optional status verification after crash recovery.
 */
export interface FulfillmentProviderAdapter {
  readonly providerName: string;
  readonly supportsIdempotency?: boolean;
  isConfigured(): boolean;
  requestFulfillment(
    order: Order,
    context?: FulfillmentRequestContext,
  ): Promise<FulfillmentAdapterResult>;
  checkExternalStatus?(
    order: Order,
    idempotencyKey: string,
  ): Promise<{
    alreadyExecuted: boolean;
    status?: 'processing' | 'completed';
    details?: string;
    externalReference?: string;
    unknownStatus?: string;
  }>;
}

export class ManualAdminFulfillmentAdapter implements FulfillmentProviderAdapter {
  public readonly providerName = 'ManualAdminFulfillment (Безопасная ручная выдача)';
  public readonly supportsIdempotency = true;

  public isConfigured(): boolean {
    return true;
  }

  public async requestFulfillment(
    order: Order,
    context?: FulfillmentRequestContext,
  ): Promise<FulfillmentAdapterResult> {
    return {
      handledAutomatically: false,
      status: 'processing',
      details: `Заказ #${order.orderId} передан администратору на ручную выдачу.`,
      externalReference: context?.idempotencyKey || `manual_${order.orderId}`,
    };
  }
}

export class FulfillmentService {
  public static readonly MAX_FULFILLMENT_ATTEMPTS = 3;
  public static baseRetryDelayMs = 2000;
  public static staleProcessingLeaseMs = 60_000;
  public static pollLeaseTtlMs = 45_000;
  public static notificationLeaseTtlMs = 45_000;
  public static staleOrderAlertThresholdMs = 15 * 60 * 1000;
  public static pollBatchBudget = 50;
  public static workerInstanceId = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;

  private static manualAdapter = new ManualAdminFulfillmentAdapter();
  private static myStarsAdapter = new MyStarsFulfillmentAdapter(myStarsClient);
  private static customAdapterOverride: FulfillmentProviderAdapter | null = null;
  private static recoveryIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private static isRecoveryPassRunning = false;
  private static mystarsPollCooldownUntilMs = 0;
  private static inFlightMyStarsPollOrders = new Set<string>();

  /**
   * Normalizes a Firestore Timestamp (or serialized plain-object / ISO / epoch representation)
   * into epoch milliseconds.
   */
  public static timestampToMillis(ts: FirestoreTimestampLike | undefined | null): number {
    if (ts === undefined || ts === null) return 0;
    if (typeof ts === 'number') {
      return Number.isFinite(ts) ? ts : 0;
    }
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof ts === 'object') {
      if (typeof ts.toMillis === 'function') {
        return ts.toMillis();
      }
      if (typeof ts.seconds === 'number') {
        return ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1e6);
      }
      if (typeof ts._seconds === 'number') {
        return ts._seconds * 1000 + Math.floor((ts._nanoseconds ?? 0) / 1e6);
      }
    }
    return 0;
  }

  /**
   * Atomically acquires a per-order distributed polling lease in Firestore using `Timestamp`.
   * Prevents multiple workers/replicas from polling the same order concurrently.
   */
  public static async acquireOrderPollLease(params: {
    orderId: string;
    leaseOwner?: string;
    operationId?: string;
    ttlMs?: number;
    nowMs?: number;
  }): Promise<{
    acquired: boolean;
    lease?: DistributedLeaseRecord;
    order?: Order;
  }> {
    const leaseOwner = params.leaseOwner || this.workerInstanceId;
    const operationId =
      params.operationId || `poll_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const ttlMs = params.ttlMs ?? this.pollLeaseTtlMs;
    const nowMs = params.nowMs ?? Date.now();

    return firestoreRepo.runTransaction(async (tx) => {
      const current = await tx.get<Order>('orders', params.orderId);
      if (!current || current.fulfillmentStatus !== 'processing') {
        return { acquired: false };
      }

      const existingLease = current.mystarsPollLease;
      const existingUntilMs = this.timestampToMillis(existingLease?.leaseUntil);
      if (existingLease && existingUntilMs > nowMs) {
        const isSameOperation =
          existingLease.leaseOwner === leaseOwner &&
          existingLease.operationId === operationId;
        if (!isSameOperation) {
          return {
            acquired: false,
            lease: existingLease,
            order: current,
          };
        }
      }

      const lease: DistributedLeaseRecord = {
        leaseOwner,
        operationId,
        acquiredAt: Timestamp.fromMillis(nowMs),
        leaseUntil: Timestamp.fromMillis(nowMs + ttlMs),
      };

      const updated: Order = {
        ...current,
        mystarsPollLease: lease,
      };
      tx.set<Order>('orders', updated.orderId, updated);
      return {
        acquired: true,
        lease,
        order: updated,
      };
    });
  }

  /**
   * Atomically renews an active polling lease if and only if both `leaseOwner` and `operationId` match.
   */
  public static async renewOrderPollLease(params: {
    orderId: string;
    leaseOwner: string;
    operationId: string;
    ttlMs?: number;
    nowMs?: number;
  }): Promise<boolean> {
    const ttlMs = params.ttlMs ?? this.pollLeaseTtlMs;
    const nowMs = params.nowMs ?? Date.now();

    return firestoreRepo.runTransaction(async (tx) => {
      const current = await tx.get<Order>('orders', params.orderId);
      if (!current || !current.mystarsPollLease) {
        return false;
      }
      if (
        current.mystarsPollLease.leaseOwner !== params.leaseOwner ||
        current.mystarsPollLease.operationId !== params.operationId
      ) {
        return false;
      }

      const renewed: DistributedLeaseRecord = {
        ...current.mystarsPollLease,
        leaseUntil: Timestamp.fromMillis(nowMs + ttlMs),
      };
      tx.set<Order>('orders', current.orderId, {
        ...current,
        mystarsPollLease: renewed,
      });
      return true;
    });
  }

  /**
   * Atomically releases an active polling lease if and only if `leaseOwner` and `operationId` match.
   * Guarantees an expired worker can never delete or clobber a newer worker's lease.
   */
  public static async releaseOrderPollLease(params: {
    orderId: string;
    leaseOwner: string;
    operationId: string;
  }): Promise<boolean> {
    return firestoreRepo.runTransaction(async (tx) => {
      const current = await tx.get<Order>('orders', params.orderId);
      if (!current || !current.mystarsPollLease) {
        return false;
      }
      if (
        current.mystarsPollLease.leaseOwner !== params.leaseOwner ||
        current.mystarsPollLease.operationId !== params.operationId
      ) {
        return false;
      }

      const updated: Order = {
        ...current,
        mystarsPollLease: undefined,
      };
      tx.set<Order>('orders', updated.orderId, updated);
      return true;
    });
  }

  public static resetMyStarsPollingState(): void {
    this.mystarsPollCooldownUntilMs = 0;
    this.inFlightMyStarsPollOrders.clear();
  }

  public static getMyStarsPollingStatus(): {
    mode: 'polling';
    workerActive: boolean;
    cooldownActive: boolean;
    cooldownUntilIso: string | null;
    inFlightOrdersCount: number;
  } {
    const now = Date.now();
    const cooldownActive = this.mystarsPollCooldownUntilMs > now;
    return {
      mode: 'polling',
      workerActive: this.recoveryIntervalHandle !== null,
      cooldownActive,
      cooldownUntilIso: cooldownActive
        ? new Date(this.mystarsPollCooldownUntilMs).toISOString()
        : null,
      inFlightOrdersCount: this.inFlightMyStarsPollOrders.size,
    };
  }

  public static setAdapter(adapter: FulfillmentProviderAdapter): void {
    if (adapter instanceof ManualAdminFulfillmentAdapter) {
      this.customAdapterOverride = null;
      this.manualAdapter = adapter;
      return;
    }
    this.customAdapterOverride = adapter;
  }

  public static resetAdapterToDefault(): void {
    this.customAdapterOverride = null;
  }

  public static getActiveAdapter(): FulfillmentProviderAdapter {
    if (this.customAdapterOverride) {
      return this.customAdapterOverride;
    }
    if (myStarsClient.isConfigured()) {
      return this.myStarsAdapter;
    }
    return this.manualAdapter;
  }

  public static getAdapterInfo(): { name: string; configured: boolean } {
    const active = this.getActiveAdapter();
    return {
      name: active.providerName,
      configured: active.isConfigured(),
    };
  }

  /**
   * Sends admin notification using a resilient state machine (`pending` -> `sending` -> `sent`)
   * with atomic claim, event ID, and lease protection.
   * If a process crashes while in `sending` (after Telegram may have accepted the request) and
   * its lease expires, transitions to `sent` with `deliveryUncertainAfterCrash: true` to avoid
   * duplicate spam while recording the uncertain post-crash state.
   */
  public static async ensureAdminNotified(
    order: Order,
    bot: Telegraf | null | undefined,
    forceResend = false,
  ): Promise<Order> {
    if (!forceResend && (order.adminNotifiedAt || order.adminNotificationState?.status === 'sent')) {
      return order;
    }
    if (!bot) {
      return order;
    }

    const eventId = `evt_admin_${order.orderId}_${order.fulfillmentStatus}`;
    const operationId = `op_admin_notify_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const leaseOwner = this.workerInstanceId;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const { adminIds } = getEnvConfig();
    if (adminIds.length === 0) {
      const sentState: NotificationDeliveryState = {
        status: 'sent',
        eventId,
        operationId,
        leaseOwner,
        attemptCount: (order.adminNotificationState?.attemptCount ?? 0) + 1,
        sentAt: nowIso,
      };
      return (
        (await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
          adminNotifiedAt: nowIso,
          adminNotificationState: sentState,
          updatedAt: nowIso,
        })) || order
      );
    }

    type AdminNotifyClaim =
      | { action: 'already_sent'; order: Order }
      | { action: 'in_flight'; order: Order }
      | { action: 'recovered_after_crash'; order: Order }
      | { action: 'claimed'; order: Order };

    const claim = await firestoreRepo.runTransaction<AdminNotifyClaim>(async (tx) => {
      const current = (await tx.get<Order>('orders', order.orderId)) || order;
      const state = current.adminNotificationState;

      if (!forceResend) {
        if (current.adminNotifiedAt || state?.status === 'sent') {
          return { action: 'already_sent', order: current };
        }
        if (state?.status === 'sending') {
          const leaseUntilMs = this.timestampToMillis(state.leaseUntil);
          if (leaseUntilMs > nowMs) {
            return { action: 'in_flight', order: current };
          }
          // Previous worker crashed during `sending` and its lease expired:
          // Mark `sent` with `deliveryUncertainAfterCrash: true` to avoid duplicate messages
          const recoveredState: NotificationDeliveryState = {
            ...state,
            status: 'sent',
            leaseUntil: undefined,
            sentAt: nowIso,
            deliveryUncertainAfterCrash: true,
          };
          const recoveredOrder: Order = {
            ...current,
            adminNotifiedAt: current.adminNotifiedAt || nowIso,
            adminNotificationState: recoveredState,
            updatedAt: nowIso,
          };
          tx.set<Order>('orders', recoveredOrder.orderId, recoveredOrder);
          return { action: 'recovered_after_crash', order: recoveredOrder };
        }
      }

      const claimingState: NotificationDeliveryState = {
        status: 'sending',
        eventId,
        operationId,
        leaseOwner,
        leaseUntil: Timestamp.fromMillis(nowMs + this.notificationLeaseTtlMs),
        attemptCount: (state?.attemptCount ?? 0) + 1,
        deliveryUncertainAfterCrash: false,
      };
      const claimedOrder: Order = {
        ...current,
        adminNotificationState: claimingState,
        updatedAt: nowIso,
      };
      tx.set<Order>('orders', claimedOrder.orderId, claimedOrder);
      return { action: 'claimed', order: claimedOrder };
    });

    if (claim.action !== 'claimed') {
      if (claim.action === 'recovered_after_crash') {
        console.warn(
          `[FulfillmentService] Восстановлено состояние adminNotificationState после истечения sending-lease для заказа #${order.orderId} (deliveryUncertainAfterCrash=true).`,
        );
      }
      return claim.order;
    }

    let deliveredCount = 0;
    for (const adminId of adminIds) {
      const ok = await this.sendTelegramMessageWithRetry(
        bot,
        adminId,
        `🔔 <b>Новый оплаченный заказ поступил на выдачу!</b>\n\n${formatAdminOrderCard(
          claim.order,
        )}`,
        {
          parse_mode: 'HTML',
          ...buildAdminOrderActionKeyboard(claim.order),
        },
      );
      if (ok) {
        deliveredCount++;
      }
    }

    const finIso = new Date().toISOString();
    return firestoreRepo.runTransaction<Order>(async (tx) => {
      const latest = (await tx.get<Order>('orders', order.orderId)) || claim.order;
      const latestState = latest.adminNotificationState;
      if (
        latestState &&
        latestState.operationId &&
        latestState.operationId !== operationId
      ) {
        return latest;
      }

      if (deliveredCount > 0) {
        const sentState: NotificationDeliveryState = {
          status: 'sent',
          eventId,
          operationId,
          leaseOwner,
          attemptCount: latestState?.attemptCount ?? 1,
          sentAt: finIso,
          deliveryUncertainAfterCrash: false,
        };
        const updated: Order = {
          ...latest,
          adminNotifiedAt: finIso,
          adminNotificationState: sentState,
          updatedAt: finIso,
        };
        tx.set<Order>('orders', updated.orderId, updated);
        return updated;
      }

      const pendingState: NotificationDeliveryState = {
        status: 'pending',
        eventId,
        operationId,
        leaseOwner,
        attemptCount: latestState?.attemptCount ?? 1,
        lastError: 'Не удалось доставить уведомление ни одному администратору',
      };
      const updated: Order = {
        ...latest,
        adminNotificationState: pendingState,
        updatedAt: finIso,
      };
      tx.set<Order>('orders', updated.orderId, updated);
      return updated;
    });
  }

  /**
   * Sends buyer completion notification using a resilient state machine (`pending` -> `sending` -> `sent`)
   * with atomic claim, event ID, and lease protection.
   * Never claims absolute `exactly-once` across process crashes right after Telegram accepts an HTTP request:
   * if a process crashes while in `sending` and `leaseUntil` expires, transitions to `sent` with
   * `deliveryUncertainAfterCrash: true` to prevent duplicate completion spam while logging the state.
   */
  public static async ensureBuyerNotified(
    order: Order,
    bot: Telegraf | null | undefined,
    forceResend = false,
  ): Promise<Order> {
    if (!forceResend && (order.buyerNotifiedAt || order.buyerNotificationState?.status === 'sent')) {
      return order;
    }
    if (!bot) {
      return order;
    }

    const eventId = `evt_buyer_completed_${order.orderId}`;
    const operationId = `op_buyer_notify_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const leaseOwner = this.workerInstanceId;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    type BuyerNotifyClaim =
      | { action: 'already_sent'; order: Order }
      | { action: 'in_flight'; order: Order }
      | { action: 'recovered_after_crash'; order: Order }
      | { action: 'claimed'; order: Order };

    const claim = await firestoreRepo.runTransaction<BuyerNotifyClaim>(async (tx) => {
      const current = (await tx.get<Order>('orders', order.orderId)) || order;
      const state = current.buyerNotificationState;

      if (!forceResend) {
        if (current.buyerNotifiedAt || state?.status === 'sent') {
          return { action: 'already_sent', order: current };
        }
        if (state?.status === 'sending') {
          const leaseUntilMs = this.timestampToMillis(state.leaseUntil);
          if (leaseUntilMs > nowMs) {
            return { action: 'in_flight', order: current };
          }
          // Previous worker crashed during `sending` and its lease expired:
          // Transition to `sent` with `deliveryUncertainAfterCrash: true` so the buyer is never spammed
          const recoveredState: NotificationDeliveryState = {
            ...state,
            status: 'sent',
            leaseUntil: undefined,
            sentAt: nowIso,
            deliveryUncertainAfterCrash: true,
          };
          const recoveredOrder: Order = {
            ...current,
            buyerNotifiedAt: current.buyerNotifiedAt || nowIso,
            buyerNotificationState: recoveredState,
            updatedAt: nowIso,
          };
          tx.set<Order>('orders', recoveredOrder.orderId, recoveredOrder);
          return { action: 'recovered_after_crash', order: recoveredOrder };
        }
      }

      const claimingState: NotificationDeliveryState = {
        status: 'sending',
        eventId,
        operationId,
        leaseOwner,
        leaseUntil: Timestamp.fromMillis(nowMs + this.notificationLeaseTtlMs),
        attemptCount: (state?.attemptCount ?? 0) + 1,
        deliveryUncertainAfterCrash: false,
      };
      const claimedOrder: Order = {
        ...current,
        buyerNotificationState: claimingState,
        updatedAt: nowIso,
      };
      tx.set<Order>('orders', claimedOrder.orderId, claimedOrder);
      return { action: 'claimed', order: claimedOrder };
    });

    if (claim.action !== 'claimed') {
      if (claim.action === 'recovered_after_crash') {
        console.warn(
          `[FulfillmentService] Восстановлено состояние buyerNotificationState после истечения sending-lease для заказа #${order.orderId} (deliveryUncertainAfterCrash=true).`,
        );
      }
      return claim.order;
    }

    const ok = await this.sendTelegramMessageWithRetry(
      bot,
      claim.order.userTelegramId,
      formatOrderCompletedUserNotice(claim.order),
      { parse_mode: 'HTML' },
    );

    const finIso = new Date().toISOString();
    return firestoreRepo.runTransaction<Order>(async (tx) => {
      const latest = (await tx.get<Order>('orders', order.orderId)) || claim.order;
      const latestState = latest.buyerNotificationState;
      if (
        latestState &&
        latestState.operationId &&
        latestState.operationId !== operationId
      ) {
        return latest;
      }

      if (ok) {
        const sentState: NotificationDeliveryState = {
          status: 'sent',
          eventId,
          operationId,
          leaseOwner,
          attemptCount: latestState?.attemptCount ?? 1,
          sentAt: finIso,
          deliveryUncertainAfterCrash: false,
        };
        const updated: Order = {
          ...latest,
          buyerNotifiedAt: finIso,
          buyerNotificationState: sentState,
          updatedAt: finIso,
        };
        tx.set<Order>('orders', updated.orderId, updated);
        return updated;
      }

      const pendingState: NotificationDeliveryState = {
        status: 'pending',
        eventId,
        operationId,
        leaseOwner,
        attemptCount: latestState?.attemptCount ?? 1,
        lastError: 'Не удалось доставить уведомление покупателю в Telegram',
      };
      const updated: Order = {
        ...latest,
        buyerNotificationState: pendingState,
        updatedAt: finIso,
      };
      tx.set<Order>('orders', updated.orderId, updated);
      return updated;
    });
  }

  public static async retryOrderNotifications(
    orderId: string,
    bot: Telegraf,
  ): Promise<{ order: Order; adminNotified: boolean; buyerNotified: boolean }> {
    let order = await OrderService.getOrderById(orderId);
    if (!order) {
      throw new Error(`Заказ #${orderId} не найден.`);
    }

    order = await this.ensureAdminNotified(order, bot, true);
    if (order.fulfillmentStatus === 'completed') {
      order = await this.ensureBuyerNotified(order, bot, true);
    }

    return {
      order,
      adminNotified: Boolean(order.adminNotifiedAt),
      buyerNotified: Boolean(order.buyerNotifiedAt),
    };
  }

  private static async sendTelegramMessageWithRetry(
    bot: Telegraf,
    chatId: number | string,
    htmlText: string,
    extra: Record<string, unknown>,
    maxAttempts = 2,
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await bot.telegram.sendMessage(chatId, htmlText, extra);
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
        }
      }
    }

    console.warn(
      `[FulfillmentService] Не удалось отправить уведомление в чат ${chatId}:`,
      lastError instanceof Error ? lastError.message : String(lastError),
    );
    return false;
  }

  /**
   * Initiates fulfillment strictly AFTER verified successful_payment commit.
   * 1. Atomically claims the order in Firestore BEFORE invoking the external adapter.
   * 2. Prevents parallel workers from executing fulfillment for the same order.
   * 3. Tracks start time, attempts count, idempotency key, and last error.
   * 4. Handles crash recovery when external execution succeeded before state persistence.
   * 5. Caps retries at MAX_FULFILLMENT_ATTEMPTS so orders never stay in 'processing' forever.
   */
  public static async initiateFulfillment(
    orderInput: Order,
    bot: Telegraf | null | undefined,
    options?: { allowStaleTakeover?: boolean },
  ): Promise<Order> {
    const idempotencyKey =
      orderInput.fulfillmentIdempotencyKey || `fulfill_${orderInput.orderId}`;
    const activeAdapter = this.getActiveAdapter();

    // Stage 3.3: Check if digital keys are available for this product (for ManualAdminFulfillmentAdapter or gifts category)
    if (
      activeAdapter instanceof ManualAdminFulfillmentAdapter ||
      orderInput.category === 'gifts'
    ) {
      const candidateKeyIds = await DigitalKeyService.getAvailableCandidateKeyIds(
        orderInput.productId,
        orderInput.quantity,
      );
      if (candidateKeyIds.length >= orderInput.quantity) {
        const keyOutcome = await DigitalKeyService.fulfillOrderWithDigitalKey(
          orderInput,
          bot,
        );
        if (keyOutcome.fulfilled) {
          return keyOutcome.order;
        }
      }
    }

    type ClaimOutcome =
      | { action: 'already_completed'; order: Order }
      | { action: 'already_processing'; order: Order }
      | { action: 'needs_admin_notification_only'; order: Order }
      | { action: 'needs_reconciliation_check'; order: Order }
      | { action: 'exhausted'; order: Order }
      | { action: 'claimed'; order: Order; attempt: number };

    // =========================================================================
    // PHASE 1: ATOMIC CLAIM BEFORE EXTERNAL ADAPTER CALL
    // =========================================================================
    const claim = await firestoreRepo.runTransaction<ClaimOutcome>(async (tx) => {
      const current = (await tx.get<Order>('orders', orderInput.orderId)) || orderInput;

      if (
        current.paymentStatus !== 'paid' &&
        current.paymentStatus !== 'processing' &&
        current.paymentStatus !== 'completed'
      ) {
        throw new Error(
          `Невозможно запустить выдачу заказа #${current.orderId} без подтверждённой оплаты (текущий статус: ${current.paymentStatus}).`,
        );
      }

      if (current.fulfillmentStatus === 'completed') {
        return { action: 'already_completed', order: current };
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const startedMs = current.fulfillmentStartedAt
        ? Date.parse(current.fulfillmentStartedAt)
        : 0;
      const isLeaseActive =
        startedMs > 0 && nowMs - startedMs < this.staleProcessingLeaseMs;

      if (current.fulfillmentStatus === 'processing') {
        // If external reference is already recorded, the adapter already finished; only ensure admin notification
        if (current.externalExecutionReference) {
          if (!current.adminNotifiedAt) {
            return { action: 'needs_admin_notification_only', order: current };
          }
          return { action: 'already_processing', order: current };
        }

        // Another worker holds an active lease right now
        if (isLeaseActive && !options?.allowStaleTakeover) {
          return { action: 'already_processing', order: current };
        }

        // Stale processing state: server crashed after claiming 'processing' before saving adapter result
        if ((current.fulfillmentAttempts ?? 0) >= 1) {
          return { action: 'needs_reconciliation_check', order: current };
        }
      }

      const prevAttempts = current.fulfillmentAttempts ?? 0;
      if (prevAttempts >= this.MAX_FULFILLMENT_ATTEMPTS) {
        const exhaustedOrder: Order = {
          ...current,
          fulfillmentStatus: 'failed',
          needsManualReconciliation: true,
          fulfillmentLastError:
            current.fulfillmentLastError ||
            `Превышен лимит попыток автоматической выдачи (${this.MAX_FULFILLMENT_ATTEMPTS}). Требуется ручная проверка администратором.`,
          fulfillmentNextRetryAt: undefined,
          updatedAt: nowIso,
        };
        tx.set<Order>('orders', exhaustedOrder.orderId, exhaustedOrder);
        return { action: 'exhausted', order: exhaustedOrder };
      }

      const nextAttempt = prevAttempts + 1;
      const claimedOrder: Order = {
        ...current,
        fulfillmentStatus: 'processing',
        fulfillmentStartedAt: nowIso,
        fulfillmentAttempts: nextAttempt,
        fulfillmentIdempotencyKey: current.fulfillmentIdempotencyKey || idempotencyKey,
        ...(activeAdapter instanceof MyStarsFulfillmentAdapter &&
        !current.mystarsOrderId &&
        !current.externalExecutionReference
          ? { mystarsCreateInFlight: true }
          : {}),
        updatedAt: nowIso,
      };

      tx.set<Order>('orders', claimedOrder.orderId, claimedOrder);
      return { action: 'claimed', order: claimedOrder, attempt: nextAttempt };
    });

    if (claim.action === 'already_completed') {
      return this.ensureBuyerNotified(claim.order, bot);
    }

    if (claim.action === 'already_processing') {
      return claim.order;
    }

    if (claim.action === 'needs_admin_notification_only') {
      return this.ensureAdminNotified(claim.order, bot);
    }

    if (claim.action === 'exhausted') {
      return this.ensureAdminNotified(claim.order, bot);
    }

    // Handle crash recovery where previous worker crashed during external execution
    if (claim.action === 'needs_reconciliation_check') {
      return this.reconcileStaleProcessingOrder(claim.order, bot);
    }

    // =========================================================================
    // PHASE 2: EXECUTE EXTERNAL ADAPTER (ONLY FOR THE WORKER THAT WON THE CLAIM)
    // =========================================================================
    let { order: claimedOrder } = claim;
    const { attempt } = claim;
    try {
      // If a previous attempt had an ambiguous POST /v1/orders timeout before saving mystarsOrderId,
      // run bounded reconciliation via GET /v1/orders before sending another POST /v1/orders.
      if (
        activeAdapter instanceof MyStarsFulfillmentAdapter &&
        !claimedOrder.mystarsOrderId &&
        claimedOrder.mystarsAmbiguousPostAt
      ) {
        const reconciled = await activeAdapter.reconcileAmbiguousCreateOrder(claimedOrder);
        if (reconciled.status === 'ambiguous_multiple') {
          throw new MyStarsApiError({
            message: `Обнаружено несколько (${reconciled.count}) подходящих заказов в MyStars после таймаута POST /v1/orders. Автоповтор заблокирован для защиты от дублирования.`,
            httpStatus: 409,
            code: 'ambiguous_create_order',
            retryable: false,
          });
        }
        if (reconciled.status === 'found' && reconciled.mystarsOrderId) {
          claimedOrder = {
            ...claimedOrder,
            mystarsOrderId: reconciled.mystarsOrderId,
            externalExecutionReference: reconciled.mystarsOrderId,
            mystarsOrderStatus: reconciled.mystarsStatus,
            mystarsCreateInFlight: false,
            mystarsAmbiguousPostAt: undefined,
          };
        }
      }

      const adapterResult = await activeAdapter.requestFulfillment(claimedOrder, {
        idempotencyKey: claimedOrder.fulfillmentIdempotencyKey || idempotencyKey,
        attempt,
      });

      // =========================================================================
      // PHASE 3: PERSIST ADAPTER RESULT ATOMICALLY
      // =========================================================================
      const finalizedOrder = await firestoreRepo.runTransaction<Order>(async (tx) => {
        const latest = (await tx.get<Order>('orders', claimedOrder.orderId)) || claimedOrder;
        if (latest.fulfillmentStatus === 'completed') {
          return latest;
        }

        const nowIso = new Date().toISOString();
        const isAutoCompleted =
          adapterResult.handledAutomatically && adapterResult.status === 'completed';

        const updated: Order = {
          ...latest,
          paymentStatus: isAutoCompleted ? 'completed' : latest.paymentStatus,
          fulfillmentStatus: adapterResult.status,
          fulfillmentNote: adapterResult.details.slice(0, 500),
          externalExecutionReference:
            adapterResult.externalReference ||
            `${activeAdapter.providerName}:${idempotencyKey}`,
          mystarsCreateInFlight: false,
          mystarsAmbiguousPostAt: undefined,
          fulfillmentLastError: undefined,
          fulfillmentNextRetryAt: undefined,
          completedAt: isAutoCompleted ? latest.completedAt || nowIso : latest.completedAt,
          updatedAt: nowIso,
        };

        tx.set<Order>('orders', updated.orderId, updated);

        if (isAutoCompleted) {
          const txId = sanitizeDocId(
            `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          );
          tx.set<StoreTransaction>('transactions', txId, {
            transactionId: txId,
            orderId: updated.orderId,
            userId: updated.userId,
            type: 'fulfillment_completed',
            amount: updated.totalPriceUsdCents ?? updated.totalPrice,
            amountUsdCents: updated.totalPriceUsdCents ?? updated.totalPrice,
            currency: updated.currency || 'USD',
            details: `Автоматическая выдача завершена: ${adapterResult.details}`.slice(
              0,
              500,
            ),
            createdAt: nowIso,
          });
        }

        return updated;
      });

      // =========================================================================
      // PHASE 4: SEND NOTIFICATIONS OUTSIDE TRANSACTION (FAULT-TOLERANT)
      // =========================================================================
      let notifiedOrder = await this.ensureAdminNotified(finalizedOrder, bot);
      if (notifiedOrder.fulfillmentStatus === 'completed') {
        notifiedOrder = await this.ensureBuyerNotified(notifiedOrder, bot);
      }
      return notifiedOrder;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const isNonRetryable =
        (error as { retryable?: boolean })?.retryable === false;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const canRetry = !isNonRetryable && attempt < this.MAX_FULFILLMENT_ATTEMPTS;
      let delayMs = this.baseRetryDelayMs * Math.pow(2, Math.max(0, attempt - 1));
      if (
        error instanceof MyStarsRateLimitError &&
        error.kind === 'general' &&
        error.retryAfterSeconds !== undefined
      ) {
        delayMs = Math.min(Math.max(error.retryAfterSeconds * 1000, 10), 120_000);
      }
      const nextRetryIso = canRetry ? new Date(nowMs + delayMs).toISOString() : undefined;
      const isAmbiguousCreateError =
        activeAdapter instanceof MyStarsFulfillmentAdapter &&
        !claimedOrder.mystarsOrderId &&
        (error instanceof MyStarsTransportError ||
          (error instanceof MyStarsApiError && error.httpStatus >= 500));

      const failedOrder = await firestoreRepo.runTransaction<Order>(async (tx) => {
        const latest = (await tx.get<Order>('orders', claimedOrder.orderId)) || claimedOrder;
        const failed: Order = {
          ...latest,
          fulfillmentStatus: 'failed',
          fulfillmentLastError: errMsg.slice(0, 500),
          fulfillmentNextRetryAt: nextRetryIso,
          needsManualReconciliation: !canRetry,
          ...(isAmbiguousCreateError && !latest.mystarsOrderId
            ? {
                mystarsCreateInFlight: true,
                mystarsAmbiguousPostAt: latest.mystarsAmbiguousPostAt || nowIso,
              }
            : {
                mystarsCreateInFlight: false,
              }),
          fulfillmentNote: canRetry
            ? `Ошибка попытки выдачи #${attempt}: ${errMsg}. Запланирован повтор.`
            : isNonRetryable
              ? `Выдача отклонена провайдером (неповторяемая ошибка): ${errMsg}. Требуется проверка администратором.`
              : `Выдача остановлена после ${attempt} попыток: ${errMsg}. Требуется ручная выдача админом.`,
          updatedAt: nowIso,
        };
        tx.set<Order>('orders', failed.orderId, failed);

        const txId = sanitizeDocId(
          `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        );
        tx.set<StoreTransaction>('transactions', txId, {
          transactionId: txId,
          orderId: failed.orderId,
          userId: failed.userId,
          type: 'fulfillment_failed',
          amount: failed.totalPriceUsdCents ?? failed.totalPrice,
          amountUsdCents: failed.totalPriceUsdCents ?? failed.totalPrice,
          currency: failed.currency || 'USD',
          details: `Ошибка выдачи (попытка ${attempt}/${this.MAX_FULFILLMENT_ATTEMPTS}): ${errMsg}`.slice(
            0,
            500,
          ),
          createdAt: nowIso,
        });

        return failed;
      });

      if (!canRetry) {
        await this.ensureAdminNotified(failedOrder, bot);
      }

      throw error;
    }
  }

  /**
   * Reconciles an order that was left in 'processing' without an externalExecutionReference
   * due to a server crash or ambiguous POST timeout mid-execution.
   * - If the adapter supports `checkExternalStatus`, queries the provider first.
   * - If the order was in the middle of `POST /v1/orders` without a saved `mystarsOrderId`,
   *   runs bounded reconciliation via `GET /v1/orders` (`reconcileAmbiguousCreateOrder`).
   *   If `fulfillmentIdempotencyKey` is missing or multiple matches are found, quarantines
   *   the order for manual admin review so a duplicate order is never created.
   */
  private static async reconcileStaleProcessingOrder(
    staleOrder: Order,
    bot: Telegraf | null | undefined,
  ): Promise<Order> {
    const hasLockedIdempotencyKey = Boolean(
      staleOrder.fulfillmentIdempotencyKey && staleOrder.fulfillmentIdempotencyKey.trim(),
    );
    const idempotencyKey =
      staleOrder.fulfillmentIdempotencyKey || `fulfill_${staleOrder.orderId}`;
    const activeAdapter = this.getActiveAdapter();

    // If MyStars POST /v1/orders crashed or timed out before mystarsOrderId was persisted,
    // attempt bounded reconciliation via GET /v1/orders first.
    if (
      activeAdapter instanceof MyStarsFulfillmentAdapter &&
      !staleOrder.mystarsOrderId &&
      !staleOrder.externalExecutionReference
    ) {
      try {
        const reconciled = await activeAdapter.reconcileAmbiguousCreateOrder(staleOrder);
        if (reconciled.status === 'found' && reconciled.mystarsOrderId) {
          staleOrder = {
            ...staleOrder,
            mystarsOrderId: reconciled.mystarsOrderId,
            externalExecutionReference: reconciled.mystarsOrderId,
            mystarsOrderStatus: reconciled.mystarsStatus,
            mystarsCreateInFlight: false,
            mystarsAmbiguousPostAt: undefined,
          };
        } else if (reconciled.status === 'ambiguous_multiple' || !hasLockedIdempotencyKey) {
          const nowIso = new Date().toISOString();
          const reason =
            reconciled.status === 'ambiguous_multiple'
              ? `Обнаружено несколько (${reconciled.count}) подходящих заказов в MyStars после сбоя POST /v1/orders. Автоповтор заблокирован для защиты от дублирования.`
              : 'Сервер перезапустился во время POST /v1/orders без сохранённого Idempotency-Key. Автоповтор заблокирован для защиты от двойного создания заказа.';
          const quarantined = await firestoreRepo.runTransaction<Order>(async (tx) => {
            const current = (await tx.get<Order>('orders', staleOrder.orderId)) || staleOrder;
            const updated: Order = {
              ...current,
              fulfillmentStatus: 'failed',
              needsManualReconciliation: true,
              mystarsCreateInFlight: false,
              fulfillmentLastError: reason,
              fulfillmentNote: reason,
              updatedAt: nowIso,
            };
            tx.set<Order>('orders', updated.orderId, updated);
            return updated;
          });
          return this.ensureAdminNotified(quarantined, bot);
        }
      } catch (reconcileErr) {
        console.warn(
          `[FulfillmentService] Ошибка сверки GET /v1/orders для зависшего заказа #${staleOrder.orderId}:`,
          reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
        );
        if (!hasLockedIdempotencyKey) {
          const nowIso = new Date().toISOString();
          const quarantined = await firestoreRepo.runTransaction<Order>(async (tx) => {
            const current = (await tx.get<Order>('orders', staleOrder.orderId)) || staleOrder;
            const updated: Order = {
              ...current,
              fulfillmentStatus: 'failed',
              needsManualReconciliation: true,
              mystarsCreateInFlight: false,
              fulfillmentLastError:
                'Не удалось сверить статус POST /v1/orders после сбоя без сохранённого Idempotency-Key. Требуется ручная проверка.',
              fulfillmentNote:
                'Требуется ручная сверка администратором (защита от двойной выдачи).',
              updatedAt: nowIso,
            };
            tx.set<Order>('orders', updated.orderId, updated);
            return updated;
          });
          return this.ensureAdminNotified(quarantined, bot);
        }
      }
    }

    if (activeAdapter.checkExternalStatus) {
      const extStatus = await activeAdapter.checkExternalStatus(
        staleOrder,
        idempotencyKey,
      );
      if (extStatus.alreadyExecuted) {
        const nowIso = new Date().toISOString();
        const finalStatus = extStatus.status || 'completed';
        const reconciled = await firestoreRepo.runTransaction<Order>(async (tx) => {
          const current = (await tx.get<Order>('orders', staleOrder.orderId)) || staleOrder;
          const updated: Order = {
            ...current,
            paymentStatus:
              finalStatus === 'completed' ? 'completed' : current.paymentStatus,
            fulfillmentStatus: finalStatus,
            fulfillmentNote: (
              extStatus.details ||
              'Статус выдачи восстановлен после сверки с внешним провайдером.'
            ).slice(0, 500),
            externalExecutionReference:
              extStatus.externalReference || `reconciled_${idempotencyKey}`,
            mystarsCreateInFlight: false,
            mystarsAmbiguousPostAt: undefined,
            fulfillmentLastError: undefined,
            completedAt:
              finalStatus === 'completed'
                ? current.completedAt || nowIso
                : current.completedAt,
            updatedAt: nowIso,
          };
          tx.set<Order>('orders', updated.orderId, updated);
          return updated;
        });

        let notified = await this.ensureAdminNotified(reconciled, bot);
        if (notified.fulfillmentStatus === 'completed') {
          notified = await this.ensureBuyerNotified(notified, bot);
        }
        return notified;
      }
    }

    // If provider does not support idempotency and we cannot verify external status,
    // NEVER re-execute automatically to prevent double fulfillment!
    if (!activeAdapter.supportsIdempotency && !activeAdapter.checkExternalStatus) {
      const nowIso = new Date().toISOString();
      const quarantined = await firestoreRepo.runTransaction<Order>(async (tx) => {
        const current = (await tx.get<Order>('orders', staleOrder.orderId)) || staleOrder;
        const updated: Order = {
          ...current,
          fulfillmentStatus: 'failed',
          needsManualReconciliation: true,
          fulfillmentLastError:
            'Сервер перезапустился во время внешнего вызова без подтверждения статуса. Автоповтор заблокирован для защиты от двойной выдачи.',
          fulfillmentNote:
            'Требуется ручная сверка администратором (защита от двойной выдачи после перезапуска).',
          updatedAt: nowIso,
        };
        tx.set<Order>('orders', updated.orderId, updated);
        return updated;
      });
      return this.ensureAdminNotified(quarantined, bot);
    }

    // Adapter is explicitly idempotent (or checkExternalStatus confirmed it wasn't executed yet):
    // Reset to 'paid' inside transaction and run initiateFulfillment with the same locked idempotencyKey
    await firestoreRepo.runTransaction<void>(async (tx) => {
      const current = await tx.get<Order>('orders', staleOrder.orderId);
      if (!current || current.fulfillmentStatus !== 'processing') return;
      tx.set<Order>('orders', current.orderId, {
        ...current,
        fulfillmentStatus: 'paid',
        fulfillmentIdempotencyKey: current.fulfillmentIdempotencyKey || idempotencyKey,
        updatedAt: new Date().toISOString(),
      });
    });

    const refreshed = (await OrderService.getOrderById(staleOrder.orderId)) || staleOrder;
    return this.initiateFulfillment(refreshed, bot, { allowStaleTakeover: true });
  }

  /**
   * Recovery worker pass:
   * - Recovers orders in 'paid' (payment committed, fulfillment not started)
   * - Retries eligible orders in 'failed' whose backoff delay has elapsed and attempts < MAX_FULFILLMENT_ATTEMPTS
   * - Recovers stale 'processing' orders or retries missing admin/buyer notifications
   * Guarded by `isRecoveryPassRunning` mutex so two recovery passes never overlap.
   */
  public static async recoverPendingFulfillments(
    bot: Telegraf | null | undefined,
  ): Promise<Order[]> {
    if (this.isRecoveryPassRunning) {
      return [];
    }
    if (!firestoreRepo.isProductionStorageHealthy()) {
      return [];
    }

    this.isRecoveryPassRunning = true;
    const recovered: Order[] = [];

    try {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      // 1. Orders in 'paid' status
      const paidOrders = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'paid' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: 25,
      });

      for (const ord of paidOrders) {
        if (ord.paymentStatus === 'paid') {
          try {
            const updated = await this.initiateFulfillment(ord, bot);
            recovered.push(updated);
          } catch (error) {
            console.error(
              `[FulfillmentService] Ошибка восстановления paid-заказа #${ord.orderId}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }

      // 2. Retryable 'failed' orders whose backoff timer has elapsed
      const failedOrders = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'failed' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: 25,
      });

      for (const ord of failedOrders) {
        const attempts = ord.fulfillmentAttempts ?? 0;
        const retryDue =
          !ord.fulfillmentNextRetryAt || ord.fulfillmentNextRetryAt <= nowIso;
        if (
          !ord.needsManualReconciliation &&
          attempts < this.MAX_FULFILLMENT_ATTEMPTS &&
          retryDue
        ) {
          try {
            const updated = await this.initiateFulfillment(ord, bot);
            recovered.push(updated);
          } catch (error) {
            console.error(
              `[FulfillmentService] Повторная попытка выдачи заказа #${ord.orderId} завершилась ошибкой:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        } else if (!ord.adminNotifiedAt) {
          await this.ensureAdminNotified(ord, bot);
        }
      }

      // 3. Stale 'processing' orders (crashed mid-call without external reference) and admin notifications
      const processingOrders = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'processing' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: 50,
      });

      for (const ord of processingOrders) {
        const startedMs = ord.fulfillmentStartedAt
          ? Date.parse(ord.fulfillmentStartedAt)
          : 0;
        const isStale =
          startedMs > 0 && nowMs - startedMs >= this.staleProcessingLeaseMs;

        if (!ord.externalExecutionReference && !ord.mystarsOrderId && isStale) {
          try {
            const reconciled = await this.reconcileStaleProcessingOrder(ord, bot);
            recovered.push(reconciled);
          } catch (error) {
            console.error(
              `[FulfillmentService] Ошибка сверки зависшего заказа #${ord.orderId}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
          continue;
        }

        if (!ord.adminNotifiedAt && !ord.mystarsOrderId) {
          const notified = await this.ensureAdminNotified(ord, bot);
          if (notified.adminNotifiedAt) {
            recovered.push(notified);
          }
        }
      }

      // 3b. Dedicated MyStars FaaS v1 Polling Pass (GET /v1/orders/{order_id})
      // Automatically resumes for all unfinished processing orders after restarts,
      // handles 429 Retry-After cooldowns, timeouts, and terminal success/failure states.
      try {
        const pollSummary = await this.pollMyStarsOrders(bot);
        for (const polledOrder of pollSummary.orders) {
          recovered.push(polledOrder);
        }
      } catch (error) {
        console.error(
          '[FulfillmentService] Ошибка фонового polling MyStars:',
          redactSecretsFromText(error instanceof Error ? error.message : String(error)),
        );
      }

      // 4. AUD-016: Recover pending/interrupted refunds where Telegram succeeded before Firestore commit
      try {
        const recoveredRefunds = await PaymentService.recoverPendingRefunds();
        for (const r of recoveredRefunds) {
          recovered.push(r);
        }
      } catch (error) {
        console.error(
          '[FulfillmentService] Ошибка фонового восстановления возвратов:',
          error instanceof Error ? error.message : String(error),
        );
      }

      // 5. Reconcile pending CryptoBot & xRocket order payments and balance top-ups
      try {
        const settledOrderPayments = await PaymentService.reconcilePendingOrderPayments();
        for (const settled of settledOrderPayments) {
          if (settled.ok && settled.order) {
            try {
              const fulfilled = await this.initiateFulfillment(settled.order, bot);
              recovered.push(fulfilled);
            } catch (err) {
              console.error(
                `[FulfillmentService] Ошибка выдачи после фоновой сверки платежа заказа #${settled.order.orderId}:`,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
        await balanceService.reconcilePendingTopUps();
      } catch (error) {
        console.error(
          '[FulfillmentService] Ошибка фоновой сверки инвойсов CryptoBot/xRocket:',
          error instanceof Error ? error.message : String(error),
        );
      }

      return recovered;
    } finally {
      this.isRecoveryPassRunning = false;
    }
  }

  /**
   * Dedicated MyStars FaaS v1 Polling Pass (`GET /v1/orders/{order_id}`).
   * - Scans all active `processing` orders across cursor-paginated pages so >50 active orders
   *   and legacy documents without `mystarsLastPolledAt` are never starved.
   * - Sorts candidates by `mystarsLastPolledAt` ascending (with missing `mystarsLastPolledAt` first).
   * - Acquires an atomic Firestore `Timestamp` lease (`mystarsPollLease`) per order before polling.
   * - Alerts admins once on unknown MyStars status (`mystarsUnknownStatusSeen`) or orders stuck
   *   in `processing` for >15 minutes (`mystarsStuckAlertedAt`) while continuing polling.
   * - Respects HTTP 429 Retry-After cooldowns without marking orders as failed.
   */
  public static async pollMyStarsOrders(
    bot: Telegraf | null | undefined,
  ): Promise<{
    polled: number;
    completed: number;
    failed: number;
    stillProcessing: number;
    rateLimited: boolean;
    deferredByCooldown: boolean;
    transientErrors: number;
    orders: Order[];
  }> {
    const summary = {
      polled: 0,
      completed: 0,
      failed: 0,
      stillProcessing: 0,
      rateLimited: false,
      deferredByCooldown: false,
      transientErrors: 0,
      orders: [] as Order[],
    };

    if (!firestoreRepo.isProductionStorageHealthy()) {
      return summary;
    }

    const activeAdapter = this.getActiveAdapter();
    if (!activeAdapter.checkExternalStatus || !activeAdapter.isConfigured()) {
      return summary;
    }

    const nowMs = Date.now();
    if (this.mystarsPollCooldownUntilMs > nowMs) {
      summary.rateLimited = true;
      summary.deferredByCooldown = true;
      return summary;
    }

    // Cursor-paginated scan of all 'processing' orders ordered by 'createdAt' (always present),
    // ensuring legacy documents without `mystarsLastPolledAt` are never excluded by Firestore indexes
    // and orders #51+ are fairly scheduled in round-robin order.
    const allProcessingOrders: Order[] = [];
    let cursorOrderId: string | undefined;
    const PAGE_SIZE = 100;
    const MAX_PAGES = 10;

    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      const page = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'processing' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: PAGE_SIZE,
        ...(cursorOrderId ? { startAfterDocId: cursorOrderId } : {}),
      });
      if (page.length === 0) break;
      allProcessingOrders.push(...page);
      if (page.length < PAGE_SIZE) break;
      cursorOrderId = page[page.length - 1].orderId;
    }

    const myStarsCandidates = allProcessingOrders
      .filter((ord) =>
        Boolean(
          ord.mystarsOrderId ||
            (ord.externalExecutionReference &&
              (ord.externalExecutionReference.startsWith('ord_') ||
                ord.externalExecutionReference.startsWith('ms_'))),
        ),
      )
      .sort((a, b) => {
        const aPolledMs = a.mystarsLastPolledAt ? Date.parse(a.mystarsLastPolledAt) || 0 : 0;
        const bPolledMs = b.mystarsLastPolledAt ? Date.parse(b.mystarsLastPolledAt) || 0 : 0;
        if (aPolledMs !== bPolledMs) {
          return aPolledMs - bPolledMs;
        }
        return (a.createdAt || '').localeCompare(b.createdAt || '');
      });

    const batchToPoll = myStarsCandidates.slice(0, Math.max(1, this.pollBatchBudget));

    for (const ord of batchToPoll) {
      if (this.inFlightMyStarsPollOrders.has(ord.orderId)) {
        continue;
      }

      const leaseOwner = this.workerInstanceId;
      const operationId = `poll_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const leaseClaim = await this.acquireOrderPollLease({
        orderId: ord.orderId,
        leaseOwner,
        operationId,
        ttlMs: this.pollLeaseTtlMs,
      });
      if (!leaseClaim.acquired || !leaseClaim.order) {
        continue;
      }

      this.inFlightMyStarsPollOrders.add(ord.orderId);
      try {
        const latest = leaseClaim.order;
        if (latest.fulfillmentStatus !== 'processing') {
          continue;
        }

        summary.polled += 1;
        const extStatus = await activeAdapter.checkExternalStatus(
          latest,
          latest.fulfillmentIdempotencyKey || `fulfill_${latest.orderId}`,
        );

        if (extStatus.alreadyExecuted && extStatus.status === 'completed') {
          const completed = await this.completeOrder({
            orderId: latest.orderId,
            adminNote:
              extStatus.details ||
              `Автоматическая выдача MyStars завершена (${latest.mystarsOrderId || extStatus.externalReference}).`,
            bot,
          });
          summary.completed += 1;
          summary.orders.push(completed);
          continue;
        }

        // If MyStars returned an unknown status, send a one-time alert to admins
        if (extStatus.unknownStatus && !latest.mystarsUnknownStatusSeen && bot) {
          const refreshedForUnknown = (await OrderService.getOrderById(latest.orderId)) || latest;
          const { adminIds } = getEnvConfig();
          for (const adminId of adminIds) {
            await this.sendTelegramMessageWithRetry(
              bot,
              adminId,
              `⚠️ <b>Неизвестный статус MyStars: "${extStatus.unknownStatus}"</b>\nЗаказ оставлен в статусе processing для безопасной проверки.\n\n${formatAdminOrderCard(refreshedForUnknown)}`,
              {
                parse_mode: 'HTML',
                ...buildAdminOrderActionKeyboard(refreshedForUnknown),
              },
            );
          }
        }

        // Check if order has been stuck in 'processing' longer than staleOrderAlertThresholdMs (15m)
        const processingStartIso =
          latest.fulfillmentStartedAt || latest.paidAt || latest.createdAt;
        const processingStartMs = processingStartIso ? Date.parse(processingStartIso) : 0;
        if (
          processingStartMs > 0 &&
          Date.now() - processingStartMs >= this.staleOrderAlertThresholdMs &&
          !latest.mystarsStuckAlertedAt
        ) {
          const alertIso = new Date().toISOString();
          const alertedOrder =
            (await firestoreRepo.updateDoc<Order>('orders', latest.orderId, {
              mystarsStuckAlertedAt: alertIso,
              updatedAt: alertIso,
            })) || { ...latest, mystarsStuckAlertedAt: alertIso };
          if (bot) {
            const { adminIds } = getEnvConfig();
            for (const adminId of adminIds) {
              await this.sendTelegramMessageWithRetry(
                bot,
                adminId,
                `⏳ <b>Заказ MyStars в обработке более 15 минут</b>\nАвтоматический polling продолжается. Проверьте статус оплаты поставщику MyStars.\n\n${formatAdminOrderCard(alertedOrder)}`,
                {
                  parse_mode: 'HTML',
                  ...buildAdminOrderActionKeyboard(alertedOrder),
                },
              );
            }
          }
        }

        summary.stillProcessing += 1;
      } catch (error) {
        const safeErrMsg = redactSecretsFromText(
          error instanceof Error ? error.message : String(error),
        );

        // 1. Rate-limit (HTTP 429 general): set global polling cooldown honoring Retry-After
        if (error instanceof MyStarsRateLimitError && error.kind === 'general') {
          const retryAfterSec = error.retryAfterSeconds ?? 15;
          const cooldownMs = Math.min(Math.max(retryAfterSec * 1000, 10), 120_000);
          this.mystarsPollCooldownUntilMs = Date.now() + cooldownMs;
          summary.rateLimited = true;
          summary.transientErrors += 1;
          await firestoreRepo
            .updateDoc<Order>('orders', ord.orderId, {
              mystarsLastPolledAt: new Date().toISOString(),
              mystarsLastPollError: safeErrMsg.slice(0, 500),
              updatedAt: new Date().toISOString(),
            })
            .catch(() => {});
          console.warn(
            `[FulfillmentService:MyStarsPolling] HTTP 429 rate limit — пауза polling на ${Math.round(cooldownMs)} мс.`,
          );
          break;
        }

        // 2. Permanent terminal failure (MyStars status failed/reversed/expired/cancelled or non-retryable 4xx)
        const isPermanent =
          (error instanceof MyStarsApiError && !error.retryable) ||
          (error as { retryable?: boolean })?.retryable === false;
        if (isPermanent) {
          const mystarsStatus =
            error instanceof MyStarsApiError ? error.mystarsStatus : undefined;
          const failedOrd = await this.markOrderFulfillmentFailedPermanent(
            ord.orderId,
            safeErrMsg,
            bot,
            mystarsStatus,
          );
          if (failedOrd) {
            summary.failed += 1;
            summary.orders.push(failedOrd);
          }
          continue;
        }

        // 3. Transient timeout / network error / HTTP 5xx / malformed payload: keep order in 'processing' and retry on next tick
        summary.transientErrors += 1;
        summary.stillProcessing += 1;
        await firestoreRepo
          .updateDoc<Order>('orders', ord.orderId, {
            mystarsLastPolledAt: new Date().toISOString(),
            mystarsLastPollError: safeErrMsg.slice(0, 500),
            updatedAt: new Date().toISOString(),
          })
          .catch(() => {});
        const kindLabel =
          error instanceof MyStarsTransportError && error.isTimeout
            ? 'таймаут'
            : 'временная ошибка API';
        console.warn(
          `[FulfillmentService:MyStarsPolling] ${kindLabel} при проверке заказа #${ord.orderId} (${ord.mystarsOrderId}): ${safeErrMsg}`,
        );
      } finally {
        this.inFlightMyStarsPollOrders.delete(ord.orderId);
        await this.releaseOrderPollLease({
          orderId: ord.orderId,
          leaseOwner,
          operationId,
        }).catch(() => {});
      }
    }

    return summary;
  }

  private static async markOrderFulfillmentFailedPermanent(
    orderId: string,
    errorMessage: string,
    bot: Telegraf | null | undefined,
    mystarsStatus?: string,
  ): Promise<Order | null> {
    const nowIso = new Date().toISOString();
    const txOutcome = await firestoreRepo.runTransaction<{
      newlyFailed: boolean;
      order: Order | null;
    }>(async (tx) => {
      const current = await tx.get<Order>('orders', orderId);
      if (!current) return { newlyFailed: false, order: null };
      if (current.fulfillmentStatus === 'completed') {
        return { newlyFailed: false, order: current };
      }
      if (current.fulfillmentStatus === 'failed' && current.needsManualReconciliation) {
        return { newlyFailed: false, order: current };
      }

      const failed: Order = {
        ...current,
        ...(mystarsStatus ? { mystarsOrderStatus: mystarsStatus } : {}),
        mystarsFailureReason: errorMessage.slice(0, 500),
        fulfillmentStatus: 'failed',
        needsManualReconciliation: true,
        fulfillmentLastError: errorMessage.slice(0, 500),
        fulfillmentNextRetryAt: undefined,
        fulfillmentNote: `Ошибка выдачи MyStars: ${errorMessage}`.slice(0, 500),
        updatedAt: nowIso,
      };
      tx.set<Order>('orders', failed.orderId, failed);

      const txId = sanitizeDocId(
        `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      );
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: failed.orderId,
        userId: failed.userId,
        type: 'fulfillment_failed',
        amount: failed.totalPriceUsdCents ?? failed.totalPrice,
        amountUsdCents: failed.totalPriceUsdCents ?? failed.totalPrice,
        currency: failed.currency || 'USD',
        details: `Постоянная ошибка выдачи MyStars: ${errorMessage}`.slice(0, 500),
        createdAt: nowIso,
      });

      return { newlyFailed: true, order: failed };
    });

    const updated = txOutcome.order;
    if (txOutcome.newlyFailed && updated && updated.fulfillmentStatus === 'failed' && bot) {
      const { adminIds } = getEnvConfig();
      for (const adminId of adminIds) {
        await this.sendTelegramMessageWithRetry(
          bot,
          adminId,
          `🚨 <b>СБОЙ АВТОВЫДАЧИ MYSTARS (Polling)</b>\n\n${formatAdminOrderCard(updated)}`,
          {
            parse_mode: 'HTML',
            ...buildAdminOrderActionKeyboard(updated),
          },
        );
      }
      await firestoreRepo
        .updateDoc<Order>('orders', updated.orderId, {
          adminNotifiedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {});
    }
    return updated;
  }

  /**
   * Starts the singleton background recovery & MyStars polling worker after DB initialization.
   * Calling multiple times is safe and never creates duplicate workers.
   */
  public static startRecoveryWorker(
    getBot: () => Telegraf | null,
    intervalMs = getEnvConfig().mystarsPollIntervalMs || 15_000,
  ): void {
    if (this.recoveryIntervalHandle) {
      return;
    }

    // Run initial recovery pass asynchronously without blocking startup
    void this.recoverPendingFulfillments(getBot()).catch((err) => {
      console.error(
        '[FulfillmentService] Ошибка стартового прохода recoverPendingFulfillments:',
        err instanceof Error ? err.message : String(err),
      );
    });

    this.recoveryIntervalHandle = setInterval(() => {
      void this.recoverPendingFulfillments(getBot()).catch((err) => {
        console.error(
          '[FulfillmentService] Ошибка фонового прохода recoverPendingFulfillments:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, intervalMs);

    this.recoveryIntervalHandle.unref?.();
  }

  public static stopRecoveryWorker(): void {
    if (this.recoveryIntervalHandle) {
      clearInterval(this.recoveryIntervalHandle);
      this.recoveryIntervalHandle = null;
    }
  }

  public static isRecoveryWorkerActive(): boolean {
    return this.recoveryIntervalHandle !== null;
  }

  /**
   * Completes an order (called by admin after manual delivery or by verified adapter)
   * and notifies the buyer in Telegram chat (with optional delivery message, code, or link).
   */
  public static async completeOrder(params: {
    orderId: string;
    adminNote?: string;
    adminTelegramId?: number;
    bot?: Telegraf | null;
  }): Promise<Order> {
    const note =
      params.adminNote?.trim() || 'Товар успешно выдан администратором магазина.';
    const adminInfo = params.adminTelegramId
      ? ` (админ ID: ${params.adminTelegramId})`
      : '';

    const claimResult = await firestoreRepo.runTransaction<{
      newlyCompleted: boolean;
      order: Order;
    }>(async (tx) => {
      const existing = await tx.get<Order>('orders', params.orderId);
      if (!existing) {
        throw new Error(`Заказ #${params.orderId} не найден.`);
      }

      if (existing.fulfillmentStatus === 'completed') {
        return { newlyCompleted: false, order: existing };
      }

      if (
        existing.paymentStatus !== 'paid' &&
        existing.paymentStatus !== 'processing'
      ) {
        throw new Error(
          `Заказ #${params.orderId} не имеет статуса подтверждённой оплаты (${existing.paymentStatus}).`,
        );
      }

      const now = new Date().toISOString();
      const completedOrder: Order = {
        ...existing,
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
        fulfillmentNote: note.slice(0, 500),
        fulfillmentLastError: undefined,
        fulfillmentNextRetryAt: undefined,
        needsManualReconciliation: false,
        completedAt: existing.completedAt || now,
        updatedAt: now,
      };

      tx.set<Order>('orders', completedOrder.orderId, completedOrder);

      const txId = sanitizeDocId(
        `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      );
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: completedOrder.orderId,
        userId: completedOrder.userId,
        type: 'fulfillment_completed',
        amount: completedOrder.totalPriceUsdCents ?? completedOrder.totalPrice,
        amountUsdCents: completedOrder.totalPriceUsdCents ?? completedOrder.totalPrice,
        currency: completedOrder.currency || 'USD',
        details: `Заказ выдан покупателю${adminInfo}: ${note}`.slice(0, 500),
        createdAt: now,
      });

      return { newlyCompleted: true, order: completedOrder };
    });

    // Ensure buyer notification is sent (or retried if previously undelivered)
    const finalOrder = await this.ensureBuyerNotified(
      claimResult.order,
      params.bot,
    );

    return finalOrder;
  }
}
