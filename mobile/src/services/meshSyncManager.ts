import { nearestUnvisited } from '../utils/geoMath';
import { HazardSyncQueue, RECONNECT_FLUSH_SPACING_MS } from './hazardSyncQueue';
import {
  HAZARD_PACKET_MAX_TTL,
  TELEMETRY_PACKET_MAX_TTL,
  type GeoPoint,
  type HazardEventPacket,
  type MeshHazardKind,
  type MeshPacket,
  type RiderNode,
  type TelemetryPingPacket,
} from '../types/telemetry';

/**
 * Drives the offline mesh-sync protocol (telemetry pings, hazard relay, reconnect catch-up) on
 * top of the existing NearbyMeshService transport. This module never talks to NativeModules
 * itself -- `send` is the caller's nearbyMeshService.sendMeshPacket, and `handlePacket` is meant
 * to be fed every packet nearbyMeshService.onMeshPacket delivers -- so it can be driven by a fake
 * in tests exactly like hazardSyncQueue and geoMath already are.
 */

/** How often this device broadcasts its own position while the mesh is active. */
export const TELEMETRY_PING_INTERVAL_MS = 15 * 1000;//3 * 60 * 1000

export function createHazardEventPacket(
  hazardType: MeshHazardKind,
  riderId: string,
  riderName: string,
  location: GeoPoint,
  now: number = Date.now(),
): HazardEventPacket {
  return {
    type: 'HAZARD_EVENT',
    hazardId: `${riderId}-${now}-${hazardType}`,
    originRiderId: riderId,
    riderName,
    senderId: riderId,
    hazardType,
    latitude: location.latitude,
    longitude: location.longitude,
    visitedNodes: [riderId],
    ttl: HAZARD_PACKET_MAX_TTL,
    timestamp: now,
  };
}

/**
 * Whether some rider this device currently knows a position for still hasn't seen a packet that
 * has already passed through `visitedNodes` -- the nearest unvisited rider to `origin`, from
 * geoMath. Shared by both the hazard and telemetry relay gates below: a device deep in a cluster
 * that has already fully relayed something stops repeating it once nobody left still needs it.
 *
 * NearbyMeshModule's native bridge only exposes broadcastHazard-to-everyone, not a targeted send
 * to a single peer -- so this can only gate *whether* to relay at all, not pick a specific next
 * hop the way a true point-to-point mesh would. That gate is still real work: without it, every
 * device in a cluster would keep re-flooding something for its full TTL even after everyone who
 * could possibly want it already has it.
 */
function hasUnvisitedRecipient(
  origin: GeoPoint,
  visitedNodes: readonly string[],
  selfRiderId: string,
  knownRiders: readonly RiderNode[],
): boolean {
  if (visitedNodes.includes(selfRiderId)) {
    return false;
  }
  const visited = new Set(visitedNodes);
  return nearestUnvisited(origin, knownRiders, visited, rider => rider.riderId) !== null;
}

/** Whether `hazard` is still worth relaying: never once its ttl is spent, otherwise per
 * hasUnvisitedRecipient above. */
export function shouldRelay(
  hazard: HazardEventPacket,
  selfRiderId: string,
  knownRiders: readonly RiderNode[],
): boolean {
  if (hazard.ttl <= 0) {
    return false;
  }
  return hasUnvisitedRecipient(hazard, hazard.visitedNodes, selfRiderId, knownRiders);
}

/** A mesh with more known riders than this makes blanket telemetry relay expensive (every rider's
 * duty-cycle ping, potentially relayed several hops, several times a minute) -- past this size,
 * third-party relay is restricted to TELEMETRY_HIGH_DENSITY_MIN_RELAY_TTL (own-position
 * broadcasts are never throttled; see sendPing). */
export const TELEMETRY_HIGH_DENSITY_RIDER_THRESHOLD = 15;

/** In a high-density mesh, a telemetry ping is only relayed while its ttl is still at or above
 * this -- a shallower depth than TELEMETRY_PACKET_MAX_TTL allows the rest of the time, not
 * necessarily down to one hop; the gap between the two numbers is exactly how much further relay
 * gets cut back once the mesh crosses TELEMETRY_HIGH_DENSITY_RIDER_THRESHOLD. */
export const TELEMETRY_HIGH_DENSITY_MIN_RELAY_TTL = 3;

/** Whether `ping` (someone else's position, already received) is still worth relaying onward. */
export function shouldRelayTelemetry(
  ping: TelemetryPingPacket,
  selfRiderId: string,
  knownRiders: readonly RiderNode[],
): boolean {
  if (ping.ttl <= 0) {
    return false;
  }
  if (
    knownRiders.length > TELEMETRY_HIGH_DENSITY_RIDER_THRESHOLD &&
    ping.ttl < TELEMETRY_HIGH_DENSITY_MIN_RELAY_TTL
  ) {
    return false;
  }
  return hasUnvisitedRecipient(ping, ping.visitedNodes, selfRiderId, knownRiders);
}

export interface MeshSyncManagerOptions {
  selfRiderId: string;
  /** This device's display name, carried on every packet it sends so a receiver never has to
   * show the meaningless random `selfRiderId` token on screen. */
  selfRiderName: string;
  /** Sends a packet to every connected peer -- pass nearbyMeshService.sendMeshPacket. */
  send: (packet: MeshPacket) => void;
  /** This device's current GPS fix, or null when none is available yet -- a ping is skipped
   * rather than sent with stale or zeroed coordinates. */
  getLocation: () => GeoPoint | null;
  onRidersChanged?: (riders: RiderNode[]) => void;
  onHazardReceived?: (hazard: HazardEventPacket) => void;
  now?: () => number;
  pingIntervalMs?: number;
  reconnectFlushSpacingMs?: number;
}

export interface MeshSyncManager {
  /** Starts the telemetry duty cycle: one ping right away, then one every pingIntervalMs. */
  start(): void;
  /** Stops the duty cycle and any reconnect flushes in progress. */
  stop(): void;
  /** Feeds a packet received from nearbyMeshService.onMeshPacket. */
  handlePacket(packet: MeshPacket): void;
  /** Call on every nearbyMeshService.onPeerCountChanged push, so a 0 -> positive transition (this
   * device regaining mesh connectivity) announces itself with a SYNC_REQUEST. There is no
   * per-peer identity in that event, so this is how a reconnect is detected without any native
   * code changes to NearbyMeshModule. */
  handlePeerCountChanged(peerCount: number): void;
  /** Raises a hazard immediately, bypassing the telemetry timer -- adds it to this device's own
   * queue first (so it is never re-admitted as new if a copy bounces back) and sends it right
   * away. */
  raiseHazard(hazardType: MeshHazardKind, location: GeoPoint): void;
  /** Every rider this device currently has a position for. */
  getKnownRiders(): RiderNode[];
  /** The hazard backlog this device knows about -- for feeding a UI list independent of the map. */
  getHazardQueue(): HazardSyncQueue;
}

export function createMeshSyncManager(options: MeshSyncManagerOptions): MeshSyncManager {
  const {
    selfRiderId,
    selfRiderName,
    send,
    getLocation,
    onRidersChanged,
    onHazardReceived,
    now = Date.now,
    pingIntervalMs = TELEMETRY_PING_INTERVAL_MS,
    reconnectFlushSpacingMs = RECONNECT_FLUSH_SPACING_MS,
  } = options;

  const hazardQueue = new HazardSyncQueue(now);
  const knownRiders = new Map<string, RiderNode>();
  const flushTimers = new Map<string, ReturnType<typeof setInterval>>();

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let lastPeerCount = 0;

  // Dedup for telemetry relay only (not for rider positions themselves -- upsertRiderPosition's
  // own newer-timestamp check already makes applying a duplicate ping harmless). Without this, a
  // ping arriving back via two different relay paths would be re-relayed twice, and a ping that
  // bounces back to its own origin would never be recognised as "already seen". Pruned lazily by
  // age on every check, the same way HazardSyncQueue prunes its own backlog -- no separate timer
  // needed to keep this bounded.
  const seenPingIds = new Map<string, number>();
  const SEEN_PING_RETENTION_MS = 2 * 60 * 1000;

  function rememberPingOnce(pingId: string): boolean {
    const nowMs = now();
    for (const [id, seenAt] of seenPingIds) {
      if (nowMs - seenAt > SEEN_PING_RETENTION_MS) {
        seenPingIds.delete(id);
      }
    }
    if (seenPingIds.has(pingId)) {
      return false;
    }
    seenPingIds.set(pingId, nowMs);
    return true;
  }

  function sendPing(): void {
    const location = getLocation();
    if (!location) {
      return;
    }
    const timestamp = now();
    const packet: TelemetryPingPacket = {
      type: 'TELEMETRY_PING',
      pingId: `${selfRiderId}-${timestamp}`,
      riderId: selfRiderId,
      riderName: selfRiderName,
      latitude: location.latitude,
      longitude: location.longitude,
      timestamp,
      ttl: TELEMETRY_PACKET_MAX_TTL,
      senderId: selfRiderId,
      visitedNodes: [selfRiderId],
    };
    // Own-position broadcasts are never throttled, high-density mesh or not -- a rider must never
    // disappear from their immediate neighbours' maps. Remembered before sending so a copy that
    // bounces back (relayed by a neighbour who's also connected to us) is recognised as already
    // seen rather than re-processed as a new fix for ourselves.
    rememberPingOnce(packet.pingId);
    send(packet);
  }

  /** Upserts a rider's known position, whether it came from a TELEMETRY_PING or from the GPS fix
   * riding along on a HAZARD_EVENT -- either way it's a real, timestamped fix for that rider, and
   * the map should show whichever one is newest. Never regresses a rider to an older position.
   * `riderName` falls back to whatever name is already on record rather than blanking it out, in
   * case a future packet shape ever omits it. */
  function upsertRiderPosition(
    riderId: string,
    riderName: string | undefined,
    latitude: number,
    longitude: number,
    timestampMs: number,
  ): void {
    const existing = knownRiders.get(riderId);
    if (existing && timestampMs <= existing.timestampMs) {
      return; // stale or duplicate
    }
    knownRiders.set(riderId, { riderId, riderName: riderName || existing?.riderName, latitude, longitude, timestampMs });
    onRidersChanged?.([...knownRiders.values()]);
  }

  function relayTelemetryIfNeeded(ping: TelemetryPingPacket): void {
    if (!shouldRelayTelemetry(ping, selfRiderId, [...knownRiders.values()])) {
      return;
    }
    send({
      ...ping,
      senderId: selfRiderId,
      ttl: ping.ttl - 1,
      visitedNodes: [...ping.visitedNodes, selfRiderId],
    });
  }

  function handleTelemetryPing(packet: Extract<MeshPacket, { type: 'TELEMETRY_PING' }>): void {
    if (!rememberPingOnce(packet.pingId)) {
      return; // already processed this exact fix, whether via another relay path or our own echo
    }
    upsertRiderPosition(packet.riderId, packet.riderName, packet.latitude, packet.longitude, packet.timestamp);
    relayTelemetryIfNeeded(packet);
  }

  function relayIfNeeded(hazard: HazardEventPacket): void {
    if (!shouldRelay(hazard, selfRiderId, [...knownRiders.values()])) {
      return;
    }
    send({
      ...hazard,
      senderId: selfRiderId,
      ttl: hazard.ttl - 1,
      visitedNodes: [...hazard.visitedNodes, selfRiderId],
    });
  }

  function handleHazardEvent(hazard: HazardEventPacket): void {
    if (!hazardQueue.add(hazard)) {
      return; // already seen (including a self-raised one bouncing back), or expired on arrival
    }
    // The hazard's own lat/lng is a real GPS fix for whoever raised it, often fresher than their
    // last 3-minute ping -- the map should move that rider there too, not just log the hazard.
    upsertRiderPosition(hazard.originRiderId, hazard.riderName, hazard.latitude, hazard.longitude, hazard.timestamp);
    onHazardReceived?.(hazard);
    relayIfNeeded(hazard);
  }

  function stopFlush(peerId: string): void {
    const timer = flushTimers.get(peerId);
    if (timer) {
      clearInterval(timer);
      flushTimers.delete(peerId);
    }
  }

  function flushNext(peerId: string): void {
    const next = hazardQueue.popNextForPeer(peerId);
    if (!next) {
      stopFlush(peerId);
      return;
    }
    send({ type: 'SYNC_RESPONSE', pendingHazards: [next] });
  }

  function handleSyncRequest(packet: Extract<MeshPacket, { type: 'SYNC_REQUEST' }>): void {
    if (packet.riderId === selfRiderId) {
      return;
    }
    // Whatever the requester already had as of their own last-known hazard is assumed theirs --
    // popNextForPeer below then only ever offers what happened after that.
    for (const hazard of hazardQueue.active()) {
      if (hazard.timestamp <= packet.lastKnownHazardTimestamp) {
        hazardQueue.markReceivedBy(hazard.hazardId, packet.riderId);
      }
    }
    stopFlush(packet.riderId); // restart clean in case a stale flush for them was still running
    flushNext(packet.riderId);
    if (hazardQueue.pendingCountForPeer(packet.riderId) > 0) {
      flushTimers.set(packet.riderId, setInterval(() => flushNext(packet.riderId), reconnectFlushSpacingMs));
    }
  }

  function handleSyncResponse(packet: Extract<MeshPacket, { type: 'SYNC_RESPONSE' }>): void {
    for (const hazard of packet.pendingHazards) {
      handleHazardEvent(hazard);
    }
  }

  return {
    start() {
      sendPing();
      pingTimer = setInterval(sendPing, pingIntervalMs);
    },
    stop() {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      for (const peerId of [...flushTimers.keys()]) {
        stopFlush(peerId);
      }
    },
    handlePacket(packet: MeshPacket) {
      switch (packet.type) {
        case 'TELEMETRY_PING':
          handleTelemetryPing(packet);
          break;
        case 'HAZARD_EVENT':
          handleHazardEvent(packet);
          break;
        case 'SYNC_REQUEST':
          handleSyncRequest(packet);
          break;
        case 'SYNC_RESPONSE':
          handleSyncResponse(packet);
          break;
      }
    },
    handlePeerCountChanged(peerCount: number) {
      const reconnected = lastPeerCount === 0 && peerCount > 0;
      lastPeerCount = peerCount;
      if (!reconnected) {
        return;
      }
      const active = hazardQueue.active(); // newest first
      const lastKnownHazardTimestamp = active.length > 0 ? active[0].timestamp : 0;
      send({ type: 'SYNC_REQUEST', riderId: selfRiderId, lastKnownHazardTimestamp });
    },
    raiseHazard(hazardType: MeshHazardKind, location: GeoPoint) {
      const packet = createHazardEventPacket(hazardType, selfRiderId, selfRiderName, location, now());
      hazardQueue.add(packet);
      send(packet);
    },
    getKnownRiders() {
      return [...knownRiders.values()];
    },
    getHazardQueue() {
      return hazardQueue;
    },
  };
}
