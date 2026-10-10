/* eslint-disable no-bitwise -- this is a bit-packed binary wire format */
/**
 * Compact binary wire format for convoy alerts (breakdown, separation, lost contact): 52 bytes.
 * Sent as raw bytes over LiveKit and as base64 (72 characters) over Nearby. Like the braking packet
 * it is deliberately not a hazard packet: it skips the hazard policy's throttle and announcement
 * path, and older apps ignore it because it is neither JSON nor a hazard.
 *
 *   0       magic 0xB8
 *   1       version (high nibble, = 1) | remaining relay hops (low nibble)
 *   2-3     sequence, u16 big-endian (wraps)
 *   4-11    reporter id (the sender), 8 ASCII bytes, NUL padded
 *   12-19   subject id (the rider the alert is about), 8 ASCII bytes, NUL padded
 *   20-31   subject display name, 12 ASCII bytes, NUL padded (non-ASCII becomes '?')
 *   32-37   timestamp, u48 big-endian, epoch ms (reporter's clock)
 *   38      kind: low 7 bits 1 BREAKDOWN | 2 SEPARATION | 3 LOST_CONTACT; high bit = recovered
 *   39-42   last known latitude, i32 big-endian, 1e-6 degrees
 *   43-46   last known longitude, i32 big-endian, 1e-6 degrees
 *   47-48   speed, u16, 0.1 km/h units
 *   49-50   distance in metres, u16 (0xFFFF = unknown, otherwise capped at 65534)
 *   51      XOR of bytes 0-50
 */

export const CONVOY_PACKET_BYTES = 52;
export const CONVOY_PACKET_MAGIC = 0xb8;
export const CONVOY_PACKET_VERSION = 1;
export const CONVOY_MAX_HOPS = 3;
/** Convoy news can be a little older than braking news; clocks across phones may differ. */
export const CONVOY_PACKET_MAX_SKEW_MS = 30_000;

export type PackEventType = 'BREAKDOWN' | 'SEPARATION' | 'LOST_CONTACT';

const KINDS: readonly PackEventType[] = [
  'BREAKDOWN',
  'SEPARATION',
  'LOST_CONTACT',
];
const ID_BYTES = 8;
const NAME_BYTES = 12;
const DISTANCE_UNKNOWN = 0xffff;
const RECOVERED_BIT = 0x80;

export interface ConvoyAlert {
  eventType: PackEventType;
  /** True when the condition has ended (rider moving again, back with the pack, heard again). */
  recovered: boolean;
  reporterId: string;
  /** The rider the alert is about. Equals reporterId for a rider's own breakdown / separation. */
  subjectId: string;
  subjectName: string;
  seq: number;
  /** Epoch ms on the reporter's clock. */
  timestamp: number;
  lastKnownLat: number;
  lastKnownLng: number;
  speedKmh: number;
  /** Metres, when known. */
  distanceMeters: number | null;
}

export interface DecodedConvoyPacket extends ConvoyAlert {
  hops: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

function checksum(bytes: Uint8Array): number {
  let x = 0;
  for (let i = 0; i < CONVOY_PACKET_BYTES - 1; i++) {
    x ^= bytes[i];
  }
  return x;
}

function putAscii(
  out: Uint8Array,
  at: number,
  length: number,
  text: string,
): void {
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    out[at + i] = Number.isNaN(code)
      ? 0
      : code >= 0x20 && code < 0x7f
      ? code
      : 0x3f;
  }
}

function getAscii(input: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = 0; i < length && input[at + i] !== 0; i++) {
    out += String.fromCharCode(input[at + i]);
  }
  return out;
}

function putI32(out: Uint8Array, at: number, value: number): void {
  const v = value | 0;
  out[at] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
}

function getI32(input: Uint8Array, at: number): number {
  return (
    (input[at] << 24) |
    (input[at + 1] << 16) |
    (input[at + 2] << 8) |
    input[at + 3]
  );
}

/** Stable 8-character id for a rider whose own id is longer than the wire field (e.g. a LiveKit identity). */
export function shortRiderId(id: string): string {
  if (id.length > 0 && id.length <= ID_BYTES && /^[\x21-\x7e]+$/.test(id)) {
    return id;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `r${h.toString(36).padStart(7, '0')}`.slice(0, ID_BYTES);
}

export function encodeConvoyPacket(
  alert: ConvoyAlert,
  hops: number = CONVOY_MAX_HOPS,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(CONVOY_PACKET_BYTES);
  out[0] = CONVOY_PACKET_MAGIC;
  out[1] = (CONVOY_PACKET_VERSION << 4) | clamp(Math.trunc(hops), 0, 15);
  const seq = Math.trunc(alert.seq) & 0xffff;
  out[2] = seq >>> 8;
  out[3] = seq & 0xff;
  putAscii(out, 4, ID_BYTES, alert.reporterId);
  putAscii(out, 12, ID_BYTES, alert.subjectId);
  putAscii(out, 20, NAME_BYTES, alert.subjectName);
  const ts = clamp(Math.trunc(alert.timestamp), 0, 2 ** 48 - 1);
  const hi = Math.floor(ts / 2 ** 32);
  const lo = ts % 2 ** 32;
  out[32] = (hi >>> 8) & 0xff;
  out[33] = hi & 0xff;
  out[34] = (lo >>> 24) & 0xff;
  out[35] = (lo >>> 16) & 0xff;
  out[36] = (lo >>> 8) & 0xff;
  out[37] = lo & 0xff;
  out[38] =
    (KINDS.indexOf(alert.eventType) + 1) |
    (alert.recovered ? RECOVERED_BIT : 0);
  putI32(out, 39, Math.round(clamp(alert.lastKnownLat, -90, 90) * 1e6));
  putI32(out, 43, Math.round(clamp(alert.lastKnownLng, -180, 180) * 1e6));
  const speed = clamp(Math.round(alert.speedKmh * 10), 0, 0xffff);
  out[47] = speed >>> 8;
  out[48] = speed & 0xff;
  const distance =
    alert.distanceMeters === null || !Number.isFinite(alert.distanceMeters)
      ? DISTANCE_UNKNOWN
      : clamp(Math.round(alert.distanceMeters), 0, DISTANCE_UNKNOWN - 1);
  out[49] = distance >>> 8;
  out[50] = distance & 0xff;
  out[51] = checksum(out);
  return out;
}

/** Returns null (never throws) for anything that is not a well-formed v1 convoy packet. */
export function decodeConvoyPacket(
  input: Uint8Array,
): DecodedConvoyPacket | null {
  if (!(input instanceof Uint8Array) || input.length !== CONVOY_PACKET_BYTES) {
    return null;
  }
  if (
    input[0] !== CONVOY_PACKET_MAGIC ||
    input[1] >>> 4 !== CONVOY_PACKET_VERSION
  ) {
    return null;
  }
  if (checksum(input) !== input[51]) {
    return null;
  }
  const kind = input[38] & ~RECOVERED_BIT;
  const eventType = KINDS[kind - 1];
  const reporterId = getAscii(input, 4, ID_BYTES);
  const subjectId = getAscii(input, 12, ID_BYTES);
  if (!eventType || reporterId.length === 0 || subjectId.length === 0) {
    return null;
  }
  const lat = getI32(input, 39) / 1e6;
  const lng = getI32(input, 43) / 1e6;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  const hi = (input[32] << 8) | input[33];
  const lo =
    ((input[34] << 24) | (input[35] << 16) | (input[36] << 8) | input[37]) >>>
    0;
  const distance = (input[49] << 8) | input[50];
  return {
    eventType,
    recovered: (input[38] & RECOVERED_BIT) !== 0,
    hops: input[1] & 0x0f,
    seq: (input[2] << 8) | input[3],
    reporterId,
    subjectId,
    subjectName: getAscii(input, 20, NAME_BYTES),
    timestamp: hi * 2 ** 32 + lo,
    lastKnownLat: lat,
    lastKnownLng: lng,
    speedKmh: ((input[47] << 8) | input[48]) / 10,
    distanceMeters: distance === DISTANCE_UNKNOWN ? null : distance,
  };
}
