import {
  GATEWAY_OBSERVATION_DEFAULT_FRESHNESS_MS,
  GATEWAY_OBSERVATION_MAX_FRESHNESS_MS,
  GATEWAY_STATE_DEFAULT_MAX_GATEWAYS,
  GATEWAY_STATE_DEFAULT_MAX_OBSERVATIONS_PER_GATEWAY,
  GATEWAY_STATE_MAX_TRANSPORT_ID_LENGTH,
  createGatewayState,
  type GatewayStateOptions,
} from '../src/connectivity/gatewayState';
import {
  RIDE_MESSAGE_MAX_HOP_LIMIT,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
} from '../src/connectivity/protocol/rideMessage';

const T0 = 1_000_000;
const FRESH = 10_000;

function state(overrides: Partial<GatewayStateOptions> = {}) {
  return createGatewayState({ localNodeId: 'rider-a', freshnessMs: FRESH, ...overrides });
}

describe('GatewayState: observe', () => {
  test('first observation creates a known gateway', () => {
    const gw = state();

    expect(gw.observe('rider-c', 'transport-x', 2, T0)).toEqual({
      observed: true,
      change: 'new_gateway',
    });
    expect(gw.getGateway('rider-c', T0)).toEqual({
      nodeId: 'rider-c',
      lastSeenAt: T0,
      observations: [{ transportId: 'transport-x', hopCount: 2, lastSeenAt: T0 }],
    });
    expect(gw.isKnownGateway('rider-c', T0)).toBe(true);
  });

  test('the same (transport, hopCount) is refreshed in place', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-x', 2, T0);

    expect(gw.observe('rider-c', 'transport-x', 2, T0 + 3_000)).toEqual({
      observed: true,
      change: 'refreshed',
    });
    expect(gw.getGateway('rider-c', T0 + 3_000)?.observations).toEqual([
      { transportId: 'transport-x', hopCount: 2, lastSeenAt: T0 + 3_000 },
    ]);
  });

  test('an out-of-order earlier observation never moves freshness backwards', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-x', 2, T0 + 5_000);

    expect(gw.observe('rider-c', 'transport-x', 2, T0)).toMatchObject({ change: 'refreshed' });
    expect(gw.getGateway('rider-c', T0 + 5_000)?.lastSeenAt).toBe(T0 + 5_000);
  });

  test('two gateways are tracked independently, listed by node id', () => {
    const gw = state();
    gw.observe('rider-d', 'transport-x', 1, T0);
    gw.observe('rider-c', 'transport-y', 3, T0 + 1_000);

    expect(gw.getGateways(T0 + 1_000).map(g => [g.nodeId, g.lastSeenAt])).toEqual([
      ['rider-c', T0 + 1_000],
      ['rider-d', T0],
    ]);
  });

  test('the local node is never recorded as a remote gateway', () => {
    const gw = state();
    expect(gw.observe('rider-a', 'transport-x', 1, T0)).toEqual({
      observed: false,
      reason: 'local_node',
    });
    expect(gw.getGateways(T0)).toEqual([]);
  });
});

describe('GatewayState: multiple observations', () => {
  test('the same gateway via X at hop 2 and Y at hop 3 is one gateway, two observations', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-y', 3, T0);
    expect(gw.observe('rider-c', 'transport-x', 2, T0 + 100)).toEqual({
      observed: true,
      change: 'new_observation',
    });

    expect(gw.getGateways(T0 + 100)).toEqual([
      {
        nodeId: 'rider-c',
        lastSeenAt: T0 + 100,
        observations: [
          { transportId: 'transport-x', hopCount: 2, lastSeenAt: T0 + 100 },
          { transportId: 'transport-y', hopCount: 3, lastSeenAt: T0 },
        ],
      },
    ]);
  });

  test('a later, longer path on the same transport does not erase a fresh shorter one', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-x', 1, T0);
    gw.observe('rider-c', 'transport-x', 4, T0 + 2_000);

    expect(gw.getGateway('rider-c', T0 + 2_000)?.observations.map(o => o.hopCount)).toEqual([1, 4]);
  });

  test('each observation ages out independently', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-x', 1, T0);
    gw.observe('rider-c', 'transport-y', 3, T0 + 6_000);

    expect(gw.getGateway('rider-c', T0 + FRESH)?.observations).toEqual([
      { transportId: 'transport-y', hopCount: 3, lastSeenAt: T0 + 6_000 },
    ]);
  });

  test('transport ids containing separators cannot collide with each other', () => {
    const gw = state();
    gw.observe('rider-c', 'a,1', 2, T0);
    gw.observe('rider-c', 'a', 12, T0);
    expect(gw.getGateway('rider-c', T0)?.observations).toHaveLength(2);
  });
});

describe('GatewayState: freshness and pruning', () => {
  test('fresh one ms before the window, stale exactly at it', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-x', 1, T0);

    expect(gw.isKnownGateway('rider-c', T0 + FRESH - 1)).toBe(true);
    expect(gw.isKnownGateway('rider-c', T0 + FRESH)).toBe(false);
    expect(gw.getGateways(T0 + FRESH)).toEqual([]);
  });

  test('prune physically removes stale observations and empty gateways', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-x', 1, T0);
    gw.observe('rider-d', 'transport-x', 1, T0 + 6_000);

    gw.prune(T0 + FRESH);

    expect(gw.getGateways(T0 + 6_001).map(g => g.nodeId)).toEqual(['rider-d']);
    expect(gw.observe('rider-c', 'transport-x', 1, T0 + FRESH)).toMatchObject({
      change: 'new_gateway',
    });
  });

  test('pruning is safe on an empty state and idempotent', () => {
    const gw = state();
    expect(() => gw.prune(T0)).not.toThrow();
    gw.observe('rider-c', 'transport-x', 1, T0);
    for (let i = 0; i < 3; i++) {
      gw.prune(T0 + FRESH);
      expect(gw.getGateways(T0 + 1)).toEqual([]);
    }
  });

  test('reads do not mutate state', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-x', 1, T0);
    gw.getGateways(T0 + FRESH);
    gw.isKnownGateway('rider-c', T0 + FRESH);
    expect(gw.isKnownGateway('rider-c', T0 + 1)).toBe(true);
  });

  test('uses the documented default freshness', () => {
    const gw = createGatewayState({ localNodeId: 'rider-a' });
    gw.observe('rider-c', 'transport-x', 1, T0);
    expect(GATEWAY_OBSERVATION_DEFAULT_FRESHNESS_MS).toBe(25_000);
    expect(gw.isKnownGateway('rider-c', T0 + 24_999)).toBe(true);
    expect(gw.isKnownGateway('rider-c', T0 + 25_000)).toBe(false);
  });
});

describe('GatewayState: bounds', () => {
  test('refuses new gateways when full but keeps refreshing known ones', () => {
    const gw = state({ maxGateways: 2 });
    gw.observe('rider-c', 'transport-x', 1, T0);
    gw.observe('rider-d', 'transport-x', 1, T0);

    expect(gw.observe('rider-e', 'transport-x', 1, T0)).toEqual({
      observed: false,
      reason: 'table_full',
    });
    expect(gw.observe('rider-c', 'transport-y', 2, T0 + 1)).toMatchObject({ observed: true });
    expect(GATEWAY_STATE_DEFAULT_MAX_GATEWAYS).toBe(64);
  });

  test('a flood of fake gateway ids never exceeds maxGateways', () => {
    const gw = state({ maxGateways: 5 });
    for (let i = 0; i < 500; i++) {
      gw.observe(`fake-${i}`, 'transport-x', 1, T0 + i);
    }
    expect(gw.getGateways(T0 + 499)).toHaveLength(5);
  });

  test('bounds distinct observations per gateway', () => {
    const gw = state({ maxObservationsPerGateway: 2 });
    gw.observe('rider-c', 'transport-x', 1, T0);
    gw.observe('rider-c', 'transport-x', 2, T0);

    expect(gw.observe('rider-c', 'transport-x', 3, T0)).toEqual({
      observed: false,
      reason: 'observations_full',
    });
    expect(gw.observe('rider-c', 'transport-x', 1, T0 + 1)).toMatchObject({ change: 'refreshed' });
    expect(GATEWAY_STATE_DEFAULT_MAX_OBSERVATIONS_PER_GATEWAY).toBe(16);
  });

  test('a refused first observation does not leave an empty gateway behind', () => {
    const gw = state({ maxGateways: 1 });
    gw.observe('rider-c', 'transport-x', 1, T0);
    gw.observe('rider-d', 'transport-x', 1, T0);
    gw.prune(T0 + FRESH);

    expect(gw.observe('rider-d', 'transport-x', 1, T0 + FRESH)).toMatchObject({
      change: 'new_gateway',
    });
  });
});

describe('GatewayState: snapshots and validation', () => {
  test('returned data is frozen and unaffected by later observations', () => {
    const gw = state();
    gw.observe('rider-c', 'transport-x', 1, T0);
    const list = gw.getGateways(T0);
    const before = list[0];

    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.observations)).toBe(true);
    expect(Object.isFrozen(before.observations[0])).toBe(true);
    expect(() => (before.observations as unknown[]).pop()).toThrow(TypeError);

    gw.observe('rider-c', 'transport-y', 2, T0 + 1);
    expect(before.observations).toHaveLength(1);
    expect(gw.getGateway('rider-c', T0 + 1)?.observations).toHaveLength(2);
  });

  test.each<[string, unknown[]]>([
    ['empty node id', ['', 'transport-x', 1, T0]],
    ['oversized node id', ['x'.repeat(RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH + 1), 't', 1, T0]],
    ['empty transport id', ['rider-c', '', 1, T0]],
    [
      'oversized transport id',
      ['rider-c', 'x'.repeat(GATEWAY_STATE_MAX_TRANSPORT_ID_LENGTH + 1), 1, T0],
    ],
    ['negative hop count', ['rider-c', 't', -1, T0]],
    ['fractional hop count', ['rider-c', 't', 1.5, T0]],
    ['hop count above protocol limit', ['rider-c', 't', RIDE_MESSAGE_MAX_HOP_LIMIT + 1, T0]],
    ['invalid time', ['rider-c', 't', 1, NaN]],
  ])('rejects %s without recording anything', (_label, args) => {
    const gw = state();
    const [id, transport, hops, now] = args as [string, string, number, number];
    expect(gw.observe(id, transport, hops, now)).toEqual({ observed: false, reason: 'invalid' });
    expect(gw.getGateways(T0)).toEqual([]);
  });

  test('invalid read times return nothing', () => {
    const gw = state();
    gw.observe('rider-c', 't', 1, T0);
    expect(gw.getGateway('rider-c', NaN)).toBeUndefined();
    expect(gw.getGateways(-1)).toEqual([]);
    expect(() => gw.prune(NaN)).not.toThrow();
    expect(gw.isKnownGateway('rider-c', T0)).toBe(true);
  });

  test('rejects invalid configuration', () => {
    expect(() => state({ localNodeId: '' })).toThrow(TypeError);
    for (const freshnessMs of [0, -1, 1.5, GATEWAY_OBSERVATION_MAX_FRESHNESS_MS + 1]) {
      expect(() => state({ freshnessMs })).toThrow(RangeError);
    }
    expect(() => state({ maxGateways: 0 })).toThrow(RangeError);
    expect(() => state({ maxObservationsPerGateway: 0 })).toThrow(RangeError);
  });

  test('separate instances do not share state', () => {
    const one = state();
    const two = state();
    one.observe('rider-c', 't', 1, T0);
    expect(two.getGateways(T0)).toEqual([]);
  });
});

describe('GatewayState: resolved direct sender (viaNodeId)', () => {
  test('stores viaNodeId when given and omits it otherwise', () => {
    const gw = state();
    gw.observe('rider-c', 'nearby', 1, T0, 'rider-b');
    gw.observe('rider-c', 'nearby', 1, T0);

    const observations = gw.getGateway('rider-c', T0)!.observations;
    expect(observations).toEqual([
      { transportId: 'nearby', hopCount: 1, lastSeenAt: T0 },
      { transportId: 'nearby', hopCount: 1, lastSeenAt: T0, viaNodeId: 'rider-b' },
    ]);
    expect(observations[0]).not.toHaveProperty('viaNodeId');
  });

  test('different senders at the same transport and hop count stay separate', () => {
    const gw = state();
    gw.observe('rider-c', 'nearby', 1, T0, 'rider-b');
    expect(gw.observe('rider-c', 'nearby', 1, T0 + 1, 'rider-d')).toMatchObject({
      change: 'new_observation',
    });
    expect(gw.observe('rider-c', 'nearby', 1, T0 + 2, 'rider-b')).toMatchObject({
      change: 'refreshed',
    });
    expect(gw.getGateway('rider-c', T0 + 2)?.observations.map(o => o.viaNodeId)).toEqual([
      'rider-b',
      'rider-d',
    ]);
  });

  test('rejects an invalid or local viaNodeId', () => {
    const gw = state();
    for (const via of ['', 'x'.repeat(RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH + 1), 'rider-a', 7]) {
      expect(gw.observe('rider-c', 'nearby', 1, T0, via as string)).toEqual({
        observed: false,
        reason: 'invalid',
      });
    }
    expect(gw.getGateways(T0)).toEqual([]);
  });
});
