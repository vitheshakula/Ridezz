import { TokenSource } from 'livekit-client';
import { LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID } from '../config/devConfig';

export interface ConnectionDetails {
  serverUrl: string;
  token: string;
}

const tokenSource = TokenSource.developmentTokenServer(
  LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID,
);

/** Trims and collapses a rider-typed room code so small formatting differences
 * between two phones (extra spaces, mixed case) still land in the same room. */
export function normalizeRoomCode(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').toLowerCase();
}

/** Builds a participant identity that's unique per join, so two riders who type
 * the same display name don't collide/replace each other in the room. */
function createParticipantIdentity(riderName: string): string {
  const slug = riderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${slug || 'rider'}-${suffix}`;
}

export async function joinRoom(
  riderName: string,
  roomCode: string,
): Promise<ConnectionDetails> {
  if (LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID === 'PASTE_TOKEN_SERVER_ID_HERE') {
    throw new Error(
      'LiveKit development token server is not configured yet. Set LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID in src/config/devConfig.ts.',
    );
  }

  const trimmedName = riderName.trim();
  const roomName = normalizeRoomCode(roomCode);

  const details = await tokenSource.fetch({
    roomName,
    participantName: trimmedName,
    participantIdentity: createParticipantIdentity(trimmedName),
  });

  return {
    serverUrl: details.serverUrl,
    token: details.participantToken,
  };
}
