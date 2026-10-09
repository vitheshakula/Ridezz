/**
 * Node-local record of RideMessage ids already accepted, so a message reaching this node again
 * (over another path, gateway or transport) is processed once. Transport-neutral and pure: no
 * timers, no wall-clock reads; all cleanup happens inside cache operations.
 *
 * Lifetime: an entry for a message is live while now < expiresAt, mirroring isRideMessageExpired.
 * At now >= expiresAt the message can no longer pass parseRideMessage, so the entry is removed and
 * the id may be claimed again.
 *
 * Capacity: a hard entry limit. Expired entries are always removed before anything live is
 * evicted. When every entry is live, the entry claimed earliest is evicted (FIFO by first claim).
 * Duplicates arrive shortly after the first copy, as copies race over different paths, so the
 * most recent claims are the most valuable to keep. Evicting by earliest expiry instead would let
 * one burst of maximum-TTL ids pin the cache for an hour while every legitimate shorter-lived
 * entry was evicted first.
 */

import { RIDE_MESSAGE_MAX_FUTURE_SKEW_MS } from './rideMessageCodec';
import {
  RIDE_MESSAGE_MAX_ID_LENGTH,
  RIDE_MESSAGE_MAX_TTL_MS,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
} from './rideMessage';

export const SEEN_MESSAGE_CACHE_DEFAULT_CAPACITY = 2048;

/** Furthest ahead of `now` an expiresAt can be for any message parseRideMessage accepts. */
export const SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS =
  RIDE_MESSAGE_MAX_TTL_MS + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS;

/**
 * - accepted: first live observation; the id is now recorded.
 * - duplicate: the id is already recorded and live.
 * - expired: now >= expiresAt; nothing is recorded.
 * - invalid: malformed id, timestamp or `now`, or expiresAt beyond what the protocol allows;
 *   nothing is recorded.
 */
export type SeenMessageClaimResult = 'accepted' | 'duplicate' | 'expired' | 'invalid';

export interface SeenMessageCache {
  /** Atomically checks and records one observation of a message id. Never throws. */
  claim(messageId: string, expiresAt: number, now: number): SeenMessageClaimResult;
  /** Removes entries expired at `now`. Claims already do this; ignored for an invalid `now`. */
  prune(now: number): void;
  /** Entries currently held, including expired ones not yet pruned. */
  readonly size: number;
}

export function createSeenMessageCache(
  capacity: number = SEEN_MESSAGE_CACHE_DEFAULT_CAPACITY,
): SeenMessageCache {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('SeenMessageCache capacity must be a positive integer');
  }

  // id -> expiresAt. Map iteration follows insertion order and set() on an existing key keeps its
  // position, so the first key is always the earliest claim still held.
  const entries = new Map<string, number>();
  // Lower bound on the smallest expiresAt held, so pruning scans only when something may have
  // expired. FIFO eviction can leave it stale-low, which costs at most one redundant scan.
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

      // The first accepted observation owns the record. Honest copies share one expiresAt, so a
      // copy carrying a different one is never allowed to alter the stored lifetime or position.
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
