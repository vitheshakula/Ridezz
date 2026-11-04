import {
  parseHazardPacket,
  serializeHazardPacket,
  type HazardPacket,
} from '../protocol/hazardProtocol';
import { nearbyTransport } from '../transports/NearbyTransport';
import type { TransportStatus } from '../transports/Transport';
import { isMeshPacket, type MeshPacket } from '../types/telemetry';

export type MeshStatus = TransportStatus;

export const nearbyMeshService = {
  start(roomCode: string, riderName: string): Promise<void> {
    return nearbyTransport.start({ roomCode, riderName });
  },
  stop(): Promise<void> {
    return nearbyTransport.stop();
  },
  broadcastHazard(packet: HazardPacket): Promise<void> {
    return nearbyTransport.broadcast(serializeHazardPacket(packet));
  },
  onHazardReceived(callback: (packet: HazardPacket) => void): () => void {
    return nearbyTransport.onPayload(raw => {
      const packet = parseHazardPacket(raw);
      if (packet) {
        callback(packet);
      }
    });
  },
  onStatus(callback: (status: MeshStatus) => void): () => void {
    return nearbyTransport.onStatus(callback);
  },
  onPeerCountChanged(callback: (peerCount: number) => void): () => void {
    return nearbyTransport.onPeerCountChanged(callback);
  },
  sendMeshPacket(packet: MeshPacket): Promise<void> {
    return nearbyTransport.broadcast(JSON.stringify(packet));
  },
  onMeshPacket(callback: (packet: MeshPacket) => void): () => void {
    return nearbyTransport.onPayload(raw => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (isMeshPacket(parsed)) {
        callback(parsed);
      }
    });
  },
};
