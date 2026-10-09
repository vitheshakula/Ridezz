/**
 * Binds the RideMessage id generator to the runtime's secure crypto.getRandomValues, which
 * react-native-get-random-values installs during startup (src/polyfills). Call this from runtime
 * composition, after the polyfills have loaded.
 *
 * Deliberately never uses crypto.randomUUID: in this app that global is LiveKit's Math.random-based
 * shim (installed by registerGlobals), not a secure implementation.
 */

import {
  createRideMessageIdGenerator,
  type SecureRandomValues,
} from './protocol/rideMessageId';

interface CryptoLike {
  getRandomValues?: unknown;
}

/**
 * Captures the current crypto.getRandomValues once, so a weaker implementation installed later
 * cannot replace it for this generator. Throws if no callable getRandomValues exists: there is
 * no fallback.
 */
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
