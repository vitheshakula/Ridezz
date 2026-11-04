import type { GeoPoint } from '../types/telemetry';

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

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

export function sortByDistance<T extends GeoPoint>(
  origin: GeoPoint,
  nodes: readonly T[],
): WithDistance<T>[] {
  return nodes
    .map(node => ({ node, distanceMeters: haversineDistanceMeters(origin, node) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

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
