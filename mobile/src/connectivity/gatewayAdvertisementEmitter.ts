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
  | { status: 'message_failed'; error: string }
  | { status: 'sent'; messageId: string }
  | { status: 'send_timeout'; messageId: string }
  | { status: 'transport_error'; messageId: string; error: string };

export interface GatewayAdvertisementEmitterOptions {
  rideId: string;
  localNodeId: string;
  transport: { broadcast(payload: string): Promise<void> };
  generateMessageId: () => string;
  wallClock: () => number;
  isCloudReachable: () => boolean;
  sendTimeoutMs?: number;
}

export interface GatewayAdvertisementEmitter {
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
