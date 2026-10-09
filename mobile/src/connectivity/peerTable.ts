/**
 * Node-local table of DIRECT neighbours: Rideaze nodes this device has itself observed over a
 * local transport recently. Nodes known only through what other peers report (remote topology,
 * gateways, routes) never belong here; the only way in is observe(), a direct observation.
 *
 * Peer identity is transport-observed and unverified: a node id is whatever a transport or packet
 * claimed. It must not be treated as authenticated until peer authentication exists.
 *
 * Freshness: an observation is fresh while now - lastSeenAt < freshnessMs and stale once
 * now - lastSeenAt >= freshnessMs. This is local observation age, unrelated to RideMessage TTL.
 * Timestamps should all come from one local clock; a monotonic clock is preferable, since nothing
 * here is compared across devices. There are no timers: reads filter by the `now` they are given
 * without mutating, and observe()/prune() physically remove stale entries.
 */

import {
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
} from './protocol/rideMessage';

/** Tolerates two or three missed presence signals at an expected interval of 5 s or less. */
export const PEER_OBSERVATION_DEFAULT_FRESHNESS_MS = 15_000;
/** Upper bound on configurable freshness; an older sighting says nothing about direct reach. */
export const PEER_OBSERVATION_MAX_FRESHNESS_MS = 10 * 60 * 1000;
/** Transport ids are local and opaque; this only bounds memory and catches misuse. */
export const PEER_TABLE_MAX_TRANSPORT_ID_LENGTH = 64;
/** Direct neighbours held at once. Bounds memory against spoofed node ids. */
export const PEER_TABLE_DEFAULT_MAX_PEERS = 128;

export interface PeerObservation {
  readonly transportId: string;
  readonly lastSeenAt: number;
}

/** A snapshot. Later observations do not change it, and it cannot change the table. */
export interface DirectPeer {
  readonly nodeId: string;
  /** Most recent fresh observation over any transport. */
  readonly lastSeenAt: number;
  /** Fresh observations, one per transport, sorted by transportId. */
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
  /** Records "at `now` this device directly observed `nodeId` through `transportId`". Never
   * throws. Never moves an observation's lastSeenAt backwards. */
  observe(nodeId: string, transportId: string, now: number): PeerObserveResult;
  /** The peer if it has at least one fresh observation at `now`. */
  getPeer(nodeId: string, now: number): DirectPeer | undefined;
  /** All peers with a fresh observation at `now`, sorted by nodeId. */
  getPeers(now: number): readonly DirectPeer[];
  isDirectPeer(nodeId: string, now: number): boolean;
  /** Removes stale observations, and peers left with none. Ignored for an invalid `now`. */
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

  // nodeId -> (transportId -> lastSeenAt). Never handed out.
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
          // Refuse rather than evict: peers that keep being observed cannot be displaced by a
          // flood of new (possibly spoofed) ids.
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
