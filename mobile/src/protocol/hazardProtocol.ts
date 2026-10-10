/** Transport-neutral v1 hazard wire contract. */

export const HAZARD_PROTOCOL_VERSION = 1 as const;

/** Hazard identifiers accepted on the v1 wire format. */
export const HAZARD_TYPE_IDS = [
  'missed_turn',
  'fuel',
  'pothole',
  'gravel',
  'roadkill',
  'obstacle',
  'police',
  'accident',
  'slippery',
  'slow',
  'stop',
  'vehicle_stopped',
  'sharp_turn',
  'info',
] as const;

export type HazardType = (typeof HAZARD_TYPE_IDS)[number];

export const HAZARD_PACKET_MAX_AGE_MS = 30_000;
export const HAZARD_PACKET_MAX_FUTURE_MS = 30_000;

const MAX_PACKET_ID_LENGTH = 96;
const MAX_SENDER_ID_LENGTH = 32;
const MAX_SENDER_NAME_LENGTH = 24;
/** Caps a dictated 'info' voice note (see JarvisVoiceService) -- packets travel over cellular
 * data and short-range radio links, same reasoning as MAX_SENDER_NAME_LENGTH above. */
const MAX_MESSAGE_LENGTH = 200;
const HAZARD_IDS: ReadonlySet<string> = new Set(HAZARD_TYPE_IDS);

export const SOS_SEVERITIES = ['SEVERE', 'HIGH', 'MODERATE', 'UNKNOWN'] as const;
export type SosSeverity = (typeof SOS_SEVERITIES)[number];

/**
 * Optional details on an 'accident' packet raised by automatic crash detection. Additive: v1
 * receivers that predate it rebuild packets from the known fields and simply drop it, and a packet
 * whose `sos` block is malformed is still accepted without it.
 */
export interface HazardSosDetails {
  /** Epoch ms of the detected impact. */
  impactAt: number;
  severity: SosSeverity;
  /** Last known position of the rider who may be down. Absent when there was no GNSS fix. */
  lat?: number;
  lng?: number;
  /** Speed before the impact, km/h. Absent without GNSS. */
  speedKmh?: number;
}

export interface HazardPacket {
  v: 1;
  id: string;
  hazard: HazardType;
  senderId: string;
  senderName: string;
  timestamp: number;
  sos?: HazardSosDetails;
  /** The dictated text for an 'info' packet (see JarvisVoiceService) -- additive, like `sos`:
   * absent for every other hazard type, and a v1 receiver that predates it still rebuilds the
   * packet from its other known fields. */
  message?: string;
}

export function createHazardPacket(
  hazard: HazardType,
  senderId: string,
  senderName: string,
  now: number = Date.now(),
  sos?: HazardSosDetails,
  message?: string,
): HazardPacket {
  return {
    v: HAZARD_PROTOCOL_VERSION,
    id: `${senderId}-${now}-${hazard}`,
    hazard,
    senderId,
    // Kept short: packets travel over cellular data and short-range radio links.
    senderName: senderName.slice(0, MAX_SENDER_NAME_LENGTH),
    timestamp: now,
    ...(sos ? { sos } : {}),
    ...(message ? { message: message.slice(0, MAX_MESSAGE_LENGTH) } : {}),
  };
}

const SOS_SEVERITY_IDS: ReadonlySet<string> = new Set(SOS_SEVERITIES);

/** Returns a clean copy of a received `sos` block, or undefined if it is absent or malformed. */
function parseSosDetails(raw: unknown): HazardSosDetails | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const s = raw as Record<string, unknown>;
  if (
    typeof s.impactAt !== 'number' ||
    !Number.isFinite(s.impactAt) ||
    typeof s.severity !== 'string' ||
    !SOS_SEVERITY_IDS.has(s.severity)
  ) {
    return undefined;
  }
  const details: HazardSosDetails = {
    impactAt: s.impactAt,
    severity: s.severity as SosSeverity,
  };
  if (
    typeof s.lat === 'number' &&
    typeof s.lng === 'number' &&
    Number.isFinite(s.lat) &&
    Number.isFinite(s.lng) &&
    Math.abs(s.lat) <= 90 &&
    Math.abs(s.lng) <= 180
  ) {
    details.lat = s.lat;
    details.lng = s.lng;
  }
  if (typeof s.speedKmh === 'number' && Number.isFinite(s.speedKmh) && s.speedKmh >= 0 && s.speedKmh < 500) {
    details.speedKmh = s.speedKmh;
  }
  return details;
}

export function serializeHazardPacket(packet: HazardPacket): string {
  return JSON.stringify(packet);
}

export function encodeHazardPacket(packet: HazardPacket): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(serializeHazardPacket(packet));
}

/** Decodes + validates a packet from any transport. Returns null (never throws) for anything
 * malformed, unknown, or stale -- callers silently drop it. */
export function parseHazardPacket(
  input: string | Uint8Array,
  now: number = Date.now(),
): HazardPacket | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof input === 'string' ? input : new TextDecoder().decode(input));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const p = parsed as Record<string, unknown>;

  if (
    p.v !== HAZARD_PROTOCOL_VERSION ||
    typeof p.hazard !== 'string' ||
    !HAZARD_IDS.has(p.hazard) ||
    typeof p.id !== 'string' ||
    typeof p.senderId !== 'string' ||
    typeof p.senderName !== 'string' ||
    typeof p.timestamp !== 'number' ||
    !Number.isFinite(p.timestamp)
  ) {
    return null;
  }
  if (
    now - p.timestamp > HAZARD_PACKET_MAX_AGE_MS ||
    p.timestamp - now > HAZARD_PACKET_MAX_FUTURE_MS
  ) {
    return null;
  }
  const sos = parseSosDetails(p.sos);
  const message = typeof p.message === 'string' ? p.message.slice(0, MAX_MESSAGE_LENGTH) : undefined;
  return {
    v: HAZARD_PROTOCOL_VERSION,
    id: p.id.slice(0, MAX_PACKET_ID_LENGTH),
    hazard: p.hazard as HazardType,
    senderId: p.senderId.slice(0, MAX_SENDER_ID_LENGTH),
    senderName: p.senderName.slice(0, MAX_SENDER_NAME_LENGTH),
    timestamp: p.timestamp,
    ...(sos ? { sos } : {}),
    ...(message ? { message } : {}),
  };
}
