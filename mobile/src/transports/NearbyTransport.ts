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
  // The native bridge retains its legacy hazard-specific method name, but treats this as raw UTF-8.
  broadcastHazard(payload: string): Promise<void>;
  /** Absent on native builds that predate targeted send. */
  sendPayloadTo?(endpointId: string, payload: string): Promise<void>;
}

const meshModule: NearbyMeshNative | undefined = NativeModules.NearbyMeshModule;
const MESH_UNAVAILABLE = new Error('Nearby mesh is not available on this platform');

/** Stable local id of this transport, as used for connectivity-layer ingress sources. */
export const NEARBY_TRANSPORT_ID = 'nearby';

/** Targeted send and peer identity refer to the endpoint-aware interface (sendTo/onPayloadFrom).
 * Delivery acknowledgement stays false: a Nearby send Task is not an end-to-end acknowledgement. */
export const NEARBY_TRANSPORT_CAPABILITIES: Readonly<TransportCapabilities> = Object.freeze({
  broadcast: true,
  targeted: true,
  peerIdentity: true,
  linkMetrics: false,
  deliveryAck: false,
});

// Keep Phase 1 broadcasts ordered and one at a time so a burst cannot interleave or overtake.
// Targeted sends deliberately bypass this chain: a stuck broadcast must not block routed traffic,
// whose sends the connectivity layer already bounds with its own timeouts.
let broadcastChain: Promise<unknown> = Promise.resolve();

/**
 * Google Nearby Connections adapter. It forwards raw strings and has no protocol knowledge.
 *
 * Receive paths are separate on purpose: Phase 1 uses onPayload (`onHazardReceived`); the
 * connectivity protocol must use onPayloadFrom (`onPayloadReceivedFrom`) only. Native emits both
 * for every payload, so subscribing one consumer to both would process each packet twice.
 */
export const nearbyTransport: Transport<string> & TargetedTransport<string> = {
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

  onPayloadFrom(
    callback: (source: TransportEndpointSource, payload: string) => void,
  ): () => void {
    const subscription = DeviceEventEmitter.addListener(
      'onPayloadReceivedFrom',
      (raw: unknown) => {
        let parsed: { endpointId?: unknown; payload?: unknown };
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return; // Ignore a malformed push from the native bridge.
        }
        const { endpointId, payload } = parsed ?? {};
        const validEndpoint = typeof endpointId === 'string' && endpointId.length > 0;
        if (validEndpoint && typeof payload === 'string') {
          callback(Object.freeze({ endpointId }), payload);
        }
      },
    );
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
