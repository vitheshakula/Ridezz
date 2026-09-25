import { fetchRoadRouteDetailed, formatDuration } from '../src/services/routingService';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('formatDuration', () => {
  test('formats sub-hour durations in minutes', () => {
    expect(formatDuration(480)).toBe('8 min');
  });

  test('rounds to the nearest minute', () => {
    expect(formatDuration(90)).toBe('2 min');
  });

  test('formats hour-plus durations as "Xh Ymin"', () => {
    expect(formatDuration(72 * 60)).toBe('1h 12min');
  });

  test('an exact hour has no leftover minutes', () => {
    expect(formatDuration(60 * 60)).toBe('1h 0min');
  });
});

describe('fetchRoadRouteDetailed', () => {
  test('returns parsed GeoJSON route details', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [
          {
            geometry: { coordinates: [[78.4, 17.3], [78.5, 17.4]] },
            distance: 1200,
            duration: 300,
          },
        ],
      }),
    } as Response);

    await expect(
      fetchRoadRouteDetailed(
        { latitude: 17.3, longitude: 78.4 },
        { latitude: 17.4, longitude: 78.5 },
      ),
    ).resolves.toEqual({
      ok: true,
      route: {
        coordinates: [[78.4, 17.3], [78.5, 17.4]],
        distanceMeters: 1200,
        durationSeconds: 300,
      },
    });
  });

  test('returns a useful reason for an HTTP failure', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(
      fetchRoadRouteDetailed(
        { latitude: 17.3, longitude: 78.4 },
        { latitude: 17.4, longitude: 78.5 },
      ),
    ).resolves.toEqual({ ok: false, reason: 'Routing service returned HTTP 503' });
  });
});
