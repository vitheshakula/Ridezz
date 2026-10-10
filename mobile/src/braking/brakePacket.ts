/* eslint-disable no-bitwise -- this is a bit-packed binary wire format */
/**
 * Compact binary wire format for the emergency hard-braking alert: 24 bytes, so it fits one radio
 * frame and parses in microseconds. Sent as raw bytes over LiveKit and as base64 (32 characters)
 * over Nearby, whose transport carries strings. It is deliberately NOT a hazard packet: it skips
 * the hazard policy's per-type throttle and announcement path, and older apps ignore it because it
 * is neither JSON nor a hazard.
 *
 *   0       magic 0xB7
 *   1       version (high nibble, = 1) | remaining relay hops (low nibble)
 *   2-3     sequence, u16 big-endian (wraps)
 *   4-11    sender id, 8 ASCII bytes, NUL padded
 *   12-17   timestamp, u48 big-endian, epoch ms (onset of the braking)
 *   18-19   speed, u16, 0.1 km/h units
 *   20      peak deceleration, u8, 0.02 g units (caps at 5.1 g)
 *   21-22   heading, u16, whole degrees; 0xFFFF = unknown
 *   23      XOR of bytes 0-22
 */

export const BRAKE_PACKET_BYTES = 24;
export const BRAKE_PACKET_MAGIC = 0xb7;
export const BRAKE_PACKET_VERSION = 1;
/** How many times a packet may be re-broadcast after the first send. */
export const BRAKE_MAX_HOPS = 3;
/** Braking news is useless when old; clocks across phones may differ by a few seconds. */
export const BRAKE_PACKET_MAX_SKEW_MS = 10_000;

const SENDER_BYTES = 8;
const HEADING_UNKNOWN = 0xffff;

export interface BrakeAlert {
  senderId: string;
  seq: number;
  /** Epoch ms of the braking onset on the sender's clock. */
  timestamp: number;
  speedKmh: number;
  peakDecelG: number;
  /** Degrees [0, 360), or null when the sender had no course. */
  headingDeg: number | null;
}

export interface DecodedBrakePacket extends BrakeAlert {
  hops: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function checksum(bytes: Uint8Array): number {
  let x = 0;
  for (let i = 0; i < BRAKE_PACKET_BYTES - 1; i++) {
    x ^= bytes[i];
  }
  return x;
}

export function encodeBrakePacket(
  alert: BrakeAlert,
  hops: number = BRAKE_MAX_HOPS,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(BRAKE_PACKET_BYTES);
  out[0] = BRAKE_PACKET_MAGIC;
  out[1] = (BRAKE_PACKET_VERSION << 4) | clamp(Math.trunc(hops), 0, 15);
  const seq = Math.trunc(alert.seq) & 0xffff;
  out[2] = seq >>> 8;
  out[3] = seq & 0xff;
  for (let i = 0; i < SENDER_BYTES; i++) {
    const code = alert.senderId.charCodeAt(i);
    out[4 + i] = Number.isNaN(code) ? 0 : code & 0x7f;
  }
  const ts = clamp(Math.trunc(alert.timestamp), 0, 2 ** 48 - 1);
  const hi = Math.floor(ts / 2 ** 32);
  const lo = ts % 2 ** 32;
  out[12] = (hi >>> 8) & 0xff;
  out[13] = hi & 0xff;
  out[14] = (lo >>> 24) & 0xff;
  out[15] = (lo >>> 16) & 0xff;
  out[16] = (lo >>> 8) & 0xff;
  out[17] = lo & 0xff;
  const speed = clamp(Math.round(alert.speedKmh * 10), 0, 0xffff);
  out[18] = speed >>> 8;
  out[19] = speed & 0xff;
  out[20] = clamp(Math.round(alert.peakDecelG * 50), 0, 255);
  const heading =
    alert.headingDeg === null || !Number.isFinite(alert.headingDeg)
      ? HEADING_UNKNOWN
      : Math.round(((alert.headingDeg % 360) + 360) % 360) % 360;
  out[21] = heading >>> 8;
  out[22] = heading & 0xff;
  out[23] = checksum(out);
  return out;
}

/** Returns null (never throws) for anything that is not a well-formed v1 braking packet. */
export function decodeBrakePacket(input: Uint8Array): DecodedBrakePacket | null {
  if (!(input instanceof Uint8Array) || input.length !== BRAKE_PACKET_BYTES) {
    return null;
  }
  if (input[0] !== BRAKE_PACKET_MAGIC || input[1] >>> 4 !== BRAKE_PACKET_VERSION) {
    return null;
  }
  if (checksum(input) !== input[23]) {
    return null;
  }
  let senderId = '';
  for (let i = 0; i < SENDER_BYTES && input[4 + i] !== 0; i++) {
    senderId += String.fromCharCode(input[4 + i]);
  }
  if (senderId.length === 0) {
    return null;
  }
  const hi = (input[12] << 8) | input[13];
  const lo = ((input[14] << 24) | (input[15] << 16) | (input[16] << 8) | input[17]) >>> 0;
  const heading = (input[21] << 8) | input[22];
  return {
    senderId,
    hops: input[1] & 0x0f,
    seq: (input[2] << 8) | input[3],
    timestamp: hi * 2 ** 32 + lo,
    speedKmh: ((input[18] << 8) | input[19]) / 10,
    peakDecelG: input[20] / 50,
    headingDeg: heading === HEADING_UNKNOWN || heading >= 360 ? null : heading,
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >>> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

/** Returns null for anything that is not strict, padded base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || text.length > 64) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    return null;
  }
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = B64.indexOf(text[i]);
    const b = B64.indexOf(text[i + 1]);
    const c = text[i + 2] === '=' ? 0 : B64.indexOf(text[i + 2]);
    const d = text[i + 3] === '=' ? 0 : B64.indexOf(text[i + 3]);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >>> 16) & 0xff;
    if (o < out.length) out[o++] = (n >>> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}
