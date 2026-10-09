/**
 * Node-local record of Rideaze nodes that recently advertised cloud reachability. Separate from
 * PeerTable: a known gateway may be several hops away and is never a direct peer because of this
 * table. Gateway identities come from unauthenticated advertisements.
 *
 * Each gateway keeps independent observations keyed by (transportId, hopCount, viaNodeId): "an
 * advertisement from this gateway arrived over local transport X after h relays, handed over by
 * direct neighbour V" (V only when it was resolved through a fresh direct-link identity at receipt;
 * transport-local peer ids are never stored). A later observation on another path adds a candidate
 * rather than replacing a still-fresh one, and each ages out on its own. No route is chosen here.
 *
 * Freshness (local, monotonic clock): an observation is fresh while now - lastSeenAt < freshnessMs
 * and stale once now - lastSeenAt >= freshnessMs. No timers: reads filter by `now` without
 * mutating; observe()/prune() remove stale entries.
 */

import {
  RIDE_MESSAGE_MAX_HOP_LIMIT,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
} from './protocol/rideMessage';

/** 2.5 advertisement intervals: tolerates one or two lost advertisements. */
export const GATEWAY_OBSERVATION_DEFAULT_FRESHNESS_MS = 25_000;
export const GATEWAY_OBSERVATION_MAX_FRESHNESS_MS = 10 * 60 * 1000;
/** Local and opaque, as in PeerTable; bounds memory only. */
export const GATEWAY_STATE_MAX_TRANSPORT_ID_LENGTH = 64;
/** Bounds memory against spoofed gateway ids. */
export const GATEWAY_STATE_DEFAULT_MAX_GATEWAYS = 64;
/** Bounds distinct (transport, hopCount, via) observations per gateway. */
export const GATEWAY_STATE_DEFAULT_MAX_OBSERVATIONS_PER_GATEWAY = 16;

export interface GatewayObservation {
  readonly transportId: string;
  /** Relays the advertisement had taken when it reached this node (0 = direct from gateway). */
  readonly hopCount: number;
  readonly lastSeenAt: number;
  /** Rideaze node that directly handed this node the advertisement, when resolved at receipt.
   * Absent when the direct sender was unknown; such an observation is not routable. */
  readonly viaNodeId?: string;
}

/** A snapshot; it cannot change the state and later observations do not change it. */
export interface KnownGateway {
  readonly nodeId: string;
  readonly lastSeenAt: number;
  /** Fresh observations, sorted by hopCount, transportId, then viaNodeId (unresolved first). */
  readonly observations: readonly GatewayObservation[];
}

export type GatewayObserveResult =
  | { observed: true; change: 'new_gateway' | 'new_observation' | 'refreshed' }
  | {
      observed: false;
      reason: 'invalid' | 'local_node' | 'table_full' | 'observations_full';
    };

export interface GatewayStateOptions {
  localNodeId: string;
  freshnessMs?: number;
  maxGateways?: number;
  maxObservationsPerGateway?: number;
}

export interface GatewayState {
  /** Records one advertisement observation at local monotonic time `now`. Never throws. Never
   * moves an observation's lastSeenAt backwards. `viaNodeId` is the resolved direct sender, if
   * known; it must be a valid node id other than the local node. */
  observe(
    gatewayNodeId: string,
    transportId: string,
    hopCount: number,
    now: number,
    viaNodeId?: string,
  ): GatewayObserveResult;
  getGateway(gatewayNodeId: string, now: number): KnownGateway | undefined;
  /** All gateways with a fresh observation at `now`, sorted by nodeId. */
  getGateways(now: number): readonly KnownGateway[];
  isKnownGateway(gatewayNodeId: string, now: number): boolean;
  prune(now: number): void;
}

interface StoredObservation {
  transportId: string;
  hopCount: number;
  lastSeenAt: number;
  viaNodeId?: string;
}

function compareObservations(a: GatewayObservation, b: GatewayObservation): number {
  if (a.hopCount !== b.hopCount) {
    return a.hopCount - b.hopCount;
  }
  if (a.transportId !== b.transportId) {
    return a.transportId < b.transportId ? -1 : 1;
  }
  const av = a.viaNodeId ?? '';
  const bv = b.viaNodeId ?? '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function createGatewayState({
  localNodeId,
  freshnessMs = GATEWAY_OBSERVATION_DEFAULT_FRESHNESS_MS,
  maxGateways = GATEWAY_STATE_DEFAULT_MAX_GATEWAYS,
  maxObservationsPerGateway = GATEWAY_STATE_DEFAULT_MAX_OBSERVATIONS_PER_GATEWAY,
}: GatewayStateOptions): GatewayState {
  if (!isValidRideMessageIdentifier(localNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH)) {
    throw new TypeError('GatewayState localNodeId must be a valid RideMessage originId');
  }
  if (!isPositiveInteger(freshnessMs) || freshnessMs > GATEWAY_OBSERVATION_MAX_FRESHNESS_MS) {
    throw new RangeError(
      `GatewayState freshnessMs must be an integer in (0, ${GATEWAY_OBSERVATION_MAX_FRESHNESS_MS}]`,
    );
  }
  if (!isPositiveInteger(maxGateways) || !isPositiveInteger(maxObservationsPerGateway)) {
    throw new RangeError('GatewayState limits must be positive integers');
  }

  // gatewayNodeId -> (observation key -> observation). Never handed out.
  const gateways = new Map<string, Map<string, StoredObservation>>();

  const isFresh = (lastSeenAt: number, now: number) => now - lastSeenAt < freshnessMs;
  // JSON keeps the key unambiguous for any id content; an unresolved sender is its own key.
  const keyOf = (transportId: string, hopCount: number, viaNodeId: string | undefined) =>
    JSON.stringify([transportId, hopCount, viaNodeId ?? null]);

  const prune = (now: number): void => {
    for (const [nodeId, observations] of gateways) {
      for (const [key, o] of observations) {
        if (!isFresh(o.lastSeenAt, now)) {
          observations.delete(key);
        }
      }
      if (observations.size === 0) {
        gateways.delete(nodeId);
      }
    }
  };

  const snapshot = (
    nodeId: string,
    observations: Map<string, StoredObservation>,
    now: number,
  ): KnownGateway | undefined => {
    const fresh: GatewayObservation[] = [];
    let lastSeenAt = -Infinity;
    for (const o of observations.values()) {
      if (isFresh(o.lastSeenAt, now)) {
        fresh.push(Object.freeze({ ...o }));
        lastSeenAt = Math.max(lastSeenAt, o.lastSeenAt);
      }
    }
    if (fresh.length === 0) {
      return undefined;
    }
    fresh.sort(compareObservations);
    return Object.freeze({ nodeId, lastSeenAt, observations: Object.freeze(fresh) });
  };

  const getGateway = (gatewayNodeId: string, now: number): KnownGateway | undefined => {
    if (!isValidRideMessageTimestamp(now)) {
      return undefined;
    }
    const observations = gateways.get(gatewayNodeId);
    return observations && snapshot(gatewayNodeId, observations, now);
  };

  return {
    observe(gatewayNodeId, transportId, hopCount, now, viaNodeId): GatewayObserveResult {
      if (
        !isValidRideMessageIdentifier(gatewayNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH) ||
        !isValidRideMessageIdentifier(transportId, GATEWAY_STATE_MAX_TRANSPORT_ID_LENGTH) ||
        !Number.isSafeInteger(hopCount) ||
        hopCount < 0 ||
        hopCount > RIDE_MESSAGE_MAX_HOP_LIMIT ||
        !isValidRideMessageTimestamp(now) ||
        (viaNodeId !== undefined &&
          (!isValidRideMessageIdentifier(viaNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH) ||
            viaNodeId === localNodeId))
      ) {
        return { observed: false, reason: 'invalid' };
      }
      if (gatewayNodeId === localNodeId) {
        return { observed: false, reason: 'local_node' };
      }

      prune(now);

      let observations = gateways.get(gatewayNodeId);
      const isNewGateway = observations === undefined;
      if (!observations) {
        if (gateways.size >= maxGateways) {
          // Refuse rather than evict, so gateways that keep advertising cannot be displaced.
          return { observed: false, reason: 'table_full' };
        }
        observations = new Map();
      }

      const key = keyOf(transportId, hopCount, viaNodeId);
      const existing = observations.get(key);
      if (existing) {
        existing.lastSeenAt = Math.max(existing.lastSeenAt, now);
        return { observed: true, change: 'refreshed' };
      }
      if (observations.size >= maxObservationsPerGateway) {
        return { observed: false, reason: 'observations_full' };
      }
      observations.set(
        key,
        viaNodeId === undefined
          ? { transportId, hopCount, lastSeenAt: now }
          : { transportId, hopCount, lastSeenAt: now, viaNodeId },
      );
      if (isNewGateway) {
        gateways.set(gatewayNodeId, observations);
        return { observed: true, change: 'new_gateway' };
      }
      return { observed: true, change: 'new_observation' };
    },

    getGateway,

    getGateways(now): readonly KnownGateway[] {
      if (!isValidRideMessageTimestamp(now)) {
        return Object.freeze([]);
      }
      const result: KnownGateway[] = [];
      for (const [nodeId, observations] of gateways) {
        const gateway = snapshot(nodeId, observations, now);
        if (gateway) {
          result.push(gateway);
        }
      }
      result.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
      return Object.freeze(result);
    },

    isKnownGateway(gatewayNodeId, now): boolean {
      return getGateway(gatewayNodeId, now) !== undefined;
    },

    prune(now): void {
      if (isValidRideMessageTimestamp(now)) {
        prune(now);
      }
    },
  };
}
