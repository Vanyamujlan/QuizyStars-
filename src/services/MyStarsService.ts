import crypto from 'crypto';
import { firestoreRepo } from '../db/firestore.ts';
import { getEnvConfig } from '../config/env.ts';
import {
  FulfillmentAdapterResult,
  FulfillmentProviderAdapter,
  FulfillmentRequestContext,
  Order,
  ProductCategory,
} from '../types.ts';
import {
  HttpTransportRequest,
  HttpTransportResponse,
  ProviderHttpTransport,
  maskSecret,
  redactSecretsFromText,
} from './PaymentProviders.ts';

export type MyStarsProductType = 'stars' | 'premium';
export type MyStarsPaymentCurrency = 'ton' | 'usdt_ton';

export type MyStarsOrderStatus =
  | 'received'
  | 'awaiting_payment'
  | 'paid'
  | 'reserved'
  | 'swapping'
  | 'funding'
  | 'purchasing'
  | 'fulfilling'
  | 'completed'
  | 'delivered'
  | 'failed'
  | 'reversed'
  | 'expired'
  | 'held'
  | 'cancelled';

export const MYSTARS_TERMINAL_STATUSES = new Set<string>([
  'delivered',
  'completed',
  'failed',
  'reversed',
  'expired',
  'cancelled',
]);

export const MYSTARS_ACTIVE_STATUSES = new Set<string>([
  'received',
  'awaiting_payment',
  'paid',
  'reserved',
  'swapping',
  'funding',
  'purchasing',
  'fulfilling',
  'held',
]);

export const MYSTARS_KNOWN_STATUSES = new Set<string>([
  ...MYSTARS_ACTIVE_STATUSES,
  ...MYSTARS_TERMINAL_STATUSES,
]);

export const MYSTARS_SUCCESS_STATUSES = new Set<string>(['delivered', 'completed']);

export const MYSTARS_FAILURE_STATUSES = new Set<string>([
  'failed',
  'reversed',
  'expired',
  'cancelled',
]);

export interface MyStarsCurrencyInfo {
  code: string;
  chain: string;
  name: string;
}

export interface MyStarsProductInfo {
  type: MyStarsProductType;
  name: string;
  parameter: 'quantity' | 'months';
  min: number;
  max: number;
  values?: number[] | null;
}

export interface MyStarsFeeBreakdown {
  subtotal: string;
  processing_fee: string;
  total: string;
  description: string;
  currency: string;
  kind?: 'swap' | 'network' | string;
}

export interface MyStarsPricingQuote {
  type: MyStarsProductType;
  quantity?: number | null;
  months?: number | null;
  amount: string;
  currency: string;
  fee?: MyStarsFeeBreakdown | null;
  usdt_per_ton?: string | null;
}

export interface MyStarsRecipientCheckResult {
  resolved: boolean;
  eligible: boolean;
  indeterminate?: boolean;
  recipient_name?: string | null;
  reason?: string | null;
  telegram_message?: string | null;
}

export interface MyStarsPaymentInstruction {
  currency: string;
  chain: string;
  pay_to_address?: string | null;
  memo?: string | null;
  amount: string;
  amount_units: string;
  fee?: MyStarsFeeBreakdown | null;
}

export interface MyStarsCreateOrderResult {
  order_id: string;
  status: MyStarsOrderStatus | string;
  type: MyStarsProductType;
  quantity?: number | null;
  months?: number | null;
  payment: MyStarsPaymentInstruction;
  expires_at?: string | null;
  purchase_tx?: string | null;
}

export interface MyStarsOrderRecord {
  order_id: string;
  status: MyStarsOrderStatus | string;
  type: MyStarsProductType;
  recipient_username?: string | null;
  quantity?: number | null;
  months?: number | null;
  amount_ton?: string | null;
  payment_tx?: string | null;
  purchase_tx?: string | null;
  failure_reason?: string | null;
  reversal_tx?: string | null;
  telegram_message?: string | null;
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
  payment?: MyStarsPaymentInstruction | null;
  currency?: string | null;
  payment_amount?: string | null;
  service_fee_usdt?: string | null;
}

export interface MyStarsOrderPage {
  orders: MyStarsOrderRecord[];
  next_cursor?: string | null;
}

export type MyStarsReconcileCreateResult =
  | {
      status: 'found';
      mystarsOrderId: string;
      mystarsStatus: string;
      pagesScanned: number;
    }
  | {
      status: 'not_found';
      pagesScanned: number;
    }
  | {
      status: 'ambiguous_multiple';
      count: number;
      pagesScanned: number;
    }
  | {
      status: 'insufficient_data';
      reason: string;
      incompleteCount: number;
      pagesScanned: number;
    };

export interface MyStarsCancelResult {
  order_id: string;
  status: string;
}

export interface MyStarsCredentialsOverride {
  apiBaseUrl?: string;
  apiKey?: string;
  paymentCurrency?: 'usdt_ton' | 'ton';
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export class MyStarsApiError extends Error {
  public readonly httpStatus: number;
  public readonly code: string;
  public readonly telegramMessage?: string;
  public readonly retryable: boolean;
  public readonly mystarsStatus?: string;

  constructor(params: {
    message: string;
    httpStatus: number;
    code?: string;
    telegramMessage?: string;
    retryable?: boolean;
    mystarsStatus?: string;
  }) {
    super(params.message);
    this.name = 'MyStarsApiError';
    this.httpStatus = params.httpStatus;
    this.code = params.code || `http_${params.httpStatus}`;
    this.telegramMessage = params.telegramMessage;
    this.retryable = Boolean(params.retryable);
    this.mystarsStatus = params.mystarsStatus;
  }
}

export class MyStarsValidationError extends MyStarsApiError {
  public readonly endpoint: string;

  constructor(params: {
    message: string;
    endpoint: string;
    httpStatus?: number;
    code?: string;
  }) {
    super({
      message: params.message,
      httpStatus: params.httpStatus ?? 502,
      code: params.code || 'invalid_api_payload',
      retryable: true,
    });
    this.name = 'MyStarsValidationError';
    this.endpoint = params.endpoint;
  }
}

export class MyStarsRecipientIneligibleError extends MyStarsApiError {
  public readonly reason?: string;

  constructor(params: {
    message: string;
    httpStatus?: number;
    code?: string;
    reason?: string;
    telegramMessage?: string;
  }) {
    super({
      message: params.message,
      httpStatus: params.httpStatus ?? 422,
      code: params.code || params.reason || 'recipient_ineligible',
      telegramMessage: params.telegramMessage,
      retryable: false,
    });
    this.name = 'MyStarsRecipientIneligibleError';
    this.reason = params.reason || params.code;
  }
}

export class MyStarsRateLimitError extends MyStarsApiError {
  public readonly kind: 'general' | 'order_cap';
  public readonly retryAfterSeconds?: number;

  constructor(params: {
    message: string;
    kind: 'general' | 'order_cap';
    retryAfterSeconds?: number;
    code?: string;
  }) {
    super({
      message: params.message,
      httpStatus: 429,
      code: params.code || (params.kind === 'order_cap' ? 'unpaid_order_cap' : 'rate_limited'),
      retryable: params.kind === 'general',
    });
    this.name = 'MyStarsRateLimitError';
    this.kind = params.kind;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export class MyStarsTransportError extends Error {
  public readonly retryable = true;
  public readonly isTimeout: boolean;

  constructor(message: string, isTimeout = false) {
    super(message);
    this.name = 'MyStarsTransportError';
    this.isTimeout = isTimeout;
  }
}

/**
 * Parses an HTTP Retry-After header (numeric seconds or RFC 7231 HTTP-date).
 */
export function parseRetryAfterSeconds(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  if (!str) return undefined;
  const asNum = Number(str);
  if (Number.isFinite(asNum) && asNum >= 0) {
    return asNum;
  }
  const asDateMs = Date.parse(str);
  if (Number.isFinite(asDateMs)) {
    const diffSec = (asDateMs - Date.now()) / 1000;
    return diffSec > 0 ? Math.ceil(diffSec) : 0;
  }
  return undefined;
}

/**
 * Builds an official MyStars FaaS API v1 URL (`https://api.mystars.tg/v1/...`)
 * without ever duplicating `/v1`.
 */
export function buildMyStarsApiV1Url(baseUrl: string, endpointPath: string): string {
  const cleanBase = (baseUrl || 'https://api.mystars.tg')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  return `${cleanBase}/v1${cleanPath}`;
}

const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;
const MIN_STARS_QTY = 50;
const MAX_STARS_QTY = 100_000;
const VALID_PREMIUM_MONTHS = new Set<number>([3, 6, 12]);

/**
 * Validates and normalizes a Telegram username for MyStars FaaS v1:
 * - Strips optional leading `@`
 * - 4–32 characters, contains only `[A-Za-z0-9_]`
 * - Returns canonical lowercase username without `@`.
 */
export function validateMyStarsUsername(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') {
    throw new MyStarsRecipientIneligibleError({
      message: 'Не указан Telegram @username получателя.',
      code: 'invalid_username',
      reason: 'invalid_username',
    });
  }
  const stripped = raw.trim().replace(/^@/, '');
  if (!USERNAME_RE.test(stripped)) {
    throw new MyStarsRecipientIneligibleError({
      message: `Некорректный формат Telegram @username: @${stripped || raw}. Допустимы 4–32 символа (латиница, цифры и "_").`,
      code: 'invalid_username',
      reason: 'invalid_username',
    });
  }
  return stripped.toLowerCase();
}

export function validateMyStarsQuantity(quantity: number): number {
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < MIN_STARS_QTY ||
    quantity > MAX_STARS_QTY
  ) {
    throw new MyStarsApiError({
      message: `Количество Telegram Stars для MyStars должно быть целым числом от ${MIN_STARS_QTY} до ${MAX_STARS_QTY} (получено: ${String(quantity)}).`,
      httpStatus: 400,
      code: 'invalid_quantity',
      retryable: false,
    });
  }
  return quantity;
}

export function validateMyStarsMonths(months: number | undefined): 3 | 6 | 12 {
  if (
    typeof months !== 'number' ||
    !Number.isInteger(months) ||
    !VALID_PREMIUM_MONTHS.has(months)
  ) {
    throw new MyStarsApiError({
      message: `Срок подписки Telegram Premium для MyStars должен быть 3, 6 или 12 месяцев (получено: ${String(months)}).`,
      httpStatus: 400,
      code: 'invalid_months',
      retryable: false,
    });
  }
  return months as 3 | 6 | 12;
}

/**
 * Converts a decimal USDT string (e.g., "0.7514" or "11.99") to integer USD cents.
 * Rounds up fractional sub-cents conservatively so wholesale cost is never understated.
 */
export function usdtDecimalToUsdCents(usdtStr: string | undefined | null): number {
  if (!usdtStr) return 0;
  const cleaned = String(usdtStr).trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.ceil(num * 100 - 1e-9);
}

// MyStars FaaS v1 integration operates exclusively in Polling mode (GET /v1/orders/{order_id}).
// MYSTARS_WEBHOOK_SECRET and MYSTARS_CALLBACK_URL are strictly optional and unused.

/**
 * Formats a clear Russian buyer-facing error message from a MyStars recipient check result.
 */
export function formatBuyerRecipientIneligibleMessage(params: {
  username: string;
  category: ProductCategory;
  reason?: string | null;
  telegramMessage?: string | null;
}): string {
  const cleanUser = params.username.replace(/^@/, '');
  const reason = (params.reason || '').toLowerCase();
  const tgMsg = (params.telegramMessage || '').trim();

  if (reason.includes('not_found') || reason.includes('unresolved') || reason.includes('no_user')) {
    return `❌ Получатель @${cleanUser} не найден в Telegram. Проверьте правильность написания @username и попробуйте снова.`;
  }
  if (reason.includes('already_subscribed') || reason.includes('already_premium')) {
    return `⚠️ У пользователя @${cleanUser} уже активна подписка Telegram Premium.${tgMsg ? ` (${tgMsg})` : ''}`;
  }
  if (reason.includes('bot') || reason.includes('channel') || reason.includes('invalid_recipient')) {
    return `❌ Получатель @${cleanUser} не может принять ${params.category === 'premium' ? 'Telegram Premium' : 'Telegram Stars'} (аккаунт является ботом, каналом или недоступен).`;
  }
  if (tgMsg) {
    return `❌ Получатель @${cleanUser} не может принять заказ: ${tgMsg}`;
  }
  return `❌ Получатель @${cleanUser} недоступен для выдачи ${params.category === 'premium' ? 'Telegram Premium' : 'Telegram Stars'}${reason ? ` (${reason})` : ''}. Проверьте @username.`;
}

async function defaultMyStarsHttpTransport(
  req: HttpTransportRequest,
): Promise<HttpTransportResponse> {
  const timeoutMs = getEnvConfig().mystarsRequestTimeoutMs || 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const rawText = await response.text();
    let parsed: unknown = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { rawText };
      }
    }
    const headersObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headersObj[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      json: parsed,
      headers: headersObj,
    };
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'));
    const msg = isAbort
      ? `Таймаут запроса к MyStars API (${timeoutMs} мс)`
      : error instanceof Error
        ? error.message
        : String(error);
    throw new MyStarsTransportError(
      redactSecretsFromText(`Ошибка сети при обращении к MyStars API: ${msg}`),
      isAbort,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export class MyStarsClient {
  private transport: ProviderHttpTransport = defaultMyStarsHttpTransport;
  private credentialsOverride: MyStarsCredentialsOverride | null = null;
  public maxTransientGetRetries = 1;
  public retryBaseDelayMs = 250;

  public setHttpTransport(transport: ProviderHttpTransport): void {
    this.transport = transport;
  }

  public resetHttpTransport(): void {
    this.transport = defaultMyStarsHttpTransport;
  }

  public setCredentialsOverride(override: MyStarsCredentialsOverride | null): void {
    this.credentialsOverride = override;
  }

  public getCredentials(): {
    apiBaseUrl: string;
    apiKey: string;
    paymentCurrency: 'usdt_ton' | 'ton';
    pollIntervalMs: number;
    requestTimeoutMs: number;
  } {
    const cfg = getEnvConfig();
    return {
      apiBaseUrl: (this.credentialsOverride?.apiBaseUrl ?? cfg.mystarsApiBaseUrl).trim(),
      apiKey: (this.credentialsOverride?.apiKey ?? cfg.mystarsApiKey).trim(),
      paymentCurrency:
        this.credentialsOverride?.paymentCurrency ?? cfg.mystarsPaymentCurrency ?? 'usdt_ton',
      pollIntervalMs:
        this.credentialsOverride?.pollIntervalMs ?? cfg.mystarsPollIntervalMs ?? 15_000,
      requestTimeoutMs:
        this.credentialsOverride?.requestTimeoutMs ?? cfg.mystarsRequestTimeoutMs ?? 15_000,
    };
  }

  public isConfigured(): boolean {
    const creds = this.getCredentials();
    return Boolean(creds.apiKey && creds.apiKey.length >= 6);
  }

  public getStatusSummary(): {
    configured: boolean;
    mode: 'polling';
    apiBaseUrl: string;
    paymentCurrency: string;
    pollIntervalMs: number;
    requestTimeoutMs: number;
    maskedApiKey: string;
  } {
    const creds = this.getCredentials();
    return {
      configured: this.isConfigured(),
      mode: 'polling',
      apiBaseUrl: buildMyStarsApiV1Url(creds.apiBaseUrl, ''),
      paymentCurrency: creds.paymentCurrency,
      pollIntervalMs: creds.pollIntervalMs,
      requestTimeoutMs: creds.requestTimeoutMs,
      maskedApiKey: maskSecret(creds.apiKey),
    };
  }

  private parseErrorEnvelope(body: unknown): {
    code?: string;
    message?: string;
    telegramMessage?: string;
  } {
    if (!body || typeof body !== 'object') return {};
    const record = body as Record<string, unknown>;
    const inner =
      record.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : record;
    const code = typeof inner.code === 'string' ? inner.code : undefined;
    const message =
      typeof inner.message === 'string'
        ? inner.message
        : typeof inner.detail === 'string'
          ? inner.detail
          : typeof record.message === 'string'
            ? record.message
            : undefined;
    const telegramMessage =
      typeof inner.telegram_message === 'string'
        ? inner.telegram_message
        : typeof record.telegram_message === 'string'
          ? record.telegram_message
          : undefined;
    return { code, message, telegramMessage };
  }

  private async requestJson<T>(params: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<T> {
    const creds = this.getCredentials();
    if (!creds.apiKey) {
      throw new MyStarsApiError({
        message: 'MYSTARS_API_KEY не настроен в окружении сервера.',
        httpStatus: 401,
        code: 'unauthenticated',
        retryable: false,
      });
    }

    let url = buildMyStarsApiV1Url(creds.apiBaseUrl, params.path);
    if (params.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params.query)) {
        if (v !== undefined && v !== null && String(v) !== '') {
          qs.set(k, String(v));
        }
      }
      const queryString = qs.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = {
      'X-Api-Key': creds.apiKey,
      Accept: 'application/json',
      'User-Agent': 'QuizyStars-MyStars-FaaS/1.0',
    };
    if (params.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (params.idempotencyKey) {
      headers['Idempotency-Key'] = params.idempotencyKey;
    }

    const maxAttempts =
      params.method === 'GET' ? Math.max(1, 1 + this.maxTransientGetRetries) : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: HttpTransportResponse;
      try {
        response = await this.transport({
          url,
          method: params.method,
          headers,
          body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
        });
      } catch (transportErr) {
        const wrapped =
          transportErr instanceof MyStarsTransportError
            ? transportErr
            : new MyStarsTransportError(
                redactSecretsFromText(
                  `Ошибка сети при обращении к MyStars API: ${
                    transportErr instanceof Error ? transportErr.message : String(transportErr)
                  }`,
                ),
                transportErr instanceof Error &&
                  (transportErr.name === 'AbortError' ||
                    transportErr.message.toLowerCase().includes('timeout')),
              );
        lastError = wrapped;
        if (attempt < maxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, this.retryBaseDelayMs * attempt)),
          );
          continue;
        }
        throw wrapped;
      }

      const isOk =
        typeof response.ok === 'boolean'
          ? response.ok
          : response.status >= 200 && response.status < 300;
      let parsedJson: unknown = response.json;
      if (
        parsedJson === undefined &&
        typeof (response as { bodyText?: string }).bodyText === 'string'
      ) {
        const rawText = (response as { bodyText?: string }).bodyText || '';
        if (rawText.trim()) {
          try {
            parsedJson = JSON.parse(rawText);
          } catch {
            parsedJson = { message: rawText };
          }
        }
      }

      if (isOk) {
        return parsedJson as T;
      }

      const { code, message, telegramMessage } = this.parseErrorEnvelope(parsedJson);
      const safeMsg = redactSecretsFromText(
        message || `HTTP ${response.status} от MyStars API (${params.path})`,
      );

      if (response.status === 422) {
        throw new MyStarsRecipientIneligibleError({
          message: safeMsg,
          httpStatus: 422,
          code: code || 'recipient_ineligible',
          reason: code || 'recipient_ineligible',
          telegramMessage,
        });
      }

      if (response.status === 429) {
        const respHeaders = response.headers || {};
        const bodyRec =
          parsedJson && typeof parsedJson === 'object'
            ? (parsedJson as Record<string, unknown>)
            : {};
        const explicitLimitType =
          typeof bodyRec.limit_type === 'string' ? bodyRec.limit_type.toLowerCase() : '';
        const hasRateLimitHeader =
          'ratelimit-limit' in respHeaders ||
          'RateLimit-Limit' in respHeaders ||
          'retry-after' in respHeaders ||
          'Retry-After' in respHeaders;
        const retryAfterRaw =
          respHeaders['retry-after'] ??
          respHeaders['Retry-After'] ??
          (typeof bodyRec.retry_after === 'number' || typeof bodyRec.retry_after === 'string'
            ? bodyRec.retry_after
            : undefined);
        const retryAfterSeconds = parseRetryAfterSeconds(retryAfterRaw);
        const kind: 'general' | 'order_cap' =
          explicitLimitType === 'order_cap'
            ? 'order_cap'
            : explicitLimitType === 'general'
              ? 'general'
              : hasRateLimitHeader
                ? 'general'
                : 'order_cap';
        throw new MyStarsRateLimitError({
          message:
            kind === 'order_cap'
              ? `Превышен лимит неоплаченных заказов MyStars (order_cap / awaiting_payment): ${safeMsg}`
              : `Превышен лимит запросов к MyStars API (429): ${safeMsg}`,
          kind,
          retryAfterSeconds,
          code,
        });
      }

      const retryable =
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;

      const apiErr = new MyStarsApiError({
        message: safeMsg,
        httpStatus: response.status,
        code,
        telegramMessage,
        retryable,
      });

      lastError = apiErr;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, this.retryBaseDelayMs * attempt)),
        );
        continue;
      }

      throw apiErr;
    }

    throw lastError;
  }

  private ensurePlainObject(raw: unknown, endpoint: string): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new MyStarsValidationError({
        message: `Некорректный JSON-ответ MyStars API (${endpoint}): ожидался объект, получено ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}.`,
        endpoint,
      });
    }
    const rec = raw as Record<string, unknown>;
    if (
      'rawText' in rec &&
      Object.keys(rec).length === 1 &&
      typeof rec.rawText === 'string'
    ) {
      throw new MyStarsValidationError({
        message: `Некорректный не-JSON ответ MyStars API (${endpoint}): ${rec.rawText.slice(0, 120)}`,
        endpoint,
      });
    }
    return rec;
  }

  private validateNonEmptyString(
    value: unknown,
    field: string,
    endpoint: string,
  ): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле ${field} должно быть непустой строкой.`,
        endpoint,
      });
    }
    return value.trim();
  }

  private validateNullableString(
    value: unknown,
    field: string,
    endpoint: string,
  ): string | null | undefined {
    if (value === undefined || value === null) {
      return value;
    }
    if (typeof value !== 'string') {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле ${field} должно быть строкой или null.`,
        endpoint,
      });
    }
    return value;
  }

  private validateNumericString(
    value: unknown,
    field: string,
    endpoint: string,
  ): string {
    let normalized = '';
    if (typeof value === 'string') {
      normalized = value.trim();
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      normalized = String(value);
    } else {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле ${field} должно быть числовой строкой.`,
        endpoint,
      });
    }

    if (
      !normalized ||
      !/^\d+(\.\d+)?$/.test(normalized) ||
      !Number.isFinite(Number(normalized))
    ) {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле ${field} содержит некорректное числовое значение "${normalized.slice(0, 40)}".`,
        endpoint,
      });
    }
    return normalized;
  }

  private validateNullableNumericString(
    value: unknown,
    field: string,
    endpoint: string,
  ): string | null | undefined {
    if (value === undefined || value === null) {
      return value;
    }
    return this.validateNumericString(value, field, endpoint);
  }

  private validateNullablePositiveInt(
    value: unknown,
    field: string,
    endpoint: string,
  ): number | null | undefined {
    if (value === undefined || value === null) {
      return value;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле ${field} должно быть положительным целым числом или null.`,
        endpoint,
      });
    }
    return value;
  }

  private validateProductType(
    value: unknown,
    field: string,
    endpoint: string,
  ): MyStarsProductType {
    if (value !== 'stars' && value !== 'premium') {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле ${field} должно быть "stars" или "premium".`,
        endpoint,
      });
    }
    return value;
  }

  private validateFeeBreakdown(
    raw: unknown,
    field: string,
    endpoint: string,
  ): MyStarsFeeBreakdown {
    const rec = this.ensurePlainObject(raw, `${endpoint}.${field}`);
    const subtotal = this.validateNumericString(rec.subtotal, `${field}.subtotal`, endpoint);
    const processing_fee = this.validateNumericString(
      rec.processing_fee,
      `${field}.processing_fee`,
      endpoint,
    );
    const total = this.validateNumericString(rec.total, `${field}.total`, endpoint);
    const currency = this.validateNonEmptyString(rec.currency, `${field}.currency`, endpoint);
    const description =
      rec.description === undefined
        ? ''
        : typeof rec.description === 'string'
          ? rec.description
          : (() => {
              throw new MyStarsValidationError({
                message: `Некорректная схема ответа MyStars API (${endpoint}): поле ${field}.description должно быть строкой.`,
                endpoint,
              });
            })();
    const kind = this.validateNullableString(rec.kind, `${field}.kind`, endpoint);
    return {
      subtotal,
      processing_fee,
      total,
      description,
      currency,
      ...(typeof kind === 'string' ? { kind } : {}),
    };
  }

  private validatePaymentInstruction(
    raw: unknown,
    field: string,
    endpoint: string,
  ): MyStarsPaymentInstruction {
    const rec = this.ensurePlainObject(raw, `${endpoint}.${field}`);
    const currency = this.validateNonEmptyString(rec.currency, `${field}.currency`, endpoint);
    const chain = this.validateNonEmptyString(rec.chain, `${field}.chain`, endpoint);
    const amount = this.validateNumericString(rec.amount, `${field}.amount`, endpoint);
    const amount_units = this.validateNumericString(
      rec.amount_units,
      `${field}.amount_units`,
      endpoint,
    );
    const pay_to_address = this.validateNullableString(
      rec.pay_to_address,
      `${field}.pay_to_address`,
      endpoint,
    );
    const memo = this.validateNullableString(rec.memo, `${field}.memo`, endpoint);
    const fee =
      rec.fee === undefined || rec.fee === null
        ? (rec.fee as null | undefined)
        : this.validateFeeBreakdown(rec.fee, `${field}.fee`, endpoint);

    return {
      currency,
      chain,
      ...(pay_to_address !== undefined ? { pay_to_address } : {}),
      ...(memo !== undefined ? { memo } : {}),
      amount,
      amount_units,
      ...(fee !== undefined ? { fee } : {}),
    };
  }

  private validateCurrenciesResponse(
    raw: unknown,
    endpoint: string,
  ): MyStarsCurrencyInfo[] {
    let list: unknown[];
    if (Array.isArray(raw)) {
      list = raw;
    } else {
      const rec = this.ensurePlainObject(raw, endpoint);
      if (!Array.isArray(rec.currencies)) {
        throw new MyStarsValidationError({
          message: `Некорректная схема ответа MyStars API (${endpoint}): ожидался массив валют или поле currencies[].`,
          endpoint,
        });
      }
      list = rec.currencies;
    }

    return list.map((item, idx) => {
      const itemRec = this.ensurePlainObject(item, `${endpoint}[${idx}]`);
      return {
        code: this.validateNonEmptyString(itemRec.code, `[${idx}].code`, endpoint),
        chain: this.validateNonEmptyString(itemRec.chain, `[${idx}].chain`, endpoint),
        name: this.validateNonEmptyString(itemRec.name, `[${idx}].name`, endpoint),
      };
    });
  }

  private validateProductsResponse(
    raw: unknown,
    endpoint: string,
  ): MyStarsProductInfo[] {
    let list: unknown[];
    if (Array.isArray(raw)) {
      list = raw;
    } else {
      const rec = this.ensurePlainObject(raw, endpoint);
      if (!Array.isArray(rec.products)) {
        throw new MyStarsValidationError({
          message: `Некорректная схема ответа MyStars API (${endpoint}): ожидался массив продуктов или поле products[].`,
          endpoint,
        });
      }
      list = rec.products;
    }

    return list.map((item, idx) => {
      const itemRec = this.ensurePlainObject(item, `${endpoint}[${idx}]`);
      const type = this.validateProductType(itemRec.type, `[${idx}].type`, endpoint);
      const name = this.validateNonEmptyString(itemRec.name, `[${idx}].name`, endpoint);
      if (itemRec.parameter !== 'quantity' && itemRec.parameter !== 'months') {
        throw new MyStarsValidationError({
          message: `Некорректная схема ответа MyStars API (${endpoint}): поле [${idx}].parameter должно быть "quantity" или "months".`,
          endpoint,
        });
      }
      const min = itemRec.min;
      const max = itemRec.max;
      if (
        typeof min !== 'number' ||
        !Number.isFinite(min) ||
        min <= 0 ||
        typeof max !== 'number' ||
        !Number.isFinite(max) ||
        max < min
      ) {
        throw new MyStarsValidationError({
          message: `Некорректная схема ответа MyStars API (${endpoint}): поля [${idx}].min и [${idx}].max должны быть корректными положительными числами (min <= max).`,
          endpoint,
        });
      }

      let values: number[] | null | undefined;
      if (itemRec.values === undefined || itemRec.values === null) {
        values = itemRec.values;
      } else if (Array.isArray(itemRec.values)) {
        values = itemRec.values.map((v, vIdx) => {
          if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
            throw new MyStarsValidationError({
              message: `Некорректная схема ответа MyStars API (${endpoint}): поле [${idx}].values[${vIdx}] должно быть положительным числом.`,
              endpoint,
            });
          }
          return v;
        });
      } else {
        throw new MyStarsValidationError({
          message: `Некорректная схема ответа MyStars API (${endpoint}): поле [${idx}].values должно быть массивом чисел или null.`,
          endpoint,
        });
      }

      return {
        type,
        name,
        parameter: itemRec.parameter,
        min,
        max,
        ...(values !== undefined ? { values } : {}),
      };
    });
  }

  private validatePricingResponse(raw: unknown, endpoint: string): MyStarsPricingQuote {
    const rec = this.ensurePlainObject(raw, endpoint);
    const type = this.validateProductType(rec.type, 'type', endpoint);
    const amount = this.validateNumericString(rec.amount, 'amount', endpoint);
    const currency = this.validateNonEmptyString(rec.currency, 'currency', endpoint);
    const quantity = this.validateNullablePositiveInt(rec.quantity, 'quantity', endpoint);
    const months = this.validateNullablePositiveInt(rec.months, 'months', endpoint);
    const fee =
      rec.fee === undefined || rec.fee === null
        ? (rec.fee as null | undefined)
        : this.validateFeeBreakdown(rec.fee, 'fee', endpoint);
    const usdt_per_ton = this.validateNullableNumericString(
      rec.usdt_per_ton,
      'usdt_per_ton',
      endpoint,
    );

    return {
      type,
      ...(quantity !== undefined ? { quantity } : {}),
      ...(months !== undefined ? { months } : {}),
      amount,
      currency,
      ...(fee !== undefined ? { fee } : {}),
      ...(usdt_per_ton !== undefined ? { usdt_per_ton } : {}),
    };
  }

  private validateRecipientCheckResponse(
    raw: unknown,
    endpoint: string,
  ): MyStarsRecipientCheckResult {
    const rec = this.ensurePlainObject(raw, endpoint);
    if (rec.resolved !== undefined && typeof rec.resolved !== 'boolean') {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле resolved должно быть булевым.`,
        endpoint,
      });
    }
    if (rec.eligible !== undefined && typeof rec.eligible !== 'boolean') {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле eligible должно быть булевым.`,
        endpoint,
      });
    }
    if (rec.indeterminate !== undefined && typeof rec.indeterminate !== 'boolean') {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле indeterminate должно быть булевым.`,
        endpoint,
      });
    }

    const hasBooleanFlags =
      typeof rec.resolved === 'boolean' && typeof rec.eligible === 'boolean';
    const hasIndeterminate = typeof rec.indeterminate === 'boolean';
    if (!hasBooleanFlags && !hasIndeterminate) {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): отсутствуют обязательные булевы поля resolved/eligible или indeterminate.`,
        endpoint,
      });
    }

    const recipient_name = this.validateNullableString(
      rec.recipient_name,
      'recipient_name',
      endpoint,
    );
    const reason = this.validateNullableString(rec.reason, 'reason', endpoint);
    const telegram_message = this.validateNullableString(
      rec.telegram_message,
      'telegram_message',
      endpoint,
    );

    return {
      resolved: typeof rec.resolved === 'boolean' ? rec.resolved : false,
      eligible: typeof rec.eligible === 'boolean' ? rec.eligible : false,
      ...(typeof rec.indeterminate === 'boolean' ? { indeterminate: rec.indeterminate } : {}),
      ...(recipient_name !== undefined ? { recipient_name } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(telegram_message !== undefined ? { telegram_message } : {}),
    };
  }

  private validateCreateOrderResponse(
    raw: unknown,
    endpoint: string,
  ): MyStarsCreateOrderResult {
    const rec = this.ensurePlainObject(raw, endpoint);
    const orderIdRaw = rec.order_id !== undefined ? rec.order_id : rec.id;
    const order_id = this.validateNonEmptyString(orderIdRaw, 'order_id', endpoint);
    const status = this.validateNonEmptyString(rec.status, 'status', endpoint);
    const type = this.validateProductType(rec.type, 'type', endpoint);
    const quantity = this.validateNullablePositiveInt(rec.quantity, 'quantity', endpoint);
    const months = this.validateNullablePositiveInt(rec.months, 'months', endpoint);
    const purchase_tx = this.validateNullableString(rec.purchase_tx, 'purchase_tx', endpoint);
    const expires_at = this.validateNullableString(rec.expires_at, 'expires_at', endpoint);

    if (typeof expires_at === 'string' && !expires_at.trim()) {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле expires_at не может быть пустой строкой.`,
        endpoint,
      });
    }
    if (status.toLowerCase() === 'awaiting_payment' && !expires_at) {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): отсутствует обязательное поле expires_at для статуса awaiting_payment.`,
        endpoint,
      });
    }

    let payment: MyStarsPaymentInstruction;
    if (rec.payment !== undefined && rec.payment !== null) {
      payment = this.validatePaymentInstruction(rec.payment, 'payment', endpoint);
    } else {
      // Documented flat response variant (currency + payment_amount + optional pay_to_address/payment_memo/service_fee_usdt)
      const flatCurrency = this.validateNonEmptyString(rec.currency, 'currency', endpoint);
      const flatAmount = this.validateNumericString(
        rec.payment_amount,
        'payment_amount',
        endpoint,
      );
      const flatPayTo = this.validateNullableString(
        rec.pay_to_address,
        'pay_to_address',
        endpoint,
      );
      const flatMemo = this.validateNullableString(
        rec.payment_memo,
        'payment_memo',
        endpoint,
      );
      const flatServiceFee = this.validateNullableNumericString(
        rec.service_fee_usdt,
        'service_fee_usdt',
        endpoint,
      );
      const flatSubtotal = this.validateNullableNumericString(
        rec.fragment_cost_usdt,
        'fragment_cost_usdt',
        endpoint,
      );
      payment = {
        currency: flatCurrency,
        chain: 'ton',
        amount: flatAmount,
        amount_units: flatAmount,
        ...(flatPayTo !== undefined ? { pay_to_address: flatPayTo } : {}),
        ...(flatMemo !== undefined ? { memo: flatMemo } : {}),
        ...(flatServiceFee !== undefined && flatServiceFee !== null
          ? {
              fee: {
                subtotal: flatSubtotal ?? flatAmount,
                processing_fee: flatServiceFee,
                total: flatAmount,
                description: 'MyStars service fee',
                currency: flatCurrency,
              },
            }
          : {}),
      };
    }

    return {
      order_id,
      status,
      type,
      ...(quantity !== undefined ? { quantity } : {}),
      ...(months !== undefined ? { months } : {}),
      payment,
      ...(expires_at !== undefined ? { expires_at } : {}),
      ...(purchase_tx !== undefined ? { purchase_tx } : {}),
    };
  }

  private validateOrderRecordResponse(
    raw: unknown,
    endpoint: string,
  ): MyStarsOrderRecord {
    const rec = this.ensurePlainObject(raw, endpoint);
    const orderIdRaw = rec.order_id !== undefined ? rec.order_id : rec.id;
    const order_id = this.validateNonEmptyString(orderIdRaw, 'order_id', endpoint);
    const status = this.validateNonEmptyString(rec.status, 'status', endpoint);
    const type = this.validateProductType(rec.type, 'type', endpoint);
    const created_at = this.validateNonEmptyString(rec.created_at, 'created_at', endpoint);
    const updated_at =
      rec.updated_at === undefined || rec.updated_at === null
        ? created_at
        : this.validateNonEmptyString(rec.updated_at, 'updated_at', endpoint);

    const recipient_username = this.validateNullableString(
      rec.recipient_username,
      'recipient_username',
      endpoint,
    );
    const quantity = this.validateNullablePositiveInt(rec.quantity, 'quantity', endpoint);
    const months = this.validateNullablePositiveInt(rec.months, 'months', endpoint);
    const amount_ton = this.validateNullableNumericString(
      rec.amount_ton,
      'amount_ton',
      endpoint,
    );
    const payment_tx = this.validateNullableString(rec.payment_tx, 'payment_tx', endpoint);
    const purchase_tx = this.validateNullableString(rec.purchase_tx, 'purchase_tx', endpoint);
    const failure_reason = this.validateNullableString(
      rec.failure_reason,
      'failure_reason',
      endpoint,
    );
    const reversal_tx = this.validateNullableString(rec.reversal_tx, 'reversal_tx', endpoint);
    const telegram_message = this.validateNullableString(
      rec.telegram_message,
      'telegram_message',
      endpoint,
    );
    const expires_at = this.validateNullableString(rec.expires_at, 'expires_at', endpoint);
    const payment =
      rec.payment === undefined || rec.payment === null
        ? (rec.payment as null | undefined)
        : this.validatePaymentInstruction(rec.payment, 'payment', endpoint);
    const currency = this.validateNullableString(rec.currency, 'currency', endpoint);
    const payment_amount = this.validateNullableNumericString(
      rec.payment_amount,
      'payment_amount',
      endpoint,
    );
    const service_fee_usdt = this.validateNullableNumericString(
      rec.service_fee_usdt,
      'service_fee_usdt',
      endpoint,
    );

    return {
      order_id,
      status,
      type,
      ...(recipient_username !== undefined ? { recipient_username } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(months !== undefined ? { months } : {}),
      ...(amount_ton !== undefined ? { amount_ton } : {}),
      ...(payment_tx !== undefined ? { payment_tx } : {}),
      ...(purchase_tx !== undefined ? { purchase_tx } : {}),
      ...(failure_reason !== undefined ? { failure_reason } : {}),
      ...(reversal_tx !== undefined ? { reversal_tx } : {}),
      ...(telegram_message !== undefined ? { telegram_message } : {}),
      created_at,
      updated_at,
      ...(expires_at !== undefined ? { expires_at } : {}),
      ...(payment !== undefined ? { payment } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(payment_amount !== undefined ? { payment_amount } : {}),
      ...(service_fee_usdt !== undefined ? { service_fee_usdt } : {}),
    };
  }

  private validateOrderPageResponse(raw: unknown, endpoint: string): MyStarsOrderPage {
    if (Array.isArray(raw)) {
      return {
        orders: raw.map((item, idx) =>
          this.validateOrderRecordResponse(item, `${endpoint}[${idx}]`),
        ),
        next_cursor: null,
      };
    }
    const rec = this.ensurePlainObject(raw, endpoint);
    if (!Array.isArray(rec.orders)) {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле orders должно быть массивом.`,
        endpoint,
      });
    }
    if (
      rec.next_cursor !== undefined &&
      rec.next_cursor !== null &&
      typeof rec.next_cursor !== 'string'
    ) {
      throw new MyStarsValidationError({
        message: `Некорректная схема ответа MyStars API (${endpoint}): поле next_cursor должно быть строкой или null.`,
        endpoint,
      });
    }
    return {
      orders: rec.orders.map((item, idx) =>
        this.validateOrderRecordResponse(item, `${endpoint}.orders[${idx}]`),
      ),
      next_cursor:
        typeof rec.next_cursor === 'string' && rec.next_cursor.trim()
          ? rec.next_cursor.trim()
          : null,
    };
  }

  private validateCancelOrderResponse(
    raw: unknown,
    cleanId: string,
    endpoint: string,
  ): MyStarsCancelResult {
    if (raw === null || raw === undefined) {
      return { order_id: cleanId, status: 'cancelled' };
    }
    const rec = this.ensurePlainObject(raw, endpoint);
    const orderIdRaw = rec.order_id !== undefined ? rec.order_id : rec.id;
    const order_id = this.validateNonEmptyString(orderIdRaw, 'order_id', endpoint);
    const status = this.validateNonEmptyString(rec.status, 'status', endpoint);
    return { order_id, status };
  }

  public async getCurrencies(): Promise<MyStarsCurrencyInfo[]> {
    const raw = await this.requestJson<unknown>({
      method: 'GET',
      path: '/currencies',
    });
    return this.validateCurrenciesResponse(raw, 'GET /v1/currencies');
  }

  public async getProducts(): Promise<MyStarsProductInfo[]> {
    const raw = await this.requestJson<unknown>({
      method: 'GET',
      path: '/products',
    });
    return this.validateProductsResponse(raw, 'GET /v1/products');
  }

  public async getPricing(params: {
    type: MyStarsProductType;
    quantity?: number;
    months?: number;
    paymentCurrency?: MyStarsPaymentCurrency;
  }): Promise<MyStarsPricingQuote> {
    const creds = this.getCredentials();
    const query: Record<string, string | number | undefined> = {
      type: params.type,
      payment_currency: params.paymentCurrency ?? creds.paymentCurrency,
    };
    if (params.type === 'stars') {
      query.quantity = validateMyStarsQuantity(params.quantity ?? 50);
    } else {
      query.months = validateMyStarsMonths(params.months);
    }
    const raw = await this.requestJson<unknown>({
      method: 'GET',
      path: '/pricing',
      query,
    });
    return this.validatePricingResponse(raw, 'GET /v1/pricing');
  }

  public async checkRecipient(params: {
    type: MyStarsProductType;
    username: string;
    months?: number;
  }): Promise<MyStarsRecipientCheckResult> {
    const cleanUsername = validateMyStarsUsername(params.username);
    const body: Record<string, unknown> = {
      type: params.type,
      recipient: { username: cleanUsername },
    };
    if (params.type === 'premium' && params.months !== undefined) {
      body.months = validateMyStarsMonths(params.months);
    }
    const raw = await this.requestJson<unknown>({
      method: 'POST',
      path: '/recipients/check',
      body,
    });
    return this.validateRecipientCheckResponse(raw, 'POST /v1/recipients/check');
  }

  public async createOrder(params: {
    type: MyStarsProductType;
    username: string;
    quantity?: number;
    months?: number;
    paymentCurrency?: MyStarsPaymentCurrency;
    idempotencyKey?: string;
  }): Promise<MyStarsCreateOrderResult> {
    const creds = this.getCredentials();
    const cleanUsername = validateMyStarsUsername(params.username);
    const body: Record<string, unknown> = {
      type: params.type,
      recipient: { username: cleanUsername },
      payment_currency: params.paymentCurrency ?? creds.paymentCurrency,
    };

    if (params.type === 'stars') {
      body.quantity = validateMyStarsQuantity(params.quantity ?? 0);
    } else {
      body.months = validateMyStarsMonths(params.months);
    }

    // Polling-only mode: callback_url is intentionally omitted so MyStars order tracking
    // relies exclusively on GET /v1/orders/{order_id} without requiring public webhook URLs.
    const raw = await this.requestJson<unknown>({
      method: 'POST',
      path: '/orders',
      body,
      idempotencyKey: params.idempotencyKey || crypto.randomUUID(),
    });
    return this.validateCreateOrderResponse(raw, 'POST /v1/orders');
  }

  public async getOrder(mystarsOrderId: string): Promise<MyStarsOrderRecord> {
    const cleanId = (mystarsOrderId || '').trim();
    if (!cleanId) {
      throw new MyStarsApiError({
        message: 'Не указан идентификатор заказа MyStars (order_id).',
        httpStatus: 400,
        code: 'invalid_order_id',
        retryable: false,
      });
    }
    const path = `/orders/${encodeURIComponent(cleanId)}`;
    const raw = await this.requestJson<unknown>({
      method: 'GET',
      path,
    });
    return this.validateOrderRecordResponse(raw, `GET /v1${path}`);
  }

  public async cancelOrder(mystarsOrderId: string): Promise<MyStarsCancelResult> {
    const cleanId = (mystarsOrderId || '').trim();
    if (!cleanId) {
      throw new MyStarsApiError({
        message: 'Не указан идентификатор заказа MyStars (order_id).',
        httpStatus: 400,
        code: 'invalid_order_id',
        retryable: false,
      });
    }
    const path = `/orders/${encodeURIComponent(cleanId)}/cancel`;
    const raw = await this.requestJson<unknown>({
      method: 'POST',
      path,
    });
    return this.validateCancelOrderResponse(raw, cleanId, `POST /v1${path}`);
  }

  public async listOrders(params?: {
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<MyStarsOrderPage> {
    const raw = await this.requestJson<unknown>({
      method: 'GET',
      path: '/orders',
      query: {
        status: params?.status,
        limit: params?.limit ?? 20,
        cursor: params?.cursor,
      },
    });
    return this.validateOrderPageResponse(raw, 'GET /v1/orders');
  }

  /**
   * Pre-validates a Telegram recipient @username BEFORE creating a payment invoice
   * or deducting the buyer's internal USD balance.
   *
   * Behavior:
   * 1. For `gifts` category: no MyStars recipient check is needed.
   * 2. Always validates canonical Telegram @username syntax locally.
   * 3. When MyStars is configured (`MYSTARS_API_KEY` set), calls `POST /v1/recipients/check`.
   *    - If `eligible === false` and `!indeterminate`, throws `MyStarsRecipientIneligibleError`
   *      with a clear Russian buyer-facing error message so the buyer is NEVER charged.
   *    - If `indeterminate === true` or transient network error occurs on pre-check,
   *      fails open as recommended by the official MyStars FaaS v1 SDK so transient
   *      upstream lookup timeouts do not break checkout.
   */
  public async validateRecipientBeforeCheckout(params: {
    category: ProductCategory;
    recipientUsername?: string;
    durationMonths?: number;
  }): Promise<{
    checked: boolean;
    normalizedUsername?: string;
    recipientName?: string | null;
    indeterminate?: boolean;
  }> {
    if (params.category !== 'stars' && params.category !== 'premium') {
      return { checked: false };
    }

    const normalizedUsername = validateMyStarsUsername(params.recipientUsername);
    if (params.category === 'premium' && params.durationMonths !== undefined) {
      validateMyStarsMonths(params.durationMonths);
    }

    if (!this.isConfigured()) {
      return {
        checked: false,
        normalizedUsername,
      };
    }

    try {
      const check = await this.checkRecipient({
        type: params.category,
        username: normalizedUsername,
        months: params.category === 'premium' ? params.durationMonths : undefined,
      });

      if (check.indeterminate) {
        return {
          checked: true,
          normalizedUsername,
          recipientName: check.recipient_name,
          indeterminate: true,
        };
      }

      if (!check.resolved || !check.eligible) {
        const buyerMessage = formatBuyerRecipientIneligibleMessage({
          username: normalizedUsername,
          category: params.category,
          reason: check.reason || (!check.resolved ? 'recipient_not_found' : 'ineligible'),
          telegramMessage: check.telegram_message,
        });
        throw new MyStarsRecipientIneligibleError({
          message: buyerMessage,
          httpStatus: 422,
          code: check.reason || 'recipient_ineligible',
          reason: check.reason || 'recipient_ineligible',
          telegramMessage: check.telegram_message || undefined,
        });
      }

      return {
        checked: true,
        normalizedUsername,
        recipientName: check.recipient_name,
        indeterminate: false,
      };
    } catch (error) {
      if (error instanceof MyStarsRecipientIneligibleError) {
        // If HTTP 422 came directly from MyStars API, format a buyer-friendly message
        const buyerMessage = error.message.startsWith('❌') || error.message.startsWith('⚠️')
          ? error.message
          : formatBuyerRecipientIneligibleMessage({
              username: normalizedUsername,
              category: params.category,
              reason: error.reason || error.code,
              telegramMessage: error.telegramMessage || error.message,
            });
        throw new MyStarsRecipientIneligibleError({
          message: buyerMessage,
          httpStatus: error.httpStatus,
          code: error.code,
          reason: error.reason,
          telegramMessage: error.telegramMessage,
        });
      }
      // If pre-check encountered a transient 5xx or network timeout, fail open like indeterminate=true
      if (
        error instanceof MyStarsTransportError ||
        (error instanceof MyStarsApiError && error.retryable)
      ) {
        return {
          checked: false,
          normalizedUsername,
          indeterminate: true,
        };
      }
      throw error;
    }
  }
}

export const myStarsClient = new MyStarsClient();

/**
 * Production FulfillmentProviderAdapter for MyStars FaaS v1 (`https://api.mystars.tg/v1`)
 * operating exclusively via Polling.
 *
 * Architectural contract of MyStars FaaS v1 (Polling-Only):
 * - `POST /v1/orders` creates an idempotent fulfillment order (`Idempotency-Key`, no `callback_url`).
 * - MyStars returns `{ order_id, status, payment: { pay_to_address, memo, amount, currency }, expires_at }`.
 * - When `status` is `"delivered"` or `"completed"`, the adapter marks the order completed automatically.
 * - When `status` is `"awaiting_payment"` or an active processing state (`"paid"`, `"purchasing"`, `"fulfilling"`, etc.),
 *   the adapter persists `mystarsOrderId`, status, payment instructions, and wholesale P&L on the Firestore `Order`,
 *   and returns `{ handledAutomatically: false, status: 'processing' }` so that the background polling worker
 *   (`GET /v1/orders/{order_id}`) tracks status transitions until terminal completion or failure — including across restarts.
 */
export class MyStarsFulfillmentAdapter implements FulfillmentProviderAdapter {
  public readonly providerName = 'MyStarsFaaS (Автовыдача Stars & Premium v1, Polling)';
  public readonly name = 'mystars-faas-v1';
  public readonly supportsIdempotency = true;
  private readonly client: MyStarsClient;

  constructor(client: MyStarsClient = myStarsClient) {
    this.client = client;
  }

  public isConfigured(): boolean {
    return this.client.isConfigured();
  }

  private async persistMyStarsOrderMetadata(
    order: Order,
    updates: Partial<Order>,
  ): Promise<void> {
    try {
      await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
        ...updates,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Best-effort metadata persistence; main FulfillmentService transaction still runs
    }
  }

  private computeOrderPnLUpdates(params: {
    order: Order;
    wholesaleTotalUsdt: string;
    processingFeeUsdt?: string;
    currency: 'usdt_ton' | 'ton';
  }): Partial<Order> {
    const grossRevenueUsdCents = params.order.grossRevenueUsdCents ?? params.order.totalPriceUsdCents;
    const providerFeeUsdCents = params.order.providerFeeUsdCents ?? 0;
    const mystarsCostUsdCents = usdtDecimalToUsdCents(params.wholesaleTotalUsdt);
    const tonNetworkFeeUsdCents = usdtDecimalToUsdCents(params.processingFeeUsdt);
    const netProfitUsdCents =
      grossRevenueUsdCents - providerFeeUsdCents - mystarsCostUsdCents;

    return {
      grossRevenueUsdCents,
      providerFeeUsdCents,
      mystarsCurrency: params.currency,
      mystarsWholesaleCostUsdt: params.wholesaleTotalUsdt,
      mystarsCostUsdCents,
      tonNetworkFeeUsdCents,
      netProfitUsdCents,
    };
  }

  /**
   * Multi-page reconciliation via `GET /v1/orders` (following `next_cursor`) when a previous
   * `POST /v1/orders` timed out or dropped before `mystarsOrderId` was persisted in Firestore.
   *
   * Strict matching safety guarantees:
   * - Never matches candidates when `recipient_username`, `quantity`/`months`, or valid `created_at`
   *   are missing; instead counts them as incomplete candidates and returns `insufficient_data` so
   *   the order is quarantined rather than risk duplicate creation.
   * - Never returns `not_found` when pagination is truncated (exceeds maxPages or cursor loop).
   * - Returns `found` ONLY when there is exactly 1 full-signal match, 0 incomplete candidates,
   *   and pagination completed cleanly without truncation.
   */
  public async reconcileAmbiguousCreateOrder(
    order: Order,
    options?: { maxPages?: number; pageLimit?: number },
  ): Promise<MyStarsReconcileCreateResult> {
    if (!this.client.isConfigured()) {
      return { status: 'not_found', pagesScanned: 0 };
    }
    if (order.category !== 'stars' && order.category !== 'premium') {
      return { status: 'not_found', pagesScanned: 0 };
    }

    let cleanUsername: string;
    try {
      cleanUsername = validateMyStarsUsername(order.recipientUsername || order.username);
    } catch {
      return {
        status: 'insufficient_data',
        reason: 'Отсутствует или некорректен username получателя для безопасной сверки POST /v1/orders.',
        incompleteCount: 0,
        pagesScanned: 0,
      };
    }

    const expectedQuantity =
      order.category === 'stars' ? Number(order.quantity) : undefined;
    const expectedMonths =
      order.category === 'premium' ? Number(order.durationMonths ?? 3) : undefined;

    if (
      order.category === 'stars' &&
      (!Number.isInteger(expectedQuantity) || (expectedQuantity ?? 0) <= 0)
    ) {
      return {
        status: 'insufficient_data',
        reason: 'Отсутствует корректное количество Stars для сверки заказа в MyStars.',
        incompleteCount: 0,
        pagesScanned: 0,
      };
    }
    if (
      order.category === 'premium' &&
      (!Number.isInteger(expectedMonths) || (expectedMonths ?? 0) <= 0)
    ) {
      return {
        status: 'insufficient_data',
        reason: 'Отсутствует корректный срок Premium (months) для сверки заказа в MyStars.',
        incompleteCount: 0,
        pagesScanned: 0,
      };
    }

    const startedAtMs = order.fulfillmentStartedAt
      ? Date.parse(order.fulfillmentStartedAt)
      : Date.parse(order.createdAt);
    if (!Number.isFinite(startedAtMs)) {
      return {
        status: 'insufficient_data',
        reason: 'Отсутствует валидная временная метка запуска выдачи для сверки GET /v1/orders.',
        incompleteCount: 0,
        pagesScanned: 0,
      };
    }

    const ambiguousAtMs = order.mystarsAmbiguousPostAt
      ? Date.parse(order.mystarsAmbiguousPostAt)
      : NaN;
    const windowStartMs = startedAtMs - 60_000;
    const windowEndMs =
      Math.max(Date.now(), Number.isFinite(ambiguousAtMs) ? ambiguousAtMs : 0) + 60_000;

    const maxPages = Math.max(1, options?.maxPages ?? 10);
    const pageLimit = Math.max(1, Math.min(100, options?.pageLimit ?? 50));

    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    const seenOrderIds = new Set<string>();
    const confirmedMatches: MyStarsOrderRecord[] = [];
    let incompleteCandidates = 0;
    let pagesScanned = 0;
    let truncated = false;
    let cursorLoopDetected = false;

    while (pagesScanned < maxPages) {
      const page = await this.client.listOrders({ limit: pageLimit, cursor });
      pagesScanned += 1;

      for (const item of page.orders) {
        if (seenOrderIds.has(item.order_id)) continue;
        seenOrderIds.add(item.order_id);

        if (item.type !== order.category) continue;

        let hasMissingSignal = false;

        // 1. Validate created_at time window strictly (never match without valid created_at)
        const itemCreatedMs = Date.parse(item.created_at);
        if (Number.isFinite(itemCreatedMs)) {
          if (itemCreatedMs < windowStartMs || itemCreatedMs > windowEndMs) {
            continue;
          }
        } else {
          hasMissingSignal = true;
        }

        // 2. Validate recipient_username strictly (never match if missing)
        const itemUser =
          typeof item.recipient_username === 'string'
            ? item.recipient_username.trim().replace(/^@/, '').toLowerCase()
            : '';
        if (itemUser) {
          if (itemUser !== cleanUsername) {
            continue;
          }
        } else {
          hasMissingSignal = true;
        }

        // 3. Validate quantity (stars) or months (premium) strictly (never match if missing)
        if (order.category === 'stars') {
          if (item.quantity !== undefined && item.quantity !== null) {
            if (Number(item.quantity) !== expectedQuantity) {
              continue;
            }
          } else {
            hasMissingSignal = true;
          }
        } else {
          if (item.months !== undefined && item.months !== null) {
            if (Number(item.months) !== expectedMonths) {
              continue;
            }
          } else {
            hasMissingSignal = true;
          }
        }

        if (hasMissingSignal) {
          incompleteCandidates += 1;
        } else {
          confirmedMatches.push(item);
        }
      }

      const nextCursor = page.next_cursor?.trim() || null;
      if (!nextCursor) {
        break;
      }
      if (seenCursors.has(nextCursor)) {
        cursorLoopDetected = true;
        truncated = true;
        break;
      }
      seenCursors.add(nextCursor);

      if (pagesScanned >= maxPages) {
        truncated = true;
        break;
      }
      cursor = nextCursor;
    }

    if (confirmedMatches.length > 1) {
      return {
        status: 'ambiguous_multiple',
        count: confirmedMatches.length,
        pagesScanned,
      };
    }

    if (incompleteCandidates > 0) {
      return {
        status: 'insufficient_data',
        reason: `В GET /v1/orders найдены кандидаты (${incompleteCandidates}) с неполными данными (отсутствует recipient_username, quantity/months или валидный created_at). Автоповтор POST /v1/orders заблокирован для защиты от дублирования.`,
        incompleteCount: incompleteCandidates,
        pagesScanned,
      };
    }

    if (truncated) {
      return {
        status: 'insufficient_data',
        reason: cursorLoopDetected
          ? `Обнаружен повтор курсора next_cursor при пагинации GET /v1/orders (${pagesScanned} стр.). Автоповтор POST /v1/orders заблокирован.`
          : `Пагинация GET /v1/orders достигла лимита (${maxPages} стр.) и не проверила все заказы. Автоповтор POST /v1/orders заблокирован для защиты от дублирования.`,
        incompleteCount: 0,
        pagesScanned,
      };
    }

    if (confirmedMatches.length === 1) {
      const matched = confirmedMatches[0];
      const resolvedId = matched.order_id;
      const resolvedStatus = (matched.status || '').toLowerCase();
      await this.persistMyStarsOrderMetadata(order, {
        mystarsOrderId: resolvedId,
        externalExecutionReference: resolvedId,
        mystarsOrderStatus: resolvedStatus,
        mystarsCreateInFlight: false,
        mystarsAmbiguousPostAt: undefined,
      });
      return {
        status: 'found',
        mystarsOrderId: resolvedId,
        mystarsStatus: resolvedStatus,
        pagesScanned,
      };
    }

    return { status: 'not_found', pagesScanned };
  }

  public async checkExternalStatus(
    order: Order,
    _idempotencyKey: string,
  ): Promise<{
    alreadyExecuted: boolean;
    status?: 'processing' | 'completed';
    externalReference?: string;
    details?: string;
    unknownStatus?: string;
  }> {
    if (!this.client.isConfigured()) {
      return { alreadyExecuted: false };
    }

    const mystarsOrderId =
      order.mystarsOrderId ||
      (order.externalExecutionReference &&
      (order.externalExecutionReference.startsWith('ord_') ||
        order.externalExecutionReference.startsWith('ms_'))
        ? order.externalExecutionReference
        : undefined);

    if (!mystarsOrderId) {
      return { alreadyExecuted: false };
    }

    const remoteOrder = await this.client.getOrder(mystarsOrderId);
    const resolvedOrderId = remoteOrder.order_id || mystarsOrderId;
    const status = (remoteOrder.status || '').toLowerCase();
    const isUnknownStatus = !MYSTARS_KNOWN_STATUSES.has(status);

    const remotePayment = remoteOrder.payment ?? undefined;
    const wholesaleTotalUsdt =
      remotePayment?.fee?.total ||
      remotePayment?.amount ||
      remoteOrder.payment_amount ||
      undefined;
    const processingFeeUsdt =
      remotePayment?.fee?.processing_fee ||
      remoteOrder.service_fee_usdt ||
      undefined;
    const remoteCurrency: 'usdt_ton' | 'ton' =
      remoteOrder.currency === 'ton' || remotePayment?.currency === 'ton'
        ? 'ton'
        : 'usdt_ton';

    const pnlUpdates = wholesaleTotalUsdt
      ? this.computeOrderPnLUpdates({
          order,
          wholesaleTotalUsdt,
          processingFeeUsdt,
          currency: remoteCurrency,
        })
      : {};

    const nowIso = new Date().toISOString();
    await this.persistMyStarsOrderMetadata(order, {
      ...pnlUpdates,
      mystarsOrderId: resolvedOrderId,
      mystarsOrderStatus: status,
      mystarsLastPolledAt: nowIso,
      mystarsPollAttempts: (order.mystarsPollAttempts ?? 0) + 1,
      mystarsLastPollError: undefined,
      mystarsCreateInFlight: false,
      mystarsAmbiguousPostAt: undefined,
      ...(remoteOrder.purchase_tx ? { mystarsPurchaseTx: remoteOrder.purchase_tx } : {}),
      ...(remoteOrder.payment_tx ? { mystarsPaymentTx: remoteOrder.payment_tx } : {}),
      ...(remoteOrder.reversal_tx ? { mystarsReversalTx: remoteOrder.reversal_tx } : {}),
      ...(remoteOrder.failure_reason ? { mystarsFailureReason: remoteOrder.failure_reason } : {}),
      ...(isUnknownStatus ? { mystarsUnknownStatusSeen: status } : {}),
    });

    if (isUnknownStatus) {
      console.warn(
        '[MyStars] Получен неизвестный статус заказа от API (заказ оставлен в processing):',
        JSON.stringify({
          orderId: order.orderId,
          mystarsOrderId: resolvedOrderId,
          unknownStatus: status,
        }),
      );
      return {
        alreadyExecuted: true,
        status: 'processing',
        externalReference: resolvedOrderId,
        unknownStatus: status,
        details: `MyStars заказ ${resolvedOrderId} вернул неизвестный статус "${status}" — заказ оставлен в обработке (processing) для проверки администратором.`,
      };
    }

    if (MYSTARS_SUCCESS_STATUSES.has(status)) {
      return {
        alreadyExecuted: true,
        status: 'completed',
        externalReference: resolvedOrderId,
        details: `MyStars заказ ${resolvedOrderId} успешно доставлен (${status})${remoteOrder.purchase_tx ? `, tx: ${remoteOrder.purchase_tx}` : ''}.`,
      };
    }

    if (MYSTARS_FAILURE_STATUSES.has(status)) {
      const reason =
        remoteOrder.failure_reason ||
        remoteOrder.telegram_message ||
        `статус MyStars: ${status}`;
      throw new MyStarsApiError({
        message: `MyStars заказ ${resolvedOrderId} завершился ошибкой (${status}): ${reason}`,
        httpStatus: 422,
        code: `mystars_${status}`,
        telegramMessage: remoteOrder.telegram_message || undefined,
        retryable: false,
        mystarsStatus: status,
      });
    }

    return {
      alreadyExecuted: true,
      status: 'processing',
      externalReference: resolvedOrderId,
      details: `MyStars заказ ${resolvedOrderId} находится в статусе ${status}.`,
    };
  }

  public async requestFulfillment(
    order: Order,
    context?: FulfillmentRequestContext,
  ): Promise<FulfillmentAdapterResult> {
    if (!this.client.isConfigured()) {
      return {
        handledAutomatically: false,
        status: 'processing',
        details:
          'MYSTARS_API_KEY не задан: заказ переведён в режим ручной выдачи администратором.',
      };
    }

    if (order.category !== 'stars' && order.category !== 'premium') {
      return {
        handledAutomatically: false,
        status: 'processing',
        details: `Категория ${order.category} не обслуживается через MyStars API (обработка вручную или через склад ключей).`,
      };
    }

    const cleanUsername = validateMyStarsUsername(
      order.recipientUsername || order.username,
    );
    const productType: MyStarsProductType = order.category;
    const quantity =
      productType === 'stars' ? validateMyStarsQuantity(order.quantity) : undefined;
    const months =
      productType === 'premium'
        ? validateMyStarsMonths(order.durationMonths ?? 3)
        : undefined;

    // 1. If a MyStars order ID already exists on the order, check its current status first
    const existingMyStarsId =
      order.mystarsOrderId ||
      (order.externalExecutionReference &&
      (order.externalExecutionReference.startsWith('ord_') ||
        order.externalExecutionReference.startsWith('ms_'))
        ? order.externalExecutionReference
        : undefined);
    if (existingMyStarsId) {
      const existingCheck = await this.checkExternalStatus(
        { ...order, mystarsOrderId: existingMyStarsId },
        context?.idempotencyKey || order.fulfillmentIdempotencyKey || `fulfill_${order.orderId}`,
      );
      if (existingCheck.alreadyExecuted && existingCheck.status === 'completed') {
        return {
          handledAutomatically: true,
          status: 'completed',
          externalReference: existingCheck.externalReference,
          details: existingCheck.details || `Выдача выполнена через MyStars (${existingMyStarsId}).`,
        };
      }
      if (existingCheck.alreadyExecuted && existingCheck.status === 'processing') {
        return {
          handledAutomatically: false,
          status: 'processing',
          externalReference: existingCheck.externalReference,
          details:
            existingCheck.details ||
            `Заказ MyStars ${existingMyStarsId} ожидает завершения выдачи.`,
        };
      }
    }

    // 2. Verify recipient eligibility via POST /v1/recipients/check
    const check = await this.client.checkRecipient({
      type: productType,
      username: cleanUsername,
      months,
    });
    if (!check.indeterminate && (!check.resolved || !check.eligible)) {
      const buyerMsg = formatBuyerRecipientIneligibleMessage({
        username: cleanUsername,
        category: order.category,
        reason: check.reason || (!check.resolved ? 'recipient_not_found' : 'ineligible'),
        telegramMessage: check.telegram_message,
      });
      throw new MyStarsRecipientIneligibleError({
        message: buyerMsg,
        httpStatus: 422,
        code: check.reason || 'recipient_ineligible',
        reason: check.reason || 'recipient_ineligible',
        telegramMessage: check.telegram_message || undefined,
      });
    }

    // 3. Create idempotent MyStars FaaS v1 order via POST /v1/orders (Polling-only, no callback_url)
    const idempotencyKey =
      context?.idempotencyKey ||
      order.fulfillmentIdempotencyKey ||
      `fulfill_${order.orderId}`;

    const created = await this.client.createOrder({
      type: productType,
      username: cleanUsername,
      quantity,
      months,
      paymentCurrency: 'usdt_ton',
      idempotencyKey,
    });

    const resolvedOrderId = created.order_id;
    const status = (created.status || '').toLowerCase();
    const isUnknownStatus = !MYSTARS_KNOWN_STATUSES.has(status);
    const payment = created.payment;
    const resolvedCurrency: 'usdt_ton' | 'ton' =
      payment.currency === 'ton' ? 'ton' : 'usdt_ton';

    const wholesaleTotalUsdt = payment.fee?.total || payment.amount || '0';
    const processingFeeUsdt = payment.fee?.processing_fee || '0';

    const pnlUpdates = this.computeOrderPnLUpdates({
      order,
      wholesaleTotalUsdt,
      processingFeeUsdt,
      currency: resolvedCurrency,
    });

    const nowIso = new Date().toISOString();
    await this.persistMyStarsOrderMetadata(order, {
      ...pnlUpdates,
      mystarsOrderId: resolvedOrderId,
      mystarsOrderStatus: status,
      mystarsLastPolledAt: nowIso,
      mystarsPollAttempts: order.mystarsPollAttempts ?? 0,
      mystarsLastPollError: undefined,
      mystarsCreateInFlight: false,
      mystarsAmbiguousPostAt: undefined,
      mystarsPayToAddress: payment.pay_to_address || undefined,
      mystarsPaymentMemo: payment.memo || resolvedOrderId,
      mystarsPaymentAmountUsdt: payment.amount || wholesaleTotalUsdt,
      ...(created.purchase_tx ? { mystarsPurchaseTx: created.purchase_tx } : {}),
      ...(isUnknownStatus ? { mystarsUnknownStatusSeen: status } : {}),
      mystarsExpiresAt: created.expires_at ?? undefined,
      externalExecutionReference: resolvedOrderId,
    });

    if (isUnknownStatus) {
      console.warn(
        '[MyStars] POST /v1/orders вернул неизвестный статус заказа (оставлен в processing):',
        JSON.stringify({
          orderId: order.orderId,
          mystarsOrderId: resolvedOrderId,
          unknownStatus: status,
        }),
      );
      return {
        handledAutomatically: false,
        status: 'processing',
        externalReference: resolvedOrderId,
        details: `Создан заказ MyStars ${resolvedOrderId} с неизвестным статусом "${status}" — оставлен в обработке для проверки.`,
      };
    }

    if (MYSTARS_SUCCESS_STATUSES.has(status)) {
      return {
        handledAutomatically: true,
        status: 'completed',
        externalReference: resolvedOrderId,
        details: `Выдача ${productType === 'stars' ? `${quantity} ⭐` : `Telegram Premium (${months} мес.)`} для @${cleanUsername} выполнена через MyStars (${resolvedOrderId}).`,
      };
    }

    if (MYSTARS_FAILURE_STATUSES.has(status)) {
      throw new MyStarsApiError({
        message: `MyStars отклонил заказ ${resolvedOrderId} со статусом ${status}.`,
        httpStatus: 422,
        code: `mystars_${status}`,
        retryable: false,
      });
    }

    const resolvedPayTo = payment.pay_to_address;
    const resolvedMemo = payment.memo || resolvedOrderId;
    const resolvedAmount = payment.amount || wholesaleTotalUsdt;
    const payInstructionSummary = resolvedPayTo
      ? `Оплата поставщику MyStars: ${resolvedAmount} ${resolvedCurrency.toUpperCase()} на адрес ${resolvedPayTo} (MEMO: ${resolvedMemo})`
      : `Статус MyStars: ${status}`;

    return {
      handledAutomatically: false,
      status: 'processing',
      externalReference: resolvedOrderId,
      details: `Создан заказ MyStars ${resolvedOrderId} (${status}) для @${cleanUsername}. ${payInstructionSummary}.`,
    };
  }
}
