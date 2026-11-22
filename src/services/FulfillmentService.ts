import crypto from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { Telegraf } from 'telegraf';
import { getEnvConfig } from '../config/env.ts';
import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  AdminRecipientDeliveryRecord,
  DistributedLeaseRecord,
  FirestoreTimestampLike,
  FulfillmentAdapterResult,
  FulfillmentProviderAdapter,
  FulfillmentRequestContext,
  MyStarsPollCheckpoint,
  NotificationDeliveryState,
  NotificationDeliveryStatus,
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
import {
  escapeHtml,
  formatAdminOrderCard,
  formatOrderCompletedUserNotice,
} from '../bot/formatters.ts';

export type {
  FulfillmentAdapterResult,
  FulfillmentProviderAdapter,
  FulfillmentRequestContext,
};

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

export class MyStarsCheckpointError extends Error {
  public readonly operation: 'load' | 'save';

  constructor(operation: 'load' | 'save', message: string, cause?: unknown) {
    super(message);
    this.name = 'MyStarsCheckpointError';
    this.operation = operation;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
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
  public static pollPageSize = 100;
  public static checkpointBackoffBaseMs = 2000;
  public static checkpointTransactionMaxAttempts = 4;
  public static checkpointConflictRetryDelayMs = 25;
  public static notificationRecoveryBatchLimit = 50;
  public static workerInstanceId = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;

  private static manualAdapter = new ManualAdminFulfillmentAdapter();
  private static myStarsAdapter = new MyStarsFulfillmentAdapter(myStarsClient);
  private static customAdapterOverride: FulfillmentProviderAdapter | null = null;
  private static recoveryIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private static isRecoveryPassRunning = false;
  private static mystarsPollCooldownUntilMs = 0;
  private static inFlightMyStarsPollOrders = new Set<string>();
  private static lastConfirmedPollCheckpoint: MyStarsPollCheckpoint | null = null;
  private static pendingUnsavedCheckpoint: MyStarsPollCheckpoint | null = null;
  private static checkpointDegraded = false;
  private static checkpointLastError: string | null = null;
  private static checkpointConsecutiveFailures = 0;
  private static checkpointRetryAfterMs = 0;
  private static buyerPendingCursorOrderId: string | null = null;
  private static adminPendingCursorOrderId: string | null = null;
  private static adminPartialCursorOrderId: string | null = null;
  private static retainedProviderResults = new Map<
    string,
    {
      claimedOrder: Order;
      adapterResult: FulfillmentAdapterResult;
      idempotencyKey: string;
      providerName: string;
    }
  >();

  public static resetNotificationRecoveryState(): void {
    this.buyerPendingCursorOrderId = null;
    this.adminPendingCursorOrderId = null;
    this.adminPartialCursorOrderId = null;
  }

  private static extractMyStarsMetadataFromOrder(source: Order): Partial<Order> {
    if (!source.mystarsOrderId) {
      return {};
    }
    return {
      mystarsOrderId: source.mystarsOrderId,
      ...(source.mystarsOrderStatus !== undefined
        ? { mystarsOrderStatus: source.mystarsOrderStatus }
        : {}),
      ...(source.mystarsLastPolledAt !== undefined
        ? { mystarsLastPolledAt: source.mystarsLastPolledAt }
        : {}),
      ...(source.mystarsPollAttempts !== undefined
        ? { mystarsPollAttempts: source.mystarsPollAttempts }
        : {}),
      ...(source.mystarsPayToAddress !== undefined
        ? { mystarsPayToAddress: source.mystarsPayToAddress }
        : {}),
      ...(source.mystarsPaymentMemo !== undefined
        ? { mystarsPaymentMemo: source.mystarsPaymentMemo }
        : {}),
      ...(source.mystarsPaymentAmountUsdt !== undefined
        ? { mystarsPaymentAmountUsdt: source.mystarsPaymentAmountUsdt }
        : {}),
      ...(source.mystarsPurchaseTx !== undefined
        ? { mystarsPurchaseTx: source.mystarsPurchaseTx }
        : {}),
      ...(source.mystarsPaymentTx !== undefined
        ? { mystarsPaymentTx: source.mystarsPaymentTx }
        : {}),
      ...(source.mystarsReversalTx !== undefined
        ? { mystarsReversalTx: source.mystarsReversalTx }
        : {}),
      ...(source.mystarsFailureReason !== undefined
        ? { mystarsFailureReason: source.mystarsFailureReason }
        : {}),
      ...(source.mystarsUnknownStatusSeen !== undefined
        ? { mystarsUnknownStatusSeen: source.mystarsUnknownStatusSeen }
        : {}),
      ...(source.mystarsExpiresAt !== undefined
        ? { mystarsExpiresAt: source.mystarsExpiresAt }
        : {}),
      ...(source.mystarsWholesaleCostUsdt !== undefined
        ? { mystarsWholesaleCostUsdt: source.mystarsWholesaleCostUsdt }
        : {}),
      ...(source.mystarsCostUsdCents !== undefined
        ? { mystarsCostUsdCents: source.mystarsCostUsdCents }
        : {}),
      ...(source.mystarsCurrency !== undefined
        ? { mystarsCurrency: source.mystarsCurrency }
        : {}),
      ...(source.grossRevenueUsdCents !== undefined
        ? { grossRevenueUsdCents: source.grossRevenueUsdCents }
        : {}),
      ...(source.providerFeeUsdCents !== undefined
        ? { providerFeeUsdCents: source.providerFeeUsdCents }
        : {}),
      ...(source.tonNetworkFeeUsdCents !== undefined
        ? { tonNetworkFeeUsdCents: source.tonNetworkFeeUsdCents }
        : {}),
      ...(source.netProfitUsdCents !== undefined
        ? { netProfitUsdCents: source.netProfitUsdCents }
        : {}),
    };
  }

  private static async ensureFulfillmentCompletedTransaction(
    order: Order,
    details: string,
    nowIso: string,
  ): Promise<void> {
    const existingTxs = await firestoreRepo.queryDocs<StoreTransaction>('transactions', {
      where: [{ field: 'orderId', op: '==', value: order.orderId }],
      limit: 50,
    });
    if (existingTxs.some((t) => t.type === 'fulfillment_completed')) {
      return;
    }
    const txId = sanitizeDocId(`tx_fulfill_done_${order.orderId}`);
    await firestoreRepo.setDoc<StoreTransaction>('transactions', txId, {
      transactionId: txId,
      orderId: order.orderId,
      userId: order.userId,
      type: 'fulfillment_completed',
      amount: order.totalPriceUsdCents ?? order.totalPrice,
      amountUsdCents: order.totalPriceUsdCents ?? order.totalPrice,
      currency: order.currency || 'USD',
      details: details.slice(0, 500),
      createdAt: nowIso,
    });
  }

  private static async flushRetainedProviderResultForOrder(
    orderId: string,
    bot?: Telegraf | null,
  ): Promise<Order | null> {
    const retained = this.retainedProviderResults.get(orderId);
    if (!retained) {
      return null;
    }
    const { claimedOrder, adapterResult, idempotencyKey, providerName } = retained;
    const nowIso = new Date().toISOString();
    const isAutoCompleted =
      adapterResult.handledAutomatically && adapterResult.status === 'completed';
    const resolvedRef =
      adapterResult.externalReference ||
      claimedOrder.mystarsOrderId ||
      `${providerName}:${idempotencyKey}`;
    const fallbackUpdates: Partial<Order> = {
      ...this.extractMyStarsMetadataFromOrder(claimedOrder),
      paymentStatus: isAutoCompleted ? 'completed' : claimedOrder.paymentStatus,
      fulfillmentStatus: adapterResult.status,
      fulfillmentNote: adapterResult.details.slice(0, 500),
      externalExecutionReference: resolvedRef,
      mystarsCreateInFlight: false,
      mystarsAmbiguousPostAt: undefined,
      fulfillmentLastError: undefined,
      fulfillmentNextRetryAt: undefined,
      ...(isAutoCompleted ? { completedAt: claimedOrder.completedAt || nowIso } : {}),
      updatedAt: nowIso,
    };

    const recoveredDoc = await firestoreRepo.updateDoc<Order>(
      'orders',
      claimedOrder.orderId,
      fallbackUpdates,
    );
    if (!recoveredDoc) {
      return null;
    }

    if (isAutoCompleted) {
      await this.ensureFulfillmentCompletedTransaction(
        recoveredDoc,
        `Автоматическая выдача завершена: ${adapterResult.details}`,
        nowIso,
      );
    }

    this.retainedProviderResults.delete(orderId);

    let notified = await this.ensureAdminNotified(recoveredDoc, bot).catch(
      () => recoveredDoc,
    );
    if (notified.fulfillmentStatus === 'completed') {
      notified = await this.ensureBuyerNotified(notified, bot).catch(
        () => notified,
      );
    }
    return notified;
  }

  private static async flushAllRetainedProviderResults(
    bot?: Telegraf | null,
  ): Promise<Order[]> {
    if (this.retainedProviderResults.size === 0) {
      return [];
    }
    const flushedOrders: Order[] = [];
    for (const orderId of Array.from(this.retainedProviderResults.keys())) {
      try {
        const flushed = await this.flushRetainedProviderResultForOrder(orderId, bot);
        if (flushed) {
          flushedOrders.push(flushed);
        }
      } catch (err) {
        console.warn(
          `[FulfillmentService] Отложенное сохранение результата провайдера для заказа #${orderId} пока не удалось:`,
          redactSecretsFromText(err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return flushedOrders;
  }

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
    this.lastConfirmedPollCheckpoint = null;
    this.pendingUnsavedCheckpoint = null;
    this.checkpointDegraded = false;
    this.checkpointLastError = null;
    this.checkpointConsecutiveFailures = 0;
    this.checkpointRetryAfterMs = 0;
    this.retainedProviderResults.clear();
    this.resetNotificationRecoveryState();
  }

  private static recordCheckpointFailure(
    operation: 'load' | 'save',
    error: unknown,
  ): MyStarsCheckpointError {
    const rawMsg = redactSecretsFromText(
      error instanceof Error ? error.message : String(error),
    );
    const wrapped =
      error instanceof MyStarsCheckpointError
        ? error
        : new MyStarsCheckpointError(
            operation,
            `Ошибка Firestore при ${operation === 'load' ? 'чтении' : 'сохранении'} checkpoint MyStars polling: ${rawMsg}`,
            error,
          );
    this.checkpointDegraded = true;
    this.checkpointLastError = wrapped.message;
    this.checkpointConsecutiveFailures += 1;
    const baseMs = Math.max(0, this.checkpointBackoffBaseMs);
    const backoffMs =
      baseMs > 0
        ? Math.min(30_000, baseMs * 2 ** Math.min(this.checkpointConsecutiveFailures - 1, 5))
        : 0;
    this.checkpointRetryAfterMs = backoffMs > 0 ? Date.now() + backoffMs : 0;
    console.error(`[FulfillmentService:MyStarsPolling] ${wrapped.message}`);
    return wrapped;
  }

  private static clearCheckpointDegradedState(): void {
    if (this.checkpointDegraded) {
      console.info(
        `[FulfillmentService:MyStarsPolling] Работа с checkpoint Firestore восстановлена после ${this.checkpointConsecutiveFailures} сбоев.`,
      );
    }
    this.checkpointDegraded = false;
    this.checkpointLastError = null;
    this.checkpointConsecutiveFailures = 0;
    this.checkpointRetryAfterMs = 0;
  }

  private static normalizeResetEpoch(
    checkpoint: Pick<MyStarsPollCheckpoint, 'resetEpoch'>,
  ): number {
    return typeof checkpoint.resetEpoch === 'number' &&
      Number.isInteger(checkpoint.resetEpoch) &&
      checkpoint.resetEpoch >= 0
      ? checkpoint.resetEpoch
      : 0;
  }

  private static extractRawResetEpoch(raw: unknown): number {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return 0;
    }
    const candidate = (raw as Record<string, unknown>).resetEpoch;
    return typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 0
      ? candidate
      : 0;
  }

  private static sanitizeCheckpointForStorage(
    checkpoint: MyStarsPollCheckpoint,
  ): MyStarsPollCheckpoint {
    const clean: MyStarsPollCheckpoint = {
      key: 'mystars_poll_cursor',
      cyclesCompleted: checkpoint.cyclesCompleted,
      lastPolledCount: checkpoint.lastPolledCount,
      updatedAt: checkpoint.updatedAt,
      resetEpoch: this.normalizeResetEpoch(checkpoint),
    };
    if (checkpoint.cursorCreatedAt && checkpoint.cursorOrderId) {
      clean.cursorCreatedAt = checkpoint.cursorCreatedAt;
      clean.cursorOrderId = checkpoint.cursorOrderId;
    }
    return clean;
  }

  private static parseValidPollCheckpoint(raw: unknown): MyStarsPollCheckpoint | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const obj = raw as Record<string, unknown>;
    if (obj.key !== 'mystars_poll_cursor') {
      return null;
    }
    if (
      typeof obj.cyclesCompleted !== 'number' ||
      !Number.isInteger(obj.cyclesCompleted) ||
      obj.cyclesCompleted < 0
    ) {
      return null;
    }
    let resetEpoch = 0;
    if (obj.resetEpoch !== undefined && obj.resetEpoch !== null) {
      if (
        typeof obj.resetEpoch !== 'number' ||
        !Number.isInteger(obj.resetEpoch) ||
        obj.resetEpoch < 0
      ) {
        return null;
      }
      resetEpoch = obj.resetEpoch;
    }
    const hasCreatedAt = obj.cursorCreatedAt !== undefined && obj.cursorCreatedAt !== null;
    const hasOrderId = obj.cursorOrderId !== undefined && obj.cursorOrderId !== null;
    if (hasCreatedAt !== hasOrderId) {
      return null;
    }
    let cursorCreatedAt: string | undefined;
    let cursorOrderId: string | undefined;
    if (hasCreatedAt && hasOrderId) {
      if (
        typeof obj.cursorCreatedAt !== 'string' ||
        obj.cursorCreatedAt.trim().length === 0 ||
        Number.isNaN(Date.parse(obj.cursorCreatedAt)) ||
        typeof obj.cursorOrderId !== 'string' ||
        obj.cursorOrderId.trim().length === 0
      ) {
        return null;
      }
      cursorCreatedAt = obj.cursorCreatedAt;
      cursorOrderId = obj.cursorOrderId;
    }
    const lastPolledCount =
      typeof obj.lastPolledCount === 'number' &&
      Number.isFinite(obj.lastPolledCount) &&
      obj.lastPolledCount >= 0
        ? obj.lastPolledCount
        : 0;
    const updatedAt =
      typeof obj.updatedAt === 'string' && obj.updatedAt.trim().length > 0
        ? obj.updatedAt
        : new Date().toISOString();

    return this.sanitizeCheckpointForStorage({
      key: 'mystars_poll_cursor',
      cursorCreatedAt,
      cursorOrderId,
      cyclesCompleted: obj.cyclesCompleted,
      lastPolledCount,
      updatedAt,
      resetEpoch,
    });
  }

  private static comparePollCheckpoints(
    a: MyStarsPollCheckpoint,
    b: MyStarsPollCheckpoint,
  ): number {
    const aEpoch = this.normalizeResetEpoch(a);
    const bEpoch = this.normalizeResetEpoch(b);
    if (aEpoch !== bEpoch) {
      return aEpoch - bEpoch;
    }
    if (a.cyclesCompleted !== b.cyclesCompleted) {
      return a.cyclesCompleted - b.cyclesCompleted;
    }
    const aHasCursor = Boolean(a.cursorCreatedAt && a.cursorOrderId);
    const bHasCursor = Boolean(b.cursorCreatedAt && b.cursorOrderId);
    if (aHasCursor !== bHasCursor) {
      return aHasCursor ? 1 : -1;
    }
    if (!aHasCursor && !bHasCursor) {
      return 0;
    }
    const aCreated = a.cursorCreatedAt || '';
    const bCreated = b.cursorCreatedAt || '';
    if (aCreated !== bCreated) {
      return aCreated < bCreated ? -1 : 1;
    }
    const aId = a.cursorOrderId || '';
    const bId = b.cursorOrderId || '';
    if (aId !== bId) {
      return aId < bId ? -1 : 1;
    }
    return 0;
  }

  private static isRetryableTransactionConflictError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const errObj = error as { code?: unknown; message?: unknown };
    const code = errObj.code;
    if (code === 10 || code === 'ABORTED' || code === 'aborted') {
      return true;
    }
    const msg =
      typeof errObj.message === 'string' ? errObj.message.toLowerCase() : '';
    return (
      msg.includes('aborted') ||
      msg.includes('contention') ||
      msg.includes('transaction conflict') ||
      msg.includes('optimistic') ||
      msg.includes('concurrent modification')
    );
  }

  private static async runCheckpointTransactionWithRetry<T>(
    operation: 'load' | 'save',
    fn: Parameters<typeof firestoreRepo.runTransaction<T>>[0],
  ): Promise<T> {
    const maxAttempts = Math.max(1, this.checkpointTransactionMaxAttempts);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await firestoreRepo.runTransaction<T>(fn);
      } catch (error) {
        lastError = error;
        if (
          this.isRetryableTransactionConflictError(error) &&
          attempt < maxAttempts
        ) {
          const delayMs = Math.max(0, this.checkpointConflictRetryDelayMs) * attempt;
          console.warn(
            `[FulfillmentService:MyStarsPolling] Конфликт транзакции Firestore при ${operation === 'load' ? 'восстановлении' : 'записи'} checkpoint (попытка ${attempt}/${maxAttempts}), повтор...`,
          );
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private static updateLocalConfirmedCheckpoint(
    effective: MyStarsPollCheckpoint | null,
    options?: { force?: boolean },
  ): void {
    if (!effective) {
      if (options?.force || !this.lastConfirmedPollCheckpoint) {
        this.lastConfirmedPollCheckpoint = null;
      }
      return;
    }
    if (
      options?.force ||
      !this.lastConfirmedPollCheckpoint ||
      this.comparePollCheckpoints(this.lastConfirmedPollCheckpoint, effective) <= 0
    ) {
      this.lastConfirmedPollCheckpoint = { ...effective };
    }
    if (
      options?.force ||
      !this.pendingUnsavedCheckpoint ||
      this.comparePollCheckpoints(this.pendingUnsavedCheckpoint, effective) <= 0
    ) {
      this.pendingUnsavedCheckpoint = null;
    }
  }

  public static async loadMyStarsPollCheckpoint(): Promise<MyStarsPollCheckpoint | null> {
    try {
      const doc = await firestoreRepo.getDoc<MyStarsPollCheckpoint>(
        'settings',
        'mystars_poll_cursor',
      );
      if (doc === null || doc === undefined) {
        this.lastConfirmedPollCheckpoint = null;
        this.clearCheckpointDegradedState();
        return null;
      }
      const valid = this.parseValidPollCheckpoint(doc);
      if (!valid) {
        console.warn(
          '[FulfillmentService:MyStarsPolling] Обнаружен повреждённый документ checkpoint settings/mystars_poll_cursor — запускается атомарное восстановление в транзакции.',
        );
        const repairResult = await this.runCheckpointTransactionWithRetry<{
          repaired: boolean;
          checkpoint: MyStarsPollCheckpoint | null;
          repairedDoc?: MyStarsPollCheckpoint;
        }>('load', async (tx) => {
          const currentRaw = await tx.get<MyStarsPollCheckpoint>(
            'settings',
            'mystars_poll_cursor',
          );
          if (currentRaw === null || currentRaw === undefined) {
            return { repaired: false, checkpoint: null };
          }
          const currentValid = this.parseValidPollCheckpoint(currentRaw);
          if (currentValid) {
            // Another worker already repaired or advanced the checkpoint — never overwrite it!
            return { repaired: false, checkpoint: currentValid };
          }
          const preservedEpoch = this.extractRawResetEpoch(currentRaw);
          const sanitized = this.sanitizeCheckpointForStorage({
            key: 'mystars_poll_cursor',
            cyclesCompleted: 0,
            lastPolledCount: 0,
            updatedAt: new Date().toISOString(),
            resetEpoch: preservedEpoch,
          });
          tx.set<MyStarsPollCheckpoint>(
            'settings',
            'mystars_poll_cursor',
            sanitized,
          );
          return { repaired: true, checkpoint: null, repairedDoc: sanitized };
        });

        if (repairResult.repaired && repairResult.repairedDoc) {
          this.updateLocalConfirmedCheckpoint(repairResult.repairedDoc, { force: true });
          this.clearCheckpointDegradedState();
          return null;
        }

        if (repairResult.checkpoint) {
          this.updateLocalConfirmedCheckpoint(repairResult.checkpoint);
          this.clearCheckpointDegradedState();
          return repairResult.checkpoint;
        }

        this.lastConfirmedPollCheckpoint = null;
        this.clearCheckpointDegradedState();
        return null;
      }
      this.updateLocalConfirmedCheckpoint(valid);
      this.clearCheckpointDegradedState();
      return valid;
    } catch (error) {
      throw this.recordCheckpointFailure('load', error);
    }
  }

  public static async saveMyStarsPollCheckpoint(
    checkpoint: MyStarsPollCheckpoint,
  ): Promise<MyStarsPollCheckpoint> {
    try {
      const normalizedIncoming = this.parseValidPollCheckpoint(checkpoint);
      if (!normalizedIncoming) {
        throw new Error('Попытка сохранить некорректный объект MyStarsPollCheckpoint.');
      }

      const txOutcome = await this.runCheckpointTransactionWithRetry<{
        written: boolean;
        effective: MyStarsPollCheckpoint;
      }>('save', async (tx) => {
        const remoteRaw = await tx.get<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
        );
        const remoteValid = this.parseValidPollCheckpoint(remoteRaw);

        if (
          remoteValid &&
          this.comparePollCheckpoints(remoteValid, normalizedIncoming) > 0
        ) {
          return { written: false, effective: remoteValid };
        }

        const toWrite = this.sanitizeCheckpointForStorage(normalizedIncoming);
        tx.set<MyStarsPollCheckpoint>(
          'settings',
          'mystars_poll_cursor',
          toWrite,
        );
        return { written: true, effective: toWrite };
      });

      if (!txOutcome.written) {
        console.info(
          `[FulfillmentService:MyStarsPolling] Атомарно пропущена запись устаревшего checkpoint (epoch=${this.normalizeResetEpoch(normalizedIncoming)}, cycle=${normalizedIncoming.cyclesCompleted}, cursor=${normalizedIncoming.cursorOrderId ?? 'none'}): в Firestore уже сохранён более новый (epoch=${this.normalizeResetEpoch(txOutcome.effective)}, cycle=${txOutcome.effective.cyclesCompleted}, cursor=${txOutcome.effective.cursorOrderId ?? 'none'}).`,
        );
      }

      this.updateLocalConfirmedCheckpoint(txOutcome.effective);
      this.clearCheckpointDegradedState();
      return txOutcome.effective;
    } catch (error) {
      throw this.recordCheckpointFailure('save', error);
    }
  }

  public static async resetMyStarsPollCheckpoint(): Promise<MyStarsPollCheckpoint> {
    this.pendingUnsavedCheckpoint = null;
    this.checkpointRetryAfterMs = 0;
    try {
      const resetDoc = await this.runCheckpointTransactionWithRetry<MyStarsPollCheckpoint>(
        'save',
        async (tx) => {
          const remoteRaw = await tx.get<MyStarsPollCheckpoint>(
            'settings',
            'mystars_poll_cursor',
          );
          const remoteValid = this.parseValidPollCheckpoint(remoteRaw);
          const remoteEpoch = remoteValid
            ? this.normalizeResetEpoch(remoteValid)
            : this.extractRawResetEpoch(remoteRaw);
          const localEpoch = this.lastConfirmedPollCheckpoint
            ? this.normalizeResetEpoch(this.lastConfirmedPollCheckpoint)
            : 0;
          const nextResetEpoch = Math.max(remoteEpoch, localEpoch) + 1;
          const nextCheckpoint = this.sanitizeCheckpointForStorage({
            key: 'mystars_poll_cursor',
            cyclesCompleted: 0,
            lastPolledCount: 0,
            updatedAt: new Date().toISOString(),
            resetEpoch: nextResetEpoch,
          });
          tx.set<MyStarsPollCheckpoint>(
            'settings',
            'mystars_poll_cursor',
            nextCheckpoint,
          );
          return nextCheckpoint;
        },
      );
      this.updateLocalConfirmedCheckpoint(resetDoc, { force: true });
      this.clearCheckpointDegradedState();
      return resetDoc;
    } catch (error) {
      throw this.recordCheckpointFailure('save', error);
    }
  }

  public static getMyStarsPollingStatus(): {
    mode: 'polling';
    workerActive: boolean;
    cooldownActive: boolean;
    cooldownUntilIso: string | null;
    inFlightOrdersCount: number;
    checkpointDegraded: boolean;
    checkpointLastError: string | null;
    checkpointConsecutiveFailures: number;
    hasPendingUnsavedCheckpoint: boolean;
    lastConfirmedCursorOrderId: string | null;
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
      checkpointDegraded: this.checkpointDegraded,
      checkpointLastError: this.checkpointLastError,
      checkpointConsecutiveFailures: this.checkpointConsecutiveFailures,
      hasPendingUnsavedCheckpoint: this.pendingUnsavedCheckpoint !== null,
      lastConfirmedCursorOrderId: this.lastConfirmedPollCheckpoint?.cursorOrderId ?? null,
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
    const cfg = getEnvConfig();
    if (
      !cfg.invalidFulfillmentProvider &&
      cfg.fulfillmentProvider === 'mystars' &&
      myStarsClient.isConfigured()
    ) {
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
   * Sends admin notification using a resilient state machine
   * (`pending` -> `sending` -> `sent` | `partial_sent` | `no_recipients` | `delivery_uncertain`)
   * with atomic claim, event ID, lease protection, and per-recipient delivery tracking.
   *
   * Honesty contract:
   * - If `ADMIN_IDS` / `OWNER_TELEGRAM_ID` has zero recipients, records explicit `no_recipients`
   *   and NEVER sets `status = 'sent'` or `adminNotifiedAt`.
   * - `status = 'sent'` and `adminNotifiedAt` are set ONLY when EVERY configured admin has confirmed
   *   delivery. Partial delivery sets `status = 'partial_sent'` (leaving `adminNotifiedAt` unset)
   *   and persists per-admin `recipientDeliveries` so retries deliver ONLY to undelivered admins
   *   without spamming already-notified recipients.
   * - Between Telegram Bot API and Firestore there is no distributed transaction, so absolute
   *   exactly-once delivery across process crashes is NOT guaranteed. If a process crashes while in
   *   `sending` and `leaseUntil` expires, transitions to explicit `delivery_uncertain` (NOT `sent`
   *   and WITHOUT setting `adminNotifiedAt`), preserving already-confirmed `recipientDeliveries`.
   * - Even `forceResend=true` respects an active `sending` lease to prevent parallel resend races.
   */
  public static async ensureAdminNotified(
    order: Order,
    bot: Telegraf | null | undefined,
    forceResend = false,
    leaseOwnerOverride?: string,
  ): Promise<Order> {
    if (
      !forceResend &&
      (order.adminNotifiedAt ||
        order.adminNotificationState?.status === 'sent' ||
        order.adminNotificationState?.status === 'delivery_uncertain')
    ) {
      return order;
    }
    if (!bot) {
      return order;
    }

    const eventId =
      order.adminNotificationState?.eventId ||
      `evt_admin_${order.orderId}_${order.fulfillmentStatus}`;
    const operationId = `op_admin_notify_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const leaseOwner = leaseOwnerOverride || this.workerInstanceId;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const uniqueAdminIds = Array.from(new Set(getEnvConfig().adminIds));
    if (uniqueAdminIds.length === 0) {
      if (
        !forceResend &&
        order.adminNotificationState?.status === 'no_recipients' &&
        !order.adminNotifiedAt
      ) {
        return order;
      }

      const noRecipientsOrder = await firestoreRepo.runTransaction<Order>(async (tx) => {
        const current = (await tx.get<Order>('orders', order.orderId)) || order;
        const state = current.adminNotificationState;
        const leaseUntilMs = this.timestampToMillis(state?.leaseUntil);

        if (state?.status === 'sending' && leaseUntilMs > nowMs) {
          return current;
        }
        if (
          current.adminNotifiedAt ||
          state?.status === 'sent' ||
          state?.status === 'delivery_uncertain'
        ) {
          return current;
        }
        if (state?.status === 'sending') {
          const uncertainState: NotificationDeliveryState = {
            ...state,
            status: 'delivery_uncertain',
            uncertainSince: state.uncertainSince || nowIso,
            deliveryUncertainAfterCrash: true,
          };
          const uncertainOrder: Order = {
            ...current,
            adminNotificationState: uncertainState,
            updatedAt: nowIso,
          };
          tx.set<Order>('orders', uncertainOrder.orderId, uncertainOrder);
          return uncertainOrder;
        }

        const noRecipientsState: NotificationDeliveryState = {
          ...state,
          status: 'no_recipients',
          eventId: state?.eventId || eventId,
          operationId,
          leaseOwner,
          leaseUntil: undefined,
          attemptCount: state?.attemptCount ?? 0,
          sentAt: undefined,
          deliveryUncertainAfterCrash: false,
          lastError:
            'Не настроены получатели ADMIN_IDS / OWNER_TELEGRAM_ID — уведомление не отправлялось.',
        };
        const updated: Order = {
          ...current,
          adminNotifiedAt: undefined,
          adminNotificationState: noRecipientsState,
          updatedAt: nowIso,
        };
        tx.set<Order>('orders', updated.orderId, updated);
        return updated;
      });

      console.warn(
        `[FulfillmentService] ADMIN_IDS / OWNER_TELEGRAM_ID не заданы — уведомление для заказа #${order.orderId} не отправлено (status=no_recipients).`,
      );
      return noRecipientsOrder;
    }

    type AdminNotifyClaim =
      | { action: 'already_sent'; order: Order }
      | { action: 'delivery_uncertain'; order: Order }
      | { action: 'in_flight'; order: Order }
      | { action: 'recovered_uncertain'; order: Order }
      | {
          action: 'claimed';
          order: Order;
          targetAdminIds: number[];
          existingDeliveries: Record<string, AdminRecipientDeliveryRecord>;
          wasUncertainBeforeClaim: boolean;
        };

    const claim = await firestoreRepo.runTransaction<AdminNotifyClaim>(async (tx) => {
      const current = (await tx.get<Order>('orders', order.orderId)) || order;
      const state = current.adminNotificationState;
      const leaseUntilMs = this.timestampToMillis(state?.leaseUntil);

      // Protect BOTH normal send and forceResend against concurrent in-flight execution
      if (state?.status === 'sending' && leaseUntilMs > nowMs) {
        return { action: 'in_flight', order: current };
      }

      const existingDeliveries: Record<string, AdminRecipientDeliveryRecord> =
        state?.recipientDeliveries
          ? Object.fromEntries(
              Object.entries(state.recipientDeliveries).map(([k, v]) => [k, { ...v }]),
            )
          : {};

      if (!forceResend) {
        if (current.adminNotifiedAt || state?.status === 'sent') {
          return { action: 'already_sent', order: current };
        }
        if (state?.status === 'delivery_uncertain') {
          return { action: 'delivery_uncertain', order: current };
        }
        if (state?.status === 'sending') {
          // Previous worker crashed during `sending` and its lease expired:
          // Mark explicit `delivery_uncertain` (NOT `sent`) preserving eventId/operationId/leaseOwner/leaseUntil/attemptCount
          // and preserving any already-confirmed per-recipient deliveries.
          const uncertainDeliveries: Record<string, AdminRecipientDeliveryRecord> = {
            ...existingDeliveries,
          };
          for (const adminId of uniqueAdminIds) {
            const key = String(adminId);
            const existing = uncertainDeliveries[key];
            if (!existing) {
              uncertainDeliveries[key] = {
                adminTelegramId: adminId,
                status: 'delivery_uncertain',
                attemptCount: state.attemptCount ?? 1,
                lastAttemptAt: nowIso,
                operationId: state.operationId,
              };
            } else if (existing.status !== 'sent') {
              uncertainDeliveries[key] = {
                ...existing,
                status: 'delivery_uncertain',
              };
            }
          }

          const uncertainState: NotificationDeliveryState = {
            ...state,
            status: 'delivery_uncertain',
            uncertainSince: state.uncertainSince || nowIso,
            deliveryUncertainAfterCrash: true,
            recipientDeliveries: uncertainDeliveries,
          };
          const uncertainOrder: Order = {
            ...current,
            adminNotificationState: uncertainState,
            updatedAt: nowIso,
          };
          tx.set<Order>('orders', uncertainOrder.orderId, uncertainOrder);
          return { action: 'recovered_uncertain', order: uncertainOrder };
        }
      }

      // Compute which admins still need delivery:
      // - For partial_sent / pending / no_recipients / delivery_uncertain, NEVER re-spam admins already marked 'sent'.
      // - Only when forceResend is explicitly invoked on an already-fully-sent order do we resend to all admins.
      const isExplicitResendOfCompletedOrder =
        forceResend &&
        (state?.status === 'sent' ||
          (Boolean(current.adminNotifiedAt) && Object.keys(existingDeliveries).length === 0));

      const undeliveredAdminIds = uniqueAdminIds.filter(
        (id) => existingDeliveries[String(id)]?.status !== 'sent',
      );

      if (!isExplicitResendOfCompletedOrder && undeliveredAdminIds.length === 0) {
        if (!forceResend) {
          // Every currently configured admin already has confirmed delivery -> reconcile to sent without re-sending
          const sentState: NotificationDeliveryState = {
            ...state,
            status: 'sent',
            eventId: state?.eventId || eventId,
            operationId: state?.operationId || operationId,
            leaseOwner: state?.leaseOwner || leaseOwner,
            attemptCount: state?.attemptCount ?? 1,
            sentAt: state?.sentAt || nowIso,
            deliveryUncertainAfterCrash: false,
            lastError: undefined,
            recipientDeliveries: existingDeliveries,
          };
          const reconciledOrder: Order = {
            ...current,
            adminNotifiedAt: current.adminNotifiedAt || nowIso,
            adminNotificationState: sentState,
            updatedAt: nowIso,
          };
          tx.set<Order>('orders', reconciledOrder.orderId, reconciledOrder);
          return { action: 'already_sent', order: reconciledOrder };
        }
      }

      const targetAdminIds =
        isExplicitResendOfCompletedOrder || undeliveredAdminIds.length === 0
          ? uniqueAdminIds
          : undeliveredAdminIds;

      const wasUncertainBeforeClaim = state?.status === 'delivery_uncertain';
      const claimingState: NotificationDeliveryState = {
        ...state,
        status: 'sending',
        eventId: state?.eventId || eventId,
        operationId,
        leaseOwner,
        leaseUntil: Timestamp.fromMillis(nowMs + this.notificationLeaseTtlMs),
        attemptCount: (state?.attemptCount ?? 0) + 1,
        deliveryUncertainAfterCrash: false,
        recipientDeliveries: existingDeliveries,
      };
      const claimedOrder: Order = {
        ...current,
        adminNotificationState: claimingState,
        updatedAt: nowIso,
      };
      tx.set<Order>('orders', claimedOrder.orderId, claimedOrder);
      return {
        action: 'claimed',
        order: claimedOrder,
        targetAdminIds,
        existingDeliveries,
        wasUncertainBeforeClaim,
      };
    });

    if (claim.action !== 'claimed') {
      if (claim.action === 'recovered_uncertain') {
        console.warn(
          `[FulfillmentService] Переведено состояние adminNotificationState в delivery_uncertain после истечения sending-lease для заказа #${order.orderId} (автоповтор заблокирован, требуется проверка админом).`,
        );
      }
      return claim.order;
    }

    const updatedDeliveries: Record<string, AdminRecipientDeliveryRecord> = {
      ...claim.existingDeliveries,
    };

    for (const adminId of claim.targetAdminIds) {
      const key = String(adminId);
      const prev = updatedDeliveries[key];
      const attemptIso = new Date().toISOString();
      const sendResult = await this.sendTelegramMessageWithResult(
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
      if (sendResult.ok) {
        updatedDeliveries[key] = {
          adminTelegramId: adminId,
          status: 'sent',
          attemptCount: (prev?.attemptCount ?? 0) + 1,
          sentAt: attemptIso,
          lastAttemptAt: attemptIso,
          lastError: undefined,
          operationId,
        };
      } else if (sendResult.ambiguous) {
        updatedDeliveries[key] = {
          adminTelegramId: adminId,
          status: 'delivery_uncertain',
          attemptCount: (prev?.attemptCount ?? 0) + 1,
          sentAt: prev?.sentAt,
          lastAttemptAt: attemptIso,
          lastError:
            sendResult.error ||
            'Неопределённый результат доставки в Telegram (таймаут/обрыв сети)',
          operationId,
        };
      } else {
        updatedDeliveries[key] = {
          adminTelegramId: adminId,
          status: prev?.status === 'delivery_uncertain' ? 'delivery_uncertain' : 'failed',
          attemptCount: (prev?.attemptCount ?? 0) + 1,
          sentAt: prev?.sentAt,
          lastAttemptAt: attemptIso,
          lastError: sendResult.error || 'Ошибка отправки в Telegram',
          operationId,
        };
      }
    }

    const finIso = new Date().toISOString();
    return firestoreRepo.runTransaction<Order>(async (tx) => {
      const latest = (await tx.get<Order>('orders', order.orderId)) || claim.order;
      const latestState = latest.adminNotificationState;
      // Strict stale-worker fencing: never overwrite if another worker/admin already
      // moved state out of `sending`, took over with a newer operationId, or owns the lease.
      if (
        !latestState ||
        latestState.status !== 'sending' ||
        latestState.operationId !== operationId ||
        latestState.leaseOwner !== leaseOwner
      ) {
        return latest;
      }

      const mergedDeliveries: Record<string, AdminRecipientDeliveryRecord> = {
        ...(latestState.recipientDeliveries || {}),
        ...updatedDeliveries,
      };
      const deliveredIds = uniqueAdminIds.filter(
        (id) => mergedDeliveries[String(id)]?.status === 'sent',
      );
      const undeliveredIds = uniqueAdminIds.filter(
        (id) => mergedDeliveries[String(id)]?.status !== 'sent',
      );
      const uncertainIds = undeliveredIds.filter(
        (id) => mergedDeliveries[String(id)]?.status === 'delivery_uncertain',
      );

      if (undeliveredIds.length === 0) {
        const sentState: NotificationDeliveryState = {
          status: 'sent',
          eventId: latestState.eventId || eventId,
          operationId,
          leaseOwner,
          leaseUntil: latestState.leaseUntil,
          attemptCount: latestState.attemptCount ?? 1,
          sentAt: finIso,
          deliveryUncertainAfterCrash: false,
          lastError: undefined,
          recipientDeliveries: mergedDeliveries,
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

      if (uncertainIds.length > 0 || claim.wasUncertainBeforeClaim) {
        const uncertainState: NotificationDeliveryState = {
          status: 'delivery_uncertain',
          eventId: latestState.eventId || eventId,
          operationId,
          leaseOwner,
          leaseUntil: undefined,
          attemptCount: latestState.attemptCount ?? 1,
          sentAt: undefined,
          uncertainSince: latestState.uncertainSince || finIso,
          deliveryUncertainAfterCrash: false,
          lastError:
            uncertainIds.length > 0
              ? `Неопределённый результат доставки администраторам (${uncertainIds.join(', ')}); автоповтор заблокирован во избежание дублей.`
              : `Повторная ручная отправка не удалась; сохраняется delivery_uncertain для (${undeliveredIds.join(', ')}).`,
          recipientDeliveries: mergedDeliveries,
        };
        const updated: Order = {
          ...latest,
          adminNotificationState: uncertainState,
          updatedAt: finIso,
        };
        tx.set<Order>('orders', updated.orderId, updated);
        return updated;
      }

      if (deliveredIds.length > 0) {
        const partialState: NotificationDeliveryState = {
          status: 'partial_sent',
          eventId: latestState.eventId || eventId,
          operationId,
          leaseOwner,
          leaseUntil: undefined,
          attemptCount: latestState.attemptCount ?? 1,
          sentAt: undefined,
          deliveryUncertainAfterCrash: false,
          lastError: `Частичная доставка администраторам (${deliveredIds.length}/${uniqueAdminIds.length}); не доставлено: ${undeliveredIds.join(', ')}`,
          recipientDeliveries: mergedDeliveries,
        };
        const updated: Order = {
          ...latest,
          adminNotificationState: partialState,
          updatedAt: finIso,
        };
        tx.set<Order>('orders', updated.orderId, updated);
        return updated;
      }

      const pendingState: NotificationDeliveryState = {
        status: 'pending',
        eventId: latestState.eventId || eventId,
        operationId,
        leaseOwner,
        leaseUntil: undefined,
        attemptCount: latestState.attemptCount ?? 1,
        sentAt: undefined,
        deliveryUncertainAfterCrash: false,
        lastError: `Не удалось доставить уведомление ни одному администратору (${undeliveredIds.join(', ')})`,
        recipientDeliveries: mergedDeliveries,
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
   * Sends buyer completion notification using a resilient state machine
   * (`pending` -> `sending` -> `sent` | `delivery_uncertain`)
   * with atomic claim, event ID, and lease protection.
   *
   * Honesty contract: never claims absolute `exactly-once` delivery across process crashes
   * after Telegram accepts an HTTP request. If a process crashes while in `sending` and
   * `leaseUntil` expires, transitions to explicit `delivery_uncertain` (NOT `sent` and WITHOUT
   * setting `buyerNotifiedAt`) so automatic loops never spam duplicates while admins can inspect
   * and trigger a controlled resend or acknowledge delivery.
   * Even `forceResend=true` respects an active `sending` lease to prevent parallel resend races.
   */
  public static async ensureBuyerNotified(
    order: Order,
    bot: Telegraf | null | undefined,
    forceResend = false,
    leaseOwnerOverride?: string,
  ): Promise<Order> {
    if (
      !forceResend &&
      (order.buyerNotifiedAt ||
        order.buyerNotificationState?.status === 'sent' ||
        order.buyerNotificationState?.status === 'delivery_uncertain')
    ) {
      return order;
    }
    if (!bot) {
      return order;
    }

    const eventId =
      order.buyerNotificationState?.eventId ||
      `evt_buyer_completed_${order.orderId}`;
    const operationId = `op_buyer_notify_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const leaseOwner = leaseOwnerOverride || this.workerInstanceId;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    type BuyerNotifyClaim =
      | { action: 'already_sent'; order: Order }
      | { action: 'delivery_uncertain'; order: Order }
      | { action: 'in_flight'; order: Order }
      | { action: 'recovered_uncertain'; order: Order }
      | { action: 'claimed'; order: Order; wasUncertainBeforeClaim: boolean };

    const claim = await firestoreRepo.runTransaction<BuyerNotifyClaim>(async (tx) => {
      const current = (await tx.get<Order>('orders', order.orderId)) || order;
      const state = current.buyerNotificationState;
      const leaseUntilMs = this.timestampToMillis(state?.leaseUntil);

      // Protect BOTH normal send and forceResend against concurrent in-flight execution
      if (state?.status === 'sending' && leaseUntilMs > nowMs) {
        return { action: 'in_flight', order: current };
      }

      if (!forceResend) {
        if (current.buyerNotifiedAt || state?.status === 'sent') {
          return { action: 'already_sent', order: current };
        }
        if (state?.status === 'delivery_uncertain') {
          return { action: 'delivery_uncertain', order: current };
        }
        if (state?.status === 'sending') {
          // Previous worker crashed during `sending` and its lease expired:
          // Transition to explicit `delivery_uncertain` (NOT `sent`) so buyer is never auto-spammed
          // and delivery is NOT falsely marked confirmed.
          const uncertainState: NotificationDeliveryState = {
            ...state,
            status: 'delivery_uncertain',
            uncertainSince: state.uncertainSince || nowIso,
            deliveryUncertainAfterCrash: true,
          };
          const uncertainOrder: Order = {
            ...current,
            buyerNotificationState: uncertainState,
            updatedAt: nowIso,
          };
          tx.set<Order>('orders', uncertainOrder.orderId, uncertainOrder);
          return { action: 'recovered_uncertain', order: uncertainOrder };
        }
      }

      const wasUncertainBeforeClaim = state?.status === 'delivery_uncertain';
      const claimingState: NotificationDeliveryState = {
        status: 'sending',
        eventId: state?.eventId || eventId,
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
      return {
        action: 'claimed',
        order: claimedOrder,
        wasUncertainBeforeClaim,
      };
    });

    if (claim.action !== 'claimed') {
      if (claim.action === 'recovered_uncertain') {
        console.warn(
          `[FulfillmentService] Переведено состояние buyerNotificationState в delivery_uncertain после истечения sending-lease для заказа #${order.orderId} (автоповтор заблокирован, требуется проверка админом).`,
        );
      }
      return claim.order;
    }

    const sendResult = await this.sendTelegramMessageWithResult(
      bot,
      claim.order.userTelegramId,
      formatOrderCompletedUserNotice(claim.order),
      { parse_mode: 'HTML' },
    );

    const finIso = new Date().toISOString();
    return firestoreRepo.runTransaction<Order>(async (tx) => {
      const latest = (await tx.get<Order>('orders', order.orderId)) || claim.order;
      const latestState = latest.buyerNotificationState;
      // Strict stale-worker fencing: never overwrite if another worker/admin already
      // moved state out of `sending`, took over with a newer operationId, or owns the lease.
      if (
        !latestState ||
        latestState.status !== 'sending' ||
        latestState.operationId !== operationId ||
        latestState.leaseOwner !== leaseOwner
      ) {
        return latest;
      }

      if (sendResult.ok) {
        const sentState: NotificationDeliveryState = {
          status: 'sent',
          eventId: latestState.eventId || eventId,
          operationId,
          leaseOwner,
          leaseUntil: latestState.leaseUntil,
          attemptCount: latestState.attemptCount ?? 1,
          sentAt: finIso,
          deliveryUncertainAfterCrash: false,
          lastError: undefined,
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

      if (sendResult.ambiguous || claim.wasUncertainBeforeClaim) {
        const uncertainState: NotificationDeliveryState = {
          status: 'delivery_uncertain',
          eventId: latestState.eventId || eventId,
          operationId,
          leaseOwner,
          leaseUntil: undefined,
          attemptCount: latestState.attemptCount ?? 1,
          sentAt: undefined,
          uncertainSince: latestState.uncertainSince || finIso,
          deliveryUncertainAfterCrash: false,
          lastError:
            sendResult.error ||
            'Неопределённый результат доставки покупателю (таймаут/обрыв сети Telegram API)',
        };
        const updated: Order = {
          ...latest,
          buyerNotificationState: uncertainState,
          updatedAt: finIso,
        };
        tx.set<Order>('orders', updated.orderId, updated);
        return updated;
      }

      const pendingState: NotificationDeliveryState = {
        status: 'pending',
        eventId: latestState.eventId || eventId,
        operationId,
        leaseOwner,
        leaseUntil: undefined,
        attemptCount: latestState.attemptCount ?? 1,
        sentAt: undefined,
        deliveryUncertainAfterCrash: false,
        lastError:
          sendResult.error ||
          'Не удалось доставить уведомление покупателю в Telegram',
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

  /**
   * Controlled admin force-resend for buyer and/or admin notifications.
   * Respects active `sending` leases so concurrent clicks or workers cannot duplicate messages.
   */
  public static async forceResendOrderNotification(params: {
    orderId: string;
    target: 'buyer' | 'admin' | 'both';
    bot: Telegraf;
    adminTelegramId?: number;
  }): Promise<{
    order: Order;
    sentAdmin: boolean;
    sentBuyer: boolean;
    skippedInFlight: boolean;
  }> {
    let order = await OrderService.getOrderById(params.orderId);
    if (!order) {
      throw new Error(`Заказ #${params.orderId} не найден.`);
    }

    let sentAdmin = false;
    let sentBuyer = false;
    let skippedInFlight = false;

    if (params.target === 'admin' || params.target === 'both') {
      const configuredAdminCount = new Set(getEnvConfig().adminIds).size;
      const next = await this.ensureAdminNotified(order, params.bot, true);
      if (next.adminNotificationState?.status === 'sending') {
        skippedInFlight = true;
      } else {
        sentAdmin =
          configuredAdminCount > 0 && next.adminNotificationState?.status === 'sent';
      }
      order = next;
    }

    if (
      (params.target === 'buyer' || params.target === 'both') &&
      order.fulfillmentStatus === 'completed'
    ) {
      const next = await this.ensureBuyerNotified(order, params.bot, true);
      if (next.buyerNotificationState?.status === 'sending') {
        skippedInFlight = true;
      } else {
        sentBuyer = next.buyerNotificationState?.status === 'sent';
      }
      order = next;
    }

    return { order, sentAdmin, sentBuyer, skippedInFlight };
  }

  /**
   * Admin inspection procedure: marks a `delivery_uncertain` notification as verified/confirmed
   * without sending a duplicate message to Telegram.
   */
  public static async acknowledgeUncertainNotification(params: {
    orderId: string;
    target: 'buyer' | 'admin' | 'both';
    adminTelegramId: number;
  }): Promise<Order> {
    const nowIso = new Date().toISOString();
    return firestoreRepo.runTransaction<Order>(async (tx) => {
      const current = await tx.get<Order>('orders', params.orderId);
      if (!current) {
        throw new Error(`Заказ #${params.orderId} не найден.`);
      }

      const ackOpId = `op_admin_ack_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const updated: Order = { ...current, updatedAt: nowIso };
      if (
        (params.target === 'buyer' || params.target === 'both') &&
        current.buyerNotificationState?.status === 'delivery_uncertain'
      ) {
        updated.buyerNotifiedAt = current.buyerNotifiedAt || nowIso;
        updated.buyerNotificationState = {
          ...current.buyerNotificationState,
          status: 'sent',
          operationId: ackOpId,
          sentAt: current.buyerNotificationState.sentAt || nowIso,
          acknowledgedByAdminId: params.adminTelegramId,
          acknowledgedAt: nowIso,
        };
      }
      if (
        (params.target === 'admin' || params.target === 'both') &&
        current.adminNotificationState?.status === 'delivery_uncertain'
      ) {
        updated.adminNotifiedAt = current.adminNotifiedAt || nowIso;
        updated.adminNotificationState = {
          ...current.adminNotificationState,
          status: 'sent',
          operationId: ackOpId,
          sentAt: current.adminNotificationState.sentAt || nowIso,
          acknowledgedByAdminId: params.adminTelegramId,
          acknowledgedAt: nowIso,
        };
      }

      tx.set<Order>('orders', updated.orderId, updated);
      return updated;
    });
  }

  public static async retryOrderNotifications(
    orderId: string,
    bot: Telegraf,
  ): Promise<{ order: Order; adminNotified: boolean; buyerNotified: boolean }> {
    const res = await this.forceResendOrderNotification({
      orderId,
      target: 'both',
      bot,
    });

    return {
      order: res.order,
      adminNotified: Boolean(res.order.adminNotifiedAt),
      buyerNotified: Boolean(res.order.buyerNotifiedAt),
    };
  }

  /**
   * Classifies whether a Telegram sendMessage failure has ambiguous delivery semantics
   * (request may have been accepted and delivered by Telegram before timeout / socket drop).
   * Ambiguous errors MUST NOT be auto-retried and MUST transition to `delivery_uncertain`.
   */
  private static isAmbiguousTelegramDeliveryError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      const text = String(error ?? '').toLowerCase();
      return (
        text.includes('timeout') ||
        text.includes('timed out') ||
        text.includes('socket hang up') ||
        text.includes('econnreset') ||
        text.includes('504')
      );
    }

    const errRecord = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      response?: { error_code?: unknown };
      cause?: { code?: unknown; name?: unknown; message?: unknown };
    };

    const httpCode = Number(errRecord.response?.error_code);
    if (httpCode === 504) {
      return true;
    }
    // Definite Telegram Bot API rejections (4xx, 500, 502, 503) are non-ambiguous
    if (Number.isFinite(httpCode) && httpCode >= 400 && httpCode !== 504) {
      return false;
    }

    const ambiguousCodes = new Set([
      'ETIMEDOUT',
      'ESOCKETTIMEDOUT',
      'ECONNRESET',
      'EPIPE',
      'ECONNABORTED',
      'UND_ERR_SOCKET',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_ABORTED',
      'ABORT_ERR',
    ]);
    const code = typeof errRecord.code === 'string' ? errRecord.code.toUpperCase() : '';
    const causeCode =
      typeof errRecord.cause?.code === 'string' ? errRecord.cause.code.toUpperCase() : '';
    if (ambiguousCodes.has(code) || ambiguousCodes.has(causeCode)) {
      return true;
    }

    const name = typeof errRecord.name === 'string' ? errRecord.name : '';
    const causeName = typeof errRecord.cause?.name === 'string' ? errRecord.cause.name : '';
    if (
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      causeName === 'AbortError' ||
      causeName === 'TimeoutError'
    ) {
      return true;
    }

    const msg = `${String(errRecord.message ?? '')} ${String(errRecord.cause?.message ?? '')}`.toLowerCase();
    return (
      msg.includes('etimedout') ||
      msg.includes('esockettimedout') ||
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('socket hang up') ||
      msg.includes('econnreset') ||
      msg.includes('epipe') ||
      msg.includes('premature close') ||
      msg.includes('request aborted') ||
      msg.includes('504 gateway')
    );
  }

  private static async sendTelegramMessageWithResult(
    bot: Telegraf,
    chatId: number | string,
    htmlText: string,
    extra: Record<string, unknown>,
    maxAttempts = 2,
  ): Promise<{ ok: boolean; error?: string; ambiguous?: boolean }> {
    let lastError: unknown;
    let ambiguous = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await bot.telegram.sendMessage(chatId, htmlText, extra);
        return { ok: true };
      } catch (error) {
        lastError = error;
        if (this.isAmbiguousTelegramDeliveryError(error)) {
          // Stop immediately: Telegram may already have delivered the message before timeout/drop.
          ambiguous = true;
          break;
        }
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
        }
      }
    }

    const errMsg = redactSecretsFromText(
      lastError instanceof Error ? lastError.message : String(lastError),
    );
    console.warn(
      `[FulfillmentService] Не удалось отправить уведомление в чат ${chatId}${ambiguous ? ' [ambiguous/delivery_uncertain]' : ''}:`,
      errMsg,
    );
    return { ok: false, ambiguous, error: errMsg.slice(0, 300) };
  }

  private static async sendTelegramMessageWithRetry(
    bot: Telegraf,
    chatId: number | string,
    htmlText: string,
    extra: Record<string, unknown>,
    maxAttempts = 2,
  ): Promise<boolean> {
    const res = await this.sendTelegramMessageWithResult(
      bot,
      chatId,
      htmlText,
      extra,
      maxAttempts,
    );
    return res.ok;
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
      | {
          action: 'claimed';
          order: Order;
          attempt: number;
          hadLockedIdempotencyKey: boolean;
          wasAmbiguousBeforeClaim: boolean;
        };

    if (this.retainedProviderResults.has(orderInput.orderId)) {
      try {
        const flushed = await this.flushRetainedProviderResultForOrder(
          orderInput.orderId,
          bot,
        );
        if (flushed) {
          Object.assign(orderInput, flushed);
          return flushed;
        }
      } catch {
        // Proceed with standard recovery / claim flow if flush could not complete
      }
    }

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

      if (
        current.fulfillmentStatus === 'cancelled' ||
        current.fulfillmentStatus === 'refunded'
      ) {
        throw new Error(
          `Невозможно запустить выдачу заказа #${current.orderId}: статус выдачи уже "${current.fulfillmentStatus}".`,
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
        if (current.externalExecutionReference || current.mystarsOrderId) {
          if (!current.adminNotifiedAt) {
            return { action: 'needs_admin_notification_only', order: current };
          }
          return { action: 'already_processing', order: current };
        }

        // If an admin manually moved a quarantined order into 'processing' (needsManualReconciliation && !mystarsCreateInFlight),
        // do not hijack it with automatic MyStars calls.
        if (current.needsManualReconciliation && !current.mystarsCreateInFlight) {
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

      if (
        current.fulfillmentStatus === 'failed' &&
        current.needsManualReconciliation
      ) {
        return { action: 'exhausted', order: current };
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
      const hadLockedIdempotencyKey = Boolean(
        current.fulfillmentIdempotencyKey && current.fulfillmentIdempotencyKey.trim(),
      );
      const wasAmbiguousBeforeClaim = Boolean(
        current.mystarsAmbiguousPostAt || current.mystarsCreateInFlight,
      );
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
      return {
        action: 'claimed',
        order: claimedOrder,
        attempt: nextAttempt,
        hadLockedIdempotencyKey,
        wasAmbiguousBeforeClaim,
      };
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
    const { attempt, hadLockedIdempotencyKey, wasAmbiguousBeforeClaim } = claim;
    let adapterResult: FulfillmentAdapterResult | null = null;
    try {
      // If a previous attempt had an ambiguous POST /v1/orders timeout or crash before saving mystarsOrderId,
      // run strict multi-page reconciliation via GET /v1/orders before sending another POST /v1/orders.
      if (
        activeAdapter instanceof MyStarsFulfillmentAdapter &&
        !claimedOrder.mystarsOrderId &&
        wasAmbiguousBeforeClaim
      ) {
        const reconciled = await activeAdapter.reconcileAmbiguousCreateOrder(claimedOrder);
        if (reconciled.status === 'ambiguous_multiple') {
          throw new MyStarsApiError({
            message: `Обнаружено несколько (${reconciled.count}) подходящих заказов в MyStars после таймаута POST /v1/orders (проверено стр.: ${reconciled.pagesScanned}). Автоповтор заблокирован для защиты от дублирования.`,
            httpStatus: 409,
            code: 'ambiguous_create_order',
            retryable: false,
          });
        }
        if (reconciled.status === 'insufficient_data') {
          throw new MyStarsApiError({
            message: reconciled.reason,
            httpStatus: 409,
            code: 'insufficient_reconciliation_data',
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
        } else if (reconciled.status === 'not_found' && !hadLockedIdempotencyKey) {
          throw new MyStarsApiError({
            message:
              'После неопределённого POST /v1/orders заказ не найден в GET /v1/orders, но исходный fulfillmentIdempotencyKey отсутствует. Автоповтор заблокирован для защиты от дублирования.',
            httpStatus: 409,
            code: 'missing_idempotency_key',
            retryable: false,
          });
        }
      }

      adapterResult = await activeAdapter.requestFulfillment(claimedOrder, {
        idempotencyKey: claimedOrder.fulfillmentIdempotencyKey || idempotencyKey,
        attempt,
      });
      const resolvedAdapterResult = adapterResult;
      Object.assign(orderInput, this.extractMyStarsMetadataFromOrder(claimedOrder));
      this.retainedProviderResults.set(claimedOrder.orderId, {
        claimedOrder: { ...claimedOrder },
        adapterResult: resolvedAdapterResult,
        idempotencyKey: claimedOrder.fulfillmentIdempotencyKey || idempotencyKey,
        providerName: activeAdapter.providerName,
      });

      // =========================================================================
      // PHASE 3: PERSIST ADAPTER RESULT ATOMICALLY
      // =========================================================================
      const finalizedOrder = await firestoreRepo.runTransaction<Order>(async (tx) => {
        const latest = (await tx.get<Order>('orders', claimedOrder.orderId)) || claimedOrder;
        if (
          latest.fulfillmentStatus === 'completed' ||
          latest.fulfillmentStatus === 'refunded' ||
          latest.fulfillmentStatus === 'cancelled' ||
          latest.paymentStatus === 'refunded' ||
          latest.paymentStatus === 'cancelled'
        ) {
          return latest;
        }

        const nowIso = new Date().toISOString();
        const isAutoCompleted =
          resolvedAdapterResult.handledAutomatically &&
          resolvedAdapterResult.status === 'completed';

        const mergedBase: Order = {
          ...latest,
          ...this.extractMyStarsMetadataFromOrder(claimedOrder),
        };

        const updated: Order = {
          ...mergedBase,
          paymentStatus: isAutoCompleted ? 'completed' : mergedBase.paymentStatus,
          fulfillmentStatus: resolvedAdapterResult.status,
          fulfillmentNote: resolvedAdapterResult.details.slice(0, 500),
          externalExecutionReference:
            resolvedAdapterResult.externalReference ||
            claimedOrder.mystarsOrderId ||
            `${activeAdapter.providerName}:${idempotencyKey}`,
          mystarsCreateInFlight: false,
          mystarsAmbiguousPostAt: undefined,
          fulfillmentLastError: undefined,
          fulfillmentNextRetryAt: undefined,
          completedAt: isAutoCompleted
            ? mergedBase.completedAt || nowIso
            : mergedBase.completedAt,
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
            details: `Автоматическая выдача завершена: ${resolvedAdapterResult.details}`.slice(
              0,
              500,
            ),
            createdAt: nowIso,
          });
        }

        return updated;
      });

      this.retainedProviderResults.delete(claimedOrder.orderId);
      Object.assign(orderInput, finalizedOrder);

      // =========================================================================
      // PHASE 4: SEND NOTIFICATIONS OUTSIDE TRANSACTION (FAULT-TOLERANT)
      // =========================================================================
      let notifiedOrder = await this.ensureAdminNotified(finalizedOrder, bot);
      if (notifiedOrder.fulfillmentStatus === 'completed') {
        notifiedOrder = await this.ensureBuyerNotified(notifiedOrder, bot);
      }
      Object.assign(orderInput, notifiedOrder);
      return notifiedOrder;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // CRITICAL PROTECTION: If `adapterResult` is already non-null, the provider call
      // SUCCEEDED and the error occurred during Phase 3 database persistence (or notification).
      // Never mark the order as 'failed' with `mystarsCreateInFlight: false` after provider success!
      if (adapterResult !== null) {
        const resolvedRef =
          adapterResult.externalReference ||
          claimedOrder.mystarsOrderId ||
          `${activeAdapter.providerName}:${idempotencyKey}`;

        try {
          const recoveredOrder = await this.flushRetainedProviderResultForOrder(
            claimedOrder.orderId,
            bot,
          );
          if (recoveredOrder) {
            Object.assign(orderInput, recoveredOrder);
            return recoveredOrder;
          }
        } catch (fallbackErr) {
          console.error(
            `[FulfillmentService] Сбой Firestore после успешного ответа провайдера для заказа #${claimedOrder.orderId} (${resolvedRef}):`,
            redactSecretsFromText(
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            ),
          );
        }

        // If Firestore remains completely unreachable, throw the DB error while leaving
        // the Firestore order in its Phase 1 state ('processing' with mystarsCreateInFlight: true
        // or persisted mystarsOrderId) and keeping the retained result in memory so background
        // recovery reconciles without duplicate POST.
        throw error;
      }

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
        if (
          latest.fulfillmentStatus === 'completed' ||
          latest.fulfillmentStatus === 'refunded' ||
          latest.fulfillmentStatus === 'cancelled' ||
          latest.paymentStatus === 'refunded' ||
          latest.paymentStatus === 'cancelled'
        ) {
          return latest;
        }
        const resolvedMystarsId = claimedOrder.mystarsOrderId || latest.mystarsOrderId;
        const failed: Order = {
          ...latest,
          ...(resolvedMystarsId ? { mystarsOrderId: resolvedMystarsId } : {}),
          ...(claimedOrder.mystarsOrderStatus && !latest.mystarsOrderStatus
            ? { mystarsOrderStatus: claimedOrder.mystarsOrderStatus }
            : {}),
          fulfillmentStatus: 'failed',
          fulfillmentLastError: errMsg.slice(0, 500),
          fulfillmentNextRetryAt: nextRetryIso,
          needsManualReconciliation: !canRetry,
          ...(isAmbiguousCreateError && !resolvedMystarsId
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
        } else if (
          reconciled.status === 'ambiguous_multiple' ||
          reconciled.status === 'insufficient_data' ||
          !hasLockedIdempotencyKey
        ) {
          const nowIso = new Date().toISOString();
          const reason =
            reconciled.status === 'ambiguous_multiple'
              ? `Обнаружено несколько (${reconciled.count}) подходящих заказов в MyStars после сбоя POST /v1/orders (проверено стр.: ${reconciled.pagesScanned}). Автоповтор заблокирован для защиты от дублирования.`
              : reconciled.status === 'insufficient_data'
                ? reconciled.reason
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
          const wasAlreadyCompleted = current.fulfillmentStatus === 'completed';
          const updated: Order = {
            ...current,
            ...this.extractMyStarsMetadataFromOrder(staleOrder),
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
          if (finalStatus === 'completed' && !wasAlreadyCompleted) {
            const txId = sanitizeDocId(`tx_fulfill_done_${updated.orderId}`);
            tx.set<StoreTransaction>('transactions', txId, {
              transactionId: txId,
              orderId: updated.orderId,
              userId: updated.userId,
              type: 'fulfillment_completed',
              amount: updated.totalPriceUsdCents ?? updated.totalPrice,
              amountUsdCents: updated.totalPriceUsdCents ?? updated.totalPrice,
              currency: updated.currency || 'USD',
              details: `Автоматическая выдача восстановлена после сверки: ${
                extStatus.details || updated.externalExecutionReference
              }`.slice(0, 500),
              createdAt: nowIso,
            });
          }
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

  private static needsBuyerNotificationRecovery(
    order: Order,
    nowMs: number,
  ): boolean {
    if (order.fulfillmentStatus !== 'completed') {
      return false;
    }
    const state = order.buyerNotificationState;
    if (
      order.buyerNotifiedAt ||
      state?.status === 'sent' ||
      state?.status === 'delivery_uncertain'
    ) {
      return false;
    }
    if (state?.status === 'sending') {
      return this.timestampToMillis(state.leaseUntil) <= nowMs;
    }
    return true;
  }

  private static needsAdminNotificationRecovery(
    order: Order,
    nowMs: number,
  ): boolean {
    const state = order.adminNotificationState;
    if (
      order.adminNotifiedAt ||
      state?.status === 'sent' ||
      state?.status === 'delivery_uncertain'
    ) {
      return false;
    }
    if (state?.status === 'sending') {
      return this.timestampToMillis(state.leaseUntil) <= nowMs;
    }
    if (state?.status === 'no_recipients') {
      return getEnvConfig().adminIds.length > 0;
    }
    return true;
  }

  private static countSentAdminRecipients(
    state?: NotificationDeliveryState,
  ): number {
    if (!state?.recipientDeliveries) {
      return 0;
    }
    let count = 0;
    for (const rec of Object.values(state.recipientDeliveries)) {
      if (rec?.status === 'sent') {
        count++;
      }
    }
    return count;
  }

  private static didBuyerNotificationProgress(
    before: Order,
    after: Order,
  ): boolean {
    return (
      (!before.buyerNotifiedAt && Boolean(after.buyerNotifiedAt)) ||
      before.buyerNotificationState?.status !==
        after.buyerNotificationState?.status
    );
  }

  private static didAdminNotificationProgress(
    before: Order,
    after: Order,
  ): boolean {
    return (
      (!before.adminNotifiedAt && Boolean(after.adminNotifiedAt)) ||
      before.adminNotificationState?.status !==
        after.adminNotificationState?.status ||
      this.countSentAdminRecipients(after.adminNotificationState) >
        this.countSentAdminRecipients(before.adminNotificationState)
    );
  }

  /**
   * Dedicated notification recovery pass:
   * - Recovers pending / expired-lease / crash-interrupted buyer notifications for `completed` orders.
   * - Recovers pending / partial_sent / no_recipients (once ADMIN_IDS configured) / expired-lease
   *   admin notifications across `processing`, `failed`, and `completed` orders without starvation.
   * - Uses separated `sending` vs actionable queries and rotating `__name__` cursors (limit=50 per pass)
   *   so active leases or persistently failing orders (e.g. blocked bots) never starve the rest of the queue.
   * - Respects active `sending` leases and never resends `sent` or `delivery_uncertain` notifications.
   */
  private static async recoverPendingNotifications(
    bot: Telegraf | null | undefined,
    nowMs: number,
    skipBuyerOrderIds: Set<string>,
    skipAdminOrderIds: Set<string>,
    leaseOwnerOverride?: string,
  ): Promise<Order[]> {
    if (!bot) {
      return [];
    }

    const progressed: Order[] = [];
    const batchLimit = Math.max(1, this.notificationRecoveryBatchLimit);
    const useSharedCursor = !leaseOwnerOverride;

    // 1. Buyer notifications for `completed` orders:
    //    (a) Actionable `pending` via single-field index + rotating documentId cursor (oldest-first, zero starvation)
    //    (b) In-flight `sending` via separate single-field index query (active leases never starve `pending`)
    //    (c) Recent `completed` orders (uses existing composite index `fulfillmentStatus ASC, createdAt DESC`)
    //        to catch crash-before-notify / legacy orders where `buyerNotificationState` and `buyerNotifiedAt` are missing.
    let pendingBuyerOrders = await firestoreRepo.queryDocs<Order>('orders', {
      where: [
        {
          field: 'buyerNotificationState.status',
          op: '==',
          value: 'pending',
        },
      ],
      startAfter: useSharedCursor
        ? (this.buyerPendingCursorOrderId ?? undefined)
        : undefined,
      limit: batchLimit,
    });

    if (useSharedCursor) {
      if (pendingBuyerOrders.length === 0 && this.buyerPendingCursorOrderId) {
        // Reached the end of the pending queue; wrap cleanly to head in the same pass
        this.buyerPendingCursorOrderId = null;
        pendingBuyerOrders = await firestoreRepo.queryDocs<Order>('orders', {
          where: [
            {
              field: 'buyerNotificationState.status',
              op: '==',
              value: 'pending',
            },
          ],
          limit: batchLimit,
        });
      }
      if (pendingBuyerOrders.length >= batchLimit) {
        this.buyerPendingCursorOrderId =
          pendingBuyerOrders[pendingBuyerOrders.length - 1].orderId;
      } else {
        this.buyerPendingCursorOrderId = null;
      }
    }

    const [sendingBuyerOrders, recentCompletedOrders] = await Promise.all([
      firestoreRepo.queryDocs<Order>('orders', {
        where: [
          {
            field: 'buyerNotificationState.status',
            op: '==',
            value: 'sending',
          },
        ],
        limit: batchLimit,
      }),
      firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'completed' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: batchLimit,
      }),
    ]);

    const buyerCandidateMap = new Map<string, Order>();
    for (const ord of pendingBuyerOrders) {
      buyerCandidateMap.set(ord.orderId, ord);
    }
    for (const ord of sendingBuyerOrders) {
      if (!buyerCandidateMap.has(ord.orderId)) {
        buyerCandidateMap.set(ord.orderId, ord);
      }
    }
    for (const ord of recentCompletedOrders) {
      if (
        !ord.buyerNotificationState &&
        !ord.buyerNotifiedAt &&
        !buyerCandidateMap.has(ord.orderId)
      ) {
        buyerCandidateMap.set(ord.orderId, ord);
      }
    }

    for (const ord of buyerCandidateMap.values()) {
      if (
        skipBuyerOrderIds.has(ord.orderId) ||
        !this.needsBuyerNotificationRecovery(ord, nowMs)
      ) {
        continue;
      }
      skipBuyerOrderIds.add(ord.orderId);
      try {
        const updated = await this.ensureBuyerNotified(
          ord,
          bot,
          false,
          leaseOwnerOverride,
        );
        if (this.didBuyerNotificationProgress(ord, updated)) {
          progressed.push(updated);
        }
      } catch (error) {
        console.error(
          `[FulfillmentService] Ошибка восстановления уведомления покупателю для заказа #${ord.orderId}:`,
          redactSecretsFromText(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }

    // 2. Admin notifications across orders with explicit unfinished `adminNotificationState`:
    //    Uses pure single-field equality queries (`==` + optional `__name__` cursor) so Cloud
    //    Firestore satisfies every query via built-in automatic single-field indexes without
    //    requiring composite indexes, while preventing starvation across >50 pending/partial/sending orders.
    let pendingAdminOrders = await firestoreRepo.queryDocs<Order>('orders', {
      where: [
        {
          field: 'adminNotificationState.status',
          op: '==',
          value: 'pending',
        },
      ],
      startAfter: useSharedCursor
        ? (this.adminPendingCursorOrderId ?? undefined)
        : undefined,
      limit: batchLimit,
    });

    if (useSharedCursor) {
      if (pendingAdminOrders.length === 0 && this.adminPendingCursorOrderId) {
        this.adminPendingCursorOrderId = null;
        pendingAdminOrders = await firestoreRepo.queryDocs<Order>('orders', {
          where: [
            {
              field: 'adminNotificationState.status',
              op: '==',
              value: 'pending',
            },
          ],
          limit: batchLimit,
        });
      }
      if (pendingAdminOrders.length >= batchLimit) {
        this.adminPendingCursorOrderId =
          pendingAdminOrders[pendingAdminOrders.length - 1].orderId;
      } else {
        this.adminPendingCursorOrderId = null;
      }
    }

    let partialAdminOrders = await firestoreRepo.queryDocs<Order>('orders', {
      where: [
        {
          field: 'adminNotificationState.status',
          op: '==',
          value: 'partial_sent',
        },
      ],
      startAfter: useSharedCursor
        ? (this.adminPartialCursorOrderId ?? undefined)
        : undefined,
      limit: batchLimit,
    });

    if (useSharedCursor) {
      if (partialAdminOrders.length === 0 && this.adminPartialCursorOrderId) {
        this.adminPartialCursorOrderId = null;
        partialAdminOrders = await firestoreRepo.queryDocs<Order>('orders', {
          where: [
            {
              field: 'adminNotificationState.status',
              op: '==',
              value: 'partial_sent',
            },
          ],
          limit: batchLimit,
        });
      }
      if (partialAdminOrders.length >= batchLimit) {
        this.adminPartialCursorOrderId =
          partialAdminOrders[partialAdminOrders.length - 1].orderId;
      } else {
        this.adminPartialCursorOrderId = null;
      }
    }

    const [noRecipientAdminOrders, sendingAdminOrders] = await Promise.all([
      getEnvConfig().adminIds.length > 0
        ? firestoreRepo.queryDocs<Order>('orders', {
            where: [
              {
                field: 'adminNotificationState.status',
                op: '==',
                value: 'no_recipients',
              },
            ],
            limit: batchLimit,
          })
        : Promise.resolve<Order[]>([]),
      firestoreRepo.queryDocs<Order>('orders', {
        where: [
          {
            field: 'adminNotificationState.status',
            op: '==',
            value: 'sending',
          },
        ],
        limit: batchLimit,
      }),
    ]);

    const adminCandidateMap = new Map<string, Order>();
    for (const ord of pendingAdminOrders) {
      adminCandidateMap.set(ord.orderId, ord);
    }
    for (const ord of partialAdminOrders) {
      if (!adminCandidateMap.has(ord.orderId)) {
        adminCandidateMap.set(ord.orderId, ord);
      }
    }
    for (const ord of noRecipientAdminOrders) {
      if (!adminCandidateMap.has(ord.orderId)) {
        adminCandidateMap.set(ord.orderId, ord);
      }
    }
    for (const ord of sendingAdminOrders) {
      if (!adminCandidateMap.has(ord.orderId)) {
        adminCandidateMap.set(ord.orderId, ord);
      }
    }

    for (const ord of adminCandidateMap.values()) {
      if (
        (ord.fulfillmentStatus !== 'processing' &&
          ord.fulfillmentStatus !== 'failed' &&
          ord.fulfillmentStatus !== 'completed') ||
        skipAdminOrderIds.has(ord.orderId) ||
        !this.needsAdminNotificationRecovery(ord, nowMs)
      ) {
        continue;
      }
      skipAdminOrderIds.add(ord.orderId);
      try {
        const updated = await this.ensureAdminNotified(
          ord,
          bot,
          false,
          leaseOwnerOverride,
        );
        if (this.didAdminNotificationProgress(ord, updated)) {
          progressed.push(updated);
        }
      } catch (error) {
        console.error(
          `[FulfillmentService] Ошибка восстановления уведомления администраторам для заказа #${ord.orderId}:`,
          redactSecretsFromText(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }

    return progressed;
  }

  /**
   * Recovery worker pass:
   * - Recovers orders in 'paid' (payment committed, fulfillment not started)
   * - Retries eligible orders in 'failed' whose backoff delay has elapsed and attempts < MAX_FULFILLMENT_ATTEMPTS
   * - Recovers stale 'processing' orders or retries missing admin/buyer notifications
   * - Recovers unfinished buyer notifications for 'completed' orders and admin notifications across orders
   * Guarded by `isRecoveryPassRunning` mutex so two recovery passes never overlap within the same process.
   */
  public static async recoverPendingFulfillments(
    bot: Telegraf | null | undefined,
    options?: { bypassLocalMutex?: boolean; workerId?: string },
  ): Promise<Order[]> {
    const bypassLocalMutex = Boolean(options?.bypassLocalMutex);
    const leaseOwnerOverride = options?.workerId;

    if (!bypassLocalMutex && this.isRecoveryPassRunning) {
      return [];
    }
    if (!firestoreRepo.isProductionStorageHealthy()) {
      return [];
    }

    if (!bypassLocalMutex) {
      this.isRecoveryPassRunning = true;
    }
    const recovered: Order[] = [];
    const adminNotifyAttemptedInPass = new Set<string>();
    const buyerNotifyAttemptedInPass = new Set<string>();

    try {
      const flushedRetained = await this.flushAllRetainedProviderResults(bot);
      for (const flushedOrd of flushedRetained) {
        adminNotifyAttemptedInPass.add(flushedOrd.orderId);
        if (flushedOrd.fulfillmentStatus === 'completed') {
          buyerNotifyAttemptedInPass.add(flushedOrd.orderId);
        }
        recovered.push(flushedOrd);
      }

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
            adminNotifyAttemptedInPass.add(ord.orderId);
            if (updated.fulfillmentStatus === 'completed') {
              buyerNotifyAttemptedInPass.add(ord.orderId);
            }
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
          (ord.paymentStatus === 'paid' || ord.paymentStatus === 'processing') &&
          !ord.needsManualReconciliation &&
          attempts < this.MAX_FULFILLMENT_ATTEMPTS &&
          retryDue
        ) {
          try {
            const updated = await this.initiateFulfillment(ord, bot);
            adminNotifyAttemptedInPass.add(ord.orderId);
            if (updated.fulfillmentStatus === 'completed') {
              buyerNotifyAttemptedInPass.add(ord.orderId);
            }
            recovered.push(updated);
          } catch (error) {
            console.error(
              `[FulfillmentService] Повторная попытка выдачи заказа #${ord.orderId} завершилась ошибкой:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        } else if (this.needsAdminNotificationRecovery(ord, nowMs)) {
          adminNotifyAttemptedInPass.add(ord.orderId);
          try {
            const notified = await this.ensureAdminNotified(
              ord,
              bot,
              false,
              leaseOwnerOverride,
            );
            if (this.didAdminNotificationProgress(ord, notified)) {
              recovered.push(notified);
            }
          } catch (error) {
            console.error(
              `[FulfillmentService] Ошибка восстановления уведомления админам для failed-заказа #${ord.orderId}:`,
              redactSecretsFromText(
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
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

        if (
          !ord.externalExecutionReference &&
          !ord.mystarsOrderId &&
          isStale &&
          (!ord.needsManualReconciliation || Boolean(ord.mystarsCreateInFlight))
        ) {
          try {
            const reconciled = await this.reconcileStaleProcessingOrder(ord, bot);
            adminNotifyAttemptedInPass.add(ord.orderId);
            if (reconciled.fulfillmentStatus === 'completed') {
              buyerNotifyAttemptedInPass.add(ord.orderId);
            }
            recovered.push(reconciled);
          } catch (error) {
            console.error(
              `[FulfillmentService] Ошибка сверки зависшего заказа #${ord.orderId}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
          continue;
        }

        const isActivelyDispatchingCreate =
          !ord.mystarsOrderId &&
          (Boolean(ord.mystarsCreateInFlight) ||
            (!ord.externalExecutionReference &&
              !ord.adminNotificationState &&
              startedMs > 0 &&
              !isStale));

        if (
          !isActivelyDispatchingCreate &&
          this.needsAdminNotificationRecovery(ord, nowMs)
        ) {
          adminNotifyAttemptedInPass.add(ord.orderId);
          try {
            const notified = await this.ensureAdminNotified(
              ord,
              bot,
              false,
              leaseOwnerOverride,
            );
            if (this.didAdminNotificationProgress(ord, notified)) {
              recovered.push(notified);
            }
          } catch (error) {
            console.error(
              `[FulfillmentService] Ошибка восстановления уведомления админам для processing-заказа #${ord.orderId}:`,
              redactSecretsFromText(
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
        }
      }

      // 3b. Dedicated MyStars FaaS v1 Polling Pass (GET /v1/orders/{order_id})
      // Automatically resumes for all unfinished processing orders after restarts,
      // handles 429 Retry-After cooldowns, timeouts, and terminal success/failure states.
      try {
        const pollSummary = await this.pollMyStarsOrders(bot);
        for (const polledOrder of pollSummary.orders) {
          if (polledOrder.fulfillmentStatus === 'completed') {
            buyerNotifyAttemptedInPass.add(polledOrder.orderId);
          }
          recovered.push(polledOrder);
        }
      } catch (error) {
        console.error(
          '[FulfillmentService] Ошибка фонового polling MyStars:',
          redactSecretsFromText(error instanceof Error ? error.message : String(error)),
        );
      }

      // 3c. Dedicated Notification Recovery Pass (completed buyer notifications & pending/partial/no_recipients/expired-lease admin notifications)
      try {
        const notificationRecovered = await this.recoverPendingNotifications(
          bot,
          Date.now(),
          buyerNotifyAttemptedInPass,
          adminNotifyAttemptedInPass,
          leaseOwnerOverride,
        );
        for (const notifiedOrder of notificationRecovered) {
          recovered.push(notifiedOrder);
        }
      } catch (error) {
        console.error(
          '[FulfillmentService] Ошибка фонового восстановления уведомлений Telegram:',
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
      if (!bypassLocalMutex) {
        this.isRecoveryPassRunning = false;
      }
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
    checkpointDegraded: boolean;
    checkpointSaved: boolean;
    checkpointError?: string;
    orders: Order[];
  }> {
    const summary: {
      polled: number;
      completed: number;
      failed: number;
      stillProcessing: number;
      rateLimited: boolean;
      deferredByCooldown: boolean;
      transientErrors: number;
      checkpointDegraded: boolean;
      checkpointSaved: boolean;
      checkpointError?: string;
      orders: Order[];
    } = {
      polled: 0,
      completed: 0,
      failed: 0,
      stillProcessing: 0,
      rateLimited: false,
      deferredByCooldown: false,
      transientErrors: 0,
      checkpointDegraded: this.checkpointDegraded,
      checkpointSaved: true,
      orders: [],
    };

    if (!firestoreRepo.isProductionStorageHealthy()) {
      return summary;
    }

    const activeAdapter = this.getActiveAdapter();
    if (!activeAdapter.checkExternalStatus || !activeAdapter.isConfigured()) {
      return summary;
    }

    await this.flushAllRetainedProviderResults(bot);

    const nowMs = Date.now();
    if (this.mystarsPollCooldownUntilMs > nowMs) {
      summary.rateLimited = true;
      summary.deferredByCooldown = true;
      return summary;
    }

    // If checkpoint persistence is currently in failure backoff, pause polling instead of repeatedly
    // re-serving the head of the queue.
    if (this.checkpointRetryAfterMs > nowMs) {
      summary.checkpointDegraded = true;
      summary.checkpointSaved = false;
      summary.deferredByCooldown = true;
      summary.checkpointError =
        this.checkpointLastError || 'Ожидание восстановления checkpoint Firestore';
      return summary;
    }

    // If a previous tick polled orders but failed to persist its checkpoint, flush that pending
    // checkpoint first before scanning any new batch. If Firestore writes still fail, abort the
    // tick rather than re-polling the beginning of the queue.
    if (this.pendingUnsavedCheckpoint) {
      try {
        await this.saveMyStarsPollCheckpoint(this.pendingUnsavedCheckpoint);
      } catch (error) {
        const msg = redactSecretsFromText(
          error instanceof Error ? error.message : String(error),
        );
        summary.checkpointDegraded = true;
        summary.checkpointSaved = false;
        summary.checkpointError = msg;
        summary.transientErrors += 1;
        return summary;
      }
    }

    // Persistent cursor-paginated fair polling over all 'processing' orders ordered by 'createdAt' ASC:
    // - Uses real Firestore `startAfter: { value: createdAt, id: orderId }` cursor pagination (never excludes
    //   legacy docs without `mystarsLastPolledAt` and never stops at a hard 1000-order cap).
    // - For small active queues (< pollPageSize on a single page from start), sorts globally with
    //   legacy/unpolled orders prioritized first.
    // - For large multi-page queues (>= pollPageSize, e.g. 1,500+ orders), advances a persistent Firestore
    //   checkpoint (`settings/mystars_poll_cursor`) across ticks and restarts, wrapping cleanly at the tail
    //   so 100% of active orders are fairly serviced with zero starvation.
    const budget = Math.max(1, this.pollBatchBudget);
    const pageSize = Math.max(1, this.pollPageSize);
    const isMyStarsCandidate = (ord: Order): boolean =>
      Boolean(
        ord.mystarsOrderId ||
          (ord.externalExecutionReference &&
            (ord.externalExecutionReference.startsWith('ord_') ||
              ord.externalExecutionReference.startsWith('ms_'))),
      );
    const hasActiveExternalLease = (ord: Order, refMs: number): boolean => {
      if (this.inFlightMyStarsPollOrders.has(ord.orderId)) {
        return true;
      }
      const untilMs = this.timestampToMillis(ord.mystarsPollLease?.leaseUntil);
      return Boolean(ord.mystarsPollLease && untilMs > refMs);
    };

    let checkpoint: MyStarsPollCheckpoint | null;
    try {
      checkpoint = await this.loadMyStarsPollCheckpoint();
      summary.checkpointDegraded = false;
    } catch (error) {
      // Never silently treat a Firestore read failure as null (head of queue)!
      const msg = redactSecretsFromText(
        error instanceof Error ? error.message : String(error),
      );
      summary.checkpointDegraded = true;
      summary.checkpointSaved = false;
      summary.checkpointError = msg;
      summary.transientErrors += 1;
      return summary;
    }

    let scanCursor: { value: string; id: string } | undefined =
      checkpoint?.cursorCreatedAt && checkpoint?.cursorOrderId
        ? { value: checkpoint.cursorCreatedAt, id: checkpoint.cursorOrderId }
        : undefined;
    let cyclesCompleted = checkpoint?.cyclesCompleted ?? 0;

    let batchToPoll: Order[] = [];
    const orderCycleMap = new Map<string, number>();
    let isMultiPageSweep = Boolean(scanCursor);
    let reachedTailOnLastScan = false;
    let wrappedAroundThisTick = false;

    const firstPage = await firestoreRepo.queryDocs<Order>('orders', {
      where: [{ field: 'fulfillmentStatus', op: '==', value: 'processing' }],
      orderBy: { field: 'createdAt', direction: 'asc' },
      limit: pageSize,
      ...(scanCursor ? { startAfter: scanCursor } : {}),
    });

    if (!isMultiPageSweep && firstPage.length < pageSize) {
      // Entire active queue fits in one page -> globally sort with missing mystarsLastPolledAt first
      const candidates = firstPage
        .filter((ord) => isMyStarsCandidate(ord) && !hasActiveExternalLease(ord, nowMs))
        .sort((a, b) => {
          const aPolledMs = a.mystarsLastPolledAt ? Date.parse(a.mystarsLastPolledAt) || 0 : 0;
          const bPolledMs = b.mystarsLastPolledAt ? Date.parse(b.mystarsLastPolledAt) || 0 : 0;
          if (aPolledMs !== bPolledMs) {
            return aPolledMs - bPolledMs;
          }
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        });
      batchToPoll = candidates.slice(0, budget);
      for (const ord of batchToPoll) {
        orderCycleMap.set(ord.orderId, cyclesCompleted);
      }
      reachedTailOnLastScan = true;
    } else {
      // Large multi-page queue or resumed mid-sweep from persistent checkpoint
      isMultiPageSweep = true;
      const visitedOrderIds = new Set<string>();
      const maxDocsToScan = Math.max(pageSize * 5, budget * 10);
      let scannedDocs = 0;
      let currentPage = firstPage;
      let pageIndex = 0;

      while (batchToPoll.length < budget && scannedDocs < maxDocsToScan) {
        if (pageIndex > 0) {
          currentPage = await firestoreRepo.queryDocs<Order>('orders', {
            where: [{ field: 'fulfillmentStatus', op: '==', value: 'processing' }],
            orderBy: { field: 'createdAt', direction: 'asc' },
            limit: pageSize,
            ...(scanCursor ? { startAfter: scanCursor } : {}),
          });
        }
        pageIndex++;

        if (currentPage.length === 0) {
          if (!wrappedAroundThisTick && checkpoint?.cursorOrderId) {
            // Reached end of collection; wrap around once to the beginning
            wrappedAroundThisTick = true;
            reachedTailOnLastScan = true;
            cyclesCompleted += 1;
            scanCursor = undefined;
            continue;
          }
          reachedTailOnLastScan = true;
          break;
        }

        let stoppedEarlyAtIndex = -1;
        for (let i = 0; i < currentPage.length; i++) {
          const ord = currentPage[i];
          scannedDocs += 1;
          if (visitedOrderIds.has(ord.orderId)) {
            continue;
          }
          visitedOrderIds.add(ord.orderId);
          if (isMyStarsCandidate(ord) && !hasActiveExternalLease(ord, Date.now())) {
            batchToPoll.push(ord);
            orderCycleMap.set(ord.orderId, cyclesCompleted);
            if (batchToPoll.length >= budget) {
              stoppedEarlyAtIndex = i;
              break;
            }
          }
        }

        if (stoppedEarlyAtIndex >= 0) {
          const lastPicked = currentPage[stoppedEarlyAtIndex];
          const isExactEndOfShortPage =
            currentPage.length < pageSize && stoppedEarlyAtIndex === currentPage.length - 1;
          if (isExactEndOfShortPage) {
            reachedTailOnLastScan = true;
            cyclesCompleted += 1;
            scanCursor = undefined;
          } else {
            reachedTailOnLastScan = false;
            scanCursor = { value: lastPicked.createdAt, id: lastPicked.orderId };
          }
          break;
        }

        const lastInPage = currentPage[currentPage.length - 1];
        if (currentPage.length < pageSize) {
          reachedTailOnLastScan = true;
          cyclesCompleted += 1;
          scanCursor = undefined;
          if (!wrappedAroundThisTick && checkpoint?.cursorOrderId) {
            // Wrap around once so the remaining budget is used on the head of the queue
            wrappedAroundThisTick = true;
            continue;
          }
          break;
        }

        scanCursor = { value: lastInPage.createdAt, id: lastInPage.orderId };
      }
    }

    let lastCompletedOrderInSweep: { order: Order; cycle: number } | null = null;
    let interruptedByRateLimit = false;

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
          lastCompletedOrderInSweep = {
            order: ord,
            cycle: orderCycleMap.get(ord.orderId) ?? cyclesCompleted,
          };
          continue;
        }

        summary.polled += 1;
        const extStatus = await activeAdapter.checkExternalStatus(
          latest,
          latest.fulfillmentIdempotencyKey || `fulfill_${latest.orderId}`,
        );
        lastCompletedOrderInSweep = {
          order: ord,
          cycle: orderCycleMap.get(ord.orderId) ?? cyclesCompleted,
        };

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
              `⚠️ <b>Неизвестный статус MyStars: "${escapeHtml(extStatus.unknownStatus)}"</b>\nЗаказ оставлен в статусе processing для безопасной проверки.\n\n${formatAdminOrderCard(refreshedForUnknown)}`,
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

        // 1. Rate-limit (HTTP 429 general): set global polling cooldown honoring Retry-After.
        // Do NOT advance lastCompletedOrderInSweep so this unprocessed order is NOT skipped on the next tick.
        if (error instanceof MyStarsRateLimitError && error.kind === 'general') {
          const retryAfterSec = error.retryAfterSeconds ?? 15;
          const cooldownMs = Math.min(Math.max(retryAfterSec * 1000, 10), 120_000);
          this.mystarsPollCooldownUntilMs = Date.now() + cooldownMs;
          summary.rateLimited = true;
          summary.transientErrors += 1;
          interruptedByRateLimit = true;
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

        // Non-rate-limit terminal/transient errors still count as processed for sweep advancement
        lastCompletedOrderInSweep = {
          order: ord,
          cycle: orderCycleMap.get(ord.orderId) ?? cyclesCompleted,
        };

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

    // Persist cursor checkpoint for multi-page sweeps so next tick & restarts resume fairly.
    // Never advance the confirmed cursor if Firestore save fails; queue pendingUnsavedCheckpoint
    // so subsequent ticks flush it before scanning any new orders (preventing head-of-queue loops).
    const sweepResetEpoch = checkpoint
      ? this.normalizeResetEpoch(checkpoint)
      : this.lastConfirmedPollCheckpoint
        ? this.normalizeResetEpoch(this.lastConfirmedPollCheckpoint)
        : 0;
    let checkpointToPersist: MyStarsPollCheckpoint | null = null;
    if (isMultiPageSweep) {
      if (interruptedByRateLimit) {
        if (lastCompletedOrderInSweep) {
          checkpointToPersist = {
            key: 'mystars_poll_cursor',
            cursorCreatedAt: lastCompletedOrderInSweep.order.createdAt,
            cursorOrderId: lastCompletedOrderInSweep.order.orderId,
            cyclesCompleted: lastCompletedOrderInSweep.cycle,
            lastPolledCount: summary.polled,
            updatedAt: new Date().toISOString(),
            resetEpoch: sweepResetEpoch,
          };
        }
        // If the very first order in batchToPoll hit HTTP 429, keep the previous checkpoint
        // unchanged so the rate-limited order is polled first after cooldown.
      } else {
        const nextCursorToSave =
          reachedTailOnLastScan && !scanCursor
            ? { cursorCreatedAt: undefined, cursorOrderId: undefined }
            : scanCursor
              ? { cursorCreatedAt: scanCursor.value, cursorOrderId: scanCursor.id }
              : { cursorCreatedAt: undefined, cursorOrderId: undefined };

        checkpointToPersist = {
          key: 'mystars_poll_cursor',
          cursorCreatedAt: nextCursorToSave.cursorCreatedAt,
          cursorOrderId: nextCursorToSave.cursorOrderId,
          cyclesCompleted,
          lastPolledCount: summary.polled,
          updatedAt: new Date().toISOString(),
          resetEpoch: sweepResetEpoch,
        };
      }
    } else if (checkpoint?.cursorOrderId && !interruptedByRateLimit) {
      checkpointToPersist = {
        key: 'mystars_poll_cursor',
        cursorCreatedAt: undefined,
        cursorOrderId: undefined,
        cyclesCompleted: cyclesCompleted + 1,
        lastPolledCount: summary.polled,
        updatedAt: new Date().toISOString(),
        resetEpoch: sweepResetEpoch,
      };
    }

    if (checkpointToPersist) {
      try {
        await this.saveMyStarsPollCheckpoint(checkpointToPersist);
        summary.checkpointSaved = true;
        summary.checkpointDegraded = false;
      } catch (error) {
        const msg = redactSecretsFromText(
          error instanceof Error ? error.message : String(error),
        );
        if (
          !this.pendingUnsavedCheckpoint ||
          this.comparePollCheckpoints(
            this.pendingUnsavedCheckpoint,
            checkpointToPersist,
          ) <= 0
        ) {
          this.pendingUnsavedCheckpoint = checkpointToPersist;
        }
        summary.checkpointSaved = false;
        summary.checkpointDegraded = true;
        summary.checkpointError = msg;
        summary.transientErrors += 1;
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
      if (
        current.fulfillmentStatus === 'completed' ||
        current.fulfillmentStatus === 'refunded' ||
        current.fulfillmentStatus === 'cancelled' ||
        current.paymentStatus === 'refunded' ||
        current.paymentStatus === 'cancelled'
      ) {
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
      const uniqueAdminIds = Array.from(new Set(getEnvConfig().adminIds));
      const finIso = new Date().toISOString();
      if (uniqueAdminIds.length === 0) {
        console.warn(
          `[FulfillmentService] ADMIN_IDS / OWNER_TELEGRAM_ID не заданы — алерт сбоя MyStars для заказа #${updated.orderId} не отправлен.`,
        );
        await firestoreRepo
          .runTransaction<void>(async (tx) => {
            const latest = await tx.get<Order>('orders', updated.orderId);
            if (!latest) return;
            const latestState = latest.adminNotificationState;
            const leaseUntilMs = this.timestampToMillis(latestState?.leaseUntil);
            if (
              latest.adminNotifiedAt ||
              latestState?.status === 'sent' ||
              latestState?.status === 'delivery_uncertain' ||
              (latestState?.status === 'sending' && leaseUntilMs > Date.now())
            ) {
              return;
            }
            tx.set<Order>('orders', latest.orderId, {
              ...latest,
              adminNotificationState: {
                ...(latestState || {}),
                status: 'no_recipients',
                eventId:
                  latestState?.eventId || `evt_admin_${latest.orderId}_failed`,
                attemptCount: latestState?.attemptCount ?? 0,
                sentAt: undefined,
                lastError:
                  'Не настроены получатели ADMIN_IDS / OWNER_TELEGRAM_ID — уведомление не отправлялось.',
              },
              updatedAt: finIso,
            });
          })
          .catch(() => {});
      } else {
        const deliveries: Record<string, AdminRecipientDeliveryRecord> = {};
        for (const adminId of uniqueAdminIds) {
          const key = String(adminId);
          const prev = updated.adminNotificationState?.recipientDeliveries?.[key];
          const res = await this.sendTelegramMessageWithResult(
            bot,
            adminId,
            `🚨 <b>СБОЙ АВТОВЫДАЧИ MYSTARS (Polling)</b>\n\n${formatAdminOrderCard(updated)}`,
            {
              parse_mode: 'HTML',
              ...buildAdminOrderActionKeyboard(updated),
            },
          );
          if (res.ok) {
            deliveries[key] = {
              adminTelegramId: adminId,
              status: 'sent',
              attemptCount: (prev?.attemptCount ?? 0) + 1,
              sentAt: finIso,
              lastAttemptAt: finIso,
            };
          } else {
            deliveries[key] = {
              adminTelegramId: adminId,
              status: 'failed',
              attemptCount: (prev?.attemptCount ?? 0) + 1,
              sentAt: prev?.sentAt,
              lastAttemptAt: finIso,
              lastError: res.error,
            };
          }
        }

        await firestoreRepo
          .runTransaction<void>(async (tx) => {
            const latest = await tx.get<Order>('orders', updated.orderId);
            if (!latest) return;
            const latestState = latest.adminNotificationState;
            const leaseUntilMs = this.timestampToMillis(latestState?.leaseUntil);
            if (latestState?.status === 'sending' && leaseUntilMs > Date.now()) {
              return;
            }
            const mergedDeliveries: Record<string, AdminRecipientDeliveryRecord> = {
              ...(latestState?.recipientDeliveries || {}),
            };
            for (const [k, rec] of Object.entries(deliveries)) {
              const existing = mergedDeliveries[k];
              if (existing?.status === 'sent' && rec.status !== 'sent') {
                mergedDeliveries[k] = {
                  ...existing,
                  attemptCount: Math.max(existing.attemptCount, rec.attemptCount),
                  lastAttemptAt: rec.lastAttemptAt,
                };
              } else {
                mergedDeliveries[k] = rec;
              }
            }

            const deliveredIds = uniqueAdminIds.filter(
              (id) => mergedDeliveries[String(id)]?.status === 'sent',
            );
            const undeliveredIds = uniqueAdminIds.filter(
              (id) => mergedDeliveries[String(id)]?.status !== 'sent',
            );
            const allDelivered = undeliveredIds.length === 0;

            tx.set<Order>('orders', latest.orderId, {
              ...latest,
              ...(allDelivered ? { adminNotifiedAt: latest.adminNotifiedAt || finIso } : {}),
              adminNotificationState: {
                ...(latestState || {}),
                status: allDelivered
                  ? 'sent'
                  : deliveredIds.length > 0
                    ? 'partial_sent'
                    : 'pending',
                eventId:
                  latestState?.eventId || `evt_admin_${latest.orderId}_failed`,
                attemptCount: (latestState?.attemptCount ?? 0) + 1,
                sentAt: allDelivered ? latestState?.sentAt || finIso : undefined,
                lastError: allDelivered
                  ? undefined
                  : deliveredIds.length > 0
                    ? `Частичная доставка алерта сбоя (${deliveredIds.length}/${uniqueAdminIds.length})`
                    : 'Не удалось доставить алерт сбоя ни одному администратору',
                recipientDeliveries: mergedDeliveries,
              },
              updatedAt: finIso,
            });
          })
          .catch(() => {});
      }
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
        redactSecretsFromText(err instanceof Error ? err.message : String(err)),
      );
    });

    this.recoveryIntervalHandle = setInterval(() => {
      void this.recoverPendingFulfillments(getBot()).catch((err) => {
        console.error(
          '[FulfillmentService] Ошибка фонового прохода recoverPendingFulfillments:',
          redactSecretsFromText(err instanceof Error ? err.message : String(err)),
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
        existing.fulfillmentStatus === 'cancelled' ||
        existing.fulfillmentStatus === 'refunded'
      ) {
        throw new Error(
          `Заказ #${params.orderId} уже находится в терминальном статусе выдачи (${existing.fulfillmentStatus}).`,
        );
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
        mystarsCreateInFlight: false,
        mystarsAmbiguousPostAt: undefined,
        mystarsPollLease: undefined,
        awaitingKeyStock: false,
        ...(params.adminTelegramId !== undefined
          ? { completedByAdminId: params.adminTelegramId }
          : {}),
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
