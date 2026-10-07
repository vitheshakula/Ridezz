import {
  nearestPointOnRoute,
  OffRouteTracker,
  OFF_ROUTE_THRESHOLD_METERS,
} from '../src/utils/routeDeviation';
import { haversineDistanceMeters } from '../src/utils/geoMath';
import type { GeoPoint } from '../src/types/telemetry';

// A short straight road segment, roughly 150m long, running due east along the equator -- easy to
// reason about distances by eye (1e-3 deg longitude at the equator is ~111m).
const ROUTE: GeoPoint[] = [
  { latitude: 0, longitude: 0 },
  { latitude: 0, longitude: 0.001 },
  { latitude: 0, longitude: 0.002 },
];

describe('nearestPointOnRoute', () => {
  it('returns null for an empty route', () => {
    expect(nearestPointOnRoute({ latitude: 0, longitude: 0 }, [])).toBeNull();
  });

  it('measures straight to the single point of a one-point route', () => {
    const result = nearestPointOnRoute({ latitude: 0.001, longitude: 0 }, [{ latitude: 0, longitude: 0 }]);
    expect(result?.distanceMeters).toBeCloseTo(haversineDistanceMeters({ latitude: 0.001, longitude: 0 }, { latitude: 0, longitude: 0 }), 3);
  });

  it('finds ~0 distance for a point sitting exactly on a route vertex', () => {
    const result = nearestPointOnRoute({ latitude: 0, longitude: 0.001 }, ROUTE);
    expect(result?.distanceMeters).toBeLessThan(1);
  });

  it('finds the perpendicular distance to a segment, not just the nearer endpoint', () => {
    // Directly above the segment's midpoint, not above either vertex.
    const point: GeoPoint = { latitude: 0.0005, longitude: 0.0005 };
    const result = nearestPointOnRoute(point, ROUTE);
    // Perpendicular distance (~55m) should be meaningfully less than the distance to either
    // endpoint (~79m via Pythagoras on the same offsets).
    expect(result?.distanceMeters).toBeLessThan(haversineDistanceMeters(point, ROUTE[0]));
    expect(result?.distanceMeters).toBeLessThan(haversineDistanceMeters(point, ROUTE[1]));
  });

  it('clamps to a segment\'s endpoint when the point is beyond it, not the infinite line', () => {
    // East of the whole route, not between any two of its points.
    const point: GeoPoint = { latitude: 0, longitude: 0.01 };
    const result = nearestPointOnRoute(point, ROUTE);
    expect(result?.point.longitude).toBeCloseTo(0.002, 5);
  });
});

describe('OffRouteTracker', () => {
  const onRoutePoint: GeoPoint = { latitude: 0, longitude: 0.001 }; // on the route
  const farPoint: GeoPoint = { latitude: 0.001, longitude: 0.001 }; // ~111m north -- well off

  it('stays on-route for a single fix beyond the threshold (debounced)', () => {
    const tracker = new OffRouteTracker();
    const state = tracker.update(farPoint, ROUTE);
    expect(state.isOffRoute).toBe(false);
    expect(state.justChanged).toBe(false);
  });

  it('flips to off-route only after the configured number of consecutive fixes', () => {
    const tracker = new OffRouteTracker();
    tracker.update(farPoint, ROUTE);
    const second = tracker.update(farPoint, ROUTE);
    expect(second.isOffRoute).toBe(true);
    expect(second.justChanged).toBe(true);
  });

  it('does not re-report justChanged on subsequent off-route fixes', () => {
    const tracker = new OffRouteTracker();
    tracker.update(farPoint, ROUTE);
    tracker.update(farPoint, ROUTE);
    const third = tracker.update(farPoint, ROUTE);
    expect(third.isOffRoute).toBe(true);
    expect(third.justChanged).toBe(false);
  });

  it('a single on-route fix does not immediately clear an established off-route state', () => {
    const tracker = new OffRouteTracker();
    tracker.update(farPoint, ROUTE);
    tracker.update(farPoint, ROUTE);
    const backOnce = tracker.update(onRoutePoint, ROUTE);
    expect(backOnce.isOffRoute).toBe(true);
    expect(backOnce.justChanged).toBe(false);
  });

  it('clears off-route after the configured number of consecutive on-route fixes', () => {
    const tracker = new OffRouteTracker();
    tracker.update(farPoint, ROUTE);
    tracker.update(farPoint, ROUTE);
    tracker.update(onRoutePoint, ROUTE);
    const cleared = tracker.update(onRoutePoint, ROUTE);
    expect(cleared.isOffRoute).toBe(false);
    expect(cleared.justChanged).toBe(true);
  });

  it('an off-route streak resets if an on-route fix interrupts it', () => {
    const tracker = new OffRouteTracker();
    tracker.update(farPoint, ROUTE); // 1 off-route
    tracker.update(onRoutePoint, ROUTE); // interrupts the streak
    const stillOn = tracker.update(farPoint, ROUTE); // only 1 off-route again
    expect(stillOn.isOffRoute).toBe(false);
  });

  it('honours a custom threshold', () => {
    const lenient = new OffRouteTracker(1000, 1);
    const state = lenient.update(farPoint, ROUTE); // ~111m, under a 1000m threshold
    expect(state.isOffRoute).toBe(false);
  });

  it('reports no route (null nearestPoint) without throwing, and does not flip state', () => {
    const tracker = new OffRouteTracker();
    const state = tracker.update(farPoint, []);
    expect(state.nearestPoint).toBeNull();
    expect(state.isOffRoute).toBe(false);
    expect(state.justChanged).toBe(false);
  });

  it('reset() clears an established off-route state back to on-route', () => {
    const tracker = new OffRouteTracker();
    tracker.update(farPoint, ROUTE);
    tracker.update(farPoint, ROUTE);
    tracker.reset();
    const state = tracker.update(farPoint, ROUTE);
    expect(state.isOffRoute).toBe(false); // first fix post-reset, debounce starts over
  });

  it('OFF_ROUTE_THRESHOLD_METERS is the real default (40m), not left at some placeholder', () => {
    expect(OFF_ROUTE_THRESHOLD_METERS).toBe(40);
  });
});
