import type { JsonValue } from './protocol/jsonValue';
import type { RideMessage } from './protocol/rideMessage';
import { serializeRideMessage } from './protocol/rideMessageCodec';

export const RELAY_RETRY_DEFAULT_CAPACITY = 512;
export const RELAY_RETRY_DEFAULT_MAX_ATTEMPTS = 3;

interface RetryEntry {
  readonly signature: string;
  readonly expiresAt: number;
  attempts: number;
  inFlight: boolean;
}

export interface RelayRetryTrackerOptions {
  readonly capacity?: number;
  /** Maximum duplicate admissions after the original forwarding attempt. */
  readonly maxAttempts?: number;
}

export interface RelayRetryTracker {
  /** Makes an exact same-ID packet eligible after a definitive forwarding failure. */
  recordDefinitiveFailure(message: RideMessage<JsonValue>, now: number): void;
  /** Atomically admits one exact duplicate retry, or fails closed. */
  beginRetry(message: RideMessage<JsonValue>, now: number): boolean;
  /** Removes eligibility after success, ambiguity, or terminal failure. */
  clear(messageId: string): void;
  readonly size: number;
}

/**
 * Bounded, session-local retry admission metadata. It owns no packet queue and schedules no work:
 * a retry can occur only when the origin's existing outbox sends the same packet again.
 */
export function createRelayRetryTracker({
  capacity = RELAY_RETRY_DEFAULT_CAPACITY,
  maxAttempts = RELAY_RETRY_DEFAULT_MAX_ATTEMPTS,
}: RelayRetryTrackerOptions = {}): RelayRetryTracker {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('Relay retry capacity must be a positive integer');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError('Relay retry maxAttempts must be a positive integer');
  }

  const entries = new Map<string, RetryEntry>();
  const signatureOf = (message: RideMessage<JsonValue>): string => serializeRideMessage(message);
  const prune = (now: number): void => {
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(id);
      }
    }
  };

  return {
    recordDefinitiveFailure(message, now): void {
      prune(now);
      if (message.expiresAt <= now) {
        entries.delete(message.id);
        return;
      }
      const signature = signatureOf(message);
      const existing = entries.get(message.id);
      if (existing) {
        if (existing.signature !== signature || existing.expiresAt !== message.expiresAt) {
          entries.delete(message.id);
          return;
        }
        existing.inFlight = false;
        return;
      }
      // Fail closed at capacity: never evict live dedup/retry state for an untrusted new id.
      if (entries.size >= capacity) {
        return;
      }
      entries.set(message.id, {
        signature,
        expiresAt: message.expiresAt,
        attempts: 0,
        inFlight: false,
      });
    },

    beginRetry(message, now): boolean {
      prune(now);
      const entry = entries.get(message.id);
      if (
        !entry ||
        entry.inFlight ||
        entry.attempts >= maxAttempts ||
        entry.expiresAt !== message.expiresAt ||
        entry.signature !== signatureOf(message)
      ) {
        return false;
      }
      entry.attempts += 1;
      entry.inFlight = true;
      return true;
    },

    clear(messageId): void {
      entries.delete(messageId);
    },

    get size(): number {
      return entries.size;
    },
  };
}
