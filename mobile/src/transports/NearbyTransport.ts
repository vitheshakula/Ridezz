import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import type {
  TargetedTransport,
  Transport,
  TransportCapabilities,
  TransportEndpointSource,
  TransportStatus,
} from './Transport';

interface NearbyMeshNative {
  startMeshSession(roomCode: string, riderName: string): Promise<void>;
  stopMeshSession(): Promise<void>;
  broadcastHazard(payload: string): Promise<void>;
  sendPayloadTo?(endpointId: string, payload: string): Promise<void>;
}

const meshModule: NearbyMeshNative | undefined = NativeModules.NearbyMeshModule;
const MESH_UNAVAILABLE = new Error('Nearby mesh is not available on this platform');

export const NEARBY_TRANSPORT_ID = 'nearby';

export const NEARBY_TRANSPORT_CAPABILITIES: Readonly<TransportCapabilities> = Object.freeze({
  broadcast: true,
  targeted: true,
  peerIdentity: true,
  linkMetrics: false,
  deliveryAck: false,
});

let broadcastChain: Promise<unknown> = Promise.resolve();

export const nearbyTransport: Transport<string> & TargetedTransport<string> = {
  capabilities: NEARBY_TRANSPORT_CAPABILITIES,

  start({ roomCode, riderName }): Promise<void> {
    return Platform.OS === 'android' && meshModule
      ? meshModule.startMeshSession(roomCode, riderName)
      : Promise.reject(MESH_UNAVAILABLE);
  },

  stop(): Promise<void> {
    return Platform.OS === 'android' && meshModule
      ? meshModule.stopMeshSession()
      : Promise.resolve();
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

  sendTo(endpointId: string, payload: string): Promise<void> {
    if (Platform.OS !== 'android' || !meshModule) {
      return Promise.reject(MESH_UNAVAILABLE);
    }
    if (typeof meshModule.sendPayloadTo !== 'function') {
      return Promise.reject(
        new Error('Nearby targeted send is not supported by this native build'),
      );
    }
    if (typeof endpointId !== 'string' || endpointId.length === 0) {
      return Promise.reject(new Error('Nearby endpoint id must be a non-empty string'));
    }
    return meshModule.sendPayloadTo(endpointId, payload);
  },

  onPayloadFrom(callback: (source: TransportEndpointSource, payload: string) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onPayloadReceivedFrom', (raw: unknown) => {
      let parsed: { endpointId?: unknown; payload?: unknown };
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      const { endpointId, payload } = parsed ?? {};
      const validEndpoint = typeof endpointId === 'string' && endpointId.length > 0;
      if (validEndpoint && typeof payload === 'string') {
        callback(Object.freeze({ endpointId }), payload);
      }
    });
    return () => subscription.remove();
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
      } catch {}
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
      } catch {}
    });
    return () => subscription.remove();
  },
};
