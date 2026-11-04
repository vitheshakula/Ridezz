import { haversineDistanceMeters } from './geoMath';
import type { GeoPoint } from '../types/telemetry';

export const OFF_ROUTE_THRESHOLD_METERS = 40;

export const OFF_ROUTE_CONSECUTIVE_FIXES = 2;

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
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));

  return {
    latitude: a.latitude + t * (b.latitude - a.latitude),
    longitude: a.longitude + t * (b.longitude - a.longitude),
  };
}

export interface OffRouteState {
  isOffRoute: boolean;
  justChanged: boolean;
  nearestPoint: GeoPoint | null;
  distanceMeters: number | null;
}

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
      return {
        isOffRoute: this.isOffRoute,
        justChanged: false,
        nearestPoint: null,
        distanceMeters: null,
      };
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
