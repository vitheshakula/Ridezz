export interface TransportCapabilities {
  broadcast: boolean;
  targeted: boolean;
  peerIdentity: boolean;
  linkMetrics: boolean;
  deliveryAck: boolean;
}

export interface TransportSession {
  roomCode: string;
  riderName: string;
}

export interface TransportStatus {
  active: boolean;
  peers: number;
  error: string | null;
}

export interface BroadcastTransport<Payload extends string | Uint8Array> {
  readonly capabilities: Readonly<TransportCapabilities>;
  broadcast(payload: Payload): Promise<void>;
  onPayload(callback: (payload: Payload) => void): () => void;
}

export interface TransportEndpointSource {
  readonly endpointId: string;
}

export interface TargetedTransport<Payload extends string | Uint8Array> {
  sendTo(endpointId: string, payload: Payload): Promise<void>;
  onPayloadFrom(callback: (source: TransportEndpointSource, payload: Payload) => void): () => void;
}

export interface Transport<Payload extends string | Uint8Array>
  extends BroadcastTransport<Payload> {
  start(session: TransportSession): Promise<void>;
  stop(): Promise<void>;
  onStatus(callback: (status: TransportStatus) => void): () => void;
  onPeerCountChanged(callback: (peerCount: number) => void): () => void;
}
