/**
 * Shared types for the offline mesh-sync subsystem: rider telemetry (position) and hazard relay,
 * carried over the existing Nearby Connections bridge (NearbyMeshModule / NearbyMeshService).
 *
 * This is a standalone subsystem, separate from the LiveKit-based location sharing
 * (useRiderLocations.ts / RiderLocation) and the existing voice-hazard system
 * (SpeechHazardService.ts) -- both of which also run over the cloud room or the same Nearby link.
 * It exists for when a rider has no cellular data at all: NearbyMeshService's native side already
 * forwards any opaque JSON string to every connected peer, so these packets ride the exact same
 * wire as the voice-hazard ones, distinguished only by carrying a `type` field the voice-hazard
 * packets don't have (see NearbyMeshService's isMeshPacket-gated listener).
 */

/** The hazard kinds this subsystem relays. Deliberately a plain string union, not imported from
 * SpeechHazardService's HazardType: that module's hazards are spoken-word triggers for the voice
 * system, this one is a fixed small set for the offline relay. The string values are the same
 * where they overlap, so merging the two systems later is just a type change. */
export type MeshHazardKind = 'pothole' | 'accident' | 'obstacle';

export const MESH_HAZARD_KINDS: readonly MeshHazardKind[] = ['pothole', 'accident', 'obstacle'];

export function isMeshHazardKind(value: unknown): value is MeshHazardKind {
  return typeof value === 'string' && (MESH_HAZARD_KINDS as readonly string[]).includes(value);
}

/** A rider's position as held in local state, fed by TelemetryPingPacket (and, incidentally, by
 * any HAZARD_EVENT that rider raised -- see meshSyncManager's upsertRiderPosition). */
export interface RiderNode {
  riderId: string;
  /** Display name, when the sender included one -- always true for a packet from this build, but
   * kept optional for a packet from an older build that predates this field. Never fall back to
   * showing `riderId` itself for a missing name: it's a random per-session token, not an
   * identity anyone should see on screen. */
  riderName?: string;
  latitude: number;
  longitude: number;
  /** Epoch ms of the fix this position came from. */
  timestampMs: number;
  /** 0-100, when the sender reported one. */
  batteryPercent?: number;
  /** Set when the sender flagged themselves (e.g. an active hazard nearby). */
  flagged?: boolean;
}

/** A {latitude, longitude} pair, satisfied by RiderNode and by a plain GPS fix alike -- the shape
 * geoMath.ts actually needs, so its functions aren't coupled to RiderNode. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

// ---------------------------------------------------------------------------
// Wire packet types (carried as JSON over NearbyMeshService.sendMeshPacket / onMeshPacket)
// ---------------------------------------------------------------------------

/**
 * Broadcast on the 3-minute duty cycle (and immediately on first connect) so every connected
 * peer's rider map stays current. Relayed hop-to-hop the same way a HAZARD_EVENT is -- `pingId`
 * identifies this specific fix (one per time a rider's position is sent) so a device that already
 * processed it can recognise a copy arriving by another path and drop it; `senderId` is whoever is
 * relaying this particular copy (changes every hop); `visitedNodes` lists every rider id the
 * packet has already passed through, origin (`riderId`) included.
 */
export interface TelemetryPingPacket {
  type: 'TELEMETRY_PING';
  pingId: string;
  riderId: string;
  riderName: string;
  latitude: number;
  longitude: number;
  timestamp: number;
  /** Decrements by 1 each hop; a packet with ttl 0 is not relayed further. Starts at
   * TELEMETRY_PACKET_MAX_TTL -- sized to the app's own MAX_RIDERS-10 "reliable map" tier (see
   * riderPresence.ts), not the full room cap: a position is only useful while fresh, so this is
   * tuned to "covers a worst-case straight-line chain of 10 riders" (9 hops between the two end
   * riders) rather than paying relay traffic to chase full-room reach the way hazards do. */
  ttl: number;
  senderId: string;
  visitedNodes: string[];
}

export const TELEMETRY_PACKET_MAX_TTL = 9;

/**
 * A hazard report as it is relayed over the mesh.
 *
 * `hazardId` identifies this specific report (one per time someone raises a hazard), so a device
 * that already handled it can recognise a copy arriving by another path and drop it (see
 * hazardSyncQueue's hasSeen). `originRiderId` is who first reported it; `senderId` is whoever is
 * broadcasting this particular copy, which changes at each hop. `visitedNodes` lists every rider
 * id the packet has already passed through (the origin included), so relay logic can tell who
 * still needs it. `riderName` is always the ORIGIN's display name (not the current sender/relay
 * hop's) -- a hazard raised by Alex and relayed by Bilal should still say "Alex" everywhere.
 */
export interface HazardEventPacket {
  type: 'HAZARD_EVENT';
  hazardId: string;
  originRiderId: string;
  riderName: string;
  senderId: string;
  hazardType: MeshHazardKind;
  latitude: number;
  longitude: number;
  visitedNodes: string[];
  /** Decrements by 1 each hop; a packet with ttl 0 is not relayed further. Starts at
   * HAZARD_PACKET_MAX_TTL -- sized to cover a worst-case straight-line chain of MAX_RIDERS riders
   * (see riderPresence.ts): the two end riders of a full room are MAX_RIDERS-1 hops apart, and a
   * hazard, unlike a position, is worth that relay cost since it's rare and never repeats. */
  ttl: number;
  timestamp: number;
}

export const HAZARD_PACKET_MAX_TTL = 24;

/** Broadcast by a device that just regained mesh connectivity (a 0 -> positive peer-count
 * transition), announcing what it already knows so others can flush what it's missing. */
export interface SyncRequestPacket {
  type: 'SYNC_REQUEST';
  riderId: string;
  lastKnownHazardTimestamp: number;
}

/** Sent in reply to a SYNC_REQUEST, one hazard at a time (see hazardSyncQueue's
 * RECONNECT_FLUSH_SPACING_MS) -- never the whole backlog in one message, so a rider who was out of
 * range for an hour doesn't get it all dumped on them at once. */
export interface SyncResponsePacket {
  type: 'SYNC_RESPONSE';
  pendingHazards: HazardEventPacket[];
}

export type MeshPacket = TelemetryPingPacket | HazardEventPacket | SyncRequestPacket | SyncResponsePacket;

/** True for any of the four mesh-sync packet types above, and false for anything else -- in
 * particular, false for SpeechHazardService's voice-hazard packets, which have no `type` field. */
export function isMeshPacket(value: unknown): value is MeshPacket {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const p = value as Record<string, unknown>;
  switch (p.type) {
    case 'TELEMETRY_PING':
      return (
        typeof p.pingId === 'string' &&
        typeof p.riderId === 'string' &&
        typeof p.riderName === 'string' &&
        typeof p.latitude === 'number' &&
        typeof p.longitude === 'number' &&
        typeof p.timestamp === 'number' &&
        typeof p.ttl === 'number' &&
        typeof p.senderId === 'string' &&
        Array.isArray(p.visitedNodes) &&
        p.visitedNodes.every(node => typeof node === 'string')
      );
    case 'HAZARD_EVENT':
      return (
        typeof p.hazardId === 'string' &&
        typeof p.originRiderId === 'string' &&
        typeof p.riderName === 'string' &&
        typeof p.senderId === 'string' &&
        isMeshHazardKind(p.hazardType) &&
        typeof p.latitude === 'number' &&
        typeof p.longitude === 'number' &&
        Array.isArray(p.visitedNodes) &&
        p.visitedNodes.every(node => typeof node === 'string') &&
        typeof p.ttl === 'number' &&
        typeof p.timestamp === 'number'
      );
    case 'SYNC_REQUEST':
      return typeof p.riderId === 'string' && typeof p.lastKnownHazardTimestamp === 'number';
    case 'SYNC_RESPONSE':
      return Array.isArray(p.pendingHazards) && p.pendingHazards.every(h => isMeshPacket(h) && (h as { type: unknown }).type === 'HAZARD_EVENT');
    default:
      return false;
  }
}
