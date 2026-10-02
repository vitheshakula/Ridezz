import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import type { Transport, TransportCapabilities, TransportStatus } from './Transport';

interface NearbyMeshNative {
  startMeshSession(roomCode: string, riderName: string): Promise<void>;
  stopMeshSession(): Promise<void>;
  // The native bridge retains its legacy hazard-specific method name, but treats this as raw UTF-8.
  broadcastHazard(payload: string): Promise<void>;
}

const meshModule: NearbyMeshNative | undefined = NativeModules.NearbyMeshModule;
const MESH_UNAVAILABLE = new Error('Nearby mesh is not available on this platform');

export const NEARBY_TRANSPORT_CAPABILITIES: Readonly<TransportCapabilities> = Object.freeze({
  broadcast: true,
  targeted: false,
  peerIdentity: false,
  linkMetrics: false,
  deliveryAck: false,
});

// Keep sends ordered and one at a time so a burst of payloads cannot interleave or overtake.
let broadcastChain: Promise<unknown> = Promise.resolve();

/** Google Nearby Connections adapter. It forwards raw strings and has no protocol knowledge. */
export const nearbyTransport: Transport<string> = {
  capabilities: NEARBY_TRANSPORT_CAPABILITIES,

  start({ roomCode, riderName }): Promise<void> {
    return Platform.OS === 'android' && meshModule
      ? meshModule.startMeshSession(roomCode, riderName)
      : Promise.reject(MESH_UNAVAILABLE);
  },

  stop(): Promise<void> {
    return Platform.OS === 'android' && meshModule ? meshModule.stopMeshSession() : Promise.resolve();
  },

  broadcast(payload: string): Promise<void> {
    if (Platform.OS !== 'android' || !meshModule) {
      return Promise.reject(MESH_UNAVAILABLE);
    }
    const module = meshModule;
    const run = broadcastChain.then(() => module.broadcastHazard(payload));
    broadcastChain = run.catch(() => {});
    return run;
  },

  onPayload(callback: (payload: string) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onHazardReceived', (raw: unknown) => {
      if (typeof raw === 'string') {
        callback(raw);
      }
    });
    return () => subscription.remove();
  },

  onStatus(callback: (status: TransportStatus) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onMeshStatus', (raw: unknown) => {
      try {
        const parsed = JSON.parse(String(raw)) as Partial<TransportStatus>;
        callback({
          active: parsed.active === true,
          peers: typeof parsed.peers === 'number' ? parsed.peers : 0,
          error: typeof parsed.error === 'string' ? parsed.error : null,
        });
      } catch {
        // Ignore a malformed status push from the native bridge.
      }
    });
    return () => subscription.remove();
  },

  onPeerCountChanged(callback: (peerCount: number) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onPeerCountChanged', (raw: unknown) => {
      try {
        const parsed = JSON.parse(String(raw)) as { peerCount?: unknown };
        if (typeof parsed.peerCount === 'number') {
          callback(parsed.peerCount);
        }
      } catch {
        // Ignore a malformed peer-count push from the native bridge.
      }
    });
    return () => subscription.remove();
  },
};
