/* eslint-disable no-bitwise -- setting UUID version/variant bits is inherently bitwise */

export type SecureRandomValues = (array: Uint8Array) => Uint8Array;

export const RIDE_MESSAGE_ID_RANDOM_BYTES = 16;

export const RIDE_MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

export function formatRideMessageId(random: Uint8Array): string {
  if (random.length !== RIDE_MESSAGE_ID_RANDOM_BYTES) {
    throw new RangeError(`RideMessage id needs exactly ${RIDE_MESSAGE_ID_RANDOM_BYTES} bytes`);
  }
  const b = Uint8Array.from(random);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
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
