import { type JsonValue } from './protocol/jsonValue';
import {
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  RIDE_MESSAGE_MAX_RIDE_ID_LENGTH,
  isValidRideMessageIdentifier,
  type RideMessage,
} from './protocol/rideMessage';
import { parseRideMessage } from './protocol/rideMessageCodec';
import type { SeenMessageCache } from './protocol/seenMessageCache';

export interface RideMessageIngressSource {
  readonly transportId: string;
  readonly peerId?: string;
}

export type RideMessageIngressRejection = 'invalid' | 'wrong_ride' | 'local_origin' | 'duplicate';

export type RideMessageIngressResult =
  | {
      accepted: true;
      message: RideMessage<JsonValue>;
      source: RideMessageIngressSource;
    }
  | {
      accepted: false;
      reason: RideMessageIngressRejection;
      source: RideMessageIngressSource;
    };

export interface RideMessageIngressOptions {
  rideId: string;
  localNodeId: string;
  seenMessages: SeenMessageCache;
  clock: () => number;
}

export interface RideMessageIngress {
  ingest(payload: string | Uint8Array, source: RideMessageIngressSource): RideMessageIngressResult;
}

function copySource(source: RideMessageIngressSource): RideMessageIngressSource {
  if (typeof source !== 'object' || source === null) {
    throw new TypeError('Ingress source must be an object');
  }
  const { transportId, peerId } = source;
  if (typeof transportId !== 'string' || transportId.length === 0) {
    throw new TypeError('Ingress source transportId must be a non-empty string');
  }
  if (peerId === undefined) {
    return { transportId };
  }
  if (typeof peerId !== 'string' || peerId.length === 0) {
    throw new TypeError('Ingress source peerId must be a non-empty string when present');
  }
  return { transportId, peerId };
}

export function createRideMessageIngress({
  rideId,
  localNodeId,
  seenMessages,
  clock,
}: RideMessageIngressOptions): RideMessageIngress {
  if (!isValidRideMessageIdentifier(rideId, RIDE_MESSAGE_MAX_RIDE_ID_LENGTH)) {
    throw new TypeError('Ingress rideId must be a valid RideMessage rideId');
  }
  if (!isValidRideMessageIdentifier(localNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH)) {
    throw new TypeError('Ingress localNodeId must be a valid RideMessage originId');
  }

  return {
    ingest(payload, rawSource): RideMessageIngressResult {
      const source = copySource(rawSource);
      const now = clock();

      const message = parseRideMessage(payload, now);
      if (!message) {
        return { accepted: false, reason: 'invalid', source };
      }
      if (message.rideId !== rideId) {
        return { accepted: false, reason: 'wrong_ride', source };
      }
      if (message.originId === localNodeId) {
        return { accepted: false, reason: 'local_origin', source };
      }

      switch (seenMessages.claim(message.id, message.expiresAt, now)) {
        case 'accepted':
          return { accepted: true, message, source };
        case 'duplicate':
          return { accepted: false, reason: 'duplicate', source };
        default:
          return { accepted: false, reason: 'invalid', source };
      }
    },
  };
}
