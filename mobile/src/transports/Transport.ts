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

/** Minimal broadcast transport contract. Payload interpretation belongs to protocol code. */
export interface Transport<Payload extends string | Uint8Array> {
  readonly capabilities: Readonly<TransportCapabilities>;
  start(session: TransportSession): Promise<void>;
  stop(): Promise<void>;
  broadcast(payload: Payload): Promise<void>;
  onPayload(callback: (payload: Payload) => void): () => void;
  onStatus(callback: (status: TransportStatus) => void): () => void;
  onPeerCountChanged(callback: (peerCount: number) => void): () => void;
}
