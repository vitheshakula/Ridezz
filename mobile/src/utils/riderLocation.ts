/**
 * Location sharing wire format + state model. Kept as pure functions so the
 * validation/distance/freshness/state-update logic is testable without any
 * LiveKit or GPS mocking (see __tests__/riderLocation.test.ts).
 */

/** Dedicated LiveKit data-channel topic for location packets, sent lossy (not
 * reliable) -- only the newest fix matters, and we don't want a retransmission
 * backlog delaying fresh updates during poor mobile coverage. */
export const LOCATION_TOPIC = 'ridezz.location';

export const LOCATION_PAYLOAD_VERSION = 1;

/** Wire format published over LiveKit data. Deliberately small. */
export interface LocationPayload {
  v: number;
  lat: number;
  lng: number;
  accuracy?: number;
  timestamp: number;
}

export interface RiderLocation {
  participantIdentity: string;
  participantName: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  /** Sender's own clock at the moment of the GPS fix (ms since epoch). */
  timestamp: number;
  /** False once the rider's ParticipantDisconnected has fired -- the last known
   * position is kept (not erased) so mounted riders retain "last seen" awareness. */
  connected: boolean;
}

/** Keyed by participant identity. Plain object (not Map) for simple, structural
 * equality in tests and easy immutable updates. */
export type RiderLocationState = Record<string, RiderLocation>;

export function encodeLocationPayload(payload: Omit<LocationPayload, 'v'>): Uint8Array<ArrayBuffer> {
  const full: LocationPayload = { v: LOCATION_PAYLOAD_VERSION, ...payload };
  return new TextEncoder().encode(JSON.stringify(full));
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Decodes + validates an incoming location packet. Returns null (never throws)
 * for malformed JSON, an unsupported version, out-of-range lat/lng, or a missing/
 * absurd timestamp -- callers should silently drop invalid packets rather than
 * let one bad/malicious payload crash the ride. */
export function decodeLocationPayload(
  bytes: Uint8Array,
  now: number = Date.now(),
): LocationPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const p = parsed as Record<string, unknown>;

  if (p.v !== LOCATION_PAYLOAD_VERSION) {
    return null;
  }
  if (typeof p.lat !== 'number' || !Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) {
    return null;
  }
  if (typeof p.lng !== 'number' || !Number.isFinite(p.lng) || p.lng < -180 || p.lng > 180) {
    return null;
  }
  if (typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp) || p.timestamp <= 0) {
    return null;
  }
  if (p.timestamp > now + MAX_CLOCK_SKEW_MS) {
    return null;
  }
  const accuracy =
    typeof p.accuracy === 'number' && Number.isFinite(p.accuracy) ? p.accuracy : undefined;

  return { v: p.v, lat: p.lat, lng: p.lng, accuracy, timestamp: p.timestamp };
}

/** Replaces (or adds) a rider's location, marking them connected. Immutable --
 * returns a new state object. */
export function upsertRiderLocation(
  state: RiderLocationState,
  update: { identity: string; name: string; payload: LocationPayload },
): RiderLocationState {
  return {
    ...state,
    [update.identity]: {
      participantIdentity: update.identity,
      participantName: update.name,
      latitude: update.payload.lat,
      longitude: update.payload.lng,
      accuracy: update.payload.accuracy,
      timestamp: update.payload.timestamp,
      connected: true,
    },
  };
}

/** Marks a rider disconnected without erasing their last known position -- a
 * no-op if we never had a location for them. Immutable. */
export function markRiderDisconnected(
  state: RiderLocationState,
  identity: string,
): RiderLocationState {
  const existing = state[identity];
  if (!existing) {
    return state;
  }
  return { ...state, [identity]: { ...existing, connected: false } };
}

export type Freshness = 'live' | 'stale' | 'offline';

const LIVE_THRESHOLD_MS = 10_000;
const STALE_THRESHOLD_MS = 60_000;

/** Live: updated <10s ago. Stale: 10-60s ago. Offline: rider disconnected, or
 * their last fix is over 60s old even while still connected (e.g. GPS lost). */
export function classifyFreshness(location: RiderLocation, nowMs: number): Freshness {
  if (!location.connected) {
    return 'offline';
  }
  const age = nowMs - location.timestamp;
  if (age < LIVE_THRESHOLD_MS) {
    return 'live';
  }
  if (age < STALE_THRESHOLD_MS) {
    return 'stale';
  }
  return 'offline';
}

const EARTH_RADIUS_METERS = 6371000;

/** Standard haversine great-circle distance in meters. */
export function haversineDistanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_METERS * c;
}

/** "820 m away" / "1.2 km away". Deliberately no ahead/behind claim -- we have
 * no route or heading model to support that inference. */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m away`;
  }
  return `${(meters / 1000).toFixed(1)} km away`;
}

/** "Updated 4s ago" / "Updated 2m ago". */
export function formatUpdatedAgo(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) {
    return `Updated ${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return `Updated ${minutes}m ago`;
}
