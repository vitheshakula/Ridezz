/**
 * Unpadded base64url (RFC 4648 section 5) for protocol fields such as public keys and signatures.
 * Pure: no Buffer, atob, btoa or any other platform API, so it behaves identically under Hermes
 * and Node.
 *
 * The decoder accepts exactly the canonical output of the encoder and nothing else: one byte
 * sequence has one text form. It rejects padding, whitespace, the standard-alphabet characters
 * `+` and `/`, a length that can never occur (4n + 1), and any non-zero unused trailing bits.
 * Without those checks two different strings could decode to the same bytes, which is unsafe for
 * anything that is compared, hashed or signed as text.
 *
 * Symbol lookup uses an Int8Array indexed by character code, never an object property, so a
 * polluted Object.prototype cannot widen the accepted alphabet.
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Decode lookup by character code in a typed array, -1 for "not in the alphabet". No property is
// ever looked up on a plain object, so nothing inherited from (or polluted onto) Object.prototype
// can be mistaken for a valid symbol. Only ASCII codes can be in the alphabet.
const DECODE_TABLE = new Int8Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index++) {
  DECODE_TABLE[ALPHABET.charCodeAt(index)] = index;
}

/**
 * True for a Uint8Array (including Node Buffers). Checked by tag rather than `instanceof`, so
 * byte arrays created in another realm (test sandboxes, native bridges) are still recognised.
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

/* eslint-disable no-bitwise -- base64 is defined in terms of 6-bit groups */

/** Encodes bytes without padding. Throws TypeError for anything that is not a Uint8Array. */
export function encodeBase64Url(bytes: Uint8Array): string {
  if (!isUint8Array(bytes)) {
    throw new TypeError('encodeBase64Url needs a Uint8Array');
  }
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** Decodes canonical unpadded base64url. Never throws; returns null for any other input. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (typeof text !== 'string') {
    return null;
  }
  const length = text.length;
  if (length % 4 === 1) {
    return null;
  }
  const values = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? DECODE_TABLE[code] : -1;
    if (value < 0) {
      return null;
    }
    values[i] = value;
  }

  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < length; i += 4) {
    const n =
      (values[i] << 18) |
      (values[i + 1] << 12) |
      (values[i + 2] << 6) |
      values[i + 3];
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = length - i;
  if (rest === 2) {
    // 12 bits carry one byte; the low 4 bits must be zero.
    if ((values[i + 1] & 15) !== 0) {
      return null;
    }
    out[o++] = ((values[i] << 2) | (values[i + 1] >> 4)) & 255;
  } else if (rest === 3) {
    // 18 bits carry two bytes; the low 2 bits must be zero.
    if ((values[i + 2] & 3) !== 0) {
      return null;
    }
    const n = (values[i] << 10) | (values[i + 1] << 4) | (values[i + 2] >> 2);
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  return out;
}
