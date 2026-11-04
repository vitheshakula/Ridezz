import { OPERATIONAL_SEND_TIMEOUT_MS, describeError, sendWithTimeout } from './boundedSend';
import { asDeliveryAcknowledgementMessage } from './protocol/deliveryAcknowledgement';
import type { JsonValue } from './protocol/jsonValue';
import { isRideMessageExpired, relayRideMessage, type RideMessage } from './protocol/rideMessage';
import { serializeRideMessage } from './protocol/rideMessageCodec';
import type { TransportEndpointSource } from '../transports/Transport';

interface ReturnHop {
  readonly endpointId: string;
  readonly expiresAt: number;
}

export type AckReturnResult =
  | { readonly status: 'origin_reached'; readonly acknowledgement: RideMessage<JsonValue> }
  | { readonly status: 'forwarded'; readonly acknowledgement: RideMessage<JsonValue> }
  | { readonly status: 'send_timeout'; readonly acknowledgement: RideMessage<JsonValue> }
  | {
      readonly status: 'transport_error';
      readonly acknowledgement: RideMessage<JsonValue>;
      readonly error: string;
    }
  | {
      readonly status: 'not_forwarded';
      readonly reason:
        | 'invalid_ack'
        | 'unknown_return_route'
        | 'expired'
        | 'hop_limit'
        | 'encode_failed';
    };

export interface AckReturnRouter {
  remember(message: RideMessage<JsonValue>, source: TransportEndpointSource): void;
  route(acknowledgement: RideMessage<JsonValue>): Promise<AckReturnResult>;
  clear(): void;
}

export function createAckReturnRouter({
  localNodeId,
  sendTo,
  wallClock,
  sendTimeoutMs = OPERATIONAL_SEND_TIMEOUT_MS,
}: {
  readonly localNodeId: string;
  readonly sendTo: (endpointId: string, payload: string) => Promise<void>;
  readonly wallClock: () => number;
  readonly sendTimeoutMs?: number;
}): AckReturnRouter {
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs <= 0) {
    throw new RangeError('ACK return router sendTimeoutMs must be a positive integer');
  }
  const returnHops = new Map<string, ReturnHop>();

  const prune = (now: number): void => {
    for (const [messageId, hop] of returnHops) {
      if (now >= hop.expiresAt) {
        returnHops.delete(messageId);
      }
    }
  };

  return {
    remember(message, source): void {
      if (
        message.type === 'ack' ||
        message.gatewayRouting === undefined ||
        typeof source.endpointId !== 'string' ||
        source.endpointId.length === 0
      ) {
        return;
      }
      const now = wallClock();
      prune(now);
      if (!isRideMessageExpired(message, now)) {
        returnHops.set(message.id, { endpointId: source.endpointId, expiresAt: message.expiresAt });
      }
    },

    async route(rawAcknowledgement): Promise<AckReturnResult> {
      const acknowledgement = asDeliveryAcknowledgementMessage(rawAcknowledgement);
      if (!acknowledgement) {
        return { status: 'not_forwarded', reason: 'invalid_ack' };
      }
      const now = wallClock();
      prune(now);
      if (isRideMessageExpired(acknowledgement, now)) {
        return { status: 'not_forwarded', reason: 'expired' };
      }
      if (acknowledgement.payload.originalOriginId === localNodeId) {
        return { status: 'origin_reached', acknowledgement };
      }
      const hop = returnHops.get(acknowledgement.payload.originalMessageId);
      if (!hop) {
        return { status: 'not_forwarded', reason: 'unknown_return_route' };
      }
      const relayed = relayRideMessage(acknowledgement, now);
      if (!relayed) {
        return { status: 'not_forwarded', reason: 'hop_limit' };
      }
      let payload: string;
      try {
        payload = serializeRideMessage(relayed);
      } catch {
        return { status: 'not_forwarded', reason: 'encode_failed' };
      }
      const outcome = await sendWithTimeout(() => sendTo(hop.endpointId, payload), sendTimeoutMs);
      if (outcome.ok) {
        return { status: 'forwarded', acknowledgement: relayed };
      }
      if ('timedOut' in outcome) {
        return { status: 'send_timeout', acknowledgement: relayed };
      }
      return {
        status: 'transport_error',
        acknowledgement: relayed,
        error: describeError(outcome.error),
      };
    },

    clear(): void {
      returnHops.clear();
    },
  };
}
