import { haversineDistanceMeters } from './geoMath';
import type { GeoPoint } from '../types/telemetry';

/** Beyond this, the rider is considered off the cached route. 30-50m (per the original ask) would
 * false-positive on an ordinary two-lane road's own width plus GPS error; 40m is the midpoint and
 * already generous versus typical consumer GPS accuracy (~5-15m). */
export const OFF_ROUTE_THRESHOLD_METERS = 40;

/** A single stray fix (a GPS jump, a bridge/tunnel multipath blip) shouldn't trigger a "you are
 * off route" alert -- require this many consecutive fixes past the threshold first. */
export const OFF_ROUTE_CONSECUTIVE_FIXES = 2;

/**
 * The closest point on `route` to `point`, and the distance to it -- the perpendicular
 * ("cross-track") distance to the nearest segment, not just the nearest vertex, so a rider
 * between two route points isn't measured against whichever endpoint happens to be nearer.
 *
 * Projects each segment with an equirectangular (locally-flat) approximation rather than an exact
 * great-circle cross-track formula: route segments are road-scale (tens to a few hundred metres),
 * far short of where the sphere's curvature would matter at a 40m threshold, and the flat
 * projection is simple enough to stay a pure, easily-tested function.
 */
export function nearestPointOnRoute(
  point: GeoPoint,
  route: readonly GeoPoint[],
): { point: GeoPoint; distanceMeters: number } | null {
  if (route.length === 0) {
    return null;
  }
  if (route.length === 1) {
    return { point: route[0], distanceMeters: haversineDistanceMeters(point, route[0]) };
  }

  let best: { point: GeoPoint; distanceMeters: number } | null = null;
  for (let i = 0; i < route.length - 1; i++) {
    const candidate = closestPointOnSegment(point, route[i], route[i + 1]);
    const distanceMeters = haversineDistanceMeters(point, candidate);
    if (!best || distanceMeters < best.distanceMeters) {
      best = { point: candidate, distanceMeters };
    }
  }
  return best;
}

function closestPointOnSegment(p: GeoPoint, a: GeoPoint, b: GeoPoint): GeoPoint {
  // Longitude degrees shrink toward the poles; scale by cos(latitude) so this segment's local
  // patch is treated as flat and isotropic before projecting p onto it.
  const latRad = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const k = Math.cos(latRad);

  const ax = a.longitude * k;
  const ay = a.latitude;
  const bx = b.longitude * k;
  const by = b.latitude;
  const px = p.longitude * k;
  const py = p.latitude;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));

  return {
    latitude: a.latitude + t * (b.latitude - a.latitude),
    longitude: a.longitude + t * (b.longitude - a.longitude),
  };
}

export interface OffRouteState {
  isOffRoute: boolean;
  /** True only on the fix that flipped `isOffRoute` -- callers use this to fire an alert once per
   * transition rather than on every fix while already (or still not) off-route. */
  justChanged: boolean;
  /** Null when there's no route to measure against at all. */
  nearestPoint: GeoPoint | null;
  distanceMeters: number | null;
}

/**
 * Tracks whether the rider has drifted off a cached route, debounced by
 * OFF_ROUTE_CONSECUTIVE_FIXES so a single bad fix doesn't trigger a false "off route" alert, and
 * symmetrically debounced coming back (OFF_ROUTE_CONSECUTIVE_FIXES on-route fixes before clearing)
 * so a rider weaving along the route's own edge doesn't flap the state every other update.
 */
export class OffRouteTracker {
  private offRouteStreak = 0;
  private onRouteStreak = 0;
  private isOffRoute = false;

  constructor(
    private readonly thresholdMeters: number = OFF_ROUTE_THRESHOLD_METERS,
    private readonly consecutiveFixes: number = OFF_ROUTE_CONSECUTIVE_FIXES,
  ) {}

  update(point: GeoPoint, route: readonly GeoPoint[]): OffRouteState {
    const nearest = nearestPointOnRoute(point, route);
    if (!nearest) {
      return { isOffRoute: this.isOffRoute, justChanged: false, nearestPoint: null, distanceMeters: null };
    }

    const beyondThreshold = nearest.distanceMeters > this.thresholdMeters;
    if (beyondThreshold) {
      this.offRouteStreak += 1;
      this.onRouteStreak = 0;
    } else {
      this.onRouteStreak += 1;
      this.offRouteStreak = 0;
    }

    const wasOffRoute = this.isOffRoute;
    if (!this.isOffRoute && this.offRouteStreak >= this.consecutiveFixes) {
      this.isOffRoute = true;
    } else if (this.isOffRoute && this.onRouteStreak >= this.consecutiveFixes) {
      this.isOffRoute = false;
    }

    return {
      isOffRoute: this.isOffRoute,
      justChanged: this.isOffRoute !== wasOffRoute,
      nearestPoint: nearest.point,
      distanceMeters: nearest.distanceMeters,
    };
  }

  reset(): void {
    this.offRouteStreak = 0;
    this.onRouteStreak = 0;
    this.isOffRoute = false;
  }
}
