/**
 * Runtime cryptography for the offline link authentication protocol: synchronous SHA-256 and
 * ECDSA P-256 signature VERIFICATION, built on audited pure-JavaScript primitives
 * (@noble/curves and @noble/hashes, pinned) that run unchanged under Hermes. It uses no Node
 * APIs and nothing asynchronous.
 *
 * These functions match the injected contracts used by `rideCredential.ts`, `linkAuth.ts` and
 * `linkAuthenticator.ts`:
 *   sha256(data)                          -> 32-byte digest
 *   verifySignature(publicKey, message, signature) -> boolean   (never throws)
 *
 * Verification conventions (they must match the Android Keystore signer and the Node reference):
 *   - `publicKey`: 65-byte uncompressed SEC1 P-256 point (0x04 || X || Y), validated to be on the
 *     curve by the library;
 *   - `message`: the raw UTF-8 bytes of the signing text. The library hashes it with SHA-256
 *     itself (`prehash: true`); callers must NOT hash it first, or the digest would be hashed twice;
 *   - `signature`: exactly 64 bytes, IEEE P1363 (r || s), not DER (`format: 'compact'`);
 *   - high-S signatures are ACCEPTED (`lowS: false`): Android Keystore and Node do not normalise
 *     S. Signatures are therefore malleable and must never be used as identifiers.
 *
 * Private-key signing is deliberately absent: signing is done by the Android Keystore (Task 2.5),
 * so no private key ever exists in JavaScript.
 */

import { p256 } from '@noble/curves/nist.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { isUint8Array } from './protocol/base64url';

export const P256_PUBLIC_KEY_BYTES = 65;
export const P256_SIGNATURE_BYTES = 64;
export const SHA256_DIGEST_BYTES = 32;

const UNCOMPRESSED_POINT_PREFIX = 0x04;

/** SHA-256 of `data`. Throws a TypeError for anything that is not a Uint8Array. */
export function sha256(data: Uint8Array): Uint8Array {
  if (!isUint8Array(data)) {
    throw new TypeError('sha256 needs a Uint8Array');
  }
  // Copy first: the library must never see (or alias) a caller's Buffer subclass.
  return Uint8Array.from(nobleSha256(Uint8Array.from(data)));
}

/**
 * True only if `signature` (64-byte P1363) is a valid ECDSA P-256 / SHA-256 signature of the raw
 * `message` bytes under `publicKey` (65-byte uncompressed point). Every malformed input, invalid
 * curve point and library exception yields false; nothing is ever thrown or returned as a Promise.
 */
export function verifyP256Signature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    if (
      !isUint8Array(publicKey) ||
      !isUint8Array(message) ||
      !isUint8Array(signature) ||
      publicKey.length !== P256_PUBLIC_KEY_BYTES ||
      publicKey[0] !== UNCOMPRESSED_POINT_PREFIX ||
      signature.length !== P256_SIGNATURE_BYTES
    ) {
      return false;
    }
    const outcome: unknown = p256.verify(
      Uint8Array.from(signature),
      Uint8Array.from(message),
      Uint8Array.from(publicKey),
      { prehash: true, lowS: false, format: 'compact' },
    );
    return outcome === true;
  } catch {
    return false;
  }
}

/** The pair, shaped for direct injection into the protocol modules. */
export const p256RuntimeCrypto = Object.freeze({
  sha256,
  verifySignature: verifyP256Signature,
});
