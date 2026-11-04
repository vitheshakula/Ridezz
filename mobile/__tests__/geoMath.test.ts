import { haversineDistanceMeters, nearestUnvisited, sortByDistance } from '../src/utils/geoMath';

const HYDERABAD = { latitude: 17.385, longitude: 78.4867 };
const GOLCONDA_FORT = { latitude: 17.3833, longitude: 78.4011 };
const CHARMINAR = { latitude: 17.3616, longitude: 78.4747 };

describe('haversineDistanceMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineDistanceMeters(HYDERABAD, HYDERABAD)).toBe(0);
  });

  it("is about 111.2km per degree of latitude at the equator (the formula's own constant)", () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 1, longitude: 0 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(111_195, -2);
  });

  it('matches a known real-world distance within 1%', () => {
    const london = { latitude: 51.5074, longitude: -0.1278 };
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    const km = haversineDistanceMeters(london, paris) / 1000;
    expect(km).toBeGreaterThan(343 * 0.99);
    expect(km).toBeLessThan(343 * 1.01);
  });

  it('is symmetric', () => {
    expect(haversineDistanceMeters(HYDERABAD, GOLCONDA_FORT)).toBeCloseTo(
      haversineDistanceMeters(GOLCONDA_FORT, HYDERABAD),
      6,
    );
  });

  it('handles crossing the antimeridian without blowing up', () => {
    const a = { latitude: 0, longitude: 179.9 };
    const b = { latitude: 0, longitude: -179.9 };
    expect(haversineDistanceMeters(a, b)).toBeLessThan(30_000);
  });

  it('never returns NaN for antipodal points (the asin domain-clamp)', () => {
    const a = { latitude: 10, longitude: 10 };
    const b = { latitude: -10, longitude: -170 };
    expect(Number.isNaN(haversineDistanceMeters(a, b))).toBe(false);
  });
});

describe('sortByDistance', () => {
  it('orders nearest first and attaches the distance', () => {
    const result = sortByDistance(HYDERABAD, [GOLCONDA_FORT, CHARMINAR]);
    expect(result.map(r => r.node)).toEqual([CHARMINAR, GOLCONDA_FORT]);
    expect(result[0].distanceMeters).toBeLessThan(result[1].distanceMeters);
  });

  it('is empty for an empty neighbour list, not an error', () => {
    expect(sortByDistance(HYDERABAD, [])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const nodes = [GOLCONDA_FORT, CHARMINAR];
    const copy = [...nodes];
    sortByDistance(HYDERABAD, nodes);
    expect(nodes).toEqual(copy);
  });
});

describe('nearestUnvisited', () => {
  type Named = { id: string; latitude: number; longitude: number };
  const riders: Named[] = [
    { id: 'fort', ...GOLCONDA_FORT },
    { id: 'charminar', ...CHARMINAR },
  ];
  const idOf = (n: Named) => n.id;

  it('returns the closest node when nothing is excluded', () => {
    expect(nearestUnvisited(HYDERABAD, riders, new Set(), idOf)?.id).toBe('charminar');
  });

  it('skips excluded nodes in distance order', () => {
    expect(nearestUnvisited(HYDERABAD, riders, new Set(['charminar']), idOf)?.id).toBe('fort');
  });

  it('returns null when every node is excluded', () => {
    expect(nearestUnvisited(HYDERABAD, riders, new Set(['charminar', 'fort']), idOf)).toBeNull();
  });

  it('returns null for an empty neighbour list', () => {
    expect(nearestUnvisited(HYDERABAD, [], new Set(), idOf)).toBeNull();
  });
});
