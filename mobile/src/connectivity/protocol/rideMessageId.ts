/**
 * Opaque RideMessage ids: RFC 4122 version 4 UUIDs built from 16 bytes of an injected secure random
 * source. Ids carry no timestamp, node, ride, rider or message-type information and use no
 * counters or Math.random. Pure: the only side effect is the injected source call.
 */

/* eslint-disable no-bitwise -- setting UUID version/variant bits is inherently bitwise */

/** Matches Crypto.getRandomValues: fills `array` in place and returns that same array. */
export type SecureRandomValues = (array: Uint8Array) => Uint8Array;

export const RIDE_MESSAGE_ID_RANDOM_BYTES = 16;

/** Lowercase canonical UUID v4: 8-4-4-4-12 hex, version nibble 4, variant nibble 8, 9, a or b. */
export const RIDE_MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

/** Formats 16 bytes as a lowercase canonical UUID v4, setting the version and variant bits. */
export function formatRideMessageId(random: Uint8Array): string {
  if (random.length !== RIDE_MESSAGE_ID_RANDOM_BYTES) {
    throw new RangeError(`RideMessage id needs exactly ${RIDE_MESSAGE_ID_RANDOM_BYTES} bytes`);
  }
  const b = Uint8Array.from(random);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant (10xx)
  const h = Array.from(b, byte => HEX[byte]);
  return (
    h.slice(0, 4).join('') +
    '-' +
    h.slice(4, 6).join('') +
    '-' +
    h.slice(6, 8).join('') +
    '-' +
    h.slice(8, 10).join('') +
    '-' +
    h.slice(10, 16).join('')
  );
}

/**
 * Returns a generator producing a fresh id from 16 new secure bytes per call. Fails closed: any
 * exception from the source propagates, and a source that breaks the getRandomValues contract
 * (does not return the buffer it was given) throws instead of producing an id. Whether the bytes
 * are random cannot be checked here; that is the source's responsibility.
 */
export function createRideMessageIdGenerator(getRandomValues: SecureRandomValues): () => string {
  if (typeof getRandomValues !== 'function') {
    throw new TypeError('RideMessage id generator needs a secure getRandomValues function');
  }
  return () => {
    const buffer = new Uint8Array(RIDE_MESSAGE_ID_RANDOM_BYTES);
    const returned = getRandomValues(buffer);
    if (returned !== buffer || buffer.length !== RIDE_MESSAGE_ID_RANDOM_BYTES) {
      throw new TypeError('Secure random source did not fill the provided buffer');
    }
    return formatRideMessageId(buffer);
  };
}
