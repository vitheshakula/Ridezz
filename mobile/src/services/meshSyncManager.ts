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

export const TELEMETRY_PING_INTERVAL_MS = 15 * 1000;

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

export const TELEMETRY_HIGH_DENSITY_RIDER_THRESHOLD = 15;

export const TELEMETRY_HIGH_DENSITY_MIN_RELAY_TTL = 3;

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
  selfRiderName: string;
  send: (packet: MeshPacket) => void;
  getLocation: () => GeoPoint | null;
  onRidersChanged?: (riders: RiderNode[]) => void;
  onHazardReceived?: (hazard: HazardEventPacket) => void;
  now?: () => number;
  pingIntervalMs?: number;
  reconnectFlushSpacingMs?: number;
}

export interface MeshSyncManager {
  start(): void;
  stop(): void;
  handlePacket(packet: MeshPacket): void;
  handlePeerCountChanged(peerCount: number): void;
  raiseHazard(hazardType: MeshHazardKind, location: GeoPoint): void;
  getKnownRiders(): RiderNode[];
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
    rememberPingOnce(packet.pingId);
    send(packet);
  }

  function upsertRiderPosition(
    riderId: string,
    riderName: string | undefined,
    latitude: number,
    longitude: number,
    timestampMs: number,
  ): void {
    const existing = knownRiders.get(riderId);
    if (existing && timestampMs <= existing.timestampMs) {
      return;
    }
    knownRiders.set(riderId, {
      riderId,
      riderName: riderName || existing?.riderName,
      latitude,
      longitude,
      timestampMs,
    });
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
      return;
    }
    upsertRiderPosition(
      packet.riderId,
      packet.riderName,
      packet.latitude,
      packet.longitude,
      packet.timestamp,
    );
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
      return;
    }
    upsertRiderPosition(
      hazard.originRiderId,
      hazard.riderName,
      hazard.latitude,
      hazard.longitude,
      hazard.timestamp,
    );
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
    for (const hazard of hazardQueue.active()) {
      if (hazard.timestamp <= packet.lastKnownHazardTimestamp) {
        hazardQueue.markReceivedBy(hazard.hazardId, packet.riderId);
      }
    }
    stopFlush(packet.riderId);
    flushNext(packet.riderId);
    if (hazardQueue.pendingCountForPeer(packet.riderId) > 0) {
      flushTimers.set(
        packet.riderId,
        setInterval(() => flushNext(packet.riderId), reconnectFlushSpacingMs),
      );
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
      const active = hazardQueue.active();
      const lastKnownHazardTimestamp = active.length > 0 ? active[0].timestamp : 0;
      send({ type: 'SYNC_REQUEST', riderId: selfRiderId, lastKnownHazardTimestamp });
    },
    raiseHazard(hazardType: MeshHazardKind, location: GeoPoint) {
      const packet = createHazardEventPacket(
        hazardType,
        selfRiderId,
        selfRiderName,
        location,
        now(),
      );
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
