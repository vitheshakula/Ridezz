/** Capabilities a transport can truthfully provide today. */
export interface TransportCapabilities {
  broadcast: boolean;
  targeted: boolean;
  peerIdentity: boolean;
  linkMetrics: boolean;
  deliveryAck: boolean;
}

/** Context required to join a transport-scoped ride session. */
export interface TransportSession {
  roomCode: string;
  riderName: string;
}

/** Live state reported by a transport. */
export interface TransportStatus {
  active: boolean;
  peers: number;
  error: string | null;
}

/** Minimal raw-payload contract shared by transports with different lifecycle ownership. */
export interface BroadcastTransport<Payload extends string | Uint8Array> {
  readonly capabilities: Readonly<TransportCapabilities>;
  broadcast(payload: Payload): Promise<void>;
  onPayload(callback: (payload: Payload) => void): () => void;
}

/** Broadcast transport whose session lifecycle and mesh state are managed by the caller. */
export interface Transport<Payload extends string | Uint8Array>
  extends BroadcastTransport<Payload> {
  start(session: TransportSession): Promise<void>;
  stop(): Promise<void>;
  onStatus(callback: (status: TransportStatus) => void): () => void;
  onPeerCountChanged(callback: (peerCount: number) => void): () => void;
}
