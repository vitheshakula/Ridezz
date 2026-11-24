/**
 * TypeScript adapter for the native Android Keystore link signer (`RideazeLinkSigner`).
 *
 * The native module owns the per-ride-session P-256 key (non-exportable, never visible here) and
 * signs ONLY canonical link-auth PROOF / CONFIRM statements for its own node id. This adapter:
 *   - exposes exactly the native operations, no more (no raw signing, no key export, no identity
 *     replacement, no retries, no automatic generation or release);
 *   - validates every argument before calling native code, and EVERY native response before
 *     returning it: nothing the bridge returns is trusted;
 *   - derives the node id from the returned public key itself and requires it to match;
 *   - maps native failures to stable error codes without leaking native messages or identifiers.
 *
 * Android only. Pure dependency injection: no Android globals are touched at import time.
 * The asynchronous `linkAuthenticator` effects are wired up by a later task.
 */

import { p256 } from '@noble/curves/nist.js';
import { Platform, NativeModules } from 'react-native';
import { p256RuntimeCrypto } from './p256Crypto';
import { decodeBase64Url } from './protocol/base64url';
import {
  deriveRideNodeId,
  isCanonicalRideNodeId,
  isCanonicalRideSessionId,
} from './protocol/rideCredential';

/** Error codes reported by the native module (see LinkSignerErrors.kt). */
export const NATIVE_LINK_SIGNER_ERROR_CODES = [
  'invalid_argument',
  'identity_not_found',
  'identity_lost',
  'identity_mismatch',
  'invalid_metadata',
  'statement_rejected',
  'keystore_unavailable',
  'signing_failed',
  'invalid_signature_encoding',
  'busy',
] as const;

export type NativeLinkSignerErrorCode =
  (typeof NATIVE_LINK_SIGNER_ERROR_CODES)[number];

/**
 * Adapter-level codes: `native_unavailable` (no module / not Android), `invalid_native_response`
 * (the bridge returned something that fails validation), `native_error` (any other failure).
 */
export type LinkSignerErrorCode =
  | NativeLinkSignerErrorCode
  | 'native_unavailable'
  | 'invalid_native_response'
  | 'native_error';

/** The message is only the code: native messages, identifiers and statements are never included. */
export class LinkSignerError extends Error {
  readonly code: LinkSignerErrorCode;

  constructor(code: LinkSignerErrorCode) {
    super(code);
    this.name = 'LinkSignerError';
    this.code = code;
  }
}

export type LinkSigningStage = 'proof' | 'confirm';
export type LinkKeySecurityLevel = 'strongbox' | 'tee' | 'software' | 'unknown';
export type LinkIdentityStatus =
  | 'ok'
  | 'identity_lost'
  | 'key_without_metadata'
  | 'invalid_metadata'
  | 'identity_mismatch'
  | 'keystore_unavailable';

const SECURITY_LEVELS: readonly string[] = [
  'strongbox',
  'tee',
  'software',
  'unknown',
];
const IDENTITY_STATUSES: readonly string[] = [
  'ok',
  'identity_lost',
  'key_without_metadata',
  'invalid_metadata',
  'identity_mismatch',
  'keystore_unavailable',
];

/** A verified ride-session identity. Bytes are returned as fresh copies on every call. */
export interface LinkSignerIdentity {
  readonly sessionId: string;
  /** Equals deriveRideNodeId(publicKey()): checked, never taken on trust. */
  readonly nodeId: string;
  readonly createdAtMs: number;
  readonly securityLevel: LinkKeySecurityLevel;
  /** True only for the call that generated the key. */
  readonly created: boolean;
  /** The 65-byte uncompressed P-256 point (a fresh copy). */
  publicKey(): Uint8Array;
}

/** One row of the inventory; fields beyond the status may be null for broken identities. */
export interface LinkSignerListing {
  readonly sessionId: string;
  readonly status: LinkIdentityStatus;
  readonly nodeId: string | null;
  readonly createdAtMs: number | null;
  readonly securityLevel: LinkKeySecurityLevel | null;
}

export interface LinkSigner {
  /** Creates the identity only if neither a key nor metadata exist for the session. */
  ensureIdentity(sessionId: string): Promise<LinkSignerIdentity>;
  /** The existing identity or null. Never generates a key. */
  getIdentity(sessionId: string): Promise<LinkSignerIdentity | null>;
  /**
   * Signs a canonical PROOF or CONFIRM statement (the exact text produced by `linkAuthSigningInput`)
   * with the session key. Returns the 64-byte IEEE P1363 signature, high-S or low-S, unmodified.
   */
  signLinkAuthStatement(
    sessionId: string,
    stage: LinkSigningStage,
    statement: string,
  ): Promise<Uint8Array>;
  /** Read-only inventory of the identities on this device. */
  listIdentities(): Promise<readonly LinkSignerListing[]>;
  /**
   * Explicitly deletes the identity of `sessionId`, only if it is exactly `expectedNodeId`. The
   * caller must first reconcile the outbox: this adapter does no such orchestration and never
   * releases anything by itself.
   */
  releaseIdentity(sessionId: string, expectedNodeId: string): Promise<void>;
}

/** The native module as the bridge exposes it (every result is `unknown` until validated). */
export interface RideazeLinkSignerNative {
  ensureIdentity(sessionId: string): Promise<unknown>;
  getIdentity(sessionId: string): Promise<unknown>;
  signLinkAuthStatement(
    sessionId: string,
    stage: string,
    statement: string,
  ): Promise<unknown>;
  listIdentities(): Promise<unknown>;
  releaseIdentity(sessionId: string, expectedNodeId: string): Promise<unknown>;
}

export interface LinkSignerCrypto {
  readonly sha256: (data: Uint8Array) => Uint8Array;
}

const PUBLIC_KEY_BYTES = 65;
const PUBLIC_KEY_CHARS = 87;
const SIGNATURE_BYTES = 64;
const SIGNATURE_CHARS = 86;
/**
 * The NIST P-256 group order n (FIPS 186-4, D.1.2.3), big-endian. Compared as bytes so no BigInt
 * support is needed under Hermes. A unit test checks this constant against @noble/curves.
 */
const P256_ORDER = Uint8Array.from([
  0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9,
  0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
]);
const SCALAR_BYTES = 32;
const MAX_STATEMENT_CHARS = 512;
const MAX_LISTING = 1000;

const IDENTITY_KEYS = [
  'created',
  'createdAt',
  'nodeId',
  'publicKey',
  'securityLevel',
  'sessionId',
];
const LISTING_KEYS = [
  'createdAt',
  'nodeId',
  'securityLevel',
  'sessionId',
  'status',
];

const invalidResponse = (): never => {
  throw new LinkSignerError('invalid_native_response');
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Maps anything a native call can throw or reject to a stable adapter error. */
function toLinkSignerError(error: unknown): LinkSignerError {
  if (error instanceof LinkSignerError) {
    return error;
  }
  let code: unknown;
  try {
    code =
      typeof error === 'object' && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
  } catch {
    code = undefined;
  }
  if (
    typeof code === 'string' &&
    (NATIVE_LINK_SIGNER_ERROR_CODES as readonly string[]).includes(code)
  ) {
    return new LinkSignerError(code as NativeLinkSignerErrorCode);
  }
  return new LinkSignerError('native_error');
}

/** A 65-byte uncompressed point that really lies on P-256 (checked by the P-256 library). */
function isValidP256Point(bytes: Uint8Array): boolean {
  if (bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    return false;
  }
  try {
    p256.Point.fromBytes(Uint8Array.from(bytes)).assertValidity();
    return true;
  } catch {
    return false;
  }
}

function readSecurityLevel(value: unknown): LinkKeySecurityLevel {
  if (typeof value !== 'string' || !SECURITY_LEVELS.includes(value)) {
    return invalidResponse();
  }
  return value as LinkKeySecurityLevel;
}

function readIdentity(
  value: unknown,
  requestedSessionId: string,
  crypto: LinkSignerCrypto,
): LinkSignerIdentity {
  if (!isPlainObject(value) || !hasExactKeys(value, IDENTITY_KEYS)) {
    return invalidResponse();
  }
  const { sessionId, nodeId, publicKey, createdAt, securityLevel, created } =
    value;
  if (
    sessionId !== requestedSessionId ||
    !isCanonicalRideSessionId(sessionId)
  ) {
    return invalidResponse();
  }
  if (typeof publicKey !== 'string' || publicKey.length !== PUBLIC_KEY_CHARS) {
    return invalidResponse();
  }
  const decoded = decodeBase64Url(publicKey);
  if (decoded === null || !isValidP256Point(decoded)) {
    return invalidResponse();
  }
  let derived: string;
  try {
    derived = deriveRideNodeId(decoded, crypto.sha256);
  } catch {
    return invalidResponse();
  }
  if (!isCanonicalRideNodeId(nodeId) || nodeId !== derived) {
    return invalidResponse();
  }
  if (!isTimestamp(createdAt) || typeof created !== 'boolean') {
    return invalidResponse();
  }
  const level = readSecurityLevel(securityLevel);
  const key = Uint8Array.from(decoded);
  return Object.freeze({
    sessionId,
    nodeId,
    createdAtMs: createdAt,
    securityLevel: level,
    created,
    publicKey: () => Uint8Array.from(key),
  });
}

/** True for a 32-byte big-endian scalar `x` with 1 <= x < n. Reads every byte: no early exit. */
function isScalarInRange(signature: Uint8Array, start: number): boolean {
  let nonZero = false;
  let order = 0; // -1: below n, 0: equal so far, 1: above n
  for (let i = 0; i < SCALAR_BYTES; i++) {
    const byte = signature[start + i];
    if (byte !== 0) {
      nonZero = true;
    }
    if (order === 0 && byte !== P256_ORDER[i]) {
      order = byte < P256_ORDER[i] ? -1 : 1;
    }
  }
  return nonZero && order === -1;
}

function readSignature(value: unknown): Uint8Array {
  // 86 canonical characters decode to exactly 64 bytes: a DER signature (70-72 bytes) can never fit.
  // Then r and s are range-checked (see isScalarInRange).
  if (typeof value !== 'string' || value.length !== SIGNATURE_CHARS) {
    return invalidResponse();
  }
  const decoded = decodeBase64Url(value);
  if (decoded === null || decoded.length !== SIGNATURE_BYTES) {
    return invalidResponse();
  }
  // r and s must both lie in [1, n-1]. High-S and low-S are BOTH valid and the bytes are never changed.
  if (!isScalarInRange(decoded, 0) || !isScalarInRange(decoded, SCALAR_BYTES)) {
    return invalidResponse();
  }
  return Uint8Array.from(decoded);
}

function readListing(value: unknown): readonly LinkSignerListing[] {
  if (!Array.isArray(value) || value.length > MAX_LISTING) {
    return invalidResponse();
  }
  const seen = new Set<string>();
  const out = value.map((row: unknown): LinkSignerListing => {
    if (!isPlainObject(row) || !hasExactKeys(row, LISTING_KEYS)) {
      return invalidResponse();
    }
    const { sessionId, status, nodeId, createdAt, securityLevel } = row;
    if (!isCanonicalRideSessionId(sessionId) || seen.has(sessionId)) {
      return invalidResponse();
    }
    seen.add(sessionId);
    if (typeof status !== 'string' || !IDENTITY_STATUSES.includes(status)) {
      return invalidResponse();
    }
    if (nodeId !== null && !isCanonicalRideNodeId(nodeId)) {
      return invalidResponse();
    }
    if (createdAt !== null && !isTimestamp(createdAt)) {
      return invalidResponse();
    }
    // Native only reports `ok` when the stored metadata exists and matches the key, so all three
    // fields are present. Every other status may legitimately have any of them null
    // (identity_lost / keystore_unavailable: all null; key_without_metadata: only nodeId).
    if (
      status === 'ok' &&
      (nodeId === null || createdAt === null || securityLevel === null)
    ) {
      return invalidResponse();
    }
    return Object.freeze({
      sessionId,
      status: status as LinkIdentityStatus,
      nodeId: nodeId as string | null,
      createdAtMs: createdAt as number | null,
      securityLevel:
        securityLevel === null ? null : readSecurityLevel(securityLevel),
    });
  });
  return Object.freeze(out);
}

function requireSessionId(sessionId: unknown): string {
  if (!isCanonicalRideSessionId(sessionId)) {
    throw new LinkSignerError('invalid_argument');
  }
  return sessionId;
}

/**
 * @param native the `RideazeLinkSigner` module, or null/undefined if it is not available
 * @param crypto the injected SHA-256 (use `p256RuntimeCrypto`)
 * @param platform the React Native platform; anything but 'android' is unsupported
 *
 * Creation never touches the native module. Every operation on a signer without a usable native
 * module rejects with `native_unavailable`; there is no JavaScript signing fallback.
 */
export function createAndroidLinkSigner(
  native: Partial<RideazeLinkSignerNative> | null | undefined,
  crypto: LinkSignerCrypto,
  platform: string = Platform.OS,
): LinkSigner {
  const module = (): RideazeLinkSignerNative => {
    if (
      platform !== 'android' ||
      !native ||
      typeof native.ensureIdentity !== 'function' ||
      typeof native.getIdentity !== 'function' ||
      typeof native.signLinkAuthStatement !== 'function' ||
      typeof native.listIdentities !== 'function' ||
      typeof native.releaseIdentity !== 'function'
    ) {
      throw new LinkSignerError('native_unavailable');
    }
    return native as RideazeLinkSignerNative;
  };

  /** Runs exactly one native call: no retry, and no other native operation as a side effect. */
  const call = async <T>(
    invoke: (m: RideazeLinkSignerNative) => Promise<unknown>,
    read: (r: unknown) => T,
  ): Promise<T> => {
    let result: unknown;
    try {
      result = await invoke(module());
    } catch (error) {
      throw toLinkSignerError(error);
    }
    try {
      return read(result);
    } catch (error) {
      // Anything thrown while VALIDATING the response (a hostile getter, a Proxy trap...) is a bad
      // response. It must never be mapped by its `code`, which would let a response masquerade as
      // a native rejection, and its message is never kept.
      if (error instanceof LinkSignerError) {
        throw error;
      }
      throw new LinkSignerError('invalid_native_response');
    }
  };

  return Object.freeze({
    async ensureIdentity(sessionId: string): Promise<LinkSignerIdentity> {
      const id = requireSessionId(sessionId);
      return call(
        m => m.ensureIdentity(id),
        r => readIdentity(r, id, crypto),
      );
    },

    async getIdentity(sessionId: string): Promise<LinkSignerIdentity | null> {
      const id = requireSessionId(sessionId);
      return call(
        m => m.getIdentity(id),
        r => (r === null ? null : readIdentity(r, id, crypto)),
      );
    },

    async signLinkAuthStatement(
      sessionId: string,
      stage: LinkSigningStage,
      statement: string,
    ): Promise<Uint8Array> {
      const id = requireSessionId(sessionId);
      if (stage !== 'proof' && stage !== 'confirm') {
        throw new LinkSignerError('invalid_argument');
      }
      if (
        typeof statement !== 'string' ||
        statement.length === 0 ||
        statement.length > MAX_STATEMENT_CHARS
      ) {
        throw new LinkSignerError('invalid_argument');
      }
      return call(
        m => m.signLinkAuthStatement(id, stage, statement),
        readSignature,
      );
    },

    async listIdentities(): Promise<readonly LinkSignerListing[]> {
      return call(m => m.listIdentities(), readListing);
    },

    async releaseIdentity(
      sessionId: string,
      expectedNodeId: string,
    ): Promise<void> {
      const id = requireSessionId(sessionId);
      if (!isCanonicalRideNodeId(expectedNodeId)) {
        throw new LinkSignerError('invalid_argument');
      }
      return call(
        m => m.releaseIdentity(id, expectedNodeId),
        r => {
          if (r !== null && r !== undefined) {
            return invalidResponse();
          }
        },
      );
    },
  });
}

/** The signer for this device: the real `RideazeLinkSigner` module, resolved lazily at each call. */
export function createDefaultLinkSigner(
  crypto: LinkSignerCrypto = p256RuntimeCrypto,
): LinkSigner {
  const lazy =
    (name: keyof RideazeLinkSignerNative) =>
    (...args: string[]): Promise<unknown> => {
      const native = NativeModules.RideazeLinkSigner as
        | Partial<RideazeLinkSignerNative>
        | undefined;
      const fn = native?.[name] as
        | ((...a: string[]) => Promise<unknown>)
        | undefined;
      if (typeof fn !== 'function') {
        return Promise.reject(new LinkSignerError('native_unavailable'));
      }
      return fn.apply(native, args);
    };
  return createAndroidLinkSigner(
    {
      ensureIdentity: lazy('ensureIdentity'),
      getIdentity: lazy('getIdentity'),
      signLinkAuthStatement: lazy('signLinkAuthStatement'),
      listIdentities: lazy('listIdentities'),
      releaseIdentity: lazy('releaseIdentity'),
    },
    crypto,
  );
}
