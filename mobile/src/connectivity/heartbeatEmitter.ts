import { createCycleScheduler, type CycleOutcome, type CycleScheduler } from './cycleScheduler';
import { HEARTBEAT_INTERVAL_MS, createHeartbeatMessage } from './protocol/heartbeat';
import {
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  RIDE_MESSAGE_MAX_RIDE_ID_LENGTH,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
} from './protocol/rideMessage';
import { encodeRideMessage, serializeRideMessage } from './protocol/rideMessageCodec';
import type { BroadcastTransport } from '../transports/Transport';

export type HeartbeatTransport =
  | ({ readonly id: string; readonly payload: 'string' } & Pick<
      BroadcastTransport<string>,
      'broadcast'
    >)
  | ({ readonly id: string; readonly payload: 'bytes' } & Pick<
      BroadcastTransport<Uint8Array<ArrayBuffer>>,
      'broadcast'
    >);

export type HeartbeatTransmissionResult =
  | { transportId: string; ok: true; messageId: string }
  | { transportId: string; ok: false; stage: 'message'; error: string }
  | {
      transportId: string;
      ok: false;
      stage: 'transport';
      messageId: string;
      reason: 'error';
      error: string;
    }
  | { transportId: string; ok: false; stage: 'transport'; messageId: string; reason: 'timeout' }
  | { transportId: string; ok: false; stage: 'duplicate_transport' }
  | { transportId: string | null; ok: false; stage: 'invalid_transport' };

export type HeartbeatCycleResult =
  | { ok: true; transmissions: readonly HeartbeatTransmissionResult[] }
  | { ok: false; reason: 'transports_unavailable' | 'invalid_clock'; error?: string };

export interface HeartbeatEmitterOptions {
  rideId: string;
  localNodeId: string;
  getActiveTransports: () => readonly HeartbeatTransport[];
  generateMessageId: () => string;
  wallClock: () => number;
  sendTimeoutMs?: number;
}

export const HEARTBEAT_SEND_TIMEOUT_MS = 2_000;

type SendOutcome = { ok: true } | { ok: false; error: unknown } | { ok: false; timedOut: true };

function sendWithTimeout(send: () => Promise<void>, timeoutMs: number): Promise<SendOutcome> {
  return new Promise<SendOutcome>(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
    let sending: Promise<void>;
    try {
      sending = send();
    } catch (error) {
      sending = Promise.reject(error);
    }
    Promise.resolve(sending).then(
      () => {
        clearTimeout(timer);
        resolve({ ok: true });
      },
      error => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      },
    );
  });
}

export interface HeartbeatEmitter {
  emitHeartbeatCycle(): Promise<HeartbeatCycleResult>;
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown error';
  }
}

function isUsableTransport(value: unknown): value is HeartbeatTransport {
  const t = value as Partial<HeartbeatTransport> | null;
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.id === 'string' &&
    t.id.length > 0 &&
    (t.payload === 'string' || t.payload === 'bytes') &&
    typeof t.broadcast === 'function'
  );
}

export function createHeartbeatEmitter({
  rideId,
  localNodeId,
  getActiveTransports,
  generateMessageId,
  wallClock,
  sendTimeoutMs = HEARTBEAT_SEND_TIMEOUT_MS,
}: HeartbeatEmitterOptions): HeartbeatEmitter {
  if (!isValidRideMessageIdentifier(rideId, RIDE_MESSAGE_MAX_RIDE_ID_LENGTH)) {
    throw new TypeError('Heartbeat emitter rideId must be a valid RideMessage rideId');
  }
  if (!isValidRideMessageIdentifier(localNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH)) {
    throw new TypeError('Heartbeat emitter localNodeId must be a valid RideMessage originId');
  }
  for (const [name, fn] of Object.entries({ getActiveTransports, generateMessageId, wallClock })) {
    if (typeof fn !== 'function') {
      throw new TypeError(`Heartbeat emitter ${name} must be a function`);
    }
  }
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs <= 0) {
    throw new RangeError('Heartbeat emitter sendTimeoutMs must be a positive integer');
  }

  const transmit = async (
    transport: HeartbeatTransport,
    createdAt: number,
  ): Promise<HeartbeatTransmissionResult> => {
    const transportId = transport.id;
    let messageId: string;
    let send: () => Promise<void>;
    try {
      messageId = generateMessageId();
      const heartbeat = createHeartbeatMessage({
        id: messageId,
        rideId,
        originId: localNodeId,
        createdAt,
      });
      if (transport.payload === 'string') {
        const text = serializeRideMessage(heartbeat);
        send = () => transport.broadcast(text);
      } else {
        const bytes = encodeRideMessage(heartbeat);
        send = () => transport.broadcast(bytes);
      }
    } catch (error) {
      return { transportId, ok: false, stage: 'message', error: describeError(error) };
    }
    const outcome = await sendWithTimeout(send, sendTimeoutMs);
    if (outcome.ok) {
      return { transportId, ok: true, messageId };
    }
    if ('timedOut' in outcome) {
      return { transportId, ok: false, stage: 'transport', messageId, reason: 'timeout' };
    }
    return {
      transportId,
      ok: false,
      stage: 'transport',
      messageId,
      reason: 'error',
      error: describeError(outcome.error),
    };
  };

  return {
    async emitHeartbeatCycle(): Promise<HeartbeatCycleResult> {
      let transports: readonly unknown[];
      try {
        transports = Array.from(getActiveTransports());
      } catch (error) {
        return { ok: false, reason: 'transports_unavailable', error: describeError(error) };
      }
      if (transports.length === 0) {
        return { ok: true, transmissions: [] };
      }

      let createdAt: number;
      try {
        createdAt = wallClock();
      } catch (error) {
        return { ok: false, reason: 'invalid_clock', error: describeError(error) };
      }
      if (!isValidRideMessageTimestamp(createdAt)) {
        return { ok: false, reason: 'invalid_clock' };
      }

      const idCounts = new Map<string, number>();
      for (const t of transports) {
        if (isUsableTransport(t)) {
          idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
        }
      }

      type Attempt = HeartbeatTransmissionResult | Promise<HeartbeatTransmissionResult>;
      const attempts = transports.map((t): Attempt => {
        if (!isUsableTransport(t)) {
          const id = (t as { id?: unknown } | null)?.id;
          return {
            transportId: typeof id === 'string' && id.length > 0 ? id : null,
            ok: false,
            stage: 'invalid_transport',
          };
        }
        if ((idCounts.get(t.id) ?? 0) > 1) {
          return { transportId: t.id, ok: false, stage: 'duplicate_transport' };
        }
        return transmit(t, createdAt);
      });
      return { ok: true, transmissions: await Promise.all(attempts) };
    },
  };
}

export interface HeartbeatSchedulerOptions {
  intervalMs?: number;
  onCycleSettled?: (outcome: CycleOutcome<HeartbeatCycleResult>) => void;
}

export function createHeartbeatScheduler(
  emitter: HeartbeatEmitter,
  { intervalMs = HEARTBEAT_INTERVAL_MS, onCycleSettled }: HeartbeatSchedulerOptions = {},
): CycleScheduler {
  return createCycleScheduler({
    runCycle: () => emitter.emitHeartbeatCycle(),
    intervalMs,
    onCycleSettled,
  });
}
