import { AccessToken } from 'livekit-server-sdk';

export interface LiveKitCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Creates a token for one rider to join and participate in a ride's LiveKit room. */
export async function createLiveKitToken(
  credentials: LiveKitCredentials,
  roomCode: string,
  riderName: string,
  userId: string,
  isHost: boolean,
): Promise<string> {
  const at = new AccessToken(credentials.apiKey, credentials.apiSecret, {
    identity: `${userId}_${Date.now()}`,
    name: riderName,
    metadata: JSON.stringify({ userId, isHost }),
    ttl: '6h',
  });
  at.addGrant({
    roomJoin: true,
    room: roomCode,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });
  return at.toJwt();
}
