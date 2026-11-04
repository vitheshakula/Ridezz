import {
  DIRECT_LINK_DEFAULT_FRESHNESS_MS,
  DIRECT_LINK_DEFAULT_MAX_LINKS,
  DIRECT_LINK_MAX_FRESHNESS_MS,
  DIRECT_LINK_MAX_TRANSPORT_ID_LENGTH,
  DIRECT_LINK_MAX_TRANSPORT_PEER_ID_LENGTH,
  createDirectLinkIdentityMap,
  type DirectLinkIdentityMapOptions,
} from '../src/connectivity/directLinkIdentityMap';
import { PEER_OBSERVATION_DEFAULT_FRESHNESS_MS } from '../src/connectivity/peerTable';
import { RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH } from '../src/connectivity/protocol/rideMessage';

const T0 = 1_000_000;
const FRESH = 10_000;

function links(overrides: Partial<DirectLinkIdentityMapOptions> = {}) {
  return createDirectLinkIdentityMap({ localNodeId: 'rider-a', freshnessMs: FRESH, ...overrides });
}

describe('DirectLinkIdentityMap: observe and resolve', () => {
  test('a first claim creates a link that resolves to the node', () => {
    const map = links();

    expect(map.observe('nearby', 'endpoint-7291', 'rider-b', T0)).toEqual({
      observed: true,
      change: 'new_link',
    });
    expect(map.resolve('nearby', 'endpoint-7291', T0)).toBe('rider-b');
    expect(map.getLinksForNode('rider-b', T0)).toEqual([
      {
        transportId: 'nearby',
        transportPeerId: 'endpoint-7291',
        nodeId: 'rider-b',
        lastSeenAt: T0,
      },
    ]);
  });

  test('the same endpoint repeatedly claiming the same node refreshes it', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);

    expect(map.observe('nearby', 'ep-1', 'rider-b', T0 + 4_000)).toEqual({
      observed: true,
      change: 'refreshed',
    });
    expect(map.getLinksForNode('rider-b', T0 + 4_000)[0].lastSeenAt).toBe(T0 + 4_000);
  });

  test('an out-of-order earlier claim never moves freshness backwards', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0 + 5_000);

    expect(map.observe('nearby', 'ep-1', 'rider-b', T0)).toMatchObject({ change: 'refreshed' });
    expect(map.getLinksForNode('rider-b', T0 + 5_000)[0].lastSeenAt).toBe(T0 + 5_000);
  });

  test('unknown links resolve to undefined', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);
    expect(map.resolve('nearby', 'ep-2', T0)).toBeUndefined();
    expect(map.resolve('ble', 'ep-1', T0)).toBeUndefined();
  });
});

describe('DirectLinkIdentityMap: conflict policy', () => {
  test('a live endpoint claiming another node is reassigned, never dual-mapped', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);

    expect(map.observe('nearby', 'ep-1', 'rider-c', T0 + 1_000)).toEqual({
      observed: true,
      change: 'reassigned',
      previousNodeId: 'rider-b',
    });
    expect(map.resolve('nearby', 'ep-1', T0 + 1_000)).toBe('rider-c');
    expect(map.getLinksForNode('rider-b', T0 + 1_000)).toEqual([]);
    expect(map.getLinksForNode('rider-c', T0 + 1_000)).toHaveLength(1);
  });

  test('a conflicting claim at the same instant is the newest call and wins', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);
    expect(map.observe('nearby', 'ep-1', 'rider-c', T0)).toMatchObject({ change: 'reassigned' });
    expect(map.resolve('nearby', 'ep-1', T0)).toBe('rider-c');
  });

  test('a conflicting claim older than the current mapping is refused', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0 + 5_000);

    expect(map.observe('nearby', 'ep-1', 'rider-c', T0 + 4_999)).toEqual({
      observed: false,
      reason: 'out_of_order',
    });
    expect(map.resolve('nearby', 'ep-1', T0 + 5_000)).toBe('rider-b');
  });

  test('a stale mapping is simply replaced by a new link', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);

    expect(map.observe('nearby', 'ep-1', 'rider-c', T0 + FRESH)).toEqual({
      observed: true,
      change: 'new_link',
    });
    expect(map.resolve('nearby', 'ep-1', T0 + FRESH)).toBe('rider-c');
  });

  test('one node through two endpoints keeps both links', () => {
    const map = links();
    map.observe('nearby', 'ep-123', 'rider-b', T0);
    map.observe('ble', 'AA:BB', 'rider-b', T0 + 1);

    expect(map.getLinksForNode('rider-b', T0 + 1)).toEqual([
      { transportId: 'ble', transportPeerId: 'AA:BB', nodeId: 'rider-b', lastSeenAt: T0 + 1 },
      { transportId: 'nearby', transportPeerId: 'ep-123', nodeId: 'rider-b', lastSeenAt: T0 },
    ]);
  });

  test('a node moving to a new endpoint coexists with the old one until it ages out', () => {
    const map = links();
    map.observe('nearby', 'ep-old', 'rider-b', T0);
    map.observe('nearby', 'ep-new', 'rider-b', T0 + 6_000);

    expect(map.getLinksForNode('rider-b', T0 + 6_000).map(l => l.transportPeerId)).toEqual([
      'ep-new',
      'ep-old',
    ]);
    expect(map.getLinksForNode('rider-b', T0 + FRESH).map(l => l.transportPeerId)).toEqual([
      'ep-new',
    ]);
  });

  test('the same endpoint id on two transports maps independently', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);
    map.observe('ble', 'ep-1', 'rider-c', T0);

    expect(map.resolve('nearby', 'ep-1', T0)).toBe('rider-b');
    expect(map.resolve('ble', 'ep-1', T0)).toBe('rider-c');
  });

  test('ids containing separators cannot collide', () => {
    const map = links();
    map.observe('a', 'b,c', 'rider-b', T0);
    map.observe('a,b', 'c', 'rider-c', T0);
    expect(map.resolve('a', 'b,c', T0)).toBe('rider-b');
    expect(map.resolve('a,b', 'c', T0)).toBe('rider-c');
  });

  test('the local node can never be claimed by a remote endpoint', () => {
    const map = links();
    expect(map.observe('nearby', 'ep-1', 'rider-a', T0)).toEqual({
      observed: false,
      reason: 'local_node',
    });
    expect(map.resolve('nearby', 'ep-1', T0)).toBeUndefined();
  });
});

describe('DirectLinkIdentityMap: freshness and pruning', () => {
  test('fresh one ms before the window, stale exactly at it', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);

    expect(map.resolve('nearby', 'ep-1', T0 + FRESH - 1)).toBe('rider-b');
    expect(map.resolve('nearby', 'ep-1', T0 + FRESH)).toBeUndefined();
    expect(map.getLinksForNode('rider-b', T0 + FRESH)).toEqual([]);
  });

  test('prune physically removes stale links; repeated pruning is stable', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);
    map.observe('nearby', 'ep-2', 'rider-c', T0 + 6_000);

    for (let i = 0; i < 3; i++) {
      map.prune(T0 + FRESH);
      expect(map.resolve('nearby', 'ep-1', T0 + 1)).toBeUndefined();
      expect(map.resolve('nearby', 'ep-2', T0 + 6_001)).toBe('rider-c');
    }
    expect(() => links().prune(T0)).not.toThrow();
  });

  test('reads do not mutate', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);
    map.resolve('nearby', 'ep-1', T0 + FRESH);
    map.getLinksForNode('rider-b', T0 + FRESH);
    expect(map.resolve('nearby', 'ep-1', T0 + 1)).toBe('rider-b');
  });

  test('defaults to the same freshness as direct peer presence', () => {
    expect(DIRECT_LINK_DEFAULT_FRESHNESS_MS).toBe(PEER_OBSERVATION_DEFAULT_FRESHNESS_MS);
    const map = createDirectLinkIdentityMap({ localNodeId: 'rider-a' });
    map.observe('nearby', 'ep-1', 'rider-b', T0);
    expect(map.resolve('nearby', 'ep-1', T0 + 14_999)).toBe('rider-b');
    expect(map.resolve('nearby', 'ep-1', T0 + 15_000)).toBeUndefined();
  });
});

describe('DirectLinkIdentityMap: bounds', () => {
  test('refuses new links when full; existing links still refresh and reassign', () => {
    const map = links({ maxLinks: 2 });
    map.observe('nearby', 'ep-1', 'rider-b', T0);
    map.observe('nearby', 'ep-2', 'rider-c', T0);

    expect(map.observe('nearby', 'ep-3', 'rider-d', T0)).toEqual({
      observed: false,
      reason: 'table_full',
    });
    expect(map.observe('nearby', 'ep-1', 'rider-b', T0 + 1)).toMatchObject({ change: 'refreshed' });
    expect(map.observe('nearby', 'ep-2', 'rider-d', T0 + 1)).toMatchObject({
      change: 'reassigned',
    });
    expect(DIRECT_LINK_DEFAULT_MAX_LINKS).toBe(256);
  });

  test('endpoint-id spam never exceeds maxLinks; stale links free capacity', () => {
    const map = links({ maxLinks: 5 });
    for (let i = 0; i < 500; i++) {
      map.observe('nearby', `spam-${i}`, `rider-${i}`, T0);
    }
    const mapped = Array.from({ length: 500 }, (_, i) => map.resolve('nearby', `spam-${i}`, T0));
    expect(mapped.filter(Boolean)).toHaveLength(5);
    expect(map.observe('nearby', 'late', 'rider-z', T0 + FRESH)).toMatchObject({
      change: 'new_link',
    });
  });

  test.each<[string, unknown[]]>([
    ['empty transport id', ['', 'ep', 'rider-b', T0]],
    [
      'oversized transport id',
      ['x'.repeat(DIRECT_LINK_MAX_TRANSPORT_ID_LENGTH + 1), 'ep', 'rider-b', T0],
    ],
    ['empty transport peer id', ['nearby', '', 'rider-b', T0]],
    [
      'oversized transport peer id',
      ['nearby', 'x'.repeat(DIRECT_LINK_MAX_TRANSPORT_PEER_ID_LENGTH + 1), 'rider-b', T0],
    ],
    ['empty node id', ['nearby', 'ep', '', T0]],
    ['oversized node id', ['nearby', 'ep', 'x'.repeat(RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH + 1), T0]],
    ['invalid time', ['nearby', 'ep', 'rider-b', NaN]],
    ['non-string peer id', ['nearby', 42, 'rider-b', T0]],
  ])('rejects %s without recording anything', (_label, args) => {
    const map = links();
    const [t, p, n, now] = args as [string, string, string, number];
    expect(map.observe(t, p, n, now)).toEqual({ observed: false, reason: 'invalid' });
    expect(map.getLinksForNode('rider-b', T0)).toEqual([]);
  });

  test('invalid read inputs return nothing without throwing', () => {
    const map = links();
    map.observe('nearby', 'ep', 'rider-b', T0);
    expect(map.resolve('nearby', 'ep', NaN)).toBeUndefined();
    expect(map.resolve('nearby', undefined as never, T0)).toBeUndefined();
    expect(map.getLinksForNode('rider-b', -1)).toEqual([]);
    expect(() => map.prune(NaN)).not.toThrow();
    expect(map.resolve('nearby', 'ep', T0)).toBe('rider-b');
  });

  test('rejects invalid configuration', () => {
    expect(() => links({ localNodeId: '' })).toThrow(TypeError);
    for (const freshnessMs of [0, -1, 1.5, DIRECT_LINK_MAX_FRESHNESS_MS + 1]) {
      expect(() => links({ freshnessMs })).toThrow(RangeError);
    }
    expect(() => links({ maxLinks: 0 })).toThrow(RangeError);
  });
});

describe('DirectLinkIdentityMap: snapshots and isolation', () => {
  test('returned links are frozen snapshots', () => {
    const map = links();
    map.observe('nearby', 'ep-1', 'rider-b', T0);
    const before = map.getLinksForNode('rider-b', T0);

    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before[0])).toBe(true);
    expect(() => (before as unknown[]).push({})).toThrow(TypeError);

    map.observe('nearby', 'ep-1', 'rider-b', T0 + 1);
    map.observe('ble', 'ep-9', 'rider-b', T0 + 1);
    expect(before).toHaveLength(1);
    expect(before[0].lastSeenAt).toBe(T0);
  });

  test('separate maps do not share state', () => {
    const one = links();
    one.observe('nearby', 'ep', 'rider-b', T0);
    expect(links().resolve('nearby', 'ep', T0)).toBeUndefined();
  });

  test('no timers and no dependency on transports, PeerTable or React Native', () => {
    const timers = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      const map = links();
      map.observe('nearby', 'ep', 'rider-b', T0);
      map.prune(T0 + FRESH);
      for (const spy of timers) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      timers.forEach(spy => spy.mockRestore());
    }

    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'livekit-client',
        '../src/transports/Transport',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/connectivity/peerTable',
        '../src/connectivity/gatewayState',
        '../src/connectivity/relayPolicy',
        '../src/connectivity/rideMessageIngress',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`identity map must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/directLinkIdentityMap')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });
});
