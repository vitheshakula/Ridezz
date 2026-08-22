import { ConnectionQuality } from 'livekit-client';

/** Ridezz MVP room capacity. Enforced client-side (see RideScreen) since the
 * Development Token Server has no way to configure server-side room capacity --
 * production-grade enforcement moves to the future Ridezz token backend, which can
 * set this authoritatively when minting tokens / creating rooms. */
export const MAX_RIDERS = 10;

/** True once the local rider would be the (MAX_RIDERS + 1)th participant, based on
 * server-reported `room.numParticipants` at the moment we connected. This can't
 * prevent every race (two riders joining within the same instant could both slip
 * through), but it reliably catches the common case and kicks the excess rider out. */
export function isRoomOverCapacity(numParticipants: number, max: number = MAX_RIDERS): boolean {
  return numParticipants > max;
}

export interface RiderIdentity {
  identity: string;
  name: string;
}

/** Sorts riders by server-assigned join time, oldest first, so the list doesn't
 * reshuffle on every render. Falls back to stable input order for any rider missing
 * a `joinedAt` (shouldn't normally happen for a confirmed participant). */
export function sortByJoinOrder<T extends { joinedAt?: Date }>(riders: T[]): T[] {
  return [...riders].sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0));
}

export type PresenceEvent =
  | { type: 'joined'; name: string }
  | { type: 'rejoined'; name: string }
  | { type: 'left'; name: string };

/** Diffs the previous vs. current remote rider identity list to produce truthful
 * join/rejoin/left events -- "rejoined" only for an identity we've genuinely seen
 * before in this room session (real LiveKit identity continuity, not guessed), never
 * fabricated. Mutates `seenIdentities` to record newly-seen identities. */
export function diffPresence(
  previous: RiderIdentity[],
  current: RiderIdentity[],
  seenIdentities: Set<string>,
): PresenceEvent[] {
  const events: PresenceEvent[] = [];
  const previousByIdentity = new Map(previous.map(r => [r.identity, r]));
  const currentByIdentity = new Map(current.map(r => [r.identity, r]));

  for (const rider of current) {
    if (!previousByIdentity.has(rider.identity)) {
      events.push({
        type: seenIdentities.has(rider.identity) ? 'rejoined' : 'joined',
        name: rider.name,
      });
      seenIdentities.add(rider.identity);
    }
  }

  for (const rider of previous) {
    if (!currentByIdentity.has(rider.identity)) {
      events.push({ type: 'left', name: rider.name });
    }
  }

  return events;
}

/** Short, user-facing label for a remote rider's connection quality. Returns null
 * for Excellent/Good/Unknown so the row stays quiet -- only worth calling out when
 * something's actually wrong. Never fabricates a "Reconnecting" state for remote
 * riders; `Lost` is LiveKit's own real signal for a rider who's temporarily (or about
 * to be permanently) disconnected. */
export function connectionQualityLabel(quality: ConnectionQuality): string | null {
  switch (quality) {
    case ConnectionQuality.Poor:
      return 'Poor connection';
    case ConnectionQuality.Lost:
      return 'Connection lost';
    default:
      return null;
  }
}

/** Priority for a rider row's single status label: muted beats speaking beats a
 * connection-quality warning, so the row never shows more than one thing at once. */
export function riderStatusLabel(
  isMuted: boolean,
  isSpeaking: boolean,
  qualityLabel: string | null,
): string | null {
  if (isMuted) {
    return 'Muted';
  }
  if (isSpeaking) {
    return 'Speaking';
  }
  return qualityLabel;
}
