/**
 * Origin side of heartbeats: each cycle sends one independent heartbeat over every currently
 * active heartbeat-capable transport. Every transmission gets its own freshly generated secure id,
 * so a receiver's id-based dedup lets each direct link through as a separate observation:
 * X -> H1, Y -> H2, never the same id on two transports.
 *
 * Heartbeats are sent exactly as created (hopCount 0, maxHops 0); relay policy is never
 * consulted for an origin transmission. Only the wall clock is used: heartbeat expiry is judged
 * on other devices. Peer freshness (monotonic) is a receive-side concern.
 */

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

/**
 * The minimum a transport must offer to carry heartbeats: an opaque local id and the existing
 * BroadcastTransport.broadcast, in whichever payload form that transport takes.
 */
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
  /** Local failure before sending: id generation, message construction or encoding. */
  | { transportId: string; ok: false; stage: 'message'; error: string }
  /** The transport rejected or threw while sending this heartbeat. */
  | {
      transportId: string;
      ok: false;
      stage: 'transport';
      messageId: string;
      reason: 'error';
      error: string;
    }
  /** broadcast() did not settle within the send timeout. The heartbeat is abandoned, not retried
   * and not cancelled: the native send may still complete later. */
  | { transportId: string; ok: false; stage: 'transport'; messageId: string; reason: 'timeout' }
  /** Two active transports share this id; none of them is sent on this cycle. */
  | { transportId: string; ok: false; stage: 'duplicate_transport' }
  /** Not a usable HeartbeatTransport (bad id, payload form or broadcast). */
  | { transportId: string | null; ok: false; stage: 'invalid_transport' };

export type HeartbeatCycleResult =
  | { ok: true; transmissions: readonly HeartbeatTransmissionResult[] }
  | { ok: false; reason: 'transports_unavailable' | 'invalid_clock'; error?: string };

export interface HeartbeatEmitterOptions {
  rideId: string;
  localNodeId: string;
  /** Queried at the start of every cycle, so transports may come and go between cycles. */
  getActiveTransports: () => readonly HeartbeatTransport[];
  /** Secure id source (createRideMessageIdGenerator). Called once per transmission attempt. */
  generateMessageId: () => string;
  /** Wall clock, epoch ms. Read once per cycle that has transports. */
  wallClock: () => number;
  /** Local bound on each broadcast(); defaults to HEARTBEAT_SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
}

/**
 * Local operational bound on one transport.broadcast() call, so a hung transport cannot stall the
 * cycle or the scheduler. Not a TTL, ACK, retry or delivery bound. Sends race their timeouts
 * concurrently, so a cycle settles within about one timeout however many transports hang, and the
 * worst scheduled period is about HEARTBEAT_SEND_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS (7 s), which
 * must stay below receivers' peer freshness (15 s).
 */
export const HEARTBEAT_SEND_TIMEOUT_MS = 2_000;

type SendOutcome = { ok: true } | { ok: false; error: unknown } | { ok: false; timedOut: true };

/**
 * Starts `send` and settles with whichever comes first: its outcome or the timeout. When the
 * timeout wins, the send keeps running in the background (it cannot be cancelled); its eventual
 * resolve or reject is absorbed here, so it is neither reported twice nor left unhandled.
 */
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
  /** One cycle. Never rejects: every failure is reported in the result. */
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

  /** Builds and sends one heartbeat; resolves with its result, never rejects. */
  const transmit = async (
    transport: HeartbeatTransport,
    createdAt: number,
  ): Promise<HeartbeatTransmissionResult> => {
    const transportId = transport.id;
    let messageId: string;
    let send: () => Promise<void>;
    try {
      // A failing generator throws here: no fallback id is ever produced.
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

      // Ids are generated and messages built synchronously in transport order (deterministic);
      // the sends then run concurrently so a slow transport does not delay the others.
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

/** Heartbeat cycles every HEARTBEAT_INTERVAL_MS (after the previous cycle settles), with an
 * immediate first cycle on start so a joining rider becomes discoverable quickly. */
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
