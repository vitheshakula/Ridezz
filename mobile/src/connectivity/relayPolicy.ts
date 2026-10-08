/**
 * Transport-neutral relay eligibility: may this node forward an accepted (or locally created)
 * RideMessage? It never sends, picks peers or transports, or touches the dedup cache. A positive
 * decision means only "legally and semantically eligible to be forwarded", not "send now".
 *
 * Decision order, so every rejection has exactly one deterministic reason:
 *   1. expired at `now` (isRideMessageExpired)    -> 'expired'
 *   2. hop budget spent (hopCount >= maxHops)      -> 'hop_limit'
 *   3. message type not relayable                  -> 'message_policy'
 *   4. otherwise: the relayed copy (relayRideMessage), hopCount + 1, all else identical
 *
 * The relayed copy keeps the same id on purpose: every receiving node performs its own dedup
 * claim at ingress, so copies converging over different paths are collapsed there.
 *
 * An origin's own first transmission is not a relay: it is sent as created, with hopCount 0.
 * Running it through this policy first would spend one hop of its budget at the origin.
 */

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

/**
 * Whether each message type may be forwarded beyond the node that received it. Exhaustive by
 * construction: adding a RideMessageType without a policy entry is a compile error.
 */
export const RIDE_MESSAGE_RELAY_POLICY: Readonly<Record<RideMessageType, boolean>> = Object.freeze(
  {
    // Highest resilience. ACK/retry, store-and-forward and cloud sync come later.
    sos: true,
    // High resilience. Store-and-forward while relevant and cloud sync come later.
    hazard: true,
    // Provisional: ACK routing is not designed yet; allowing relay avoids assuming ACKs are
    // one-hop. Revisit when ACK semantics are implemented.
    ack: true,
    // Liveness of a directly observed neighbour only; rebroadcasting would misreport remote
    // nodes as neighbours. Remote reachability will need its own topology message.
    heartbeat: false,
    // Control plane: lets gateway reachability travel beyond direct neighbours, still bounded by
    // TTL and hop limit. Gateway selection comes later.
    gateway_advertisement: true,
    // Later likely "latest wins" with tighter hop/TTL limits.
    location: true,
    // Lets session state propagate across the local mesh.
    ride_state: true,
  },
);

/** True only for a known type whose policy allows relaying. Fails closed for anything else. */
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

/**
 * Decides relay eligibility at `now`. On success returns the exact immutable copy to forward:
 * hopCount + 1, every other field (including the payload reference) unchanged. The input is
 * never mutated. Throws RangeError for an invalid `now`, which is a caller bug.
 */
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
  // Not expired, so the only way canRelayRideMessage can refuse is an exhausted hop budget.
  if (!canRelayRideMessage(message, now)) {
    return { relay: false, reason: 'hop_limit' };
  }
  if (!isRelayableMessageType(message.type)) {
    return { relay: false, reason: 'message_policy' };
  }
  const relayed = relayRideMessage(message, now);
  // Always non-null here: both of its conditions were checked above at the same `now`.
  return relayed ? { relay: true, message: relayed } : { relay: false, reason: 'hop_limit' };
}
