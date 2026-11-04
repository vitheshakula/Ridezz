import type { RiderUser } from '../services/AuthService';
import { isRoomCode } from './roomCode';

export function parseStoredUser(json: string | null): RiderUser | null {
  if (!json) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const p = raw as Record<string, unknown>;
  const name =
    typeof p.name === 'string' ? p.name : typeof p.rider_name === 'string' ? p.rider_name : null;
  if (typeof p.id !== 'string' || typeof p.email !== 'string' || !name) {
    return null;
  }
  return {
    id: p.id,
    email: p.email,
    name,
    emailVerified: p.emailVerified === true,
    ...(isRoomCode(p.roomCode) ? { roomCode: p.roomCode } : {}),
  };
}
