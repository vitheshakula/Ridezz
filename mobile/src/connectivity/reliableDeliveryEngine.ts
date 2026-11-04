import type {
  OutboxEnqueueResult,
  PersistentOutbox,
  PersistentOutboxRecord,
} from './persistentOutbox';
import type { RideMessage } from './protocol/rideMessage';

export type ReliableDeliveryAttemptOutcome =
  | { readonly state: 'destination_delivered' }
  | { readonly state: 'retry'; readonly reason: string };

export type ReliableDeliveryEvent =
  | { readonly kind: 'recovered'; readonly count: number; readonly corrupted: boolean }
  | { readonly kind: 'attempt'; readonly messageId: string; readonly attempt: number }
  | { readonly kind: 'retry_scheduled'; readonly messageId: string; readonly nextAttemptAt: number }
  | { readonly kind: 'destination_delivered'; readonly messageId: string }
  | { readonly kind: 'retry_exhausted'; readonly messageId: string }
  | { readonly kind: 'expired'; readonly messageId: string; readonly expiresAt: number }
  | { readonly kind: 'engine_error'; readonly reason: string };

export interface ReliableDeliveryEngine {
  start(): Promise<void>;
  stop(): void;
  submit(message: RideMessage, destinationGatewayId?: string): Promise<OutboxEnqueueResult>;
  acknowledge(messageId: string): Promise<boolean>;
  connectivityAvailable(): void;
  readonly running: boolean;
}

export function createReliableDeliveryEngine({
  outbox,
  attempt,
  clock = () => Date.now(),
  onEvent,
  initializeOutbox = true,
  rideId,
}: {
  readonly outbox: PersistentOutbox;
  readonly attempt: (record: PersistentOutboxRecord) => Promise<ReliableDeliveryAttemptOutcome>;
  readonly clock?: () => number;
  readonly onEvent?: (event: ReliableDeliveryEvent) => void;
  readonly initializeOutbox?: boolean;
  readonly rideId?: string;
}): ReliableDeliveryEngine {
  let state: 'idle' | 'running' | 'stopped' = 'idle';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pumping = false;
  let pumpAgain = false;

  const report = (event: ReliableDeliveryEvent): void => {
    try {
      onEvent?.(Object.freeze({ ...event }));
    } catch {}
  };

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = (run: () => void): void => {
    clearTimer();
    if (state !== 'running') {
      return;
    }
    const next = outbox.nextAttemptAt(rideId);
    if (next === undefined) {
      return;
    }
    timer = setTimeout(run, Math.max(0, next - clock()));
  };

  const pump = async (): Promise<void> => {
    if (state !== 'running') {
      return;
    }
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    clearTimer();
    try {
      const now = clock();
      for (const expired of await outbox.expire(now)) {
        report({ kind: 'expired', ...expired });
      }
      for (const record of outbox.due(now, rideId)) {
        if (state !== 'running') {
          break;
        }
        report({ kind: 'attempt', messageId: record.message.id, attempt: record.attempts + 1 });
        let outcome: ReliableDeliveryAttemptOutcome;
        try {
          outcome = await attempt(record);
        } catch {
          outcome = { state: 'retry', reason: 'attempt_threw' };
          report({ kind: 'engine_error', reason: 'attempt_threw' });
        }
        if (outcome.state === 'destination_delivered') {
          await outbox.acknowledge(record.message.id);
          report({ kind: 'destination_delivered', messageId: record.message.id });
          continue;
        }
        const retry = await outbox.recordAttempt(record.message.id, clock());
        if (retry.state === 'scheduled') {
          report({
            kind: 'retry_scheduled',
            messageId: record.message.id,
            nextAttemptAt: retry.nextAttemptAt,
          });
        } else if (retry.state === 'exhausted') {
          report({ kind: 'retry_exhausted', messageId: record.message.id });
        } else if (retry.state === 'expired') {
          report({
            kind: 'expired',
            messageId: record.message.id,
            expiresAt: record.message.expiresAt,
          });
        }
      }
    } catch {
      report({ kind: 'engine_error', reason: 'outbox_operation_failed' });
    } finally {
      pumping = false;
      if (pumpAgain) {
        pumpAgain = false;
        pump().catch(() => report({ kind: 'engine_error', reason: 'pump_failed' }));
      } else {
        schedule(() => {
          pump().catch(() => report({ kind: 'engine_error', reason: 'pump_failed' }));
        });
      }
    }
  };

  return {
    async start(): Promise<void> {
      if (state === 'running') {
        return;
      }
      if (state === 'stopped') {
        throw new Error('A stopped reliable delivery engine cannot be restarted');
      }
      const recovered = initializeOutbox
        ? await outbox.initialize(clock())
        : { recovered: outbox.size, corrupted: false };
      state = 'running';
      report({ kind: 'recovered', count: recovered.recovered, corrupted: recovered.corrupted });
      await pump();
    },

    stop(): void {
      state = 'stopped';
      clearTimer();
    },

    async submit(message, destinationGatewayId): Promise<OutboxEnqueueResult> {
      if (state !== 'running') {
        throw new Error('Reliable delivery engine is not running');
      }
      const result = await outbox.enqueue(message, destinationGatewayId, clock());
      if (result.accepted) {
        pump().catch(() => report({ kind: 'engine_error', reason: 'pump_failed' }));
      }
      return result;
    },

    async acknowledge(messageId): Promise<boolean> {
      if (state !== 'running') {
        return false;
      }
      const removed = await outbox.acknowledge(messageId);
      schedule(() => {
        pump().catch(() => report({ kind: 'engine_error', reason: 'pump_failed' }));
      });
      return removed;
    },

    connectivityAvailable(): void {
      if (state === 'running') {
        pump().catch(() => report({ kind: 'engine_error', reason: 'pump_failed' }));
      }
    },

    get running(): boolean {
      return state === 'running';
    },
  };
}
