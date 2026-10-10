import type { PackEventType } from './convoyPacket';

/** One active convoy alert, keyed by the rider it is about. */
export interface PackAlert {
  /** Subject id: this rider's senderId, a peer's short id, or GROUP_SILENT_KEY. */
  key: string;
  eventType: PackEventType;
  name: string;
  self: boolean;
  /** Last known position of the rider, for the map pin. */
  lat: number | null;
  lng: number | null;
  speedKmh: number | null;
  /** Distance from the pack (separation) as reported, in metres. */
  distanceMeters: number | null;
  /** Epoch ms of the underlying event on this phone's clock when it was received. */
  at: number;
  /** For lost contact: when the rider was last heard (local epoch ms). */
  lastSeenAt: number | null;
  groupSilent: boolean;
}

/** One alert stands in for "every peer went silent at once". */
export const GROUP_SILENT_KEY = 'group-silent';
/** Alerts nobody recovered or dismissed are dropped after this long. */
export const PACK_ALERT_MAX_AGE_MS = 15 * 60 * 1000;

const PRIORITY: Record<PackEventType, number> = {
  BREAKDOWN: 3,
  SEPARATION: 2,
  LOST_CONTACT: 1,
};

/** Adds or replaces the alert for a rider; a less severe alert never replaces a more severe one. */
export function upsertAlert(
  list: readonly PackAlert[],
  next: PackAlert,
): PackAlert[] {
  const existing = list.find(a => a.key === next.key);
  if (existing && PRIORITY[existing.eventType] > PRIORITY[next.eventType]) {
    return list.slice();
  }
  return [...list.filter(a => a.key !== next.key), next];
}

/** Clears a rider's alert when the recovered condition is the one on show. */
export function removeAlert(
  list: readonly PackAlert[],
  key: string,
  eventType: PackEventType,
): PackAlert[] {
  return list.filter(a => !(a.key === key && a.eventType === eventType));
}

export function expireAlerts(
  list: readonly PackAlert[],
  now: number,
  maxAgeMs: number = PACK_ALERT_MAX_AGE_MS,
): PackAlert[] {
  const kept = list.filter(a => now - a.at <= maxAgeMs);
  return kept.length === list.length ? (list as PackAlert[]) : kept;
}

/** The alert to feature on the card: most severe first, then newest. */
export function mostSevere(list: readonly PackAlert[]): PackAlert | null {
  let best: PackAlert | null = null;
  for (const a of list) {
    if (
      !best ||
      PRIORITY[a.eventType] > PRIORITY[best.eventType] ||
      (PRIORITY[a.eventType] === PRIORITY[best.eventType] && a.at > best.at)
    ) {
      best = a;
    }
  }
  return best;
}

const fmtMeters = (m: number) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

export interface PackAlertText {
  title: string;
  detail: string | null;
}

/**
 * Card text. Deliberately says "from the group", not "behind": the centroid is not a route and the
 * rider may as easily be ahead of the pack as behind it.
 */
export function describeAlert(alert: PackAlert, now: number): PackAlertText {
  const who = alert.self ? 'You' : alert.name || 'A rider';
  if (
    alert.key === GROUP_SILENT_KEY ||
    (alert.eventType === 'LOST_CONTACT' && alert.groupSilent)
  ) {
    return {
      title: 'No contact with the group',
      detail: 'Check your connection',
    };
  }
  if (alert.eventType === 'BREAKDOWN') {
    return {
      title: alert.self ? 'You have stopped' : `${who} stopped`,
      detail:
        alert.distanceMeters !== null
          ? `${fmtMeters(alert.distanceMeters)} from the group`
          : null,
    };
  }
  if (alert.eventType === 'SEPARATION') {
    const where =
      alert.distanceMeters !== null
        ? ` ${fmtMeters(alert.distanceMeters)}`
        : '';
    return {
      title: alert.self
        ? `You are separated${where} from the group`
        : `${who} separated${where} from the group`,
      detail: null,
    };
  }
  return {
    title: `${who} lost contact`,
    detail:
      alert.lastSeenAt !== null
        ? `Last seen ${fmtAgo(now - alert.lastSeenAt)}`
        : null,
  };
}

/**
 * What to say aloud. Avoids the app's hazard words ("stop", "stopped", "help", "crash"...) so the
 * always-on recogniser can never turn its own announcement into a hazard.
 */
export function spokenLine(alert: PackAlert): string {
  if (
    alert.key === GROUP_SILENT_KEY ||
    (alert.eventType === 'LOST_CONTACT' && alert.groupSilent)
  ) {
    return 'No contact with your group.';
  }
  const who = alert.name || 'A rider';
  if (alert.self) {
    return alert.eventType === 'BREAKDOWN'
      ? 'Group notified.'
      : 'You are separated from the group.';
  }
  switch (alert.eventType) {
    case 'BREAKDOWN':
      return `Heads up. ${who} is not moving.`;
    case 'SEPARATION':
      return `Heads up. ${who} has drifted from the group.`;
    default:
      return `${who} is out of contact.`;
  }
}
