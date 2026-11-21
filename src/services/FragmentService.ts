import { firestoreRepo } from '../db/firestore.ts';
import { getEnvConfig } from '../config/env.ts';
import { Order, ProductCategory } from '../types.ts';
import {
  FulfillmentAdapterResult,
  FulfillmentProviderAdapter,
  FulfillmentRequestContext,
} from './FulfillmentService.ts';
import {
  HttpTransportRequest,
  HttpTransportResponse,
  ProviderHttpTransport,
  maskSecret,
  redactSecretsFromText,
} from './PaymentProviders.ts';

export type FragmentCurrency = 'ton' | 'usdt_ton';
export type FragmentOrderType = 'STARS' | 'PREMIUM';
export type FragmentOrderStatus =
  | 'CREATED'
  | 'PENDING'
  | 'BLOCKCHAIN_SENT'
  | 'COMPLETED'
  | 'FAILED';

export const FRAGMENT_ACTIVE_STATUSES = new Set<string>([
  'CREATED',
  'PENDING',
  'BLOCKCHAIN_SENT',
]);

export const FRAGMENT_TERMINAL_STATUSES = new Set<string>([
  'COMPLETED',
  'FAILED',
]);

export const FRAGMENT_KNOWN_STATUSES = new Set<string>([
  ...FRAGMENT_ACTIVE_STATUSES,
  ...FRAGMENT_TERMINAL_STATUSES,
]);

/** Official fragment-api.com error codes from OpenAPI schema (https://api.fragment-api.com/api/schema.yaml) */
export const FRAGMENT_ERROR_CODES = {
  GENERAL: 0,
  TON_NETWORK_ERROR: 10,
  KYC_REQUIRED: 11,
  TON_CONNECTION_ERROR: 12,
  TON_TELEGRAM_ERROR: 13,
  USERNAME_NOT_FOUND: 20,
  FRAGMENT_REFUSED: 21,
} as const;

export interface FragmentErrorItem {
  error?: string | null;
  code?: string | number | null;
}

export interface FragmentErrorsObject {
  errors: FragmentErrorItem[];
}

export interface FragmentAmountInfo {
  currency: string;
  amount: string;
}

export interface FragmentSenderInfo {
  phone_number: string;
  name?: string | null;
}

export interface FragmentOrderResponse {
  id: string;
  success: boolean | null;
  receiver: string;
  goods_quantity?: number | null;
  sender?: FragmentSenderInfo | null;
  price?: FragmentAmountInfo | null;
  fee?: FragmentAmountInfo | null;
  ref_id?: string | null;
  status: FragmentOrderStatus | string;
  type: FragmentOrderType | string;
  error?: FragmentErrorsObject | null;
  created_at?: string;
}

export interface FragmentUserInfo {
  username: string;
  photo?: string | null;
  name?: string | null;
  has_premium: boolean;
}

export interface FragmentWalletBalanceResponse {
  balances: FragmentAmountInfo[];
}

export interface FragmentRecipientCheckResult {
  resolved: boolean;
  eligible: boolean;
  indeterminate?: boolean;
  hasPremium?: boolean;
  recipientName?: string | null;
  reason?: string | null;
}

export interface FragmentCredentialsOverride {
  apiKey?: string;
  apiBaseUrl?: string;
  currency?: FragmentCurrency;
  requestTimeoutMs?: number;
  responseUrl?: string;
}

export interface FragmentStatusSummary {
  configured: boolean;
  provider: 'fragment';
  maskedApiKey: string;
  apiBaseUrl: string;
  currency: FragmentCurrency;
  requestTimeoutMs: number;
  asyncWebhookConfigured: boolean;
}

const FRAGMENT_USERNAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;
const FRAGMENT_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FragmentApiError extends Error {
  public readonly httpStatus: number;
  public readonly code?: string | number;
  public readonly retryable: boolean;
  public readonly fragmentStatus?: string;
  public readonly ambiguous: boolean;

  constructor(params: {
    message: string;
    httpStatus: number;
    code?: string | number;
    retryable: boolean;
    fragmentStatus?: string;
    ambiguous?: boolean;
  }) {
    super(params.message);
    this.name = 'FragmentApiError';
    this.httpStatus = params.httpStatus;
    this.code = params.code;
    this.retryable = params.retryable;
    this.fragmentStatus = params.fragmentStatus;
    this.ambiguous = Boolean(params.ambiguous);
  }
}

export class FragmentAuthError extends FragmentApiError {
  constructor(message: string, httpStatus: number) {
    super({
      message,
      httpStatus,
      code: 'auth_error',
      retryable: false,
    });
    this.name = 'FragmentAuthError';
  }
}

export class FragmentRateLimitError extends FragmentApiError {
  public readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super({
      message,
      httpStatus: 429,
      code: 'rate_limited',
      retryable: true,
    });
    this.name = 'FragmentRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class FragmentTransportError extends Error {
  public readonly isTimeout: boolean;
  public readonly retryable: boolean;
  public readonly ambiguous: boolean;

  constructor(
    message: string,
    options?: { isTimeout?: boolean; retryable?: boolean; ambiguous?: boolean },
  ) {
    super(message);
    this.name = 'FragmentTransportError';
    this.isTimeout = Boolean(options?.isTimeout);
    this.retryable = options?.retryable ?? true;
    this.ambiguous = Boolean(options?.ambiguous);
  }
}

export class FragmentValidationError extends FragmentApiError {
  constructor(message: string, code?: string | number) {
    super({
      message,
      httpStatus: 400,
      code: code ?? 'validation_error',
      retryable: false,
    });
    this.name = 'FragmentValidationError';
  }
}

export class FragmentRecipientIneligibleError extends Error {
  public readonly code = 'FRAGMENT_RECIPIENT_INELIGIBLE';
  public readonly reason?: string;

  constructor(message: string, reason?: string) {
    super(message);
    this.name = 'FragmentRecipientIneligibleError';
    this.reason = reason;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeFragmentUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

function parseRetryAfterHeader(
  headers: Record<string, string> | undefined,
): number | undefined {
  if (!headers) return undefined;
  const raw =
    headers['retry-after'] ??
    headers['Retry-After'] ??
    headers['RETRY-AFTER'];
  if (!raw) return undefined;
  const num = Number(raw);
  if (Number.isFinite(num) && num >= 0) {
    return Math.ceil(num);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

function extractFragmentErrors(body: unknown): {
  messages: string[];
  codes: Array<string | number>;
} {
  const messages: string[] = [];
  const codes: Array<string | number> = [];

  if (!isPlainRecord(body)) {
    return { messages, codes };
  }

  const errorList = Array.isArray(body.errors)
    ? body.errors
    : isPlainRecord(body.error) && Array.isArray(body.error.errors)
      ? body.error.errors
      : null;

  if (errorList) {
    for (const item of errorList) {
      if (!isPlainRecord(item)) continue;
      if (typeof item.error === 'string' && item.error.trim()) {
        messages.push(item.error.trim());
      }
      if (typeof item.code === 'number' || typeof item.code === 'string') {
        codes.push(item.code);
      }
    }
  } else if (typeof body.detail === 'string' && body.detail.trim()) {
    messages.push(body.detail.trim());
  } else if (typeof body.message === 'string' && body.message.trim()) {
    messages.push(body.message.trim());
  }

  return { messages, codes };
}

function formatFragmentErrorCodeHint(code: string | number | undefined): string {
  const numeric = typeof code === 'string' ? Number(code) : code;
  switch (numeric) {
    case FRAGMENT_ERROR_CODES.TON_NETWORK_ERROR:
      return 'ошибка сети TON (code=10)';
    case FRAGMENT_ERROR_CODES.KYC_REQUIRED:
      return 'требуется KYC для подключённого аккаунта Fragment (code=11)';
    case FRAGMENT_ERROR_CODES.TON_CONNECTION_ERROR:
      return 'ошибка подключения к TON (code=12)';
    case FRAGMENT_ERROR_CODES.TON_TELEGRAM_ERROR:
      return 'ошибка TON/Telegram (code=13)';
    case FRAGMENT_ERROR_CODES.USERNAME_NOT_FOUND:
      return 'получатель не найден на Fragment (code=20)';
    case FRAGMENT_ERROR_CODES.FRAGMENT_REFUSED:
      return 'Fragment отклонил заказ (code=21)';
    default:
      return code !== undefined ? `code=${String(code)}` : '';
  }
}

export function validateFragmentOrderResponse(
  raw: unknown,
  contextLabel: string,
): FragmentOrderResponse {
  if (!isPlainRecord(raw)) {
    throw new FragmentApiError({
      message: `Некорректный ответ Fragment API (${contextLabel}): ожидался JSON-объект OrderResponse.`,
      httpStatus: 200,
      code: 'malformed_response',
      retryable: false,
      ambiguous: true,
    });
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const status = typeof raw.status === 'string' ? raw.status.trim() : '';
  if (!id || !status) {
    throw new FragmentApiError({
      message: `Неполный ответ Fragment API (${contextLabel}): отсутствуют обязательные поля id или status.`,
      httpStatus: 200,
      code: 'incomplete_order_response',
      retryable: false,
      ambiguous: true,
    });
  }

  const success =
    typeof raw.success === 'boolean'
      ? raw.success
      : raw.success === null || raw.success === undefined
        ? null
        : null;

  const price =
    isPlainRecord(raw.price) &&
    typeof raw.price.currency === 'string' &&
    (typeof raw.price.amount === 'string' || typeof raw.price.amount === 'number')
      ? { currency: raw.price.currency, amount: String(raw.price.amount) }
      : null;

  const fee =
    isPlainRecord(raw.fee) &&
    typeof raw.fee.currency === 'string' &&
    (typeof raw.fee.amount === 'string' || typeof raw.fee.amount === 'number')
      ? { currency: raw.fee.currency, amount: String(raw.fee.amount) }
      : null;

  const sender =
    isPlainRecord(raw.sender) && typeof raw.sender.phone_number === 'string'
      ? {
          phone_number: raw.sender.phone_number,
          name: typeof raw.sender.name === 'string' ? raw.sender.name : null,
        }
      : null;

  let errorObj: FragmentErrorsObject | null = null;
  if (isPlainRecord(raw.error) && Array.isArray(raw.error.errors)) {
    errorObj = {
      errors: raw.error.errors
        .filter((e): e is Record<string, unknown> => isPlainRecord(e))
        .map((e) => ({
          error: typeof e.error === 'string' ? e.error : null,
          code:
            typeof e.code === 'number' || typeof e.code === 'string'
              ? e.code
              : null,
        })),
    };
  }

  return {
    id,
    success,
    receiver: typeof raw.receiver === 'string' ? raw.receiver : '',
    goods_quantity:
      typeof raw.goods_quantity === 'number' ? raw.goods_quantity : null,
    sender,
    price,
    fee,
    ref_id: typeof raw.ref_id === 'string' ? raw.ref_id : null,
    status,
    type: typeof raw.type === 'string' ? raw.type : '',
    error: errorObj,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
  };
}

export class FragmentClient {
  private transport: ProviderHttpTransport;
  private credentialsOverride: FragmentCredentialsOverride | null = null;

  constructor(transport?: ProviderHttpTransport) {
    this.transport = transport ?? this.defaultFetchTransport;
  }

  public setTransport(transport: ProviderHttpTransport): void {
    this.transport = transport;
  }

  public resetTransport(): void {
    this.transport = this.defaultFetchTransport;
  }

  public setCredentialsOverride(
    override: FragmentCredentialsOverride | null,
  ): void {
    if (!override) {
      this.credentialsOverride = null;
      return;
    }
    this.credentialsOverride = {
      ...override,
      ...(override.apiKey !== undefined
        ? { apiKey: override.apiKey.replace(/^JWT\s+/i, '').trim() }
        : {}),
      ...(override.apiBaseUrl !== undefined
        ? { apiBaseUrl: override.apiBaseUrl.replace(/\/+$/, '') }
        : {}),
    };
  }

  private getEffectiveConfig(): {
    apiKey: string;
    apiBaseUrl: string;
    currency: FragmentCurrency;
    requestTimeoutMs: number;
    responseUrl?: string;
  } {
    const env = getEnvConfig();
    const rawKey =
      this.credentialsOverride?.apiKey !== undefined
        ? this.credentialsOverride.apiKey
        : env.fragmentApiKey;
    const apiKey = rawKey.replace(/^JWT\s+/i, '').trim();
    const apiBaseUrl = (
      this.credentialsOverride?.apiBaseUrl !== undefined
        ? this.credentialsOverride.apiBaseUrl
        : env.fragmentApiUrl || 'https://api.fragment-api.com'
    ).replace(/\/+$/, '');
    const currency: FragmentCurrency =
      this.credentialsOverride?.currency ?? env.fragmentCurrency ?? 'ton';
    const requestTimeoutMs =
      this.credentialsOverride?.requestTimeoutMs ??
      env.fragmentRequestTimeoutMs ??
      30_000;
    const responseUrl =
      this.credentialsOverride?.responseUrl !== undefined
        ? this.credentialsOverride.responseUrl || undefined
        : env.fragmentResponseUrl;

    return {
      apiKey,
      apiBaseUrl,
      currency,
      requestTimeoutMs,
      responseUrl,
    };
  }

  private redactLocalSecrets(text: string): string {
    const cfg = this.getEffectiveConfig();
    let safe = redactSecretsFromText(text);
    if (cfg.apiKey && cfg.apiKey.length >= 4) {
      safe = safe.split(cfg.apiKey).join(maskSecret(cfg.apiKey));
    }
    return safe;
  }

  public isConfigured(): boolean {
    const cfg = this.getEffectiveConfig();
    return Boolean(cfg.apiKey && cfg.apiBaseUrl);
  }

  public getStatusSummary(): FragmentStatusSummary {
    const cfg = this.getEffectiveConfig();
    return {
      configured: Boolean(cfg.apiKey && cfg.apiBaseUrl),
      provider: 'fragment',
      maskedApiKey: maskSecret(cfg.apiKey),
      apiBaseUrl: cfg.apiBaseUrl,
      currency: cfg.currency,
      requestTimeoutMs: cfg.requestTimeoutMs,
      asyncWebhookConfigured: Boolean(cfg.responseUrl),
    };
  }

  private defaultFetchTransport: ProviderHttpTransport = async (
    req: HttpTransportRequest,
  ): Promise<HttpTransportResponse> => {
    const cfg = this.getEffectiveConfig();
    const controller = new AbortController();
    const timeoutMs = cfg.requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      const text = await response.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        status: response.status,
        ok: response.ok,
        text,
        json,
        headers,
      };
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === 'AbortError' ||
          error.message.toLowerCase().includes('aborted') ||
          error.message.toLowerCase().includes('timeout'));
      if (isAbort) {
        throw new FragmentTransportError(
          `Таймаут запроса к Fragment API (${timeoutMs} мс).`,
          { isTimeout: true, retryable: true },
        );
      }
      const rawMsg = error instanceof Error ? error.message : String(error);
      throw new FragmentTransportError(
        `Сетевая ошибка при обращении к Fragment API: ${this.redactLocalSecrets(rawMsg)}`,
        { isTimeout: false, retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  };

  private async requestJson(params: {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
    requireAuth?: boolean;
    isOrderCreate?: boolean;
  }): Promise<HttpTransportResponse> {
    const cfg = this.getEffectiveConfig();
    const requireAuth = params.requireAuth ?? true;
    if (requireAuth && !cfg.apiKey) {
      throw new FragmentAuthError(
        'FRAGMENT_API_KEY не настроен. Укажите Fragment Connection JWT из https://fragment-api.com/dashboard.',
        401,
      );
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (cfg.apiKey) {
      headers.Authorization = `JWT ${cfg.apiKey}`;
    }
    if (params.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const url = `${cfg.apiBaseUrl}${params.path}`;
    let res: HttpTransportResponse;
    try {
      res = await this.transport({
        method: params.method,
        url,
        headers,
        ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
      });
    } catch (error) {
      if (error instanceof FragmentTransportError) {
        if (params.isOrderCreate) {
          throw new FragmentTransportError(
            this.redactLocalSecrets(error.message),
            {
              isTimeout: error.isTimeout,
              retryable: false,
              ambiguous: true,
            },
          );
        }
        throw new FragmentTransportError(this.redactLocalSecrets(error.message), {
          isTimeout: error.isTimeout,
          retryable: error.retryable,
          ambiguous: error.ambiguous,
        });
      }
      const rawMsg = error instanceof Error ? error.message : String(error);
      const isTimeout =
        rawMsg.toLowerCase().includes('timeout') ||
        rawMsg.toLowerCase().includes('abort');
      throw new FragmentTransportError(
        `Ошибка сети Fragment API (${params.method} ${params.path}): ${this.redactLocalSecrets(rawMsg)}`,
        {
          isTimeout,
          retryable: !params.isOrderCreate,
          ambiguous: Boolean(params.isOrderCreate),
        },
      );
    }

    const parsedJson =
      res.json !== undefined
        ? res.json
        : (() => {
            try {
              return res.text ? JSON.parse(res.text) : undefined;
            } catch {
              return undefined;
            }
          })();

    if (res.status === 401 || res.status === 403) {
      const extracted = extractFragmentErrors(parsedJson);
      const detail =
        extracted.messages.join('; ') || `HTTP ${res.status} Unauthorized`;
      throw new FragmentAuthError(
        `Ошибка авторизации Fragment API (HTTP ${res.status}): ${this.redactLocalSecrets(detail)}`,
        res.status,
      );
    }

    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfterHeader(res.headers);
      const extracted = extractFragmentErrors(parsedJson);
      const detail =
        extracted.messages.join('; ') ||
        'Превышен лимит запросов Fragment API (HTTP 429).';
      throw new FragmentRateLimitError(
        this.redactLocalSecrets(detail),
        retryAfterSeconds,
      );
    }

    if (res.status >= 500) {
      const extracted = extractFragmentErrors(parsedJson);
      const detail = extracted.messages.join('; ') || `HTTP ${res.status}`;
      throw new FragmentApiError({
        message: `Ошибка сервера Fragment API (HTTP ${res.status}): ${this.redactLocalSecrets(detail)}`,
        httpStatus: res.status,
        code: extracted.codes[0] ?? 'server_error',
        // Never blindly retry POST /v1/order/* on HTTP 5xx (order may have been accepted server-side)
        retryable: !params.isOrderCreate,
        ambiguous: Boolean(params.isOrderCreate),
      });
    }

    if (!res.ok) {
      const extracted = extractFragmentErrors(parsedJson);
      const primaryCode = extracted.codes[0];
      const hint = formatFragmentErrorCodeHint(primaryCode);
      const detail =
        extracted.messages.join('; ') ||
        hint ||
        `HTTP ${res.status} Bad Request`;
      throw new FragmentValidationError(
        `Fragment API отклонил запрос (HTTP ${res.status}${hint ? `, ${hint}` : ''}): ${this.redactLocalSecrets(detail)}`,
        primaryCode ?? `http_${res.status}`,
      );
    }

    return {
      ...res,
      json: parsedJson,
    };
  }

  /**
   * POST /v1/order/stars/
   * Official schema: StarsOrderRequest { username, quantity (50..1000000), show_sender?, currency?, response_url? }
   */
  public async buyStars(params: {
    username: string;
    quantity: number;
    showSender?: boolean;
    currency?: FragmentCurrency;
    responseUrl?: string;
  }): Promise<FragmentOrderResponse> {
    const username = normalizeFragmentUsername(params.username);
    if (!FRAGMENT_USERNAME_REGEX.test(username)) {
      throw new FragmentValidationError(
        `Некорректный Telegram username получателя для Fragment API: "${username}".`,
        'invalid_username',
      );
    }
    if (
      !Number.isInteger(params.quantity) ||
      params.quantity < 50 ||
      params.quantity > 1_000_000
    ) {
      throw new FragmentValidationError(
        `Недопустимое количество Telegram Stars для Fragment API: ${params.quantity} (допустимо 50–1 000 000).`,
        'invalid_quantity',
      );
    }

    const cfg = this.getEffectiveConfig();
    const payload: Record<string, unknown> = {
      username,
      quantity: params.quantity,
      show_sender: params.showSender ?? false,
      currency: params.currency ?? cfg.currency,
    };
    const effectiveResponseUrl = params.responseUrl ?? cfg.responseUrl;
    if (effectiveResponseUrl) {
      payload.response_url = effectiveResponseUrl;
    }

    const res = await this.requestJson({
      method: 'POST',
      path: '/v1/order/stars/',
      body: payload,
      requireAuth: true,
      isOrderCreate: true,
    });

    return validateFragmentOrderResponse(res.json, 'POST /v1/order/stars/');
  }

  /**
   * POST /v1/order/premium/
   * Official schema: PremiumOrderRequest { username, months (3|6|12), show_sender?, currency?, response_url? }
   */
  public async giftPremium(params: {
    username: string;
    months: 3 | 6 | 12;
    showSender?: boolean;
    currency?: FragmentCurrency;
    responseUrl?: string;
  }): Promise<FragmentOrderResponse> {
    const username = normalizeFragmentUsername(params.username);
    if (!FRAGMENT_USERNAME_REGEX.test(username)) {
      throw new FragmentValidationError(
        `Некорректный Telegram username получателя для Fragment API: "${username}".`,
        'invalid_username',
      );
    }
    if (params.months !== 3 && params.months !== 6 && params.months !== 12) {
      throw new FragmentValidationError(
        `Недопустимый срок Telegram Premium для Fragment API: ${String(params.months)} (допустимо 3, 6 или 12 мес.).`,
        'invalid_months',
      );
    }

    const cfg = this.getEffectiveConfig();
    const payload: Record<string, unknown> = {
      username,
      months: params.months,
      show_sender: params.showSender ?? false,
      currency: params.currency ?? cfg.currency,
    };
    const effectiveResponseUrl = params.responseUrl ?? cfg.responseUrl;
    if (effectiveResponseUrl) {
      payload.response_url = effectiveResponseUrl;
    }

    const res = await this.requestJson({
      method: 'POST',
      path: '/v1/order/premium/',
      body: payload,
      requireAuth: true,
      isOrderCreate: true,
    });

    return validateFragmentOrderResponse(res.json, 'POST /v1/order/premium/');
  }

  /**
   * GET /v1/order/{id}/
   * Official schema: Check_Order -> OrderResponse
   */
  public async getOrder(fragmentOrderId: string): Promise<FragmentOrderResponse> {
    const cleanId = fragmentOrderId.trim();
    if (!cleanId) {
      throw new FragmentValidationError(
        'Пустой ID заказа Fragment API для GET /v1/order/{id}/.',
        'invalid_order_id',
      );
    }
    const encodedId = encodeURIComponent(cleanId);
    const res = await this.requestJson({
      method: 'GET',
      path: `/v1/order/${encodedId}/`,
      requireAuth: true,
      isOrderCreate: false,
    });
    return validateFragmentOrderResponse(res.json, `GET /v1/order/${cleanId}/`);
  }

  /**
   * GET /v1/misc/user/{username}/
   * Returns { username, photo, name, has_premium } or throws 404 if user not found on Fragment.
   */
  public async getUserInfo(rawUsername: string): Promise<FragmentUserInfo | null> {
    const username = normalizeFragmentUsername(rawUsername);
    if (!FRAGMENT_USERNAME_REGEX.test(username)) {
      throw new FragmentValidationError(
        `Некорректный формат @username: "${username}".`,
        'invalid_username',
      );
    }
    const cfg = this.getEffectiveConfig();
    if (!cfg.apiKey) {
      throw new FragmentAuthError('FRAGMENT_API_KEY не настроен.', 401);
    }

    const url = `${cfg.apiBaseUrl}/v1/misc/user/${encodeURIComponent(username)}/`;
    const res = await this.transport({
      method: 'GET',
      url,
      headers: {
        Accept: 'application/json',
        Authorization: `JWT ${cfg.apiKey}`,
      },
    });

    if (res.status === 404) {
      return null;
    }
    const parsedJson =
      res.json !== undefined
        ? res.json
        : (() => {
            try {
              return res.text ? JSON.parse(res.text) : undefined;
            } catch {
              return undefined;
            }
          })();

    if (res.status === 401 || res.status === 403) {
      throw new FragmentAuthError(
        `Ошибка авторизации Fragment API (HTTP ${res.status}).`,
        res.status,
      );
    }
    if (res.status === 429) {
      throw new FragmentRateLimitError(
        'Превышен лимит запросов Fragment API (HTTP 429).',
        parseRetryAfterHeader(res.headers),
      );
    }
    if (!res.ok) {
      const extracted = extractFragmentErrors(parsedJson);
      throw new FragmentApiError({
        message: `Ошибка проверки получателя в Fragment API (HTTP ${res.status}): ${this.redactLocalSecrets(extracted.messages.join('; ') || res.text || 'unknown')}`,
        httpStatus: res.status,
        code: extracted.codes[0],
        retryable: res.status >= 500,
      });
    }

    if (!isPlainRecord(parsedJson) || typeof parsedJson.username !== 'string') {
      throw new FragmentApiError({
        message: 'Некорректный ответ Fragment API (GET /v1/misc/user/{username}/).',
        httpStatus: 200,
        retryable: true,
      });
    }

    return {
      username: parsedJson.username,
      photo: typeof parsedJson.photo === 'string' ? parsedJson.photo : null,
      name: typeof parsedJson.name === 'string' ? parsedJson.name : null,
      has_premium: Boolean(parsedJson.has_premium),
    };
  }

  /**
   * GET /v1/misc/wallet/
   * Returns current TON / USDT-TON balances of the connected TON wallet.
   */
  public async getWalletBalance(): Promise<FragmentWalletBalanceResponse> {
    const res = await this.requestJson({
      method: 'GET',
      path: '/v1/misc/wallet/',
      requireAuth: true,
      isOrderCreate: false,
    });
    if (!isPlainRecord(res.json) || !Array.isArray(res.json.balances)) {
      throw new FragmentApiError({
        message: 'Некорректный ответ Fragment API (GET /v1/misc/wallet/).',
        httpStatus: 200,
        retryable: true,
      });
    }
    const balances: FragmentAmountInfo[] = res.json.balances
      .filter((item): item is Record<string, unknown> => isPlainRecord(item))
      .map((item) => ({
        currency: String(item.currency ?? ''),
        amount: String(item.amount ?? '0'),
      }));
    return { balances };
  }

  /**
   * Pre-checkout recipient verification using GET /v1/misc/user/{username}/.
   * - If Fragment is not configured: fail-open (returns indeterminate).
   * - If user is 404 on Fragment: blocks checkout (throws FragmentRecipientIneligibleError).
   * - If category === 'premium' and user already has Premium (`has_premium === true`):
   *   blocks checkout (throws FragmentRecipientIneligibleError).
   * - On transient errors (429, 5xx, timeout): fail-open so temporary API blips do not
   *   block legitimate orders unnecessarily.
   */
  public async validateRecipientBeforeCheckout(params: {
    category: ProductCategory;
    recipientUsername: string;
    durationMonths?: 3 | 6 | 12;
  }): Promise<FragmentRecipientCheckResult> {
    if (params.category !== 'stars' && params.category !== 'premium') {
      return { resolved: true, eligible: true };
    }
    if (!this.isConfigured()) {
      return { resolved: false, eligible: true, indeterminate: true };
    }

    const username = normalizeFragmentUsername(params.recipientUsername);
    if (!FRAGMENT_USERNAME_REGEX.test(username)) {
      throw new FragmentRecipientIneligibleError(
        `Некорректный Telegram @username «@${username}». Укажите действующий username (3–32 символа, латиница, цифры, _).`,
        'invalid_username',
      );
    }

    try {
      const userInfo = await this.getUserInfo(username);
      if (!userInfo) {
        throw new FragmentRecipientIneligibleError(
          `Пользователь @${username} не найден в Telegram/Fragment. Проверьте правильность @username.`,
          'username_not_found',
        );
      }
      if (params.category === 'premium' && userInfo.has_premium) {
        throw new FragmentRecipientIneligibleError(
          `У пользователя @${username} уже активна подписка Telegram Premium — Fragment не позволяет подарить Premium повторно.`,
          'already_has_premium',
        );
      }
      return {
        resolved: true,
        eligible: true,
        hasPremium: userInfo.has_premium,
        recipientName: userInfo.name,
      };
    } catch (error) {
      if (error instanceof FragmentRecipientIneligibleError) {
        throw error;
      }
      // Fail-open on transient Fragment API outages / rate limits / auth issues during pre-checkout
      console.warn(
        `[FragmentService] Не удалось предварительно проверить получателя @${username} (fail-open):`,
        this.redactLocalSecrets(error instanceof Error ? error.message : String(error)),
      );
      return {
        resolved: false,
        eligible: true,
        indeterminate: true,
        reason: 'indeterminate_upstream_error',
      };
    }
  }
}

export const fragmentClient = new FragmentClient();

function buildFragmentFailureMessage(resp: FragmentOrderResponse): string {
  const errors = resp.error?.errors ?? [];
  const parts: string[] = [];
  for (const item of errors) {
    const hint = formatFragmentErrorCodeHint(item.code ?? undefined);
    const msg = item.error?.trim() || '';
    if (msg && hint) {
      parts.push(`${msg} (${hint})`);
    } else if (msg) {
      parts.push(msg);
    } else if (hint) {
      parts.push(hint);
    }
  }
  const suffix = parts.length > 0 ? `: ${parts.join('; ')}` : '';
  return `Fragment API отклонил заказ ${resp.id} (status=${resp.status}${suffix}).`;
}

/**
 * Interprets a verified Fragment OrderResponse strictly:
 * - HTTP 200 NEVER blindly means success!
 * - Only `status === 'COMPLETED' && success === true` confirms fulfillment.
 * - `status === 'COMPLETED' && success !== true` is AMBIGUOUS -> safe `processing` + `needsManualReconciliation: true`.
 * - `CREATED | PENDING | BLOCKCHAIN_SENT` -> safe `processing` (keep polling `GET /v1/order/{id}/`).
 * - `FAILED` (or `success === false` on non-active status) -> permanent failure (`retryable: false`).
 * - Unknown status -> safe `processing` + `unknownStatus` (admin alert, no premature failure/completion).
 */
export function evaluateFragmentOrderResponse(resp: FragmentOrderResponse): {
  outcome: 'completed' | 'processing' | 'failed' | 'ambiguous' | 'unknown_status';
  details: string;
  unknownStatus?: string;
  failureReason?: string;
  primaryErrorCode?: string | number;
} {
  const statusUpper = resp.status.trim().toUpperCase();

  if (statusUpper === 'COMPLETED') {
    if (resp.success === true) {
      return {
        outcome: 'completed',
        details: `Fragment API подтвердил выдачу (${resp.type || 'ORDER'}, ID: ${resp.id}${resp.ref_id ? `, ref: ${resp.ref_id}` : ''}).`,
      };
    }
    return {
      outcome: 'ambiguous',
      details: `Неоднозначный ответ Fragment API для заказа ${resp.id}: status=COMPLETED, но success=${String(resp.success)}. Требуется ручная сверка (защита от ложного подтверждения).`,
    };
  }

  if (statusUpper === 'FAILED') {
    const reason = buildFragmentFailureMessage(resp);
    return {
      outcome: 'failed',
      details: reason,
      failureReason: reason,
      primaryErrorCode: resp.error?.errors?.[0]?.code ?? undefined,
    };
  }

  if (FRAGMENT_ACTIVE_STATUSES.has(statusUpper)) {
    if (resp.success === false) {
      const reason = buildFragmentFailureMessage(resp);
      return {
        outcome: 'failed',
        details: reason,
        failureReason: reason,
        primaryErrorCode: resp.error?.errors?.[0]?.code ?? undefined,
      };
    }
    return {
      outcome: 'processing',
      details: `Заказ создан в Fragment API (ID: ${resp.id}, статус: ${statusUpper}). Ожидание подтверждения блокчейна TON.`,
    };
  }

  // Unknown status -> never fail or complete blindly!
  return {
    outcome: 'unknown_status',
    unknownStatus: resp.status,
    details: `Fragment API вернул неизвестный статус "${resp.status}" для заказа ${resp.id}. Заказ оставлен в processing до ручной проверки.`,
  };
}

export class FragmentFulfillmentAdapter implements FulfillmentProviderAdapter {
  public readonly providerName = 'Fragment API (https://fragment-api.com)';
  /**
   * Official fragment-api.com POST /v1/order/* endpoints do NOT accept a client Idempotency-Key
   * and have no public GET /v1/orders list endpoint. Setting supportsIdempotency=false ensures
   * stale-processing recovery NEVER blindly re-submits POST after a crash/timeout!
   */
  public readonly supportsIdempotency = false;

  private readonly client: FragmentClient;

  constructor(client: FragmentClient = fragmentClient) {
    this.client = client;
  }

  public isConfigured(): boolean {
    return this.client.isConfigured();
  }

  private async persistFragmentMetadata(
    orderId: string,
    resp: FragmentOrderResponse,
    extra?: Partial<Order>,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const statusUpper = resp.status.trim().toUpperCase();
    const currencyRaw = resp.price?.currency?.toLowerCase();
    const fragmentCurrency: FragmentCurrency | undefined =
      currencyRaw === 'usdt_ton'
        ? 'usdt_ton'
        : currencyRaw === 'ton'
          ? 'ton'
          : undefined;

    await firestoreRepo.runTransaction<void>(async (tx) => {
      const current = await tx.get<Order>('orders', orderId);
      if (!current) return;
      const updated: Order = {
        ...current,
        fulfillmentProvider: current.fulfillmentProvider || 'fragment',
        fragmentOrderId: resp.id,
        fragmentOrderStatus: statusUpper,
        externalExecutionReference: resp.id,
        fragmentCreateInFlight: false,
        fragmentAmbiguousPostAt: undefined,
        ...(resp.ref_id ? { fragmentRefId: resp.ref_id } : {}),
        ...(fragmentCurrency ? { fragmentCurrency } : {}),
        ...(resp.price?.amount ? { fragmentPriceAmount: resp.price.amount } : {}),
        ...(resp.fee?.amount ? { fragmentFeeAmount: resp.fee.amount } : {}),
        ...extra,
        updatedAt: nowIso,
      };
      tx.set<Order>('orders', updated.orderId, updated);
    });
  }

  public async requestFulfillment(
    order: Order,
    context?: FulfillmentRequestContext,
  ): Promise<FulfillmentAdapterResult> {
    // Only Stars and Premium are supported by fragment-api.com
    if (order.category !== 'stars' && order.category !== 'premium') {
      return {
        handledAutomatically: false,
        status: 'processing',
        details: `Категория «${order.category}» не поддерживается Fragment API — заказ #${order.orderId} передан на ручную выдачу администратору.`,
        externalReference: context?.idempotencyKey || `manual_${order.orderId}`,
      };
    }

    // Strict anti-double-purchase guard: if fragmentOrderId already exists, NEVER send POST again!
    if (order.fragmentOrderId) {
      const statusCheck = await this.checkExternalStatus(
        order,
        context?.idempotencyKey || order.fulfillmentIdempotencyKey || `fulfill_${order.orderId}`,
      );
      return {
        handledAutomatically: true,
        status: statusCheck.status === 'completed' ? 'completed' : 'processing',
        details:
          statusCheck.details ||
          `Заказ уже зарегистрирован в Fragment API (ID: ${order.fragmentOrderId}).`,
        externalReference: statusCheck.externalReference || order.fragmentOrderId,
      };
    }

    const recipient = order.recipientUsername?.trim().replace(/^@+/, '');
    if (!recipient) {
      throw new FragmentValidationError(
        `Для заказа #${order.orderId} не указан @username получателя.`,
        'missing_recipient',
      );
    }

    let response: FragmentOrderResponse;
    if (order.category === 'stars') {
      response = await this.client.buyStars({
        username: recipient,
        quantity: order.quantity,
      });
    } else {
      const months = order.durationMonths;
      if (months !== 3 && months !== 6 && months !== 12) {
        throw new FragmentValidationError(
          `Для заказа Telegram Premium #${order.orderId} не задан корректный срок подписки (3, 6 или 12 мес.).`,
          'missing_duration_months',
        );
      }
      response = await this.client.giftPremium({
        username: recipient,
        months,
      });
    }

    // Validate UUID shape if present (defensive sanity check against malformed 200 bodies)
    if (!FRAGMENT_UUID_REGEX.test(response.id) && response.id.length < 4) {
      throw new FragmentApiError({
        message: `Fragment API вернул подозрительный ID заказа: "${response.id}". Автоповтор заблокирован.`,
        httpStatus: 200,
        code: 'invalid_order_id_response',
        retryable: false,
        ambiguous: true,
      });
    }

    const evaluated = evaluateFragmentOrderResponse(response);

    if (evaluated.outcome === 'failed') {
      await this.persistFragmentMetadata(order.orderId, response, {
        fragmentFailureReason: evaluated.failureReason?.slice(0, 500),
      });
      throw new FragmentApiError({
        message: evaluated.details,
        httpStatus: 200,
        code: evaluated.primaryErrorCode ?? 'order_failed',
        retryable: false,
        fragmentStatus: response.status,
      });
    }

    if (evaluated.outcome === 'ambiguous') {
      await this.persistFragmentMetadata(order.orderId, response, {
        needsManualReconciliation: true,
        fragmentLastPollError: evaluated.details.slice(0, 500),
      });
      return {
        handledAutomatically: false,
        status: 'processing',
        details: evaluated.details,
        externalReference: response.id,
      };
    }

    if (evaluated.outcome === 'unknown_status') {
      await this.persistFragmentMetadata(order.orderId, response, {
        fragmentUnknownStatusSeen: evaluated.unknownStatus,
        needsManualReconciliation: true,
      });
      return {
        handledAutomatically: false,
        status: 'processing',
        details: evaluated.details,
        externalReference: response.id,
      };
    }

    await this.persistFragmentMetadata(order.orderId, response, {
      fragmentLastPolledAt: new Date().toISOString(),
      fragmentLastPollError: undefined,
    });

    if (evaluated.outcome === 'completed') {
      return {
        handledAutomatically: true,
        status: 'completed',
        details: evaluated.details,
        externalReference: response.id,
      };
    }

    return {
      handledAutomatically: false,
      status: 'processing',
      details: evaluated.details,
      externalReference: response.id,
    };
  }

  public async checkExternalStatus(
    order: Order,
    _idempotencyKey: string,
  ): Promise<{
    alreadyExecuted: boolean;
    status?: 'processing' | 'completed';
    details?: string;
    externalReference?: string;
    unknownStatus?: string;
    ambiguousOutcome?: boolean;
  }> {
    const fragmentOrderId = order.fragmentOrderId;
    if (!fragmentOrderId) {
      return { alreadyExecuted: false };
    }

    const response = await this.client.getOrder(fragmentOrderId);
    const evaluated = evaluateFragmentOrderResponse(response);
    const nowIso = new Date().toISOString();
    const nextPollAttempts = (order.fragmentPollAttempts ?? 0) + 1;

    if (evaluated.outcome === 'failed') {
      await this.persistFragmentMetadata(order.orderId, response, {
        fragmentLastPolledAt: nowIso,
        fragmentPollAttempts: nextPollAttempts,
        fragmentLastPollError: evaluated.failureReason?.slice(0, 500),
        fragmentFailureReason: evaluated.failureReason?.slice(0, 500),
      });
      throw new FragmentApiError({
        message: evaluated.details,
        httpStatus: 200,
        code: evaluated.primaryErrorCode ?? 'order_failed',
        retryable: false,
        fragmentStatus: response.status,
      });
    }

    if (evaluated.outcome === 'ambiguous') {
      await this.persistFragmentMetadata(order.orderId, response, {
        fragmentLastPolledAt: nowIso,
        fragmentPollAttempts: nextPollAttempts,
        fragmentLastPollError: evaluated.details.slice(0, 500),
        needsManualReconciliation: true,
      });
      return {
        alreadyExecuted: true,
        status: 'processing',
        details: evaluated.details,
        externalReference: response.id,
        ambiguousOutcome: true,
      };
    }

    if (evaluated.outcome === 'unknown_status') {
      await this.persistFragmentMetadata(order.orderId, response, {
        fragmentLastPolledAt: nowIso,
        fragmentPollAttempts: nextPollAttempts,
        fragmentUnknownStatusSeen:
          order.fragmentUnknownStatusSeen || evaluated.unknownStatus,
        fragmentLastPollError: evaluated.details.slice(0, 500),
      });
      return {
        alreadyExecuted: true,
        status: 'processing',
        details: evaluated.details,
        externalReference: response.id,
        unknownStatus: evaluated.unknownStatus,
      };
    }

    await this.persistFragmentMetadata(order.orderId, response, {
      fragmentLastPolledAt: nowIso,
      fragmentPollAttempts: nextPollAttempts,
      fragmentLastPollError: undefined,
    });

    if (evaluated.outcome === 'completed') {
      return {
        alreadyExecuted: true,
        status: 'completed',
        details: evaluated.details,
        externalReference: response.id,
      };
    }

    return {
      alreadyExecuted: true,
      status: 'processing',
      details: evaluated.details,
      externalReference: response.id,
    };
  }
}
