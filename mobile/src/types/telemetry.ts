export type MeshHazardKind = 'pothole' | 'accident' | 'obstacle';

export const MESH_HAZARD_KINDS: readonly MeshHazardKind[] = ['pothole', 'accident', 'obstacle'];

export function isMeshHazardKind(value: unknown): value is MeshHazardKind {
  return typeof value === 'string' && (MESH_HAZARD_KINDS as readonly string[]).includes(value);
}

export interface RiderNode {
  riderId: string;
  riderName?: string;
  latitude: number;
  longitude: number;
  timestampMs: number;
  batteryPercent?: number;
  flagged?: boolean;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface TelemetryPingPacket {
  type: 'TELEMETRY_PING';
  pingId: string;
  riderId: string;
  riderName: string;
  latitude: number;
  longitude: number;
  timestamp: number;
  ttl: number;
  senderId: string;
  visitedNodes: string[];
}

export const TELEMETRY_PACKET_MAX_TTL = 9;

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
  ttl: number;
  timestamp: number;
}

export const HAZARD_PACKET_MAX_TTL = 24;

export interface SyncRequestPacket {
  type: 'SYNC_REQUEST';
  riderId: string;
  lastKnownHazardTimestamp: number;
}

export interface SyncResponsePacket {
  type: 'SYNC_RESPONSE';
  pendingHazards: HazardEventPacket[];
}

export type MeshPacket =
  | TelemetryPingPacket
  | HazardEventPacket
  | SyncRequestPacket
  | SyncResponsePacket;

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
    case 'VOICE_INFO':
      return (
        typeof p.packetId === 'string' &&
        typeof p.originRiderId === 'string' &&
        typeof p.riderName === 'string' &&
        typeof p.senderId === 'string' &&
        typeof p.message === 'string' &&
        (p.latitude === null || typeof p.latitude === 'number') &&
        (p.longitude === null || typeof p.longitude === 'number') &&
        Array.isArray(p.visitedNodes) &&
        p.visitedNodes.every(node => typeof node === 'string') &&
        typeof p.ttl === 'number' &&
        typeof p.timestamp === 'number'
      );
    case 'SYNC_REQUEST':
      return typeof p.riderId === 'string' && typeof p.lastKnownHazardTimestamp === 'number';
    case 'SYNC_RESPONSE':
      return (
        Array.isArray(p.pendingHazards) &&
        p.pendingHazards.every(
          h => isMeshPacket(h) && (h as { type: unknown }).type === 'HAZARD_EVENT',
        )
      );
    default:
      return false;
  }
}
