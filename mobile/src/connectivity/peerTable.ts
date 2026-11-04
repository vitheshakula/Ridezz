import {
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
} from './protocol/rideMessage';

export const PEER_OBSERVATION_DEFAULT_FRESHNESS_MS = 15_000;
export const PEER_OBSERVATION_MAX_FRESHNESS_MS = 10 * 60 * 1000;
export const PEER_TABLE_MAX_TRANSPORT_ID_LENGTH = 64;
export const PEER_TABLE_DEFAULT_MAX_PEERS = 128;

export interface PeerObservation {
  readonly transportId: string;
  readonly lastSeenAt: number;
}

export interface DirectPeer {
  readonly nodeId: string;
  readonly lastSeenAt: number;
  readonly transports: readonly PeerObservation[];
}

export type PeerObserveResult =
  | { observed: true; change: 'new_peer' | 'new_transport' | 'refreshed' }
  | { observed: false; reason: 'invalid' | 'local_node' | 'table_full' };

export interface PeerTableOptions {
  localNodeId: string;
  freshnessMs?: number;
  maxPeers?: number;
}

export interface PeerTable {
  observe(nodeId: string, transportId: string, now: number): PeerObserveResult;
  getPeer(nodeId: string, now: number): DirectPeer | undefined;
  getPeers(now: number): readonly DirectPeer[];
  isDirectPeer(nodeId: string, now: number): boolean;
  prune(now: number): void;
}

function isValidNodeId(value: unknown): value is string {
  return isValidRideMessageIdentifier(value, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH);
}

function isValidTransportId(value: unknown): value is string {
  return isValidRideMessageIdentifier(value, PEER_TABLE_MAX_TRANSPORT_ID_LENGTH);
}

export function createPeerTable({
  localNodeId,
  freshnessMs = PEER_OBSERVATION_DEFAULT_FRESHNESS_MS,
  maxPeers = PEER_TABLE_DEFAULT_MAX_PEERS,
}: PeerTableOptions): PeerTable {
  if (!isValidNodeId(localNodeId)) {
    throw new TypeError('PeerTable localNodeId must be a valid RideMessage originId');
  }
  if (
    !Number.isSafeInteger(freshnessMs) ||
    freshnessMs <= 0 ||
    freshnessMs > PEER_OBSERVATION_MAX_FRESHNESS_MS
  ) {
    throw new RangeError(
      `PeerTable freshnessMs must be an integer in (0, ${PEER_OBSERVATION_MAX_FRESHNESS_MS}]`,
    );
  }
  if (!Number.isSafeInteger(maxPeers) || maxPeers < 1) {
    throw new RangeError('PeerTable maxPeers must be a positive integer');
  }

  const peers = new Map<string, Map<string, number>>();

  const isFresh = (lastSeenAt: number, now: number) => now - lastSeenAt < freshnessMs;

  const snapshot = (
    nodeId: string,
    observations: Map<string, number>,
    now: number,
  ): DirectPeer | undefined => {
    const transports: PeerObservation[] = [];
    let lastSeenAt = -Infinity;
    for (const [transportId, seenAt] of observations) {
      if (isFresh(seenAt, now)) {
        transports.push(Object.freeze({ transportId, lastSeenAt: seenAt }));
        lastSeenAt = Math.max(lastSeenAt, seenAt);
      }
    }
    if (transports.length === 0) {
      return undefined;
    }
    transports.sort((a, b) => (a.transportId < b.transportId ? -1 : 1));
    return Object.freeze({ nodeId, lastSeenAt, transports: Object.freeze(transports) });
  };

  const prune = (now: number): void => {
    for (const [nodeId, observations] of peers) {
      for (const [transportId, seenAt] of observations) {
        if (!isFresh(seenAt, now)) {
          observations.delete(transportId);
        }
      }
      if (observations.size === 0) {
        peers.delete(nodeId);
      }
    }
  };

  const getPeer = (nodeId: string, now: number): DirectPeer | undefined => {
    if (!isValidRideMessageTimestamp(now)) {
      return undefined;
    }
    const observations = peers.get(nodeId);
    return observations && snapshot(nodeId, observations, now);
  };

  return {
    observe(nodeId, transportId, now): PeerObserveResult {
      if (
        !isValidNodeId(nodeId) ||
        !isValidTransportId(transportId) ||
        !isValidRideMessageTimestamp(now)
      ) {
        return { observed: false, reason: 'invalid' };
      }
      if (nodeId === localNodeId) {
        return { observed: false, reason: 'local_node' };
      }

      prune(now);

      let observations = peers.get(nodeId);
      const isNewPeer = observations === undefined;
      if (!observations) {
        if (peers.size >= maxPeers) {
          return { observed: false, reason: 'table_full' };
        }
        observations = new Map();
        peers.set(nodeId, observations);
      }

      const previous = observations.get(transportId);
      observations.set(transportId, previous === undefined ? now : Math.max(previous, now));
      if (isNewPeer) {
        return { observed: true, change: 'new_peer' };
      }
      return { observed: true, change: previous === undefined ? 'new_transport' : 'refreshed' };
    },

    getPeer,

    getPeers(now): readonly DirectPeer[] {
      if (!isValidRideMessageTimestamp(now)) {
        return Object.freeze([]);
      }
      const result: DirectPeer[] = [];
      for (const [nodeId, observations] of peers) {
        const peer = snapshot(nodeId, observations, now);
        if (peer) {
          result.push(peer);
        }
      }
      result.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
      return Object.freeze(result);
    },

    isDirectPeer(nodeId, now): boolean {
      return getPeer(nodeId, now) !== undefined;
    },

    prune(now): void {
      if (isValidRideMessageTimestamp(now)) {
        prune(now);
      }
    },
  };
}
