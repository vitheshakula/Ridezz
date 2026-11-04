import {
  RIDE_MESSAGE_TYPES,
  canRelayRideMessage,
  isRideMessageExpired,
  isValidRideMessageTimestamp,
  relayRideMessage,
  type RideMessage,
  type RideMessageType,
} from './protocol/rideMessage';
import type { JsonValue } from './protocol/jsonValue';

export const RIDE_MESSAGE_RELAY_POLICY: Readonly<Record<RideMessageType, boolean>> = Object.freeze({
  sos: true,
  hazard: true,
  ack: true,
  heartbeat: false,
  gateway_advertisement: true,
  location: true,
  ride_state: true,
});

export function isRelayableMessageType(type: unknown): boolean {
  return (
    (RIDE_MESSAGE_TYPES as readonly unknown[]).includes(type) &&
    RIDE_MESSAGE_RELAY_POLICY[type as RideMessageType] === true
  );
}

export type RelayRejection = 'expired' | 'hop_limit' | 'message_policy';

export type RelayDecision<TPayload = JsonValue, TType extends RideMessageType = RideMessageType> =
  | { relay: true; message: RideMessage<TPayload, TType> }
  | { relay: false; reason: RelayRejection };

export function decideRelay<TPayload, TType extends RideMessageType>(
  message: RideMessage<TPayload, TType>,
  now: number,
): RelayDecision<TPayload, TType> {
  if (!isValidRideMessageTimestamp(now)) {
    throw new RangeError('decideRelay now must be a non-negative safe integer');
  }
  if (isRideMessageExpired(message, now)) {
    return { relay: false, reason: 'expired' };
  }
  if (!canRelayRideMessage(message, now)) {
    return { relay: false, reason: 'hop_limit' };
  }
  if (!isRelayableMessageType(message.type)) {
    return { relay: false, reason: 'message_policy' };
  }
  const relayed = relayRideMessage(message, now);
  return relayed ? { relay: true, message: relayed } : { relay: false, reason: 'hop_limit' };
}
