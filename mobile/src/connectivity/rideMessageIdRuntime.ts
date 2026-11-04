import { createRideMessageIdGenerator, type SecureRandomValues } from './protocol/rideMessageId';

interface CryptoLike {
  getRandomValues?: unknown;
}

export function createRuntimeRideMessageIdGenerator(
  runtime: { crypto?: unknown } = globalThis as { crypto?: unknown },
): () => string {
  const crypto = runtime.crypto as CryptoLike | undefined;
  if (typeof crypto !== 'object' || crypto === null) {
    throw new TypeError('Secure crypto is unavailable: RideMessage ids cannot be generated');
  }
  const getRandomValues = crypto.getRandomValues;
  if (typeof getRandomValues !== 'function') {
    throw new TypeError(
      'crypto.getRandomValues is unavailable: RideMessage ids cannot be generated',
    );
  }
  const bound: SecureRandomValues = array => getRandomValues.call(crypto, array);
  return createRideMessageIdGenerator(bound);
}
