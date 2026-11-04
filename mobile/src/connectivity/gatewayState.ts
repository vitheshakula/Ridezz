import {
  RIDE_MESSAGE_MAX_HOP_LIMIT,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
} from './protocol/rideMessage';

export const GATEWAY_OBSERVATION_DEFAULT_FRESHNESS_MS = 25_000;
export const GATEWAY_OBSERVATION_MAX_FRESHNESS_MS = 10 * 60 * 1000;
export const GATEWAY_STATE_MAX_TRANSPORT_ID_LENGTH = 64;
export const GATEWAY_STATE_DEFAULT_MAX_GATEWAYS = 64;
export const GATEWAY_STATE_DEFAULT_MAX_OBSERVATIONS_PER_GATEWAY = 16;

export interface GatewayObservation {
  readonly transportId: string;
  readonly hopCount: number;
  readonly lastSeenAt: number;
  readonly viaNodeId?: string;
}

export interface KnownGateway {
  readonly nodeId: string;
  readonly lastSeenAt: number;
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
  observe(
    gatewayNodeId: string,
    transportId: string,
    hopCount: number,
    now: number,
    viaNodeId?: string,
  ): GatewayObserveResult;
  getGateway(gatewayNodeId: string, now: number): KnownGateway | undefined;
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

  const gateways = new Map<string, Map<string, StoredObservation>>();

  const isFresh = (lastSeenAt: number, now: number) => now - lastSeenAt < freshnessMs;
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
