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
  | { readonly kind: 'expired'; readonly messageId: string }
  | { readonly kind: 'engine_error'; readonly reason: string };

export interface ReliableDeliveryEngine {
  start(): Promise<void>;
  stop(): void;
  submit(
    message: RideMessage,
    destinationGatewayId?: string,
  ): Promise<OutboxEnqueueResult>;
  acknowledge(messageId: string): Promise<boolean>;
  connectivityAvailable(): void;
  readonly running: boolean;
}

export function createReliableDeliveryEngine({
  outbox,
  attempt,
  clock = () => Date.now(),
  onEvent,
}: {
  readonly outbox: PersistentOutbox;
  readonly attempt: (record: PersistentOutboxRecord) => Promise<ReliableDeliveryAttemptOutcome>;
  readonly clock?: () => number;
  readonly onEvent?: (event: ReliableDeliveryEvent) => void;
}): ReliableDeliveryEngine {
  let state: 'idle' | 'running' | 'stopped' = 'idle';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pumping = false;
  let pumpAgain = false;

  const report = (event: ReliableDeliveryEvent): void => {
    try {
      onEvent?.(Object.freeze({ ...event }));
    } catch {
      // Diagnostics cannot affect delivery.
    }
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
    const next = outbox.nextAttemptAt();
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
      for (const messageId of await outbox.expire(now)) {
        report({ kind: 'expired', messageId });
      }
      for (const record of outbox.due(now)) {
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
          report({ kind: 'expired', messageId: record.message.id });
        }
      }
    } catch {
      report({ kind: 'engine_error', reason: 'outbox_operation_failed' });
    } finally {
      pumping = false;
      if (pumpAgain) {
        pumpAgain = false;
        void pump();
      } else {
        schedule(() => void pump());
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
      const recovered = await outbox.initialize(clock());
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
        void pump();
      }
      return result;
    },

    async acknowledge(messageId): Promise<boolean> {
      if (state !== 'running') {
        return false;
      }
      const removed = await outbox.acknowledge(messageId);
      schedule(() => void pump());
      return removed;
    },

    connectivityAvailable(): void {
      if (state === 'running') {
        void pump();
      }
    },

    get running(): boolean {
      return state === 'running';
    },
  };
}
