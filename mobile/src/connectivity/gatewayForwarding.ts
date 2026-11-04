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

export function originateGatewayRouted<TPayload, TType extends RideMessageType>(
  message: RideMessage<TPayload, TType>,
  context: GatewayRouteContext,
  gatewayNodeId?: string,
  excludedRouteKeys?: ReadonlySet<string>,
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
  const decision = selectGatewayForwardingRoute(getGatewayRouteCandidates(context, gatewayNodeId), {
    gatewayNodeId,
    excludedRouteKeys,
  });
  if (!decision.ok) {
    return { ok: false, reason: decision.reason };
  }
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

export function decideGatewayForward<TPayload, TType extends RideMessageType>(
  message: RideMessage<TPayload, TType>,
  context: GatewayRouteContext,
  previousHopNodeId: string | undefined,
  wallNow: number,
  excludedRouteKeys?: ReadonlySet<string>,
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
    excludedRouteKeys,
  });
  if (!decision.ok) {
    return { outcome: 'failed', reason: decision.reason };
  }

  const relayed = relayRideMessage(message, wallNow);
  if (!relayed) {
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
