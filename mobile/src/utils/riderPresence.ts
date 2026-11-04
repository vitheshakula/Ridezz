import { ConnectionQuality } from 'livekit-client';

export const MAX_RIDERS = 25;

export function isRoomOverCapacity(numParticipants: number, max: number = MAX_RIDERS): boolean {
  return numParticipants > max;
}

export interface RiderIdentity {
  identity: string;
  name: string;
}

export function sortByJoinOrder<T extends { joinedAt?: Date }>(riders: T[]): T[] {
  return [...riders].sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0));
}

export type PresenceEvent =
  | { type: 'joined'; name: string }
  | { type: 'rejoined'; name: string }
  | { type: 'left'; name: string };

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
