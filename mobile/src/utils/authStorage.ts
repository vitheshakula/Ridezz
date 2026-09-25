import type { RiderUser } from '../services/AuthService';

/**
 * Reads a rider profile back out of storage, accepting the shape saved by earlier builds
 * (`rider_name` instead of `name`) so an upgrade doesn't sign anyone out or show them as "Rider".
 * Returns null for anything that isn't recognisably a profile -- the caller then treats the
 * rider as signed out instead of running with half a profile.
 */
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
  const name = typeof p.name === 'string' ? p.name : typeof p.rider_name === 'string' ? p.rider_name : null;
  if (typeof p.id !== 'string' || typeof p.email !== 'string' || !name) {
    return null;
  }
  return {
    id: p.id,
    email: p.email,
    name,
    emailVerified: p.emailVerified === true,
  };
}
