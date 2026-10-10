/**
 * Pure routing decisions toward cloud gateways. Nothing is stored: candidates are derived on
 * demand from current GatewayState and DirectLinkIdentityMap, so they disappear as soon as the
 * state they rest on goes stale or changes. "Known gateway" does not imply "routable gateway".
 *
 * A gateway observation becomes a candidate only if, at `now`:
 *   1. the observation is fresh (GatewayState reads only return fresh observations);
 *   2. it carries a viaNodeId, i.e. the direct sender was resolved at receipt;
 *   3. that via node still has a fresh direct link on the observation's transport
 *      (DirectLinkIdentityMap is authoritative for next-hop identity, so an endpoint reassigned
 *      to another node invalidates routes learned through the old node);
 *   4. neither the next hop nor the gateway is the local node; and
 *   5. the hop count is consistent with the sender (hop 0 iff the next hop is the gateway).
 *
 * PeerTable is deliberately not consulted. Links are only created and refreshed by direct
 * heartbeats that refreshed PeerTable at the same instant with the same default freshness, so a
 * fresh link already implies fresh presence; PeerTable can lag a link reassignment, and must not
 * revive a route the link map has invalidated.
 *
 * Freshness is eligibility, not quality: selection never prefers newer observations.
 */

import type { DirectLinkIdentityMap } from './directLinkIdentityMap';
import type { GatewayState } from './gatewayState';
import { isValidRideMessageTimestamp } from './protocol/rideMessage';

export interface GatewayRouteCandidate {
  readonly gatewayNodeId: string;
  /** Direct Rideaze neighbour to hand traffic to. Equals gatewayNodeId when hopCount is 0. */
  readonly nextHopNodeId: string;
  readonly transportId: string;
  /**
   * Relays the gateway's advertisement took before reaching this node, as carried in the
   * envelope: 0 = the next hop is the gateway itself; h = h relaying nodes (the next hop included)
   * between this node and the gateway. The path to the gateway is hopCount + 1 links.
   */
  readonly hopCount: number;
  /** Local monotonic time of the supporting observation (eligibility only, never a metric). */
  readonly observedAt: number;
}

export interface GatewayRouteContext {
  localNodeId: string;
  gatewayState: GatewayState;
  linkIdentities: DirectLinkIdentityMap;
  /** Local monotonic time, the same clock both state structures use. */
  now: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic preference: lowest hopCount, then next-hop id, transport id, gateway id. */
export function compareGatewayRoutes(a: GatewayRouteCandidate, b: GatewayRouteCandidate): number {
  return (
    a.hopCount - b.hopCount ||
    compareStrings(a.nextHopNodeId, b.nextHopNodeId) ||
    compareStrings(a.transportId, b.transportId) ||
    compareStrings(a.gatewayNodeId, b.gatewayNodeId)
  );
}

/** Stable key used only for node-local attempt exclusion; it is never serialized. */
export function gatewayRouteKey(route: GatewayRouteCandidate): string {
  return JSON.stringify([
    route.gatewayNodeId,
    route.nextHopNodeId,
    route.transportId,
    route.hopCount,
  ]);
}

/**
 * All currently usable routes, optionally for one gateway, sorted by preference. Reads only:
 * neither state structure is pruned or otherwise mutated.
 */
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

/**
 * This node's distance to the gateway, in links, if it forwards via `candidate`: the next hop's own
 * distance (the candidate's hopCount, as carried by the advertisement copy it handed over) plus
 * the link to it. A direct gateway (hopCount 0) is distance 1.
 */
export function gatewayRouteDistance(candidate: GatewayRouteCandidate): number {
  return candidate.hopCount + 1;
}

/**
 * The direct neighbour that handed over a received packet, from verified direct-link identity
 * only. Never the packet's originId: that is who created the message, not who delivered it.
 */
export function resolvePreviousHop(
  source: { readonly transportId: string; readonly peerId?: string },
  linkIdentities: DirectLinkIdentityMap,
  now: number,
): string | undefined {
  return source.peerId === undefined
    ? undefined
    : linkIdentities.resolve(source.transportId, source.peerId, now);
}

/**
 * The fresh transport endpoint on `transportId` currently claimed by `nextHopNodeId`, derived from
 * the existing link snapshot (getLinksForNode). Never guesses: no other node, no other transport.
 * When the node has several fresh endpoints on that transport the lexically smallest is chosen:
 * deterministic, not yet quality-based.
 */
export function resolveTargetEndpoint(
  linkIdentities: DirectLinkIdentityMap,
  nextHopNodeId: string,
  transportId: string,
  now: number,
): string | undefined {
  // getLinksForNode returns only fresh links, sorted by transportId then transportPeerId.
  return linkIdentities
    .getLinksForNode(nextHopNodeId, now)
    .find(link => link.transportId === transportId)?.transportPeerId;
}

export interface GatewayForwardingContext {
  /** Restrict to routes toward this gateway. A distance bound is only meaningful toward the gateway
   * (or, when omitted, the nearest-gateway metric) it was computed for; every forwarder of a packet
   * must use the same choice. */
  gatewayNodeId?: string;
  /** Routes already attempted for this one bounded operation. */
  excludedRouteKeys?: ReadonlySet<string>;
  /**
   * Absent when this node originates the packet. Present when forwarding a packet received from
   * another node; both fields are then required, and either being unknown fails closed.
   */
  received?: {
    /** Direct previous hop, from resolvePreviousHop. Never the packet's originId. */
    fromNodeId: string | undefined;
    /** The previous forwarder's distance when it chose this node (its decision's `distance`). */
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

/**
 * Loop-safe next-hop choice for forwarding toward a gateway.
 *
 * Safety property: gateway forwarding follows a strictly decreasing non-negative hop metric. A
 * forwarder may use a route only if its distance via that route is strictly smaller than the
 * distance bound the previous forwarder used, and it hands on its own distance as the next bound.
 * Therefore a forwarding chain cannot return to a previous distance without violating route
 * eligibility, and its length is bounded by the originating node's distance.
 *
 * Also enforced: split horizon (never the direct previous hop) and fail-closed on unknown previous
 * hop or unknown bound. Equal-cost choices at one node are fine (deterministic tie-break);
 * an equal distance across a forwarding edge is not.
 *
 * Limitations: this holds for honest hop advertisements and an honestly carried bound. It does
 * not protect against nodes lying about hop counts or bounds, identity spoofing or compromised
 * gateways; those need authentication/signing. The bound must travel with the packet: a receiver
 * cannot reconstruct the previous forwarder's distance from its own state.
 */
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

/** The preferred candidate, or undefined when none is usable. Does not modify its input. */
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
