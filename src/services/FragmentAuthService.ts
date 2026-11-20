import crypto from 'node:crypto';
import { getEnvConfig, readFragmentWalletSeedFromEnv } from '../config/env.ts';
import { firestoreRepo } from '../db/firestore.ts';
import { FragmentAuthSessionRecord, FragmentWalletVersion } from '../types.ts';
import {
  HttpTransportRequest,
  HttpTransportResponse,
  ProviderHttpTransport,
  redactSecretsFromText,
  registerRuntimeSecret,
  unregisterRuntimeSecret,
} from './PaymentProviders.ts';

// ---------------------------------------------------------------------------
// Constants aligned with Fragment API .NET v3 docs & official node SDK (v3)
// ---------------------------------------------------------------------------

export const FRAGMENT_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days from last use
export const FRAGMENT_MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000; // 365 days hard cap
export const FRAGMENT_EXPIRY_SAFETY_BUFFER_MS = 60 * 1000; // 60s proactive refresh margin
export const FRAGMENT_LAST_USED_PERSIST_INTERVAL_MS = 5 * 60 * 1000; // Throttle Firestore sliding writes

const FRAGMENT_AUTH_DOC_ID = 'fragment_auth';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const TON_PBKDF_ITERATIONS = 100_000;
const MAINNET_NETWORK_ID = -239;
const V4_SUBWALLET_ID = 698_983_191;
const LOCAL_TEST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Official wallet contract code BoC (hex) matching tonweb / pytoniq / fragment-api-node v3
const WALLET_CODE_HEX: Record<FragmentWalletVersion, string> = {
  v4r2:
    'b5ee9c72010214010002d4000114ff00f4a413f4bcf2c80b01020120020f020148030602e6d001d0d3032171b0925f04e022d749c120925f04e002d31f218210706c7567bd22821064737472bdb0925f05e003fa403020fa4401c8ca07cbffc9d0ed44d0810140d721f404305c810108f40a6fa131b3925f07e005d33fc8258210706c7567ba923830e30d03821064737472ba925f06e30d0405007801fa00f40430f8276f2230500aa121bef2e0508210706c7567831eb17080185004cb0526cf1658fa0219f400cb6917cb1f5260cb3f20c98040fb0006008a5004810108f45930ed44d0810140d720c801cf16f400c9ed540172b08e23821064737472831eb17080185005cb055003cf1623fa0213cb6acb1fcb3fc98040fb00925f03e2020120070e020120080d020158090a003db29dfb513420405035c87d010c00b23281f2fff274006040423d029be84c600201200b0c0019adce76a26840206b90eb85ffc00019af1df6a26840106b90eb858fc00011b8c97ed44d0d70b1f80059bd242b6f6a2684080a06b90fa0218470d4080847a4937d29910ce6903e9ff9837812801b7810148987159f318404f8f28308d71820d31fd31fd31f02f823bbf264ed44d0d31fd31fd3fff404d15143baf2a15151baf2a205f901541064f910f2a3f80024a4c8cb1f5240cb1f5230cbff5210f400c9ed54f80f01d30721c0009f6c519320d74a96d307d402fb00e830e021c001e30021c002e30001c0039130e30d03a4c8cb1f12cb1fcbff10111213006ed207fa00d4d422f90005c8ca0715cbffc9d077748018c8cb05cb0222cf165005fa0214cb6b12ccccc973fb00c84014810108f451f2a7020070810108d718fa00d33fc8542047810108f451f2a782106e6f746570748018c8cb05cb025006cf165004fa0214cb6a12cb1fcb3fc973fb0002006c810108d718fa00d33f305224810108f459f2a782106473747270748018c8cb05cb025005cf165003fa0213cb6acb1f12cb3fc973fb00000af400c9ed54',
  v5r1:
    'b5ee9c7201021401000281000114ff00f4a413f4bcf2c80b01020120020d020148030402dcd020d749c120915b8f6320d70b1f2082106578746ebd21821073696e74bdb0925f03e082106578746eba8eb48020d72101d074d721fa4030fa44f828fa443058bd915be0ed44d0810141d721f4058307f40e6fa1319130e18040d721707fdb3ce03120d749810280b99130e070e2100f020120050c020120060902016e07080019adce76a2684020eb90eb85ffc00019af1df6a2684010eb90eb858fc00201480a0b0017b325fb51341c75c875c2c7e00011b262fb513435c280200019be5f0f6a2684080a0eb90fa02c0102f20e011e20d70b1f82107369676ebaf2e08a7f0f01e68ef0eda2edfb218308d722028308d723208020d721d31fd31fd31fed44d0d200d31f20d31fd3ffd70a000af90140ccf9109a28945f0adb31e1f2c087df02b35007b0f2d0845125baf2e0855036baf2e086f823bbf2d0882292f800de01a47fc8ca00cb1f01cf16c9ed542092f80fde70db3cd81003f6eda2edfb02f404216e926c218e4c0221d73930709421c700b38e2d01d72820761e436c20d749c008f2e09320d74ac002f2e09320d71d06c712c2005230b0f2d089d74cd7393001a4e86c128407bbf2e093d74ac000f2e093ed55e2d20001c000915be0ebd72c08142091709601d72c081c12e25210b1e30f20d74a111213009601fa4001fa44f828fa443058baf2e091ed44d0810141d718f405049d7fc8ca0040048307f453f2e08b8e14038307f45bf2e08c22d70a00216e01b3b0f2d090e2c85003cf1612f400c9ed54007230d72c08248e2d21f2e092d200ed44d0d2005113baf2d08f54503091319c01810140d721d70a00f2e08ee2c8ca0058cf16c9ed5493f2c08de20010935bdb31e1d74cd0',
};

// ---------------------------------------------------------------------------
// Minimal TON Cell / Address / Mnemonic / ton_proof crypto (zero deps)
// ---------------------------------------------------------------------------

const BOC_MAGIC = 0xb5ee9c72;
const BOUNCEABLE_TAG = 0x11;
const NON_BOUNCEABLE_TAG = 0x51;
const TEST_FLAG = 0x80;

function bitsToBuffer(bits: readonly number[]): Buffer {
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

function bufferToBits(buf: Buffer, bitLen = buf.length * 8): number[] {
  const bits: number[] = new Array(bitLen);
  for (let i = 0; i < bitLen; i++) {
    bits[i] = (buf[i >> 3] >> (7 - (i & 7))) & 1;
  }
  return bits;
}

function readUintBE(buf: Buffer, pos: number, bytes: number): number {
  let v = 0;
  for (let i = 0; i < bytes; i++) v = v * 256 + buf[pos + i];
  return v;
}

function crc16(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export class TonCell {
  private cachedHash?: Buffer;
  private cachedDepth?: number;

  constructor(
    readonly bits: readonly number[],
    readonly refs: readonly TonCell[] = [],
  ) {
    if (bits.length > 1023) throw new Error(`TON cell overflow: ${bits.length} bits`);
    if (refs.length > 4) throw new Error(`TON cell overflow: ${refs.length} refs`);
  }

  depth(): number {
    if (this.cachedDepth === undefined) {
      this.cachedDepth = this.refs.length
        ? 1 + Math.max(...this.refs.map((r) => r.depth()))
        : 0;
    }
    return this.cachedDepth;
  }

  descriptors(): [number, number] {
    const full = Math.floor(this.bits.length / 8);
    return [this.refs.length, full + Math.ceil(this.bits.length / 8)];
  }

  dataBytes(): Buffer {
    const padded = [...this.bits];
    if (padded.length % 8) {
      padded.push(1);
      while (padded.length % 8) padded.push(0);
    }
    return bitsToBuffer(padded);
  }

  hash(): Buffer {
    if (!this.cachedHash) {
      const [d1, d2] = this.descriptors();
      const parts: Buffer[] = [Buffer.from([d1, d2]), this.dataBytes()];
      for (const r of this.refs) {
        const depth = Buffer.alloc(2);
        depth.writeUInt16BE(r.depth());
        parts.push(depth);
      }
      for (const r of this.refs) parts.push(r.hash());
      this.cachedHash = crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
    }
    return this.cachedHash;
  }
}

class TonCellBuilder {
  private readonly bits: number[] = [];
  private readonly refs: TonCell[] = [];

  storeBit(value: number | boolean): this {
    this.bits.push(value ? 1 : 0);
    return this;
  }

  storeUint(value: bigint | number, bitLength: number): this {
    const v = BigInt(value);
    if (v < 0n || v >= 1n << BigInt(bitLength)) {
      throw new Error(`uint${bitLength} out of range`);
    }
    for (let i = bitLength - 1; i >= 0; i--) {
      this.bits.push(Number((v >> BigInt(i)) & 1n));
    }
    return this;
  }

  storeBuffer(buf: Buffer | Uint8Array): this {
    for (const byte of buf) this.storeUint(byte, 8);
    return this;
  }

  storeMaybeRef(cell: TonCell | null | undefined): this {
    if (!cell) return this.storeBit(0);
    if (this.refs.length >= 4) throw new Error('too many TON cell refs');
    this.storeBit(1);
    this.refs.push(cell);
    return this;
  }

  endCell(): TonCell {
    return new TonCell([...this.bits], [...this.refs]);
  }
}

function parseSingleRootBocFromHex(hexStr: string): TonCell {
  const buf = Buffer.from(hexStr, 'hex');
  if (buf.length < 6 || buf.readUInt32BE(0) !== BOC_MAGIC) {
    throw new Error('Invalid TON BoC magic');
  }
  const flags = buf[4];
  const hasIdx = (flags & 0x80) !== 0;
  const hasCrc = (flags & 0x40) !== 0;
  const sizeBytes = flags & 0x07;
  const offBytes = buf[5];
  let pos = 6;
  const cellCount = readUintBE(buf, pos, sizeBytes);
  pos += sizeBytes;
  const rootCount = readUintBE(buf, pos, sizeBytes);
  pos += sizeBytes;
  pos += sizeBytes; // absent count
  const totalSize = readUintBE(buf, pos, offBytes);
  pos += offBytes;
  const roots: number[] = [];
  for (let i = 0; i < rootCount; i++) {
    roots.push(readUintBE(buf, pos, sizeBytes));
    pos += sizeBytes;
  }
  if (hasIdx) pos += cellCount * offBytes;
  const end = pos + totalSize;
  if (end + (hasCrc ? 4 : 0) > buf.length) throw new Error('Truncated TON BoC');
  const raw: { bits: number[]; refs: number[] }[] = [];
  while (pos < end) {
    const d1 = buf[pos];
    const d2 = buf[pos + 1];
    pos += 2;
    if (d1 & 0x08 || d1 & 0x10) {
      throw new Error('Exotic TON cells are not supported');
    }
    const refCount = d1 & 0x07;
    const dataLen = Math.ceil(d2 / 2);
    const data = buf.subarray(pos, pos + dataLen);
    pos += dataLen;
    let bitLen = dataLen * 8;
    if (d2 % 2) {
      while (bitLen > 0 && !((data[(bitLen - 1) >> 3] >> (7 - ((bitLen - 1) & 7))) & 1)) {
        bitLen--;
      }
      bitLen--;
    }
    const refs: number[] = [];
    for (let i = 0; i < refCount; i++) {
      refs.push(readUintBE(buf, pos, sizeBytes));
      pos += sizeBytes;
    }
    raw.push({ bits: bufferToBits(data, bitLen), refs });
  }
  if (raw.length !== cellCount || roots.length !== 1) {
    throw new Error('Unexpected TON wallet code BoC layout');
  }
  const built: TonCell[] = new Array(raw.length);
  for (let i = raw.length - 1; i >= 0; i--) {
    built[i] = new TonCell(
      raw[i].bits,
      raw[i].refs.map((r) => {
        if (r <= i || !built[r]) throw new Error('Invalid TON BoC topological order');
        return built[r];
      }),
    );
  }
  return built[roots[0]];
}

const PARSED_WALLET_CODE: Record<FragmentWalletVersion, TonCell> = {
  v4r2: parseSingleRootBocFromHex(WALLET_CODE_HEX.v4r2),
  v5r1: parseSingleRootBocFromHex(WALLET_CODE_HEX.v5r1),
};

export class TonAddress {
  constructor(
    public readonly workchain: number,
    public readonly hash: Buffer,
    public readonly bounceable = false,
    public readonly testOnly = false,
  ) {
    if (hash.length !== 32) {
      throw new Error('TON address hash must be 32 bytes');
    }
  }

  static parse(value: string): TonAddress {
    const trimmed = String(value || '').trim();
    if (/^-?\d+:[0-9a-fA-F]{64}$/.test(trimmed)) {
      const [wc, hex] = trimmed.split(':');
      return new TonAddress(Number(wc), Buffer.from(hex, 'hex'), false, false);
    }
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const raw = Buffer.from(normalized, 'base64');
    if (raw.length !== 36) {
      throw new Error('Некорректный формат TON-адреса');
    }
    if (crc16(raw.subarray(0, 34)) !== raw.readUInt16BE(34)) {
      throw new Error('Неверная контрольная сумма TON-адреса');
    }
    const tag = raw[0];
    const test = (tag & TEST_FLAG) !== 0;
    const base = tag & ~TEST_FLAG;
    if (base !== BOUNCEABLE_TAG && base !== NON_BOUNCEABLE_TAG) {
      throw new Error('Неподдерживаемый тип TON-адреса');
    }
    const wc = raw[1] > 127 ? raw[1] - 256 : raw[1];
    return new TonAddress(wc, Buffer.from(raw.subarray(2, 34)), base === BOUNCEABLE_TAG, test);
  }

  toRaw(): string {
    return `${this.workchain}:${this.hash.toString('hex')}`;
  }

  toFriendly(bounceable = this.bounceable, testOnly = this.testOnly): string {
    const body = Buffer.concat([
      Buffer.from([
        (bounceable ? BOUNCEABLE_TAG : NON_BOUNCEABLE_TAG) | (testOnly ? TEST_FLAG : 0),
        this.workchain & 0xff,
      ]),
      this.hash,
    ]);
    const crc = Buffer.alloc(2);
    crc.writeUInt16BE(crc16(body));
    return Buffer.concat([body, crc])
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  equals(other: TonAddress): boolean {
    return this.workchain === other.workchain && this.hash.equals(other.hash);
  }
}

export function sameTonAddress(a: string, b: string): boolean {
  try {
    return TonAddress.parse(a).equals(TonAddress.parse(b));
  } catch {
    return false;
  }
}

export function normalizeMnemonicWords(mnemonic: string | string[]): string[] {
  const raw = Array.isArray(mnemonic) ? mnemonic.join(' ') : mnemonic;
  return raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function isValidTonMnemonic(mnemonic: string | string[]): boolean {
  const words = normalizeMnemonicWords(mnemonic);
  if (![12, 18, 24].includes(words.length)) return false;
  const entropy = crypto.createHmac('sha512', words.join(' ')).update(Buffer.alloc(0)).digest();
  const check = crypto.pbkdf2Sync(
    entropy,
    'TON seed version',
    Math.max(1, Math.floor(TON_PBKDF_ITERATIONS / 256)),
    64,
    'sha512',
  );
  const valid = check[0] === 0;
  entropy.fill(0);
  check.fill(0);
  return valid;
}

export function computeTonWalletId(walletType: FragmentWalletVersion): number {
  if (walletType === 'v4r2') return V4_SUBWALLET_ID;
  return (0x80000000 ^ (MAINNET_NETWORK_ID >>> 0)) >>> 0;
}

export function computeTonWalletAddress(
  walletType: FragmentWalletVersion,
  publicKey: Buffer,
): TonAddress {
  if (publicKey.length !== 32) {
    throw new Error('Ed25519 public key must be 32 bytes');
  }
  const dataCell =
    walletType === 'v4r2'
      ? new TonCellBuilder()
          .storeUint(0, 32)
          .storeUint(V4_SUBWALLET_ID, 32)
          .storeBuffer(publicKey)
          .storeBit(0)
          .endCell()
      : new TonCellBuilder()
          .storeBit(1)
          .storeUint(0, 32)
          .storeUint(computeTonWalletId('v5r1'), 32)
          .storeBuffer(publicKey)
          .storeBit(0)
          .endCell();

  const stateInitCell = new TonCellBuilder()
    .storeBit(0)
    .storeBit(0)
    .storeMaybeRef(PARSED_WALLET_CODE[walletType])
    .storeMaybeRef(dataCell)
    .storeBit(0)
    .endCell();

  return new TonAddress(0, stateInitCell.hash(), false, false);
}

export function buildTonProofPayload(
  nonce: string,
  fragmentCookies?: string | null,
): string {
  const digest = fragmentCookies
    ? crypto.createHash('sha256').update(fragmentCookies, 'utf8').digest('hex')
    : '';
  return `fragment-api/v3:${nonce}:${digest}`;
}

export function buildTonProofSigningDigest(params: {
  wallet: TonAddress;
  domain: string;
  timestamp: number;
  payload: string;
}): Buffer {
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(params.wallet.workchain);
  const domainBytes = Buffer.from(params.domain, 'utf8');
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(domainBytes.length);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(params.timestamp));

  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/', 'utf8'),
    wc,
    params.wallet.hash,
    domainLen,
    domainBytes,
    ts,
    Buffer.from(params.payload, 'utf8'),
  ]);
  const inner = crypto.createHash('sha256').update(message).digest();
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect', 'utf8'), inner]))
    .digest();
}

function withDerivedKeyMaterial<T>(
  mnemonic: string | string[],
  fn: (material: {
    publicKey: Buffer;
    sign: (digest: Buffer) => Buffer;
    storageKey: Buffer;
  }) => T,
): T {
  const words = normalizeMnemonicWords(mnemonic);
  if (![12, 18, 24].includes(words.length)) {
    throw new FragmentApiError({
      message: 'Некорректная мнемоническая фраза TON-кошелька: ожидается 12, 18 или 24 слова.',
      code: 'INVALID_WALLET_CONFIG',
      retryable: false,
    });
  }
  if (!isValidTonMnemonic(words)) {
    throw new FragmentApiError({
      message: 'Мнемоническая фраза TON-кошелька не прошла проверку контрольной суммы TON.',
      code: 'INVALID_WALLET_CONFIG',
      retryable: false,
    });
  }

  const entropy = crypto
    .createHmac('sha512', words.join(' '))
    .update(Buffer.alloc(0))
    .digest();
  const seed = crypto.pbkdf2Sync(
    entropy,
    'TON default seed',
    TON_PBKDF_ITERATIONS,
    64,
    'sha512',
  );
  const seed32 = Buffer.from(seed.subarray(0, 32));
  const storageKey = crypto
    .createHmac('sha256', seed32)
    .update('quizystars:fragment:auth_storage:v1', 'utf8')
    .digest();

  try {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = crypto
      .createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' }) as Buffer;
    const publicKey = Buffer.from(spki.subarray(-32));
    return fn({
      publicKey,
      sign: (digest: Buffer) => crypto.sign(null, digest, privateKey),
      storageKey,
    });
  } finally {
    entropy.fill(0);
    seed.fill(0);
    seed32.fill(0);
    storageKey.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Error Model & Response Types
// ---------------------------------------------------------------------------

export type FragmentApiErrorCode =
  | 'HTTPS_REQUIRED'
  | 'INVALID_WALLET_CONFIG'
  | 'WALLET_MISMATCH'
  | 'CHALLENGE_EXPIRED'
  | 'PROOF_DOMAIN'
  | 'PROOF_PAYLOAD'
  | 'PROOF_INVALID'
  | 'INVALID_FRAGMENT_COOKIES'
  | 'AUTH_KEY_INVALID'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'FRAGMENT_PURCHASE_NOT_ENABLED_STAGE_4_6_1'
  | 'API_ERROR';

export class FragmentApiError extends Error {
  public readonly httpStatus?: number;
  public readonly code: FragmentApiErrorCode;
  public readonly retryable: boolean;
  public readonly retryAfterSeconds?: number;

  constructor(params: {
    message: string;
    httpStatus?: number;
    code: FragmentApiErrorCode;
    retryable?: boolean;
    retryAfterSeconds?: number;
  }) {
    super(redactSecretsFromText(params.message));
    this.name = 'FragmentApiError';
    this.httpStatus = params.httpStatus;
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export interface FragmentChallenge {
  nonce: string;
  expiresAtUnixSec: number;
  expiresAtMs: number;
  fetchedAtMs: number;
}

export interface FragmentWalletIdentity {
  walletType: FragmentWalletVersion;
  publicKeyHex: string;
  addressRaw: string;
  addressFriendly: string;
  workchain: number;
}

export interface FragmentTonProofPayload {
  timestamp: number;
  domain: string;
  payload: string;
  signature: string;
}

export interface FragmentAuthSummary {
  authenticated: boolean;
  walletType: FragmentWalletVersion;
  walletAddress: string;
  walletAddressFriendly: string;
  kycMode: false;
  apiBaseUrl: string;
  issuedAt: string;
  lastUsedAt: string;
  idleExpiresAt: string;
  maxExpiresAt: string;
  keyFingerprint: string;
  persistedToFirestore: boolean;
}

export interface FragmentStatusSummary {
  providerConfigured: boolean;
  configured: boolean;
  walletConfigured: boolean;
  seedConfigured: boolean;
  walletType: FragmentWalletVersion;
  walletAddress: string | null;
  walletAddressFriendly: string | null;
  kycMode: false;
  apiBaseUrl: string;
  requestTimeoutMs: number;
  authenticated: boolean;
  hasValidAuthKey: boolean;
  keyFingerprint: string | null;
  issuedAt: string | null;
  lastUsedAt: string | null;
  idleExpiresAt: string | null;
  maxExpiresAt: string | null;
  lastChallengeExpiresAt: string | null;
  lastError: string | null;
}

export interface FragmentCredentialsOverride {
  mnemonic?: string;
  walletType?: FragmentWalletVersion;
  apiBaseUrl?: string;
  expectedWalletAddress?: string;
  requestTimeoutMs?: number;
}

interface InternalAuthSession {
  authKey: string;
  keyFingerprint: string;
  walletType: FragmentWalletVersion;
  walletAddress: string;
  walletAddressFriendly: string;
  apiBaseUrl: string;
  issuedAtMs: number;
  lastUsedAtMs: number;
  idleExpiresAtMs: number;
  maxExpiresAtMs: number;
  lastPersistedTouchMs: number;
}

// ---------------------------------------------------------------------------
// FragmentAuthenticationService — Official API v3 Auth Lifecycle (Option 1)
// ---------------------------------------------------------------------------

export class FragmentAuthenticationService {
  private httpTransport: ProviderHttpTransport | null = null;
  private credentialsOverride: FragmentCredentialsOverride | null = null;
  private clockFn: () => number = () => Date.now();
  private session: InternalAuthSession | null = null;
  private authInFlight: Promise<FragmentAuthSummary> | null = null;
  private lastChallenge: FragmentChallenge | null = null;
  private lastError: string | null = null;

  public setHttpTransport(transport: ProviderHttpTransport): void {
    this.httpTransport = transport;
  }

  public resetHttpTransport(): void {
    this.httpTransport = null;
  }

  public setCredentialsOverride(override: FragmentCredentialsOverride | null): void {
    this.credentialsOverride = override;
  }

  public setClock(clock: () => number): void {
    this.clockFn = clock;
  }

  public resetClock(): void {
    this.clockFn = () => Date.now();
  }

  public resetForTests(): void {
    if (this.session) {
      unregisterRuntimeSecret(this.session.authKey);
    }
    this.session = null;
    this.authInFlight = null;
    this.lastChallenge = null;
    this.lastError = null;
    this.httpTransport = null;
    this.credentialsOverride = null;
    this.resetClock();
  }

  private nowMs(): number {
    return this.clockFn();
  }

  private getEffectiveSettings(): {
    mnemonic: string;
    walletType: FragmentWalletVersion;
    apiBaseUrl: string;
    expectedWalletAddress: string;
    requestTimeoutMs: number;
  } {
    const envCfg = getEnvConfig();
    const ov = this.credentialsOverride;
    const rawMnemonic =
      ov && ov.mnemonic !== undefined ? ov.mnemonic : readFragmentWalletSeedFromEnv();
    const walletType: FragmentWalletVersion =
      ov?.walletType || envCfg.fragmentWalletVersion || 'v4r2';
    const rawApiUrl =
      ov && ov.apiBaseUrl !== undefined ? ov.apiBaseUrl : envCfg.fragmentApiUrl;
    const expectedWalletAddress =
      ov && ov.expectedWalletAddress !== undefined
        ? ov.expectedWalletAddress
        : envCfg.tonWalletAddress;
    const requestTimeoutMs =
      ov && ov.requestTimeoutMs !== undefined
        ? Math.max(10, Math.round(ov.requestTimeoutMs))
        : envCfg.fragmentRequestTimeoutMs;

    return {
      mnemonic: rawMnemonic.trim(),
      walletType,
      apiBaseUrl: this.validateApiBaseUrl(rawApiUrl),
      expectedWalletAddress: expectedWalletAddress.trim(),
      requestTimeoutMs,
    };
  }

  public validateApiBaseUrl(rawUrl: string): string {
    const clean = String(rawUrl || 'https://api.fragment-api.net')
      .trim()
      .replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      throw new FragmentApiError({
        message: 'Некорректный FRAGMENT_API_URL.',
        code: 'INVALID_WALLET_CONFIG',
        retryable: false,
      });
    }
    const isLocalHttp =
      parsed.protocol === 'http:' && LOCAL_TEST_HOSTS.has(parsed.hostname.toLowerCase());
    if (parsed.protocol !== 'https:' && !isLocalHttp) {
      throw new FragmentApiError({
        message: `Fragment API v3 требует HTTPS (передан протокол ${parsed.protocol}).`,
        code: 'HTTPS_REQUIRED',
        retryable: false,
      });
    }
    return clean;
  }

  public isWalletConfigured(): boolean {
    try {
      const settings = this.getEffectiveSettings();
      if (!settings.mnemonic) return false;
      return isValidTonMnemonic(settings.mnemonic);
    } catch {
      return false;
    }
  }

  /**
   * Locally derives public key and wallet address (`v4r2` / `v5r1`) from memory-only seed
   * and verifies against `TON_WALLET_ADDRESS` if set. Never logs or returns seed/privateKey.
   */
  public deriveWalletIdentity(): FragmentWalletIdentity {
    const settings = this.getEffectiveSettings();
    if (!settings.mnemonic) {
      throw new FragmentApiError({
        message:
          'Seed-фраза TON-кошелька не задана в переменных окружения (TON_SEED).',
        code: 'INVALID_WALLET_CONFIG',
        retryable: false,
      });
    }

    registerRuntimeSecret(settings.mnemonic);

    return withDerivedKeyMaterial(settings.mnemonic, ({ publicKey }) => {
      const addr = computeTonWalletAddress(settings.walletType, publicKey);
      const addressRaw = addr.toRaw();
      const addressFriendly = addr.toFriendly(false, false);

      if (
        settings.expectedWalletAddress &&
        !sameTonAddress(settings.expectedWalletAddress, addressRaw)
      ) {
        throw new FragmentApiError({
          message: `Вычисленный адрес кошелька (${settings.walletType}: ${addressFriendly}) не совпадает с TON_WALLET_ADDRESS.`,
          code: 'WALLET_MISMATCH',
          retryable: false,
        });
      }

      return {
        walletType: settings.walletType,
        publicKeyHex: publicKey.toString('hex'),
        addressRaw,
        addressFriendly,
        workchain: addr.workchain,
      };
    });
  }

  // -------------------------------------------------------------------------
  // HTTP Transport Execution with Timeout, Rate-Limit, Error Classification
  // -------------------------------------------------------------------------

  private async executeRequest<T>(params: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
    authKey?: string;
  }): Promise<T> {
    const settings = this.getEffectiveSettings();
    const url = `${settings.apiBaseUrl}${params.path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    let serializedBody: string | undefined;
    if (params.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      serializedBody = JSON.stringify(params.body);
    }
    if (params.authKey) {
      headers.Authorization = `Bearer ${params.authKey}`;
    }

    const req: HttpTransportRequest = {
      url,
      method: params.method,
      headers,
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
    };

    const transport: ProviderHttpTransport =
      this.httpTransport ??
      (async (r: HttpTransportRequest): Promise<HttpTransportResponse> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
        try {
          const response = await fetch(r.url, {
            method: r.method,
            headers: r.headers,
            ...(r.body !== undefined ? { body: r.body } : {}),
            signal: controller.signal,
          });
          const rawText = await response.text();
          let json: unknown = {};
          if (rawText) {
            try {
              json = JSON.parse(rawText);
            } catch {
              throw new FragmentApiError({
                message: `Fragment API вернул невалидный JSON (HTTP ${response.status}).`,
                httpStatus: response.status,
                code: 'INVALID_RESPONSE',
                retryable: response.status >= 500,
              });
            }
          }
          const respHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            respHeaders[k.toLowerCase()] = v;
          });
          return {
            status: response.status,
            ok: response.ok,
            json,
            headers: respHeaders,
          };
        } finally {
          clearTimeout(timer);
        }
      });

    let response: HttpTransportResponse;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          const timeoutErr = new Error(
            `Fragment API request timeout after ${settings.requestTimeoutMs}ms`,
          );
          timeoutErr.name = 'AbortError';
          reject(timeoutErr);
        }, settings.requestTimeoutMs);
        timer.unref?.();
      });

      response = await Promise.race([transport(req), timeoutPromise]);
    } catch (error) {
      if (error instanceof FragmentApiError) {
        this.lastError = redactSecretsFromText(error.message);
        throw error;
      }
      const rawMsg = error instanceof Error ? error.message : String(error);
      const isTimeout =
        (error instanceof Error &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
        /timeout|aborted/i.test(rawMsg);

      const wrapped = new FragmentApiError({
        message: isTimeout
          ? `Превышен таймаут ожидания Fragment API (${settings.requestTimeoutMs} мс) на ${params.path}.`
          : `Сетевая ошибка при обращении к Fragment API (${params.path}): ${rawMsg}`,
        code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        retryable: true,
      });
      this.lastError = wrapped.message;
      throw wrapped;
    }

    if (!response.ok) {
      const apiErr = this.buildHttpApiError(params.path, response);
      this.lastError = apiErr.message;
      throw apiErr;
    }

    if (!response.json || typeof response.json !== 'object' || Array.isArray(response.json)) {
      const badJsonErr = new FragmentApiError({
        message: `Fragment API вернул неожиданный формат ответа на ${params.path}.`,
        httpStatus: response.status,
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
      this.lastError = badJsonErr.message;
      throw badJsonErr;
    }

    return response.json as T;
  }

  private buildHttpApiError(path: string, response: HttpTransportResponse): FragmentApiError {
    const rec =
      response.json && typeof response.json === 'object' && !Array.isArray(response.json)
        ? (response.json as Record<string, unknown>)
        : {};
    const rawCode =
      typeof rec.error_code === 'string'
        ? rec.error_code.trim().toUpperCase()
        : typeof rec.code === 'string'
          ? rec.code.trim().toUpperCase()
          : '';
    const detailMsg =
      typeof rec.message === 'string' && rec.message.trim()
        ? rec.message.trim()
        : typeof rec.detail === 'string' && rec.detail.trim()
          ? rec.detail.trim()
          : typeof rec.error === 'string' && rec.error.trim()
            ? rec.error.trim()
            : `HTTP ${response.status}`;

    const retryAfterRaw = response.headers?.['retry-after'];
    const retryAfterNum = retryAfterRaw ? Number(retryAfterRaw) : NaN;
    const retryAfterSeconds =
      Number.isFinite(retryAfterNum) && retryAfterNum > 0
        ? Math.round(retryAfterNum)
        : undefined;

    let code: FragmentApiErrorCode = 'API_ERROR';
    let retryable = false;

    if (response.status === 429) {
      code = 'RATE_LIMITED';
      retryable = true;
    } else if (response.status >= 500) {
      code = 'SERVER_ERROR';
      retryable = true;
    } else if (
      rawCode === 'PROOF_DOMAIN' ||
      rawCode === 'PROOF_PAYLOAD' ||
      rawCode === 'PROOF_INVALID' ||
      rawCode === 'INVALID_FRAGMENT_COOKIES' ||
      rawCode === 'AUTH_KEY_INVALID' ||
      rawCode === 'HTTPS_REQUIRED' ||
      rawCode === 'WALLET_MISMATCH'
    ) {
      code = rawCode;
      retryable = rawCode === 'AUTH_KEY_INVALID';
    } else if (response.status === 401 || response.status === 403) {
      code = 'UNAUTHORIZED';
      retryable = true;
    }

    return new FragmentApiError({
      message: `Fragment API ошибка ${path} (HTTP ${response.status}${rawCode ? `, ${rawCode}` : ''}): ${detailMsg}`,
      httpStatus: response.status,
      code,
      retryable,
      retryAfterSeconds,
    });
  }

  // -------------------------------------------------------------------------
  // Step 1: GET /v3/auth/challenge
  // -------------------------------------------------------------------------

  public async fetchChallenge(): Promise<FragmentChallenge> {
    const data = await this.executeRequest<{
      success?: unknown;
      nonce?: unknown;
      expires_at?: unknown;
    }>({
      method: 'GET',
      path: '/v3/auth/challenge',
    });

    if (
      data.success !== true ||
      typeof data.nonce !== 'string' ||
      !data.nonce.trim() ||
      typeof data.expires_at !== 'number' ||
      !Number.isFinite(data.expires_at) ||
      data.expires_at <= 0
    ) {
      throw new FragmentApiError({
        message: 'Fragment API /v3/auth/challenge вернул неполный или некорректный challenge.',
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
    }

    const challenge: FragmentChallenge = {
      nonce: data.nonce.trim(),
      expiresAtUnixSec: data.expires_at,
      expiresAtMs: data.expires_at * 1000,
      fetchedAtMs: this.nowMs(),
    };
    this.lastChallenge = challenge;
    return challenge;
  }

  // -------------------------------------------------------------------------
  // Step 2-3: Local ton_proof signing + POST /v3/auth + encrypted storage
  // -------------------------------------------------------------------------

  private signChallengeLocally(
    challenge: FragmentChallenge,
    identity: FragmentWalletIdentity,
  ): FragmentTonProofPayload {
    const nowMs = this.nowMs();
    if (challenge.expiresAtMs <= nowMs) {
      throw new FragmentApiError({
        message: 'Срок действия одноразового challenge истёк до отправки подписи. Запросите новый challenge.',
        code: 'CHALLENGE_EXPIRED',
        retryable: true,
      });
    }

    const settings = this.getEffectiveSettings();
    const domain = new URL(settings.apiBaseUrl).hostname;
    const timestamp = Math.floor(nowMs / 1000);
    // Stage 4.6.1 Option 1: No-KYC mode (fragment_cookies: null -> empty cookie digest suffix)
    const payload = buildTonProofPayload(challenge.nonce, null);
    const wallet = TonAddress.parse(identity.addressRaw);
    const digest = buildTonProofSigningDigest({
      wallet,
      domain,
      timestamp,
      payload,
    });

    const signature = withDerivedKeyMaterial(settings.mnemonic, ({ sign }) =>
      sign(digest).toString('base64'),
    );
    registerRuntimeSecret(signature);

    return {
      timestamp,
      domain,
      payload,
      signature,
    };
  }

  private encryptAuthKeyForStorage(
    authKey: string,
    mnemonic: string,
    walletAddressRaw: string,
  ): string {
    return withDerivedKeyMaterial(mnemonic, ({ storageKey }) => {
      const iv = crypto.randomBytes(12);
      const aad = Buffer.from(`${walletAddressRaw}:fragment_auth`, 'utf8');
      const cipher = crypto.createCipheriv('aes-256-gcm', storageKey, iv);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([
        cipher.update(authKey, 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
    });
  }

  private decryptAuthKeyFromStorage(
    encryptedPayload: string,
    mnemonic: string,
    walletAddressRaw: string,
  ): string | null {
    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) return null;
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const tag = Buffer.from(parts[1], 'base64');
      const ciphertext = Buffer.from(parts[2], 'base64');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
        return null;
      }
      return withDerivedKeyMaterial(mnemonic, ({ storageKey }) => {
        const aad = Buffer.from(`${walletAddressRaw}:fragment_auth`, 'utf8');
        const decipher = crypto.createDecipheriv('aes-256-gcm', storageKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        return decrypted.toString('utf8');
      });
    } catch {
      return null;
    }
  }

  private computeKeyFingerprint(authKey: string): string {
    return crypto.createHash('sha256').update(authKey, 'utf8').digest('hex').slice(0, 8);
  }

  private async persistSession(session: InternalAuthSession, mnemonic: string): Promise<boolean> {
    try {
      const encryptedAuthKey = this.encryptAuthKeyForStorage(
        session.authKey,
        mnemonic,
        session.walletAddress,
      );
      const nowIso = new Date(this.nowMs()).toISOString();
      const record: FragmentAuthSessionRecord = {
        key: 'fragment_auth',
        walletAddress: session.walletAddress,
        walletAddressFriendly: session.walletAddressFriendly,
        walletType: session.walletType,
        kycMode: false,
        apiBaseUrl: session.apiBaseUrl,
        encryptedAuthKey,
        keyFingerprint: session.keyFingerprint,
        issuedAt: new Date(session.issuedAtMs).toISOString(),
        lastUsedAt: new Date(session.lastUsedAtMs).toISOString(),
        idleExpiresAt: new Date(session.idleExpiresAtMs).toISOString(),
        maxExpiresAt: new Date(session.maxExpiresAtMs).toISOString(),
        updatedAt: nowIso,
      };
      await firestoreRepo.setDoc<FragmentAuthSessionRecord>(
        'settings',
        FRAGMENT_AUTH_DOC_ID,
        record,
      );
      session.lastPersistedTouchMs = this.nowMs();
      return true;
    } catch {
      return false;
    }
  }

  private async tryLoadPersistedSession(): Promise<InternalAuthSession | null> {
    if (!this.isWalletConfigured()) return null;
    try {
      const settings = this.getEffectiveSettings();
      const identity = this.deriveWalletIdentity();
      const record = await firestoreRepo.getDoc<FragmentAuthSessionRecord>(
        'settings',
        FRAGMENT_AUTH_DOC_ID,
      );
      if (!record || record.key !== 'fragment_auth' || !record.encryptedAuthKey) {
        return null;
      }
      if (
        !sameTonAddress(record.walletAddress, identity.addressRaw) ||
        record.walletType !== identity.walletType ||
        record.apiBaseUrl !== settings.apiBaseUrl
      ) {
        return null;
      }

      const issuedAtMs = Date.parse(record.issuedAt);
      const lastUsedAtMs = Date.parse(record.lastUsedAt);
      const idleExpiresAtMs = Date.parse(record.idleExpiresAt);
      const maxExpiresAtMs = Date.parse(record.maxExpiresAt);
      if (
        !Number.isFinite(issuedAtMs) ||
        !Number.isFinite(lastUsedAtMs) ||
        !Number.isFinite(idleExpiresAtMs) ||
        !Number.isFinite(maxExpiresAtMs)
      ) {
        return null;
      }

      const decryptedKey = this.decryptAuthKeyFromStorage(
        record.encryptedAuthKey,
        settings.mnemonic,
        identity.addressRaw,
      );
      if (!decryptedKey) {
        return null;
      }
      registerRuntimeSecret(decryptedKey);

      const loaded: InternalAuthSession = {
        authKey: decryptedKey,
        keyFingerprint: this.computeKeyFingerprint(decryptedKey),
        walletType: identity.walletType,
        walletAddress: identity.addressRaw,
        walletAddressFriendly: identity.addressFriendly,
        apiBaseUrl: settings.apiBaseUrl,
        issuedAtMs,
        lastUsedAtMs,
        idleExpiresAtMs,
        maxExpiresAtMs,
        lastPersistedTouchMs: lastUsedAtMs,
      };
      if (!this.isSessionValid(loaded, settings.apiBaseUrl, identity)) {
        unregisterRuntimeSecret(decryptedKey);
        return null;
      }
      return loaded;
    } catch {
      return null;
    }
  }

  private isSessionValid(
    session: InternalAuthSession | null,
    apiBaseUrl: string,
    identity: FragmentWalletIdentity,
  ): boolean {
    if (!session) return false;
    if (
      session.apiBaseUrl !== apiBaseUrl ||
      session.walletType !== identity.walletType ||
      !sameTonAddress(session.walletAddress, identity.addressRaw)
    ) {
      return false;
    }
    const nowMs = this.nowMs();
    const effectiveIdleDeadline = Math.min(
      session.lastUsedAtMs + FRAGMENT_IDLE_TTL_MS,
      session.idleExpiresAtMs,
    );
    const effectiveMaxDeadline = Math.min(
      session.issuedAtMs + FRAGMENT_MAX_LIFETIME_MS,
      session.maxExpiresAtMs,
    );
    const hardDeadline = Math.min(effectiveIdleDeadline, effectiveMaxDeadline);
    return nowMs + FRAGMENT_EXPIRY_SAFETY_BUFFER_MS < hardDeadline;
  }

  /**
   * Executes full Fragment API v3 authentication flow:
   * 1. Derives TON wallet (`v4r2` / `v5r1`) in memory without exposing mnemonic/private key
   * 2. Fetches one-time challenge (`GET /v3/auth/challenge`)
   * 3. Validates challenge expiration and signs TON Connect `ton_proof` (No-KYC: `fragment_cookies: null`)
   * 4. Sends `POST /v3/auth` and verifies returned wallet equals local derived wallet
   * 5. Stores `auth_key` securely in memory + AES-256-GCM encrypted session doc
   */
  public async authenticate(options?: {
    challengeOverride?: FragmentChallenge;
  }): Promise<FragmentAuthSummary> {
    if (this.authInFlight) {
      return this.authInFlight;
    }

    const run = async (): Promise<FragmentAuthSummary> => {
      const settings = this.getEffectiveSettings();
      const identity = this.deriveWalletIdentity();

      const challenge = options?.challengeOverride ?? (await this.fetchChallenge());
      const proof = this.signChallengeLocally(challenge, identity);

      const authResponse = await this.executeRequest<{
        success?: unknown;
        auth_key?: unknown;
        wallet?: {
          address?: unknown;
          address_friendly?: unknown;
          wallet_type?: unknown;
        };
      }>({
        method: 'POST',
        path: '/v3/auth',
        body: {
          public_key: identity.publicKeyHex,
          wallet_type: identity.walletType,
          fragment_cookies: null,
          proof,
        },
      });

      const returnedKey =
        typeof authResponse.auth_key === 'string' ? authResponse.auth_key.trim() : '';
      const returnedAddr =
        typeof authResponse.wallet?.address === 'string'
          ? authResponse.wallet.address.trim()
          : '';
      const returnedType = authResponse.wallet?.wallet_type;

      if (authResponse.success !== true || !returnedKey || !returnedAddr) {
        throw new FragmentApiError({
          message: 'Fragment API /v3/auth вернул неполный ответ без auth_key или wallet.',
          code: 'INVALID_RESPONSE',
          retryable: false,
        });
      }

      registerRuntimeSecret(returnedKey);

      if (
        !sameTonAddress(returnedAddr, identity.addressRaw) ||
        (returnedType && returnedType !== identity.walletType)
      ) {
        unregisterRuntimeSecret(returnedKey);
        throw new FragmentApiError({
          message: 'Fragment API /v3/auth вернул кошелёк, не совпадающий с локальным кошельком QuizyStars.',
          code: 'WALLET_MISMATCH',
          retryable: false,
        });
      }

      if (this.session && this.session.authKey !== returnedKey) {
        unregisterRuntimeSecret(this.session.authKey);
      }

      const nowMs = this.nowMs();
      const maxExpiresAtMs = nowMs + FRAGMENT_MAX_LIFETIME_MS;
      const idleExpiresAtMs = Math.min(nowMs + FRAGMENT_IDLE_TTL_MS, maxExpiresAtMs);
      const nextSession: InternalAuthSession = {
        authKey: returnedKey,
        keyFingerprint: this.computeKeyFingerprint(returnedKey),
        walletType: identity.walletType,
        walletAddress: identity.addressRaw,
        walletAddressFriendly:
          typeof authResponse.wallet?.address_friendly === 'string' &&
          authResponse.wallet.address_friendly.trim()
            ? authResponse.wallet.address_friendly.trim()
            : identity.addressFriendly,
        apiBaseUrl: settings.apiBaseUrl,
        issuedAtMs: nowMs,
        lastUsedAtMs: nowMs,
        idleExpiresAtMs,
        maxExpiresAtMs,
        lastPersistedTouchMs: 0,
      };
      this.session = nextSession;
      this.lastError = null;

      const persisted = await this.persistSession(nextSession, settings.mnemonic);
      return this.toSummary(nextSession, persisted);
    };

    this.authInFlight = run().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private toSummary(
    session: InternalAuthSession,
    persistedToFirestore: boolean,
  ): FragmentAuthSummary {
    return {
      authenticated: true,
      walletType: session.walletType,
      walletAddress: session.walletAddress,
      walletAddressFriendly: session.walletAddressFriendly,
      kycMode: false,
      apiBaseUrl: session.apiBaseUrl,
      issuedAt: new Date(session.issuedAtMs).toISOString(),
      lastUsedAt: new Date(session.lastUsedAtMs).toISOString(),
      idleExpiresAt: new Date(session.idleExpiresAtMs).toISOString(),
      maxExpiresAt: new Date(session.maxExpiresAtMs).toISOString(),
      keyFingerprint: session.keyFingerprint,
      persistedToFirestore,
    };
  }

  /**
   * Returns a valid `auth_key` strictly for internal `Authorization: Bearer <auth_key>` headers.
   * Automatically restores encrypted Firestore session or re-authenticates on expiry.
   */
  public async getValidAuthKey(options?: { forceRefresh?: boolean }): Promise<string> {
    if (options?.forceRefresh) {
      await this.invalidateLocalSession();
      await this.authenticate();
      if (!this.session) {
        throw new FragmentApiError({
          message: 'Не удалось обновить auth_key Fragment API.',
          code: 'AUTH_KEY_INVALID',
          retryable: false,
        });
      }
      return this.session.authKey;
    }

    const settings = this.getEffectiveSettings();
    const identity = this.deriveWalletIdentity();

    if (!this.isSessionValid(this.session, settings.apiBaseUrl, identity)) {
      if (this.session) {
        unregisterRuntimeSecret(this.session.authKey);
        this.session = null;
      }
      const restored = await this.tryLoadPersistedSession();
      if (restored && this.isSessionValid(restored, settings.apiBaseUrl, identity)) {
        this.session = restored;
      }
    }

    if (!this.isSessionValid(this.session, settings.apiBaseUrl, identity)) {
      await this.authenticate();
    }

    if (!this.session) {
      throw new FragmentApiError({
        message: 'Сессия авторизации Fragment API недоступна.',
        code: 'AUTH_KEY_INVALID',
        retryable: false,
      });
    }

    await this.touchSessionUsed(settings.mnemonic);
    return this.session.authKey;
  }

  public async touchSessionUsed(mnemonic?: string): Promise<void> {
    if (!this.session) return;
    const nowMs = this.nowMs();
    this.session.lastUsedAtMs = nowMs;
    this.session.idleExpiresAtMs = Math.min(
      nowMs + FRAGMENT_IDLE_TTL_MS,
      this.session.maxExpiresAtMs,
    );

    if (nowMs - this.session.lastPersistedTouchMs >= FRAGMENT_LAST_USED_PERSIST_INTERVAL_MS) {
      const seed = mnemonic ?? this.getEffectiveSettings().mnemonic;
      if (seed) {
        await this.persistSession(this.session, seed);
      }
    }
  }

  public async invalidateLocalSession(): Promise<void> {
    if (this.session) {
      unregisterRuntimeSecret(this.session.authKey);
      this.session = null;
    }
    try {
      await firestoreRepo.deleteDoc('settings', FRAGMENT_AUTH_DOC_ID);
    } catch {
      // Ignore storage cleanup error on local invalidation
    }
  }

  /**
   * Revokes the current `auth_key` via `DELETE /v3/auth` (Bearer header)
   * and wipes both in-memory cache and persistent encrypted session.
   */
  public async revokeAuthKey(): Promise<{ revoked: boolean; remoteCalled: boolean }> {
    const activeKey = this.session?.authKey ?? (await this.tryLoadPersistedSession())?.authKey;
    if (!activeKey) {
      await this.invalidateLocalSession();
      return { revoked: true, remoteCalled: false };
    }

    try {
      await this.executeRequest<{ success?: unknown }>({
        method: 'DELETE',
        path: '/v3/auth',
        authKey: activeKey,
      });
      await this.invalidateLocalSession();
      return { revoked: true, remoteCalled: true };
    } catch (error) {
      // Clear local credentials immediately on explicit revocation request
      await this.invalidateLocalSession();
      if (
        error instanceof FragmentApiError &&
        (error.code === 'AUTH_KEY_INVALID' ||
          error.code === 'UNAUTHORIZED' ||
          error.httpStatus === 401)
      ) {
        return { revoked: true, remoteCalled: true };
      }
      throw error;
    }
  }

  /**
   * Authenticated request helper for Fragment API v3 Bearer endpoints.
   * Automatically refreshes sliding TTL on success and re-authenticates once on 401 / AUTH_KEY_INVALID.
   */
  public async authorizedRequest<T>(params: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
  }): Promise<T> {
    const authKey = await this.getValidAuthKey();
    try {
      const res = await this.executeRequest<T>({
        ...params,
        authKey,
      });
      await this.touchSessionUsed();
      return res;
    } catch (error) {
      if (
        error instanceof FragmentApiError &&
        (error.code === 'AUTH_KEY_INVALID' ||
          error.code === 'UNAUTHORIZED' ||
          error.httpStatus === 401 ||
          error.httpStatus === 403)
      ) {
        const refreshedKey = await this.getValidAuthKey({ forceRefresh: true });
        const retryRes = await this.executeRequest<T>({
          ...params,
          authKey: refreshedKey,
        });
        await this.touchSessionUsed();
        return retryRes;
      }
      throw error;
    }
  }

  public getStatusSummary(): FragmentStatusSummary {
    const envCfg = getEnvConfig();
    let apiBaseUrl = envCfg.fragmentApiUrl;
    let walletType: FragmentWalletVersion = envCfg.fragmentWalletVersion;
    let timeoutMs = envCfg.fragmentRequestTimeoutMs;
    let seedConfigured = false;
    let walletAddress: string | null = null;
    let walletAddressFriendly: string | null = null;
    let walletConfigured = false;
    let hasValidAuthKey = false;

    try {
      const settings = this.getEffectiveSettings();
      apiBaseUrl = settings.apiBaseUrl;
      walletType = settings.walletType;
      timeoutMs = settings.requestTimeoutMs;
      seedConfigured = settings.mnemonic.length > 0;
      if (seedConfigured) {
        const identity = this.deriveWalletIdentity();
        walletAddress = identity.addressRaw;
        walletAddressFriendly = identity.addressFriendly;
        walletConfigured = true;
        hasValidAuthKey = this.isSessionValid(this.session, apiBaseUrl, identity);
      }
    } catch {
      walletConfigured = false;
      hasValidAuthKey = false;
    }

    const active = hasValidAuthKey ? this.session : null;

    return {
      providerConfigured: envCfg.fulfillmentProvider === 'fragment',
      configured: walletConfigured,
      walletConfigured,
      seedConfigured,
      walletType,
      walletAddress,
      walletAddressFriendly,
      kycMode: false,
      apiBaseUrl,
      requestTimeoutMs: timeoutMs,
      authenticated: active !== null,
      hasValidAuthKey,
      keyFingerprint: active?.keyFingerprint ?? null,
      issuedAt: active ? new Date(active.issuedAtMs).toISOString() : null,
      lastUsedAt: active ? new Date(active.lastUsedAtMs).toISOString() : null,
      idleExpiresAt: active ? new Date(active.idleExpiresAtMs).toISOString() : null,
      maxExpiresAt: active ? new Date(active.maxExpiresAtMs).toISOString() : null,
      lastChallengeExpiresAt: this.lastChallenge
        ? new Date(this.lastChallenge.expiresAtMs).toISOString()
        : null,
      lastError: this.lastError ? redactSecretsFromText(this.lastError) : null,
    };
  }
}

export const fragmentAuthService = new FragmentAuthenticationService();
