/**
 * Message transformations for gateway-routed forwarding. Decides and transforms only: nothing is
 * sent, no transport is chosen, nothing is stored.
 *
 * Origin: the node that creates a routable message selects a route, pins its gateway as
 * targetGatewayId and stamps its own distance as forwarderDistance. The message itself is sent as
 * created (hopCount 0).
 *
 * Forward: a node that receives a routed message either recognises itself as the target gateway
 * (terminal), or looks up routes to that SAME gateway only and requires its selected distance to
 * be strictly smaller than the received forwarderDistance. The forwarded copy has hopCount + 1
 * (normal relay semantics, still bounded by maxHops and expiry) and forwarderDistance = the
 * selected distance; targetGatewayId never changes. If no safe route to the target exists, the
 * attempt fails closed: switching to another gateway is a separate, future policy.
 *
 * Invariant for an honest chain: forwarderDistance strictly decreases, D0 > D1 > ... > 0, so a
 * routed message cannot loop forever (see selectGatewayForwardingRoute).
 */

import {
  getGatewayRouteCandidates,
  selectGatewayForwardingRoute,
  type GatewayForwardingDecision,
  type GatewayRouteCandidate,
  type GatewayRouteContext,
} from './gatewayRouting';
import {
  isGatewayRoutableMessageType,
  isRideMessageExpired,
  relayRideMessage,
  withGatewayRouting,
  type RideMessage,
  type RideMessageType,
} from './protocol/rideMessage';

type ForwardingRejection = Extract<GatewayForwardingDecision, { ok: false }>['reason'];

export type GatewayOriginDecision<TPayload, TType extends RideMessageType> =
  | { ok: true; message: RideMessage<TPayload, TType>; route: GatewayRouteCandidate }
  | {
      ok: false;
      reason:
        | 'not_routable_type'
        | 'not_local_origin'
        | 'already_routed'
        | 'insufficient_hop_budget'
        | ForwardingRejection;
    };

/**
 * Relays a routed message needs to reach the gateway along a route of `routeDistance` links:
 * requiredRelayBudget = routeDistance - 1. Every node between origin and gateway relays once; the
 * gateway receives the final transmission and does not relay it. Compared against maxHops.
 */
export function requiredRelayBudget(routeDistance: number): number {
  return routeDistance - 1;
}

export type GatewayForwardDecision<TPayload, TType extends RideMessageType> =
  | { outcome: 'gateway_reached'; targetGatewayId: string }
  | {
      outcome: 'forward';
      message: RideMessage<TPayload, TType>;
      route: GatewayRouteCandidate;
    }
  | {
      outcome: 'failed';
      reason: 'not_routed' | 'expired' | 'hop_limit' | ForwardingRejection;
    };

/**
 * Begins routed forwarding of a message this node created. Picks the best route (to
 * `gatewayNodeId` if given, otherwise to any gateway) and returns the message carrying
 * targetGatewayId and this node's distance. The input is never mutated.
 */
export function originateGatewayRouted<TPayload, TType extends RideMessageType>(
  message: RideMessage<TPayload, TType>,
  context: GatewayRouteContext,
  gatewayNodeId?: string,
): GatewayOriginDecision<TPayload, TType> {
  if (!isGatewayRoutableMessageType(message.type)) {
    return { ok: false, reason: 'not_routable_type' };
  }
  if (message.originId !== context.localNodeId) {
    return { ok: false, reason: 'not_local_origin' };
  }
  if (message.gatewayRouting !== undefined) {
    return { ok: false, reason: 'already_routed' };
  }
  const decision = selectGatewayForwardingRoute(
    getGatewayRouteCandidates(context, gatewayNodeId),
    { gatewayNodeId },
  );
  if (!decision.ok) {
    return { ok: false, reason: decision.reason };
  }
  // Early impossibility check: the caller's relay limit cannot cover this route. maxHops is never
  // raised here, and forwarders still enforce the hop limit at every hop.
  if (message.maxHops < requiredRelayBudget(decision.distance)) {
    return { ok: false, reason: 'insufficient_hop_budget' };
  }
  return {
    ok: true,
    route: decision.route,
    message: withGatewayRouting(message, {
      targetGatewayId: decision.route.gatewayNodeId,
      forwarderDistance: decision.distance,
    }),
  };
}

/**
 * Decides what this node does with a received routed message.
 *
 * `previousHopNodeId` must come from resolvePreviousHop (verified direct-link identity), never
 * from the message origin. `wallNow` is the protocol clock used for expiry; the route context's
 * `now` is the local monotonic clock used for state freshness.
 */
export function decideGatewayForward<TPayload, TType extends RideMessageType>(
  message: RideMessage<TPayload, TType>,
  context: GatewayRouteContext,
  previousHopNodeId: string | undefined,
  wallNow: number,
): GatewayForwardDecision<TPayload, TType> {
  const routing = message.gatewayRouting;
  if (routing === undefined) {
    return { outcome: 'failed', reason: 'not_routed' };
  }
  const target = routing.targetGatewayId;
  if (target === context.localNodeId) {
    return { outcome: 'gateway_reached', targetGatewayId: target };
  }
  if (isRideMessageExpired(message, wallNow)) {
    return { outcome: 'failed', reason: 'expired' };
  }
  if (message.hopCount >= message.maxHops) {
    return { outcome: 'failed', reason: 'hop_limit' };
  }

  const decision = selectGatewayForwardingRoute(getGatewayRouteCandidates(context, target), {
    gatewayNodeId: target,
    received: { fromNodeId: previousHopNodeId, distanceBound: routing.forwarderDistance },
  });
  if (!decision.ok) {
    return { outcome: 'failed', reason: decision.reason };
  }

  const relayed = relayRideMessage(message, wallNow);
  if (!relayed) {
    // Unreachable: expiry and hop budget were checked above at the same wallNow.
    return { outcome: 'failed', reason: 'hop_limit' };
  }
  return {
    outcome: 'forward',
    route: decision.route,
    message: withGatewayRouting(relayed, {
      targetGatewayId: target,
      forwarderDistance: decision.distance,
    }),
  };
}
