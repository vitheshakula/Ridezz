import {
  parseHazardPacket,
  serializeHazardPacket,
  type HazardPacket,
} from '../protocol/hazardProtocol';
import { nearbyTransport } from '../transports/NearbyTransport';
import type { TransportStatus } from '../transports/Transport';
import { isMeshPacket, type MeshPacket } from '../types/telemetry';

/**
 * Offline rider-to-rider transport (NearbyMeshModule / Google Nearby Connections). Runs
 * independently of the LiveKit cloud room -- see RideScreen for how the two are bridged.
 */

/** Live state of the local mesh session, pushed from native. */
export type MeshStatus = TransportStatus;

/** @deprecated Prefer nearbyTransport and perform protocol serialization/parsing at the caller. */
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
  /** Subscribes to hazards heard over the mesh; invalid/stale packets are dropped. */
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
  /** Number of riders of this room currently connected over the mesh; fires on every join/leave. */
  onPeerCountChanged(callback: (peerCount: number) => void): () => void {
    return nearbyTransport.onPeerCountChanged(callback);
  },
  /**
   * Sends an offline mesh-sync packet (telemetry ping, hazard event, sync request/response) to
   * every connected peer, over the exact same native call broadcastHazard above uses -- the
   * native side only ever forwards an opaque JSON string, so this is purely additive and never
   * changes what the voice-hazard feature above sends or receives.
   */
  sendMeshPacket(packet: MeshPacket): Promise<void> {
    return nearbyTransport.broadcast(JSON.stringify(packet));
  },
  /**
   * Subscribes to mesh-sync packets heard over the same link onHazardReceived listens on.
   * Anything that isn't one of the four mesh-sync packet types -- in particular, a voice-hazard
   * packet, which has no `type` field -- is ignored here, the same way onHazardReceived's own
   * parseHazardPacket ignores ours.
   */
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
