import {
  FALLING_BEHIND_METERS,
  LOCATION_PAYLOAD_VERSION,
  classifyFreshness,
  computeCentroid,
  decodeLocationPayload,
  encodeLocationPayload,
  formatDistance,
  formatSpeed,
  haversineDistanceMeters,
  isFallingBehind,
  markRiderDisconnected,
  upsertRiderLocation,
  type RiderLocation,
  type RiderLocationState,
} from '../src/utils/riderLocation';

describe('encodeLocationPayload / decodeLocationPayload', () => {
  test('a valid payload round-trips', () => {
    const now = 1_700_000_000_000;
    const bytes = encodeLocationPayload({ lat: 17.123456, lng: 78.123456, accuracy: 8.2, timestamp: now });
    const decoded = decodeLocationPayload(bytes, now);
    expect(decoded).toEqual({
      v: LOCATION_PAYLOAD_VERSION,
      lat: 17.123456,
      lng: 78.123456,
      accuracy: 8.2,
      timestamp: now,
    });
  });

  test('rejects malformed JSON', () => {
    const bytes = new TextEncoder().encode('{not valid json');
    expect(decodeLocationPayload(bytes)).toBeNull();
  });

  test('rejects an unsupported version', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 99, lat: 1, lng: 1, timestamp: Date.now() }),
    );
    expect(decodeLocationPayload(bytes)).toBeNull();
  });

  test('rejects an out-of-range latitude', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, lat: 200, lng: 1, timestamp: Date.now() }),
    );
    expect(decodeLocationPayload(bytes)).toBeNull();
  });

  test('rejects an out-of-range longitude', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, lat: 1, lng: -200, timestamp: Date.now() }),
    );
    expect(decodeLocationPayload(bytes)).toBeNull();
  });

  test('rejects non-numeric coordinates', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, lat: '17.4', lng: 78.4, timestamp: Date.now() }),
    );
    expect(decodeLocationPayload(bytes)).toBeNull();
  });

  test('rejects a non-positive timestamp', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, lat: 1, lng: 1, timestamp: 0 }));
    expect(decodeLocationPayload(bytes)).toBeNull();
  });

  test('rejects a missing timestamp', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, lat: 1, lng: 1 }));
    expect(decodeLocationPayload(bytes)).toBeNull();
  });

  test('rejects a timestamp absurdly far in the future', () => {
    const now = 1_700_000_000_000;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, lat: 1, lng: 1, timestamp: now + 60 * 60 * 1000 }),
    );
    expect(decodeLocationPayload(bytes, now)).toBeNull();
  });

  test('rejects a non-object payload', () => {
    const bytes = new TextEncoder().encode(JSON.stringify('just a string'));
    expect(decodeLocationPayload(bytes)).toBeNull();
  });

  test('accuracy is optional', () => {
    const now = 1_700_000_000_000;
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, lat: 1, lng: 1, timestamp: now }));
    expect(decodeLocationPayload(bytes, now)).toEqual({ v: 1, lat: 1, lng: 1, accuracy: undefined, timestamp: now });
  });

  test('speed and heading round-trip', () => {
    const now = 1_700_000_000_000;
    const bytes = encodeLocationPayload({
      lat: 17.4,
      lng: 78.4,
      accuracy: 5,
      speed: 12.5,
      heading: 270,
      timestamp: now,
    });
    expect(decodeLocationPayload(bytes, now)).toEqual({
      v: LOCATION_PAYLOAD_VERSION,
      lat: 17.4,
      lng: 78.4,
      accuracy: 5,
      speed: 12.5,
      heading: 270,
      timestamp: now,
    });
  });

  test('a negative speed is dropped rather than trusted', () => {
    const now = 1_700_000_000_000;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, lat: 1, lng: 1, speed: -5, timestamp: now }),
    );
    expect(decodeLocationPayload(bytes, now)?.speed).toBeUndefined();
  });

  test('an out-of-range heading is dropped rather than trusted', () => {
    const now = 1_700_000_000_000;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, lat: 1, lng: 1, heading: 400, timestamp: now }),
    );
    expect(decodeLocationPayload(bytes, now)?.heading).toBeUndefined();
  });
});

describe('upsertRiderLocation / markRiderDisconnected', () => {
  const payload = { v: 1 as const, lat: 10, lng: 20, timestamp: 1000 };

  test('adds a new rider location', () => {
    const state = upsertRiderLocation({}, { identity: 'rahul', name: 'Rahul', payload });
    expect(state.rahul).toEqual({
      participantIdentity: 'rahul',
      participantName: 'Rahul',
      latitude: 10,
      longitude: 20,
      accuracy: undefined,
      timestamp: 1000,
      connected: true,
    });
  });

  test('a newer update replaces the old one for the same rider', () => {
    let state = upsertRiderLocation({}, { identity: 'rahul', name: 'Rahul', payload });
    state = upsertRiderLocation(state, {
      identity: 'rahul',
      name: 'Rahul',
      payload: { v: 1, lat: 11, lng: 21, timestamp: 2000 },
    });
    expect(Object.keys(state)).toEqual(['rahul']);
    expect(state.rahul.latitude).toBe(11);
    expect(state.rahul.timestamp).toBe(2000);
  });

  test('does not mutate the previous state object', () => {
    const original: RiderLocationState = {};
    const next = upsertRiderLocation(original, { identity: 'rahul', name: 'Rahul', payload });
    expect(original).toEqual({});
    expect(next).not.toBe(original);
  });

  test('disconnecting keeps the last known location but marks it disconnected', () => {
    let state = upsertRiderLocation({}, { identity: 'rahul', name: 'Rahul', payload });
    state = markRiderDisconnected(state, 'rahul');
    expect(state.rahul.connected).toBe(false);
    expect(state.rahul.latitude).toBe(10);
  });

  test('disconnecting a rider we never had a location for is a no-op', () => {
    const state: RiderLocationState = {};
    expect(markRiderDisconnected(state, 'unknown')).toBe(state);
  });

  test('tracks 10 riders independently', () => {
    let state: RiderLocationState = {};
    for (let i = 0; i < 10; i++) {
      state = upsertRiderLocation(state, {
        identity: `rider-${i}`,
        name: `Rider ${i}`,
        payload: { v: 1, lat: i, lng: i, timestamp: 1000 + i },
      });
    }
    expect(Object.keys(state)).toHaveLength(10);
    expect(state['rider-7'].latitude).toBe(7);
  });
});

describe('classifyFreshness', () => {
  function location(overrides: Partial<RiderLocation> = {}): RiderLocation {
    return {
      participantIdentity: 'rahul',
      participantName: 'Rahul',
      latitude: 0,
      longitude: 0,
      timestamp: 100_000,
      connected: true,
      ...overrides,
    };
  }

  test('under 10s old and connected is live', () => {
    expect(classifyFreshness(location({ timestamp: 100_000 }), 105_000)).toBe('live');
  });

  test('10-60s old and connected is stale', () => {
    expect(classifyFreshness(location({ timestamp: 100_000 }), 140_000)).toBe('stale');
  });

  test('over 60s old and connected is offline', () => {
    expect(classifyFreshness(location({ timestamp: 100_000 }), 170_000)).toBe('offline');
  });

  test('disconnected is offline even with a fresh timestamp', () => {
    expect(classifyFreshness(location({ timestamp: 100_000, connected: false }), 100_500)).toBe('offline');
  });
});

describe('haversineDistanceMeters', () => {
  test('distance between the same point is zero', () => {
    const p = { latitude: 17.4, longitude: 78.4 };
    expect(haversineDistanceMeters(p, p)).toBeCloseTo(0, 3);
  });

  test('known distance: roughly 1 degree of latitude is ~111km', () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 1, longitude: 0 };
    const distance = haversineDistanceMeters(a, b);
    expect(distance).toBeGreaterThan(110_000);
    expect(distance).toBeLessThan(112_000);
  });

  test('is symmetric', () => {
    const a = { latitude: 17.41, longitude: 78.48 };
    const b = { latitude: 17.42, longitude: 78.49 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a), 6);
  });
});

describe('formatDistance', () => {
  test('formats sub-kilometer distances in meters', () => {
    expect(formatDistance(820)).toBe('820 m away');
  });

  test('formats kilometer-plus distances in km', () => {
    expect(formatDistance(1234)).toBe('1.2 km away');
  });
});

describe('formatSpeed', () => {
  test('converts m/s to rounded km/h', () => {
    expect(formatSpeed(10)).toBe('36 km/h');
  });

  test('near-zero speed reads as Stopped, not "0 km/h"', () => {
    expect(formatSpeed(0.1)).toBe('Stopped');
    expect(formatSpeed(0)).toBe('Stopped');
  });
});

describe('computeCentroid', () => {
  test('returns null for an empty group', () => {
    expect(computeCentroid([])).toBeNull();
  });

  test('a single point is its own centroid', () => {
    const p = { latitude: 17.4, longitude: 78.4 };
    expect(computeCentroid([p])).toEqual(p);
  });

  test('averages multiple points', () => {
    const centroid = computeCentroid([
      { latitude: 0, longitude: 0 },
      { latitude: 2, longitude: 4 },
    ]);
    expect(centroid).toEqual({ latitude: 1, longitude: 2 });
  });
});

describe('isFallingBehind', () => {
  const centroid = { latitude: 17.4, longitude: 78.4 };

  test('false when there is no centroid (e.g. rider alone in the room)', () => {
    expect(isFallingBehind({ latitude: 17.4, longitude: 78.4 }, null)).toBe(false);
  });

  test('false for a rider close to the group', () => {
    expect(isFallingBehind({ latitude: 17.4001, longitude: 78.4001 }, centroid)).toBe(false);
  });

  test('true for a rider well past the threshold', () => {
    // ~0.01 degrees of latitude is roughly 1.1km, comfortably over FALLING_BEHIND_METERS.
    expect(isFallingBehind({ latitude: 17.41, longitude: 78.4 }, centroid)).toBe(true);
  });

  test('respects a custom threshold', () => {
    expect(
      isFallingBehind({ latitude: 17.4001, longitude: 78.4001 }, centroid, 1),
    ).toBe(true);
  });
});

test('FALLING_BEHIND_METERS is a sane positive default', () => {
  expect(FALLING_BEHIND_METERS).toBeGreaterThan(0);
});
