import type { DirectLinkIdentityMap } from './directLinkIdentityMap';
import type { GatewayState } from './gatewayState';
import { isValidRideMessageTimestamp } from './protocol/rideMessage';

export interface GatewayRouteCandidate {
  readonly gatewayNodeId: string;
  readonly nextHopNodeId: string;
  readonly transportId: string;
  readonly hopCount: number;
  readonly observedAt: number;
}

export interface GatewayRouteContext {
  localNodeId: string;
  gatewayState: GatewayState;
  linkIdentities: DirectLinkIdentityMap;
  now: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareGatewayRoutes(a: GatewayRouteCandidate, b: GatewayRouteCandidate): number {
  return (
    a.hopCount - b.hopCount ||
    compareStrings(a.nextHopNodeId, b.nextHopNodeId) ||
    compareStrings(a.transportId, b.transportId) ||
    compareStrings(a.gatewayNodeId, b.gatewayNodeId)
  );
}

export function gatewayRouteKey(route: GatewayRouteCandidate): string {
  return JSON.stringify([
    route.gatewayNodeId,
    route.nextHopNodeId,
    route.transportId,
    route.hopCount,
  ]);
}

export function getGatewayRouteCandidates(
  { localNodeId, gatewayState, linkIdentities, now }: GatewayRouteContext,
  gatewayNodeId?: string,
): readonly GatewayRouteCandidate[] {
  if (!isValidRideMessageTimestamp(now)) {
    return Object.freeze([]);
  }
  const gateways =
    gatewayNodeId === undefined
      ? gatewayState.getGateways(now)
      : [gatewayState.getGateway(gatewayNodeId, now)].filter(g => g !== undefined);

  const linkTransports = new Map<string, ReadonlySet<string>>();
  const transportsFor = (nodeId: string) => {
    let transports = linkTransports.get(nodeId);
    if (!transports) {
      transports = new Set(linkIdentities.getLinksForNode(nodeId, now).map(l => l.transportId));
      linkTransports.set(nodeId, transports);
    }
    return transports;
  };

  const candidates: GatewayRouteCandidate[] = [];
  for (const gateway of gateways) {
    if (gateway.nodeId === localNodeId) {
      continue;
    }
    for (const o of gateway.observations) {
      const via = o.viaNodeId;
      if (
        via === undefined ||
        via === localNodeId ||
        (o.hopCount === 0) !== (via === gateway.nodeId) ||
        !transportsFor(via).has(o.transportId)
      ) {
        continue;
      }
      candidates.push(
        Object.freeze({
          gatewayNodeId: gateway.nodeId,
          nextHopNodeId: via,
          transportId: o.transportId,
          hopCount: o.hopCount,
          observedAt: o.lastSeenAt,
        }),
      );
    }
  }
  candidates.sort(compareGatewayRoutes);
  return Object.freeze(candidates);
}

export function gatewayRouteDistance(candidate: GatewayRouteCandidate): number {
  return candidate.hopCount + 1;
}

export function resolvePreviousHop(
  source: { readonly transportId: string; readonly peerId?: string },
  linkIdentities: DirectLinkIdentityMap,
  now: number,
): string | undefined {
  return source.peerId === undefined
    ? undefined
    : linkIdentities.resolve(source.transportId, source.peerId, now);
}

export function resolveTargetEndpoint(
  linkIdentities: DirectLinkIdentityMap,
  nextHopNodeId: string,
  transportId: string,
  now: number,
): string | undefined {
  return linkIdentities
    .getLinksForNode(nextHopNodeId, now)
    .find(link => link.transportId === transportId)?.transportPeerId;
}

export interface GatewayForwardingContext {
  gatewayNodeId?: string;
  excludedRouteKeys?: ReadonlySet<string>;
  received?: {
    fromNodeId: string | undefined;
    distanceBound: number | undefined;
  };
}

export type GatewayForwardingDecision =
  | { ok: true; route: GatewayRouteCandidate; distance: number }
  | {
      ok: false;
      reason:
        | 'no_route'
        | 'unknown_previous_hop'
        | 'unknown_progress'
        | 'previous_hop_only'
        | 'no_progress';
    };

export function selectGatewayForwardingRoute(
  candidates: readonly GatewayRouteCandidate[],
  { gatewayNodeId, received, excludedRouteKeys }: GatewayForwardingContext = {},
): GatewayForwardingDecision {
  const scoped =
    gatewayNodeId === undefined
      ? candidates
      : candidates.filter(c => c.gatewayNodeId === gatewayNodeId);
  const toGateway = excludedRouteKeys
    ? scoped.filter(candidate => !excludedRouteKeys.has(gatewayRouteKey(candidate)))
    : scoped;
  if (toGateway.length === 0) {
    return { ok: false, reason: 'no_route' };
  }

  let eligible = toGateway;
  if (received) {
    const { fromNodeId, distanceBound } = received;
    if (fromNodeId === undefined) {
      return { ok: false, reason: 'unknown_previous_hop' };
    }
    if (!Number.isSafeInteger(distanceBound) || (distanceBound as number) < 0) {
      return { ok: false, reason: 'unknown_progress' };
    }
    eligible = toGateway.filter(c => c.nextHopNodeId !== fromNodeId);
    if (eligible.length === 0) {
      return { ok: false, reason: 'previous_hop_only' };
    }
    eligible = eligible.filter(c => gatewayRouteDistance(c) < (distanceBound as number));
    if (eligible.length === 0) {
      return { ok: false, reason: 'no_progress' };
    }
  }

  const route = selectGatewayRoute(eligible)!;
  return { ok: true, route, distance: gatewayRouteDistance(route) };
}

export function selectGatewayRoute(
  candidates: readonly GatewayRouteCandidate[],
): GatewayRouteCandidate | undefined {
  let best: GatewayRouteCandidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined || compareGatewayRoutes(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}
