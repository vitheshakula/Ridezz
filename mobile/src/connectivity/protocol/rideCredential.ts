/**
 * RideCredential: a backend-issued statement that "device key `pub` was admitted to ride
 * `rideId` as node `nodeId` between `issuedAt` and `expiresAt`", signed by a backend verification
 * key identified by `kid`. It is the building block for ride-scoped authenticated peer identity.
 *
 * This module is pure and offline-safe: no network, no clock reads (`now` is passed in), and no
 * crypto library. Signature verification and SHA-256 are injected, so the connectivity layer
 * depends on neither a library nor a platform keystore, and tests can use real signatures.
 *
 * Trust: a credential proves the backend admitted a device key to a ride at some time. It does not
 * prove the holder of the key is present: that needs a challenge-response made with the matching
 * private key, which is a separate protocol step. A node id is accepted only when it equals
 * SHA-256 of the credential's public key, so an id cannot be claimed without the key.
 *
 * Wire form (all binary fields are unpadded base64url, see base64url.ts):
 *   v          1
 *   kid        ASCII identifier of the backend verification key, see RIDE_CREDENTIAL_KID_PATTERN
 *   rideId     the ride's ROOM CODE, five digits (see isValidRideCredentialRideId)
 *   sessionId  the server-issued id of ONE ride session: 16 random bytes, 22 canonical characters
 *   nodeId     base64url(SHA-256(pub)): exactly 43 canonical characters
 *   pub        65-byte uncompressed P-256 point (0x04 || X || Y): 87 characters
 *   issuedAt   epoch ms
 *   expiresAt  epoch ms, strictly after issuedAt, at most RIDE_CREDENTIAL_MAX_LIFETIME_MS later
 *   sig        64-byte ECDSA P-256 / SHA-256 signature, IEEE P1363 (r || s): 86 characters, over
 *              rideCredentialSigningInput
 *
 * Contracts the caller and the injected crypto must honour (this module cannot check them):
 *
 * - Curve validation. Parsing proves only that `pub` is 65 bytes starting 0x04. It does NOT prove
 *   the point lies on P-256. Validity of every public key (the credential's `pub` and each trusted
 *   server key) and of the signature scalars, 1 <= r, s <= n - 1, is the responsibility of the
 *   injected `verifySignature`, which must return false (not accept) for an invalid point or
 *   scalar. The backend must reject an off-curve `pub` when it issues a credential, and whoever
 *   builds the trusted key set must import each key through a validating crypto API.
 *
 * - Synchronous crypto. `verifySignature` must be synchronous and return exactly `true` or
 *   `false`. A Promise, a thrown error, or any other value is treated as a failed verification.
 *   An asynchronous backend (WebCrypto, a native bridge) cannot be used directly with this
 *   module; resolve it before calling verify() or use a synchronous implementation.
 *
 * - Signature malleability. ECDSA signatures are malleable: for a valid (r, s), (r, n - s) is
 *   also valid. A credential therefore has more than one valid `sig`. Never use `sig`, or the
 *   serialised credential, as an identifier, cache key, replay token or deduplication key. A
 *   credential is identified by (kid, rideId, sessionId, nodeId, issuedAt), i.e. by the signed fields
 *   only.
 *
 * - Signing input. rideCredentialSigningInput does not validate its argument. Callers must pass
 *   a credential that already passed parseRideCredential (the backend must validate before
 *   signing). Because the parser restricts every string to an ASCII alphabet that needs no JSON
 *   escaping, and every number to a safe integer, the signed text is byte-identical in every
 *   implementation.
 */

import { decodeBase64Url, encodeBase64Url, isUint8Array } from './base64url';
import { isValidRideMessageTimestamp } from './rideMessage';

export const RIDE_CREDENTIAL_VERSION = 1 as const;
export const RIDE_CREDENTIAL_DOMAIN = 'rideaze.ride-credential.v1';
/** Longest validity a credential may claim. Bounds exposure, since revocation is impossible offline. */
export const RIDE_CREDENTIAL_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** How far a receiver's clock may be behind `issuedAt` and still accept the credential. */
export const RIDE_CREDENTIAL_NOT_BEFORE_TOLERANCE_MS = 300_000;
export const RIDE_CREDENTIAL_MAX_KID_LENGTH = 64;
export const RIDE_CREDENTIAL_PUBLIC_KEY_BYTES = 65;
export const RIDE_CREDENTIAL_SIGNATURE_BYTES = 64;
/** Canonical unpadded base64url lengths of the fixed-size binary fields. */
export const RIDE_CREDENTIAL_PUBLIC_KEY_CHARS = 87;
export const RIDE_CREDENTIAL_SIGNATURE_CHARS = 86;
export const RIDE_CREDENTIAL_NODE_ID_CHARS = 43;
/** A ride session id is 16 random bytes: exactly 22 characters of unpadded base64url. */
export const RIDE_CREDENTIAL_SESSION_ID_BYTES = 16;
export const RIDE_CREDENTIAL_SESSION_ID_CHARS = 22;
/** `notAfter` for a trusted key that has no scheduled retirement. */
export const RIDE_CREDENTIAL_KEY_NO_RETIREMENT = Number.MAX_SAFE_INTEGER;

/**
 * Backend verification-key id: 1 to 64 ASCII characters from [A-Za-z0-9._-], starting with a letter
 * or digit (for example `srv-2026-11a`). The restriction keeps the signed text pure ASCII.
 */
export const RIDE_CREDENTIAL_KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The ride id in a credential is the ROOM CODE, the same value the Phase 2 stack uses as `rideId`
 * (`session.roomCode` in RideScreen) and the server stores as `Room.code` / `User.roomCode`: five
 * digits, "10000" to "99999" (server `isRoomCode`, mobile `utils/roomCode`). It is NOT `Room.id`,
 * the persistent database UUID that the server returns as `roomId`; the two are different
 * identifiers and a UUID is rejected here.
 */
export const RIDE_CREDENTIAL_RIDE_ID_PATTERN = /^[1-9][0-9]{4}$/;

const SHA256_BYTES = 32;
const UNCOMPRESSED_POINT_PREFIX = 0x04;

export function isValidRideCredentialKid(value: unknown): value is string {
  return typeof value === 'string' && RIDE_CREDENTIAL_KID_PATTERN.test(value);
}

export function isValidRideCredentialRideId(value: unknown): value is string {
  return (
    typeof value === 'string' && RIDE_CREDENTIAL_RIDE_ID_PATTERN.test(value)
  );
}

/**
 * True only for the canonical unpadded base64url text of a 32-byte SHA-256 digest: exactly 43
 * characters, valid alphabet, zero trailing bits. Two texts never denote the same node.
 */
export function isCanonicalRideNodeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === RIDE_CREDENTIAL_NODE_ID_CHARS &&
    decodeBase64Url(value)?.length === SHA256_BYTES
  );
}

/**
 * True only for the canonical unpadded base64url text of exactly 16 bytes: 22 characters, valid
 * alphabet, zero trailing bits. The ride SESSION id is issued by the server for each ride session
 * and is what separates one ride from the next: the room code (and Room.id) are reused every time
 * the same host rides, so on their own they cannot tell a former participant's credential from a
 * current one. It is an identifier, not a secret. It is neither the room code nor Room.id (a UUID),
 * and neither is accepted here.
 */
export function isCanonicalRideSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === RIDE_CREDENTIAL_SESSION_ID_CHARS &&
    decodeBase64Url(value)?.length === RIDE_CREDENTIAL_SESSION_ID_BYTES
  );
}

export interface RideCredential {
  readonly v: typeof RIDE_CREDENTIAL_VERSION;
  readonly kid: string;
  readonly rideId: string;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly pub: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sig: string;
}

export type UnsignedRideCredential = Omit<RideCredential, 'sig'>;

const CREDENTIAL_KEYS: readonly string[] = [
  'v',
  'kid',
  'rideId',
  'sessionId',
  'nodeId',
  'pub',
  'issuedAt',
  'expiresAt',
  'sig',
];

const utf8Encoder = new TextEncoder();

/**
 * The exact text that is signed. The key order is part of the protocol and is fixed here rather
 * than inherited from the caller's object, so two implementations always sign identical bytes.
 * The argument must already be validated: see the module comment.
 */
export function rideCredentialSigningInput(
  credential: UnsignedRideCredential,
): string {
  return JSON.stringify({
    domain: RIDE_CREDENTIAL_DOMAIN,
    v: credential.v,
    kid: credential.kid,
    rideId: credential.rideId,
    sessionId: credential.sessionId,
    nodeId: credential.nodeId,
    pub: credential.pub,
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
  });
}

function isUncompressedP256Point(
  bytes: Uint8Array | null,
): bytes is Uint8Array {
  return (
    bytes !== null &&
    bytes.length === RIDE_CREDENTIAL_PUBLIC_KEY_BYTES &&
    bytes[0] === UNCOMPRESSED_POINT_PREFIX
  );
}

/**
 * Node id for a device key: base64url(SHA-256(publicKey)), always the canonical 43 characters.
 * Throws for a key that is not a 65-byte uncompressed P-256 point, or a `sha256` that does not
 * return 32 bytes: programmer errors, not untrusted wire data.
 */
export function deriveRideNodeId(
  publicKey: Uint8Array,
  sha256: (data: Uint8Array) => Uint8Array,
): string {
  if (!isUint8Array(publicKey) || !isUncompressedP256Point(publicKey)) {
    throw new RangeError(
      'A ride node id needs a 65-byte uncompressed P-256 public key',
    );
  }
  if (typeof sha256 !== 'function') {
    throw new TypeError('deriveRideNodeId needs a sha256 function');
  }
  const digest = sha256(publicKey);
  if (!isUint8Array(digest) || digest.length !== SHA256_BYTES) {
    throw new TypeError('sha256 must return a 32-byte Uint8Array');
  }
  return encodeBase64Url(digest);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every(key => keys.includes(key))
  );
}

/**
 * Structural validation only: shape, bounds and encodings. It checks nothing that needs a clock,
 * a ride, a key set or a signature, and it does not check that `pub` is on the curve (see the
 * module comment). Never throws. Returns a frozen copy holding only protocol fields, or null.
 *
 * Every field is read from the input exactly once, into a local; the locals are what is
 * validated and what is returned. A getter or proxy that answers differently on a second read
 * therefore cannot make the result differ from what was checked.
 */
export function parseRideCredential(value: unknown): RideCredential | null {
  try {
    if (!isPlainObject(value) || !hasExactKeys(value, CREDENTIAL_KEYS)) {
      return null;
    }
    const v = value.v;
    const kid = value.kid;
    const rideId = value.rideId;
    const sessionId = value.sessionId;
    const nodeId = value.nodeId;
    const pub = value.pub;
    const issuedAt = value.issuedAt;
    const expiresAt = value.expiresAt;
    const sig = value.sig;

    if (
      v !== RIDE_CREDENTIAL_VERSION ||
      !isValidRideCredentialKid(kid) ||
      !isValidRideCredentialRideId(rideId) ||
      !isCanonicalRideSessionId(sessionId) ||
      !isCanonicalRideNodeId(nodeId) ||
      typeof pub !== 'string' ||
      pub.length !== RIDE_CREDENTIAL_PUBLIC_KEY_CHARS ||
      typeof sig !== 'string' ||
      sig.length !== RIDE_CREDENTIAL_SIGNATURE_CHARS ||
      !isValidRideMessageTimestamp(issuedAt) ||
      !isValidRideMessageTimestamp(expiresAt)
    ) {
      return null;
    }
    const lifetime = expiresAt - issuedAt;
    if (lifetime <= 0 || lifetime > RIDE_CREDENTIAL_MAX_LIFETIME_MS) {
      return null;
    }
    if (!isUncompressedP256Point(decodeBase64Url(pub))) {
      return null;
    }
    if (decodeBase64Url(sig)?.length !== RIDE_CREDENTIAL_SIGNATURE_BYTES) {
      return null;
    }
    return Object.freeze({
      v: RIDE_CREDENTIAL_VERSION,
      kid,
      rideId,
      sessionId,
      nodeId,
      pub,
      issuedAt,
      expiresAt,
      sig,
    });
  } catch {
    // A hostile getter or proxy must not escape the parser.
    return null;
  }
}

export type RideCredentialRejection =
  | 'invalid'
  | 'wrong_ride'
  | 'wrong_session'
  | 'unknown_key'
  | 'node_id_mismatch'
  | 'not_yet_valid'
  | 'expired'
  | 'bad_signature';

export type RideCredentialVerification =
  | { readonly ok: true; readonly credential: RideCredential }
  | { readonly ok: false; readonly reason: RideCredentialRejection };

/**
 * A backend verification key and the half-open window of ISSUANCE times it may sign for:
 * `notBefore <= credential.issuedAt < notAfter`. The window is about when a credential was
 * issued, not when it is checked, so a credential legitimately issued before the key was retired
 * stays valid until its own `expiresAt` (at most RIDE_CREDENTIAL_MAX_LIFETIME_MS later), while a
 * retired or compromised key cannot mint credentials dated after `notAfter`. Use
 * RIDE_CREDENTIAL_KEY_NO_RETIREMENT as `notAfter` for a key with no scheduled retirement.
 * `publicKey` is a 65-byte uncompressed P-256 point that the caller has already validated.
 */
export interface RideCredentialTrustedKey {
  readonly publicKey: Uint8Array;
  readonly notBefore: number;
  readonly notAfter: number;
}

export interface RideCredentialVerifierOptions {
  /** The ride this node has joined: a room code. Credentials for any other ride are rejected. */
  readonly rideId: string;
  /**
   * The ride SESSION this node has joined, as issued by the server at join time. A credential from
   * any other session of the same room code (a previous ride) is rejected as `wrong_session`.
   */
  readonly sessionId: string;
  /** Trusted backend verification keys by `kid`. Copied at creation. */
  readonly keys: ReadonlyMap<string, RideCredentialTrustedKey>;
  /**
   * ECDSA P-256 / SHA-256 over `message` with an IEEE P1363 (r || s) signature. MUST be
   * synchronous and return exactly `true` for a valid signature. It must also reject invalid
   * points and out-of-range scalars. A Promise, a throw or any value other than `true` fails
   * closed as `bad_signature`.
   */
  readonly verifySignature: (
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ) => boolean;
  readonly sha256: (data: Uint8Array) => Uint8Array;
}

export interface RideCredentialVerifier {
  /** Never throws. Fails closed: an exception from an injected function is `bad_signature`. */
  verify(value: unknown, now: number): RideCredentialVerification;
}

const reject = (reason: RideCredentialRejection): RideCredentialVerification =>
  Object.freeze({ ok: false, reason });

/**
 * A callback that wrongly returned a Promise must not leave an unhandled rejection behind. The
 * Promise is never awaited or trusted: verification has already failed closed.
 */
function discardPendingResult(result: unknown): void {
  try {
    if (
      (typeof result === 'object' || typeof result === 'function') &&
      result !== null &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      Promise.resolve(result).then(undefined, () => undefined);
    }
  } catch {
    // Nothing to do: the verification outcome is already a rejection.
  }
}

/**
 * Checks run cheapest first, and signature verification runs last so a credential that is
 * malformed, for another ride or another session of the same ride, from an unknown or
 * out-of-window key, mismatched, premature or expired never costs a signature check:
 *   invalid -> wrong_ride -> wrong_session -> unknown_key -> node_id_mismatch -> not_yet_valid
 *   -> expired -> bad_signature
 *
 * `unknown_key` covers both a `kid` that is not trusted and one whose issuance window
 * [notBefore, notAfter) does not contain `issuedAt`: to the verifier both mean "this key was not
 * trusted to sign this credential".
 *
 * Validity is the half-open interval [issuedAt - tolerance, expiresAt): accepted at exactly
 * issuedAt - RIDE_CREDENTIAL_NOT_BEFORE_TOLERANCE_MS, rejected at exactly expiresAt.
 */
export function createRideCredentialVerifier({
  rideId,
  sessionId,
  keys,
  verifySignature,
  sha256,
}: RideCredentialVerifierOptions): RideCredentialVerifier {
  if (!isValidRideCredentialRideId(rideId)) {
    throw new TypeError(
      'RideCredentialVerifier rideId must be a five-digit room code',
    );
  }
  if (!isCanonicalRideSessionId(sessionId)) {
    throw new TypeError(
      'RideCredentialVerifier sessionId must be a canonical 22-character ride session id',
    );
  }
  if (Object.prototype.toString.call(keys) !== '[object Map]') {
    throw new TypeError(
      'RideCredentialVerifier keys must be a Map of kid to trusted key',
    );
  }
  if (typeof verifySignature !== 'function' || typeof sha256 !== 'function') {
    throw new TypeError(
      'RideCredentialVerifier needs verifySignature and sha256 functions',
    );
  }

  // Snapshot, so later changes to the caller's map, entries or buffers cannot alter what is
  // trusted. Each entry field is read once.
  const trustedKeys = new Map<string, RideCredentialTrustedKey>();
  for (const [kid, entry] of keys) {
    if (!isValidRideCredentialKid(kid) || !isPlainObject(entry)) {
      throw new TypeError('RideCredentialVerifier keys are invalid');
    }
    const publicKey = entry.publicKey;
    const notBefore = entry.notBefore;
    const notAfter = entry.notAfter;
    if (
      !isUint8Array(publicKey) ||
      !isUncompressedP256Point(publicKey) ||
      !isValidRideMessageTimestamp(notBefore) ||
      !isValidRideMessageTimestamp(notAfter) ||
      notBefore >= notAfter
    ) {
      throw new TypeError(
        'RideCredentialVerifier keys need a 65-byte uncompressed P-256 publicKey and ' +
          'notBefore < notAfter',
      );
    }
    trustedKeys.set(
      kid,
      Object.freeze({
        publicKey: Uint8Array.from(publicKey),
        notBefore,
        notAfter,
      }),
    );
  }

  return {
    verify(value, now): RideCredentialVerification {
      try {
        if (!isValidRideMessageTimestamp(now)) {
          return reject('invalid');
        }
        const credential = parseRideCredential(value);
        if (!credential) {
          return reject('invalid');
        }
        if (credential.rideId !== rideId) {
          return reject('wrong_ride');
        }
        if (credential.sessionId !== sessionId) {
          return reject('wrong_session');
        }
        const serverKey = trustedKeys.get(credential.kid);
        if (
          !serverKey ||
          credential.issuedAt < serverKey.notBefore ||
          credential.issuedAt >= serverKey.notAfter
        ) {
          return reject('unknown_key');
        }
        const publicKey = decodeBase64Url(credential.pub) as Uint8Array;
        if (deriveRideNodeId(publicKey, sha256) !== credential.nodeId) {
          return reject('node_id_mismatch');
        }
        if (
          now <
          credential.issuedAt - RIDE_CREDENTIAL_NOT_BEFORE_TOLERANCE_MS
        ) {
          return reject('not_yet_valid');
        }
        if (now >= credential.expiresAt) {
          return reject('expired');
        }
        const message = utf8Encoder.encode(
          rideCredentialSigningInput(credential),
        );
        const signature = decodeBase64Url(credential.sig) as Uint8Array;
        const outcome: unknown = verifySignature(
          Uint8Array.from(serverKey.publicKey),
          message,
          signature,
        );
        // Strict equality: only an explicit `true` is success. A Promise (an accidentally
        // asynchronous callback) is truthy but is not `true`, and is discarded.
        if (outcome !== true) {
          discardPendingResult(outcome);
          return reject('bad_signature');
        }
        return Object.freeze({ ok: true, credential });
      } catch {
        // A throwing injected function must never turn into acceptance.
        return reject('bad_signature');
      }
    },
  };
}
