export const LOCATION_TOPIC = 'ridezz.location';

export const LOCATION_REQUEST_TOPIC = 'ridezz.location.request';

export const LOCATION_PAYLOAD_VERSION = 1;

export interface LocationPayload {
  v: number;
  lat: number;
  lng: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  timestamp: number;
}

export interface RiderLocation {
  participantIdentity: string;
  participantName: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  timestamp: number;
  connected: boolean;
}

export type RiderLocationState = Record<string, RiderLocation>;

export function encodeLocationPayload(
  payload: Omit<LocationPayload, 'v'>,
): Uint8Array<ArrayBuffer> {
  const full: LocationPayload = { v: LOCATION_PAYLOAD_VERSION, ...payload };
  return new TextEncoder().encode(JSON.stringify(full));
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

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
  const speed =
    typeof p.speed === 'number' && Number.isFinite(p.speed) && p.speed >= 0 ? p.speed : undefined;
  const heading =
    typeof p.heading === 'number' && Number.isFinite(p.heading) && p.heading >= 0 && p.heading < 360
      ? p.heading
      : undefined;

  return { v: p.v, lat: p.lat, lng: p.lng, accuracy, speed, heading, timestamp: p.timestamp };
}

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
      speed: update.payload.speed,
      heading: update.payload.heading,
      timestamp: update.payload.timestamp,
      connected: true,
    },
  };
}

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

export function computeCentroid(
  locations: Array<{ latitude: number; longitude: number }>,
): { latitude: number; longitude: number } | null {
  if (locations.length === 0) {
    return null;
  }
  const latitude = locations.reduce((sum, l) => sum + l.latitude, 0) / locations.length;
  const longitude = locations.reduce((sum, l) => sum + l.longitude, 0) / locations.length;
  return { latitude, longitude };
}

export const FALLING_BEHIND_METERS = 500;

export function isFallingBehind(
  location: { latitude: number; longitude: number },
  centroid: { latitude: number; longitude: number } | null,
  thresholdMeters: number = FALLING_BEHIND_METERS,
): boolean {
  if (!centroid) {
    return false;
  }
  return haversineDistanceMeters(location, centroid) > thresholdMeters;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m away`;
  }
  return `${(meters / 1000).toFixed(1)} km away`;
}

export function formatUpdatedAgo(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) {
    return `Updated ${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return `Updated ${minutes}m ago`;
}

export function formatSpeed(metersPerSecond: number): string {
  const kmh = metersPerSecond * 3.6;
  if (kmh < 1) {
    return 'Stopped';
  }
  return `${Math.round(kmh)} km/h`;
}
