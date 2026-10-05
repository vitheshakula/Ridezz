import type { GeoPoint } from '../types/telemetry';

/** Mean Earth radius, in metres (the same constant most GPS/mapping haversine implementations
 * use; the ~0.3% error against the WGS84 ellipsoid is irrelevant at bike-to-bike mesh range). */
const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two points, in metres. Pure and side-effect free, so the relay
 * and sorting logic built on it (below, and in bleMeshManager.ts) can be unit-tested without GPS. */
export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface WithDistance<T> {
  node: T;
  distanceMeters: number;
}

/** `nodes`, nearest to `origin` first. Does not mutate `nodes`. Empty input gives an empty result --
 * callers don't need to special-case "no neighbours yet". */
export function sortByDistance<T extends GeoPoint>(origin: GeoPoint, nodes: readonly T[]): WithDistance<T>[] {
  return nodes
    .map(node => ({ node, distanceMeters: haversineDistanceMeters(origin, node) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/**
 * The nearest node to `origin` whose id (via `idOf`) is not in `exclude`, or null when every known
 * node is excluded (including when there are no known nodes at all). Used both to pick a relay
 * target and, in bleMeshManager's suppression check, to ask "am I that node?".
 */
export function nearestUnvisited<T extends GeoPoint>(
  origin: GeoPoint,
  nodes: readonly T[],
  exclude: ReadonlySet<string>,
  idOf: (node: T) => string,
): T | null {
  for (const { node } of sortByDistance(origin, nodes)) {
    if (!exclude.has(idOf(node))) {
      return node;
    }
  }
  return null;
}
