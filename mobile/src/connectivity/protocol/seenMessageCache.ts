import { RIDE_MESSAGE_MAX_FUTURE_SKEW_MS } from './rideMessageCodec';
import {
  RIDE_MESSAGE_MAX_ID_LENGTH,
  RIDE_MESSAGE_MAX_TTL_MS,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
} from './rideMessage';

export const SEEN_MESSAGE_CACHE_DEFAULT_CAPACITY = 2048;

export const SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS =
  RIDE_MESSAGE_MAX_TTL_MS + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS;

export type SeenMessageClaimResult = 'accepted' | 'duplicate' | 'expired' | 'invalid';

export interface SeenMessageCache {
  claim(messageId: string, expiresAt: number, now: number): SeenMessageClaimResult;
  prune(now: number): void;
  readonly size: number;
}

export function createSeenMessageCache(
  capacity: number = SEEN_MESSAGE_CACHE_DEFAULT_CAPACITY,
): SeenMessageCache {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('SeenMessageCache capacity must be a positive integer');
  }

  const entries = new Map<string, number>();
  let earliestExpiry = Infinity;

  const prune = (now: number): void => {
    if (now < earliestExpiry) {
      return;
    }
    let next = Infinity;
    for (const [id, expiresAt] of entries) {
      if (now >= expiresAt) {
        entries.delete(id);
      } else if (expiresAt < next) {
        next = expiresAt;
      }
    }
    earliestExpiry = next;
  };

  return {
    claim(messageId: string, expiresAt: number, now: number): SeenMessageClaimResult {
      if (
        !isValidRideMessageIdentifier(messageId, RIDE_MESSAGE_MAX_ID_LENGTH) ||
        !isValidRideMessageTimestamp(expiresAt) ||
        !isValidRideMessageTimestamp(now)
      ) {
        return 'invalid';
      }
      if (now >= expiresAt) {
        return 'expired';
      }
      if (expiresAt - now > SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS) {
        return 'invalid';
      }

      prune(now);

      if (entries.has(messageId)) {
        return 'duplicate';
      }

      if (entries.size >= capacity) {
        entries.delete(entries.keys().next().value as string);
      }
      entries.set(messageId, expiresAt);
      earliestExpiry = Math.min(earliestExpiry, expiresAt);
      return 'accepted';
    },

    prune(now: number): void {
      if (isValidRideMessageTimestamp(now)) {
        prune(now);
      }
    },

    get size(): number {
      return entries.size;
    },
  };
}
