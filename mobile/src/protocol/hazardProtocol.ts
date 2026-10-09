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
] as const;

export type HazardType = (typeof HAZARD_TYPE_IDS)[number];

export const HAZARD_PACKET_MAX_AGE_MS = 30_000;
export const HAZARD_PACKET_MAX_FUTURE_MS = 30_000;

const MAX_PACKET_ID_LENGTH = 96;
const MAX_SENDER_ID_LENGTH = 32;
const MAX_SENDER_NAME_LENGTH = 24;
const HAZARD_IDS: ReadonlySet<string> = new Set(HAZARD_TYPE_IDS);

export interface HazardPacket {
  v: 1;
  id: string;
  hazard: HazardType;
  senderId: string;
  senderName: string;
  timestamp: number;
}

export function createHazardPacket(
  hazard: HazardType,
  senderId: string,
  senderName: string,
  now: number = Date.now(),
): HazardPacket {
  return {
    v: HAZARD_PROTOCOL_VERSION,
    id: `${senderId}-${now}-${hazard}`,
    hazard,
    senderId,
    // Kept short: packets travel over cellular data and short-range radio links.
    senderName: senderName.slice(0, MAX_SENDER_NAME_LENGTH),
    timestamp: now,
  };
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
  return {
    v: HAZARD_PROTOCOL_VERSION,
    id: p.id.slice(0, MAX_PACKET_ID_LENGTH),
    hazard: p.hazard as HazardType,
    senderId: p.senderId.slice(0, MAX_SENDER_ID_LENGTH),
    senderName: p.senderName.slice(0, MAX_SENDER_NAME_LENGTH),
    timestamp: p.timestamp,
  };
}
