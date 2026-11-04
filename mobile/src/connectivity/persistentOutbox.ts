import type { RideMessage } from './protocol/rideMessage';
import { isRideMessageExpired } from './protocol/rideMessage';
import { parseRideMessage, serializeRideMessage } from './protocol/rideMessageCodec';

export const OUTBOX_DEFAULT_CAPACITY = 100;
export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 5;
export const OUTBOX_DEFAULT_BASE_DELAY_MS = 1_000;
export const OUTBOX_DEFAULT_MAX_DELAY_MS = 60_000;

const PRIORITY_ORDER = Object.freeze({ critical: 0, high: 1, normal: 2, low: 3 });

export interface PersistentOutboxStore {
  load(): Promise<string | null>;
  save(serialized: string): Promise<void>;
}

export interface PersistentOutboxRecord {
  readonly message: RideMessage;
  readonly destinationGatewayId?: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

interface StoredRecord {
  readonly wireMessage: string;
  readonly destinationGatewayId?: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

export type OutboxEnqueueResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: 'duplicate' | 'queue_full' | 'expired' | 'invalid';
    };

export type OutboxAttemptResult =
  | { readonly state: 'scheduled'; readonly nextAttemptAt: number; readonly attempts: number }
  | { readonly state: 'exhausted'; readonly attempts: number }
  | { readonly state: 'missing' | 'expired' };

export interface PersistentOutbox {
  initialize(now: number): Promise<{ readonly recovered: number; readonly corrupted: boolean }>;
  enqueue(
    message: RideMessage,
    destinationGatewayId: string | undefined,
    now: number,
  ): Promise<OutboxEnqueueResult>;
  due(now: number, rideId?: string): readonly PersistentOutboxRecord[];
  nextAttemptAt(rideId?: string): number | undefined;
  originIdForRide(rideId: string): string | undefined;
  recordAttempt(messageId: string, now: number): Promise<OutboxAttemptResult>;
  acknowledge(messageId: string): Promise<boolean>;
  remove(messageId: string): Promise<boolean>;
  expire(
    now: number,
  ): Promise<readonly { readonly messageId: string; readonly expiresAt: number }[]>;
  readonly size: number;
}

function validStoredRecord(value: unknown, now: number): StoredRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.wireMessage !== 'string' ||
    !Number.isSafeInteger(record.attempts) ||
    (record.attempts as number) < 0 ||
    !Number.isSafeInteger(record.nextAttemptAt) ||
    (record.nextAttemptAt as number) < 0 ||
    (record.destinationGatewayId !== undefined &&
      (typeof record.destinationGatewayId !== 'string' || record.destinationGatewayId.length === 0))
  ) {
    return null;
  }
  const parsed = JSON.parse(record.wireMessage) as { createdAt?: unknown };
  const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : now;
  if (!parseRideMessage(record.wireMessage, Math.max(0, createdAt))) {
    return null;
  }
  return {
    wireMessage: record.wireMessage,
    ...(record.destinationGatewayId !== undefined && {
      destinationGatewayId: record.destinationGatewayId,
    }),
    attempts: record.attempts as number,
    nextAttemptAt: record.nextAttemptAt as number,
  };
}

export function createPersistentOutbox({
  store,
  capacity = OUTBOX_DEFAULT_CAPACITY,
  maxAttempts = OUTBOX_DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = OUTBOX_DEFAULT_BASE_DELAY_MS,
  maxDelayMs = OUTBOX_DEFAULT_MAX_DELAY_MS,
  random = Math.random,
}: {
  readonly store: PersistentOutboxStore;
  readonly capacity?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly random?: () => number;
}): PersistentOutbox {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('Outbox capacity must be a positive integer');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError('Outbox maxAttempts must be a positive integer');
  }
  if (
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs <= 0 ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < baseDelayMs
  ) {
    throw new RangeError('Outbox retry delays are invalid');
  }

  const records = new Map<string, StoredRecord>();
  let initialized = false;

  const persist = async (): Promise<void> => {
    await store.save(JSON.stringify([...records.values()]));
  };

  const decode = (record: StoredRecord): PersistentOutboxRecord | null => {
    const raw = JSON.parse(record.wireMessage) as { createdAt?: unknown };
    const at = typeof raw.createdAt === 'number' ? raw.createdAt : 0;
    const message = parseRideMessage(record.wireMessage, at);
    return message
      ? Object.freeze({
          message,
          destinationGatewayId: record.destinationGatewayId,
          attempts: record.attempts,
          nextAttemptAt: record.nextAttemptAt,
        })
      : null;
  };

  const requireInitialized = (): void => {
    if (!initialized) {
      throw new Error('Persistent outbox must be initialized before use');
    }
  };

  return {
    async initialize(now): Promise<{ recovered: number; corrupted: boolean }> {
      records.clear();
      let corrupted = false;
      try {
        const serialized = await store.load();
        if (serialized !== null) {
          const parsed = JSON.parse(serialized) as unknown;
          if (!Array.isArray(parsed)) {
            corrupted = true;
          } else {
            for (const candidate of parsed) {
              const record = validStoredRecord(candidate, now);
              if (!record) {
                corrupted = true;
                continue;
              }
              const decoded = decode(record);
              if (!decoded || records.has(decoded.message.id) || records.size >= capacity) {
                corrupted = true;
                continue;
              }
              records.set(decoded.message.id, record);
            }
          }
        }
      } catch {
        corrupted = true;
      }
      initialized = true;
      if (corrupted) {
        await persist();
      }
      return { recovered: records.size, corrupted };
    },

    async enqueue(message, destinationGatewayId, now): Promise<OutboxEnqueueResult> {
      requireInitialized();
      if (records.has(message.id)) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (records.size >= capacity) {
        return { accepted: false, reason: 'queue_full' };
      }
      if (isRideMessageExpired(message, now)) {
        return { accepted: false, reason: 'expired' };
      }
      let wireMessage: string;
      try {
        wireMessage = serializeRideMessage(message);
      } catch {
        return { accepted: false, reason: 'invalid' };
      }
      records.set(message.id, {
        wireMessage,
        destinationGatewayId,
        attempts: 0,
        nextAttemptAt: now,
      });
      await persist();
      return { accepted: true };
    },

    due(now, rideId): readonly PersistentOutboxRecord[] {
      requireInitialized();
      const due: PersistentOutboxRecord[] = [];
      for (const record of records.values()) {
        const decoded = decode(record);
        if (
          decoded &&
          (rideId === undefined || decoded.message.rideId === rideId) &&
          !isRideMessageExpired(decoded.message, now) &&
          record.nextAttemptAt <= now
        ) {
          due.push(decoded);
        }
      }
      due.sort(
        (a, b) =>
          PRIORITY_ORDER[a.message.priority] - PRIORITY_ORDER[b.message.priority] ||
          a.nextAttemptAt - b.nextAttemptAt ||
          a.message.createdAt - b.message.createdAt ||
          a.message.id.localeCompare(b.message.id),
      );
      return Object.freeze(due);
    },

    nextAttemptAt(rideId): number | undefined {
      requireInitialized();
      let next: number | undefined;
      for (const record of records.values()) {
        if (rideId !== undefined && decode(record)?.message.rideId !== rideId) {
          continue;
        }
        next = next === undefined ? record.nextAttemptAt : Math.min(next, record.nextAttemptAt);
      }
      return next;
    },

    originIdForRide(rideId): string | undefined {
      requireInitialized();
      for (const record of records.values()) {
        const decoded = decode(record);
        if (decoded?.message.rideId === rideId) {
          return decoded.message.originId;
        }
      }
      return undefined;
    },

    async recordAttempt(messageId, now): Promise<OutboxAttemptResult> {
      requireInitialized();
      const record = records.get(messageId);
      if (!record) {
        return { state: 'missing' };
      }
      const decoded = decode(record);
      if (!decoded || isRideMessageExpired(decoded.message, now)) {
        records.delete(messageId);
        await persist();
        return { state: 'expired' };
      }
      const attempts = record.attempts + 1;
      if (attempts >= maxAttempts) {
        records.delete(messageId);
        await persist();
        return { state: 'exhausted', attempts };
      }
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1));
      const jitter = Math.floor(exponential * 0.2 * Math.max(0, Math.min(1, random())));
      const nextAttemptAt = now + exponential + jitter;
      records.set(messageId, { ...record, attempts, nextAttemptAt });
      await persist();
      return { state: 'scheduled', attempts, nextAttemptAt };
    },

    async acknowledge(messageId): Promise<boolean> {
      return this.remove(messageId);
    },

    async remove(messageId): Promise<boolean> {
      requireInitialized();
      const removed = records.delete(messageId);
      if (removed) {
        await persist();
      }
      return removed;
    },

    async expire(
      now,
    ): Promise<readonly { readonly messageId: string; readonly expiresAt: number }[]> {
      requireInitialized();
      const expired: { messageId: string; expiresAt: number }[] = [];
      for (const [messageId, record] of records) {
        const decoded = decode(record);
        if (!decoded || isRideMessageExpired(decoded.message, now)) {
          records.delete(messageId);
          expired.push({ messageId, expiresAt: decoded?.message.expiresAt ?? now });
        }
      }
      if (expired.length > 0) {
        await persist();
      }
      return Object.freeze(expired);
    },

    get size(): number {
      return records.size;
    },
  };
}
