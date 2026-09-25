/**
 * Real road-route fetching via OSRM's public demo server (router.project-osrm.org).
 * No API key required -- MapTiler's own Directions API is beta/gated and wasn't
 * reachable with this project's key (see RiderMap.tsx for that finding). This is
 * a public demo server with no uptime/rate-limit guarantee, not a production
 * dependency: on any failure (network, timeout, non-200, malformed response)
 * callers should fall back to a straight-line guide rather than show nothing.
 */

export interface RoadRoute {
  /** [lng, lat] pairs, ready to feed straight into a MapLibre LineString. */
  coordinates: Array<[number, number]>;
  distanceMeters: number;
  durationSeconds: number;
}

export type RoadRouteResult =
  | { ok: true; route: RoadRoute }
  | { ok: false; reason: string };

const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';
const FETCH_TIMEOUT_MS = 8000;

export async function fetchRoadRouteDetailed(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): Promise<RoadRouteResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${OSRM_BASE_URL}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, reason: `Routing service returned HTTP ${response.status}` };
    }
    const data = await response.json();
    if (data?.code !== 'Ok') {
      return { ok: false, reason: data?.message || data?.code || 'No road route was found' };
    }
    const route = data?.routes?.[0];
    const coordinates = route?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return { ok: false, reason: 'Routing service returned no route geometry' };
    }
    const distanceMeters = route?.distance;
    const durationSeconds = route?.duration;
    if (typeof distanceMeters !== 'number' || typeof durationSeconds !== 'number') {
      return { ok: false, reason: 'Routing service returned incomplete route details' };
    }
    return { ok: true, route: { coordinates, distanceMeters, durationSeconds } };
  } catch (error) {
    // Network failure, timeout (AbortController), or malformed JSON -- all treated
    // the same: no route. Never throws.
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'Routing request timed out'
        : 'Could not reach the routing service';
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

/** Compatibility helper for callers that only care whether a route was found. */
export async function fetchRoadRoute(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): Promise<RoadRoute | null> {
  const result = await fetchRoadRouteDetailed(from, to);
  return result.ok ? result.route : null;
}

/** "8 min" / "1h 12min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}min`;
}
