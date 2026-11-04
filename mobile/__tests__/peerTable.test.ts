import {
  PEER_OBSERVATION_DEFAULT_FRESHNESS_MS,
  PEER_OBSERVATION_MAX_FRESHNESS_MS,
  PEER_TABLE_DEFAULT_MAX_PEERS,
  PEER_TABLE_MAX_TRANSPORT_ID_LENGTH,
  createPeerTable,
  type PeerTableOptions,
} from '../src/connectivity/peerTable';
import { RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH } from '../src/connectivity/protocol/rideMessage';

const T0 = 1_000_000;
const FRESH = 10_000;

function table(overrides: Partial<PeerTableOptions> = {}) {
  return createPeerTable({ localNodeId: 'node-a', freshnessMs: FRESH, ...overrides });
}

describe('PeerTable: observe', () => {
  test('first observation creates a direct peer', () => {
    const peers = table();

    expect(peers.observe('node-b', 'transport-x', T0)).toEqual({
      observed: true,
      change: 'new_peer',
    });
    expect(peers.getPeer('node-b', T0)).toEqual({
      nodeId: 'node-b',
      lastSeenAt: T0,
      transports: [{ transportId: 'transport-x', lastSeenAt: T0 }],
    });
    expect(peers.isDirectPeer('node-b', T0)).toBe(true);
  });

  test('observing the same peer and transport again updates lastSeenAt in place', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);

    expect(peers.observe('node-b', 'transport-x', T0 + 3_000)).toEqual({
      observed: true,
      change: 'refreshed',
    });
    expect(peers.getPeer('node-b', T0 + 3_000)?.transports).toEqual([
      { transportId: 'transport-x', lastSeenAt: T0 + 3_000 },
    ]);
  });

  test('an out-of-order earlier observation never moves lastSeenAt backwards', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0 + 5_000);

    expect(peers.observe('node-b', 'transport-x', T0)).toMatchObject({ change: 'refreshed' });
    expect(peers.getPeer('node-b', T0 + 5_000)?.lastSeenAt).toBe(T0 + 5_000);
  });

  test('the same peer on two transports remains one peer with two observations', () => {
    const peers = table();
    peers.observe('node-b', 'transport-y', T0);

    expect(peers.observe('node-b', 'transport-x', T0 + 1_000)).toEqual({
      observed: true,
      change: 'new_transport',
    });
    expect(peers.getPeers(T0 + 1_000)).toEqual([
      {
        nodeId: 'node-b',
        lastSeenAt: T0 + 1_000,
        transports: [
          { transportId: 'transport-x', lastSeenAt: T0 + 1_000 },
          { transportId: 'transport-y', lastSeenAt: T0 },
        ],
      },
    ]);
  });

  test('two peers are tracked independently and listed in node-id order', () => {
    const peers = table();
    peers.observe('node-c', 'transport-x', T0);
    peers.observe('node-b', 'transport-y', T0 + 2_000);

    expect(peers.getPeers(T0 + 2_000).map(p => [p.nodeId, p.lastSeenAt])).toEqual([
      ['node-b', T0 + 2_000],
      ['node-c', T0],
    ]);
    expect(peers.getPeer('node-c', T0 + 2_000)?.transports).toEqual([
      { transportId: 'transport-x', lastSeenAt: T0 },
    ]);
  });

  test('the local node can never become its own peer', () => {
    const peers = table();

    expect(peers.observe('node-a', 'transport-x', T0)).toEqual({
      observed: false,
      reason: 'local_node',
    });
    expect(peers.getPeers(T0)).toEqual([]);
  });

  test('transport ids are opaque strings', () => {
    const peers = table();
    peers.observe('node-b', 'anything:goes/7', T0);
    expect(peers.getPeer('node-b', T0)?.transports[0].transportId).toBe('anything:goes/7');
  });
});

describe('PeerTable: direct-only topology', () => {
  test('A observes B and B observes C: A holds B only', () => {
    const a = createPeerTable({ localNodeId: 'node-a' });
    const b = createPeerTable({ localNodeId: 'node-b' });
    a.observe('node-b', 'transport-x', T0);
    b.observe('node-a', 'transport-x', T0);
    b.observe('node-c', 'transport-x', T0);

    expect(a.getPeers(T0).map(p => p.nodeId)).toEqual(['node-b']);
    expect(a.isDirectPeer('node-c', T0)).toBe(false);
    expect(b.getPeers(T0).map(p => p.nodeId)).toEqual(['node-a', 'node-c']);
  });

  test('the only way to add a peer is a direct observation', () => {
    const a = table();
    expect(Object.keys(a).sort()).toEqual([
      'getPeer',
      'getPeers',
      'isDirectPeer',
      'observe',
      'prune',
    ]);
    expect(a.observe.length).toBe(3);
  });
});

describe('PeerTable: freshness', () => {
  test('fresh one ms before the timeout, stale exactly at it', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);

    expect(peers.isDirectPeer('node-b', T0 + FRESH - 1)).toBe(true);
    expect(peers.isDirectPeer('node-b', T0 + FRESH)).toBe(false);
    expect(peers.getPeer('node-b', T0 + FRESH)).toBeUndefined();
    expect(peers.getPeers(T0 + FRESH)).toEqual([]);
  });

  test('a refresh restarts the freshness window', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    peers.observe('node-b', 'transport-x', T0 + FRESH - 1);

    expect(peers.isDirectPeer('node-b', T0 + 2 * FRESH - 2)).toBe(true);
    expect(peers.isDirectPeer('node-b', T0 + 2 * FRESH - 1)).toBe(false);
  });

  test('reads hide stale observations without needing prune', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    peers.observe('node-b', 'transport-y', T0 + 8_000);

    expect(peers.getPeer('node-b', T0 + FRESH)).toEqual({
      nodeId: 'node-b',
      lastSeenAt: T0 + 8_000,
      transports: [{ transportId: 'transport-y', lastSeenAt: T0 + 8_000 }],
    });
  });

  test('uses the documented default freshness', () => {
    const peers = createPeerTable({ localNodeId: 'node-a' });
    peers.observe('node-b', 'transport-x', T0);

    expect(PEER_OBSERVATION_DEFAULT_FRESHNESS_MS).toBe(15_000);
    expect(peers.isDirectPeer('node-b', T0 + 14_999)).toBe(true);
    expect(peers.isDirectPeer('node-b', T0 + 15_000)).toBe(false);
  });
});

describe('PeerTable: pruning', () => {
  test('prune physically removes a stale observation', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    peers.observe('node-b', 'transport-y', T0 + 8_000);

    peers.prune(T0 + FRESH);

    expect(peers.getPeer('node-b', T0 + 1)?.transports.map(t => t.transportId)).toEqual([
      'transport-y',
    ]);
    expect(peers.observe('node-b', 'transport-x', T0 + FRESH)).toMatchObject({
      change: 'new_transport',
    });
  });

  test('B seen over X and Y: X goes stale, B stays direct through Y', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    peers.observe('node-b', 'transport-y', T0 + 8_000);

    peers.prune(T0 + FRESH);

    expect(peers.isDirectPeer('node-b', T0 + FRESH)).toBe(true);
    expect(peers.getPeer('node-b', T0 + FRESH)?.transports).toEqual([
      { transportId: 'transport-y', lastSeenAt: T0 + 8_000 },
    ]);
  });

  test('a peer is removed when its final observation goes stale', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    peers.observe('node-b', 'transport-y', T0 + 8_000);

    peers.prune(T0 + 8_000 + FRESH);

    expect(peers.getPeers(T0 + 1)).toEqual([]);
    expect(peers.observe('node-b', 'transport-y', T0 + 8_000 + FRESH)).toMatchObject({
      change: 'new_peer',
    });
  });

  test('observe also prunes stale entries', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);

    peers.observe('node-c', 'transport-x', T0 + FRESH);

    expect(peers.getPeers(T0 + 1).map(p => p.nodeId)).toEqual(['node-c']);
  });

  test('pruning an empty table is safe', () => {
    const peers = table();
    expect(() => peers.prune(T0)).not.toThrow();
    expect(peers.getPeers(T0)).toEqual([]);
  });

  test('repeated pruning is idempotent', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    peers.observe('node-c', 'transport-x', T0 + 5_000);

    for (let i = 0; i < 4; i++) {
      peers.prune(T0 + FRESH);
      expect(peers.getPeers(T0 + 1).map(p => p.nodeId)).toEqual(['node-c']);
    }
  });

  test('an observation after pruning recreates the peer', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    peers.prune(T0 + FRESH);

    expect(peers.observe('node-b', 'transport-z', T0 + FRESH + 1)).toEqual({
      observed: true,
      change: 'new_peer',
    });
    expect(peers.getPeer('node-b', T0 + FRESH + 1)?.transports).toEqual([
      { transportId: 'transport-z', lastSeenAt: T0 + FRESH + 1 },
    ]);
  });
});

describe('PeerTable: capacity', () => {
  test('refuses new peers when full, but keeps refreshing existing ones', () => {
    const peers = table({ maxPeers: 2 });
    peers.observe('node-b', 'transport-x', T0);
    peers.observe('node-c', 'transport-x', T0);

    expect(peers.observe('node-d', 'transport-x', T0 + 1)).toEqual({
      observed: false,
      reason: 'table_full',
    });
    expect(peers.observe('node-b', 'transport-y', T0 + 1)).toMatchObject({ observed: true });
    expect(peers.getPeers(T0 + 1).map(p => p.nodeId)).toEqual(['node-b', 'node-c']);
  });

  test('stale peers free capacity for new ones', () => {
    const peers = table({ maxPeers: 1 });
    peers.observe('node-b', 'transport-x', T0);

    expect(peers.observe('node-c', 'transport-x', T0 + FRESH)).toMatchObject({
      change: 'new_peer',
    });
  });

  test('a flood of distinct ids never exceeds maxPeers', () => {
    const peers = table({ maxPeers: 10 });
    for (let i = 0; i < 1_000; i++) {
      peers.observe(`spoof-${i}`, 'transport-x', T0 + i);
    }
    expect(peers.getPeers(T0 + 999)).toHaveLength(10);
    expect(PEER_TABLE_DEFAULT_MAX_PEERS).toBe(128);
  });
});

describe('PeerTable: immutability of returned data', () => {
  test('returned peers, lists and observations are frozen', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    const list = peers.getPeers(T0);
    const peer = list[0];

    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(peer)).toBe(true);
    expect(Object.isFrozen(peer.transports)).toBe(true);
    expect(Object.isFrozen(peer.transports[0])).toBe(true);
    expect(() => (list as unknown[]).push({})).toThrow(TypeError);
    expect(() => (peer.transports as unknown[]).pop()).toThrow(TypeError);
    try {
      (peer.transports[0] as { lastSeenAt: number }).lastSeenAt = 0;
    } catch {}
    expect(peer.transports[0].lastSeenAt).toBe(T0);
    expect(peers.getPeer('node-b', T0)?.transports).toEqual([
      { transportId: 'transport-x', lastSeenAt: T0 },
    ]);
  });

  test('a returned snapshot is not affected by later observations', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);
    const before = peers.getPeer('node-b', T0)!;

    peers.observe('node-b', 'transport-y', T0 + 1_000);

    expect(before.transports).toHaveLength(1);
    expect(before.lastSeenAt).toBe(T0);
  });

  test('reads do not mutate the table', () => {
    const peers = table();
    peers.observe('node-b', 'transport-x', T0);

    peers.getPeers(T0 + FRESH);
    peers.getPeer('node-b', T0 + FRESH);
    peers.isDirectPeer('node-b', T0 + FRESH);

    expect(peers.isDirectPeer('node-b', T0 + 1)).toBe(true);
  });
});

describe('PeerTable: input validation', () => {
  test.each<unknown>(['', 'x'.repeat(RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH + 1), 7, null, undefined])(
    'rejects node id %p',
    nodeId => {
      const peers = table();
      expect(peers.observe(nodeId as string, 'transport-x', T0)).toEqual({
        observed: false,
        reason: 'invalid',
      });
      expect(peers.getPeers(T0)).toEqual([]);
    },
  );

  test('accepts a node id of exactly the maximum length', () => {
    const id = 'x'.repeat(RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH);
    expect(table().observe(id, 'transport-x', T0)).toMatchObject({ observed: true });
  });

  test.each<unknown>(['', 'x'.repeat(PEER_TABLE_MAX_TRANSPORT_ID_LENGTH + 1), 7, null, undefined])(
    'rejects transport id %p',
    transportId => {
      const peers = table();
      expect(peers.observe('node-b', transportId as string, T0)).toMatchObject({
        reason: 'invalid',
      });
      expect(peers.getPeers(T0)).toEqual([]);
    },
  );

  test.each<unknown>([NaN, Infinity, -1, 1.5, '1000000', null])(
    'rejects timestamp %p everywhere without throwing or mutating',
    now => {
      const peers = table();
      peers.observe('node-b', 'transport-x', T0);
      const n = now as number;

      expect(peers.observe('node-c', 'transport-x', n)).toMatchObject({ reason: 'invalid' });
      expect(peers.getPeer('node-b', n)).toBeUndefined();
      expect(peers.getPeers(n)).toEqual([]);
      expect(peers.isDirectPeer('node-b', n)).toBe(false);
      expect(() => peers.prune(n)).not.toThrow();
      expect(peers.getPeers(T0).map(p => p.nodeId)).toEqual(['node-b']);
    },
  );

  test('rejects invalid configuration', () => {
    for (const freshnessMs of [0, -1, 1.5, NaN, Infinity, PEER_OBSERVATION_MAX_FRESHNESS_MS + 1]) {
      expect(() => table({ freshnessMs })).toThrow(RangeError);
    }
    expect(() => table({ freshnessMs: PEER_OBSERVATION_MAX_FRESHNESS_MS })).not.toThrow();
    for (const maxPeers of [0, -1, 1.5, NaN]) {
      expect(() => table({ maxPeers })).toThrow(RangeError);
    }
    for (const localNodeId of ['', 'x'.repeat(RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH + 1)]) {
      expect(() => table({ localNodeId })).toThrow(TypeError);
    }
  });
});

describe('PeerTable: isolation', () => {
  test('separate tables do not share state', () => {
    const one = table();
    const two = table();
    one.observe('node-b', 'transport-x', T0);

    expect(two.getPeers(T0)).toEqual([]);
    expect(two.observe('node-b', 'transport-x', T0)).toMatchObject({ change: 'new_peer' });
  });

  test('never schedules timers', () => {
    const timers = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      const peers = table();
      peers.observe('node-b', 'transport-x', T0);
      peers.getPeers(T0 + 1);
      peers.prune(T0 + FRESH);
      for (const spy of timers) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      timers.forEach(spy => spy.mockRestore());
    }
  });

  test('does not depend on any transport, React Native or other connectivity module', () => {
    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'livekit-client',
        '../src/transports/Transport',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/connectivity/rideMessageIngress',
        '../src/connectivity/relayPolicy',
        '../src/connectivity/protocol/seenMessageCache',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`peer table must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/peerTable')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });
});
