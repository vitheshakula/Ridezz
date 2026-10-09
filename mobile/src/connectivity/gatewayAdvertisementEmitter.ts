/**
 * Origin side of gateway advertisements. While this node believes it can reach the Rideaze cloud
 * (`isCloudReachable`, injected, checked every cycle), each cycle broadcasts one advertisement with
 * a NEW secure message id; relays then preserve that cycle's id. When not reachable, a cycle does
 * nothing: no clock read, no id consumed, no send. A failed cycle is not retried: the next
 * scheduled cycle is the retry.
 *
 * The local node never records itself in its own GatewayState (GatewayState refuses the local
 * node), so no route to itself exists. When this node is the gateway, cloud delivery is a local
 * hand-off (future cloud upload), not a Nearby route.
 */

import { OPERATIONAL_SEND_TIMEOUT_MS, describeError, sendWithTimeout } from './boundedSend';
import { createCycleScheduler, type CycleOutcome, type CycleScheduler } from './cycleScheduler';
import {
  GATEWAY_ADVERTISEMENT_INTERVAL_MS,
  createGatewayAdvertisementMessage,
} from './protocol/gatewayAdvertisement';
import { isValidRideMessageTimestamp } from './protocol/rideMessage';
import { serializeRideMessage } from './protocol/rideMessageCodec';

export type GatewayAdvertisementCycleResult =
  | { status: 'not_reachable' }
  | { status: 'reachability_unavailable'; error: string }
  | { status: 'invalid_clock' }
  /** Id generation, message construction or encoding failed; nothing was sent. */
  | { status: 'message_failed'; error: string }
  | { status: 'sent'; messageId: string }
  /** broadcast() did not settle in time: the advertisement may or may not have gone out. */
  | { status: 'send_timeout'; messageId: string }
  | { status: 'transport_error'; messageId: string; error: string };

export interface GatewayAdvertisementEmitterOptions {
  rideId: string;
  localNodeId: string;
  transport: { broadcast(payload: string): Promise<void> };
  /** Secure id source; called only when an advertisement is actually built. */
  generateMessageId: () => string;
  /** Wall clock, epoch ms (advertisement expiry is judged on other devices). */
  wallClock: () => number;
  /** Application-level cloud reachability of THIS node. */
  isCloudReachable: () => boolean;
  sendTimeoutMs?: number;
}

export interface GatewayAdvertisementEmitter {
  /** One cycle. Never rejects. */
  emitAdvertisementCycle(): Promise<GatewayAdvertisementCycleResult>;
}

export function createGatewayAdvertisementEmitter({
  rideId,
  localNodeId,
  transport,
  generateMessageId,
  wallClock,
  isCloudReachable,
  sendTimeoutMs = OPERATIONAL_SEND_TIMEOUT_MS,
}: GatewayAdvertisementEmitterOptions): GatewayAdvertisementEmitter {
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs <= 0) {
    throw new RangeError('Gateway advertisement sendTimeoutMs must be a positive integer');
  }

  return {
    async emitAdvertisementCycle(): Promise<GatewayAdvertisementCycleResult> {
      let reachable: boolean;
      try {
        reachable = isCloudReachable() === true;
      } catch (error) {
        return { status: 'reachability_unavailable', error: describeError(error) };
      }
      if (!reachable) {
        return { status: 'not_reachable' };
      }

      let createdAt: number;
      try {
        createdAt = wallClock();
      } catch {
        return { status: 'invalid_clock' };
      }
      if (!isValidRideMessageTimestamp(createdAt)) {
        return { status: 'invalid_clock' };
      }

      let messageId: string;
      let payload: string;
      try {
        // A failing secure generator throws here: no fallback id.
        messageId = generateMessageId();
        const advertisement = createGatewayAdvertisementMessage({
          id: messageId,
          rideId,
          originId: localNodeId,
          createdAt,
        });
        payload = serializeRideMessage(advertisement);
      } catch (error) {
        return { status: 'message_failed', error: describeError(error) };
      }

      const outcome = await sendWithTimeout(() => transport.broadcast(payload), sendTimeoutMs);
      if (outcome.ok) {
        return { status: 'sent', messageId };
      }
      if ('timedOut' in outcome) {
        return { status: 'send_timeout', messageId };
      }
      return { status: 'transport_error', messageId, error: describeError(outcome.error) };
    },
  };
}

/** Advertisement cycles every GATEWAY_ADVERTISEMENT_INTERVAL_MS after the previous one settles,
 * with an immediate first cycle; non-overlapping (see createCycleScheduler). */
export function createGatewayAdvertisementScheduler(
  emitter: GatewayAdvertisementEmitter,
  options: {
    intervalMs?: number;
    onCycleSettled?: (outcome: CycleOutcome<GatewayAdvertisementCycleResult>) => void;
  } = {},
): CycleScheduler {
  return createCycleScheduler({
    runCycle: () => emitter.emitAdvertisementCycle(),
    intervalMs: options.intervalMs ?? GATEWAY_ADVERTISEMENT_INTERVAL_MS,
    onCycleSettled: options.onCycleSettled,
  });
}
