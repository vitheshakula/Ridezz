import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  parseHazardPacket,
  serializeHazardPacket,
  type HazardPacket,
} from './SpeechHazardService';

/**
 * Offline rider-to-rider transport (NearbyMeshModule / Google Nearby Connections). Runs
 * independently of the LiveKit cloud room -- see RideScreen for how the two are bridged.
 */

interface NearbyMeshNative {
  startMeshSession(roomCode: string, riderName: string): Promise<void>;
  stopMeshSession(): Promise<void>;
  broadcastHazard(payloadJson: string): Promise<void>;
}

const meshModule: NearbyMeshNative | undefined = NativeModules.NearbyMeshModule;

const MESH_UNAVAILABLE = new Error('Nearby mesh is not available on this platform');

/** Live state of the local mesh session, pushed from native. */
export interface MeshStatus {
  active: boolean;
  /** Riders in the same room currently connected over the mesh. */
  peers: number;
  error: string | null;
}

// Keep sends ordered and one at a time so a burst of hazards can't interleave or overtake each other.
let broadcastChain: Promise<unknown> = Promise.resolve();

export const nearbyMeshService = {
  start(roomCode: string, riderName: string): Promise<void> {
    return Platform.OS === 'android' && meshModule
      ? meshModule.startMeshSession(roomCode, riderName)
      : Promise.reject(MESH_UNAVAILABLE);
  },
  stop(): Promise<void> {
    return Platform.OS === 'android' && meshModule ? meshModule.stopMeshSession() : Promise.resolve();
  },
  broadcastHazard(packet: HazardPacket): Promise<void> {
    if (Platform.OS !== 'android' || !meshModule) {
      return Promise.reject(MESH_UNAVAILABLE);
    }
    const module = meshModule;
    const run = broadcastChain.then(() => module.broadcastHazard(serializeHazardPacket(packet)));
    broadcastChain = run.catch(() => {});
    return run;
  },
  /** Subscribes to hazards heard over the mesh; invalid/stale packets are dropped. */
  onHazardReceived(callback: (packet: HazardPacket) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onHazardReceived', (raw: unknown) => {
      const packet = typeof raw === 'string' ? parseHazardPacket(raw) : null;
      if (packet) {
        callback(packet);
      }
    });
    return () => subscription.remove();
  },
  onStatus(callback: (status: MeshStatus) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onMeshStatus', (raw: unknown) => {
      try {
        const parsed = JSON.parse(String(raw)) as Partial<MeshStatus>;
        callback({
          active: parsed.active === true,
          peers: typeof parsed.peers === 'number' ? parsed.peers : 0,
          error: typeof parsed.error === 'string' ? parsed.error : null,
        });
      } catch {
        // ignore a malformed status push
      }
    });
    return () => subscription.remove();
  },
  /** Number of riders of this room currently connected over the mesh; fires on every join/leave. */
  onPeerCountChanged(callback: (peerCount: number) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onPeerCountChanged', (raw: unknown) => {
      try {
        const parsed = JSON.parse(String(raw)) as { peerCount?: unknown };
        if (typeof parsed.peerCount === 'number') {
          callback(parsed.peerCount);
        }
      } catch {
        // ignore a malformed push
      }
    });
    return () => subscription.remove();
  },
};
