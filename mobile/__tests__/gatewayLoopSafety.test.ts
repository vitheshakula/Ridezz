import {
  gatewayRouteDistance,
  getGatewayRouteCandidates,
  resolvePreviousHop,
  selectGatewayForwardingRoute,
  selectGatewayRoute,
  type GatewayForwardingContext,
  type GatewayForwardingDecision,
  type GatewayRouteCandidate,
} from '../src/connectivity/gatewayRouting';
import { handleGatewayAdvertisement } from '../src/connectivity/gatewayAdvertisementHandler';
import { handleHeartbeat } from '../src/connectivity/heartbeatHandler';
import { createDirectLinkIdentityMap } from '../src/connectivity/directLinkIdentityMap';
import { createGatewayState } from '../src/connectivity/gatewayState';
import { createPeerTable } from '../src/connectivity/peerTable';
import { decideRelay } from '../src/connectivity/relayPolicy';
import {
  createRideMessageIngress,
  type RideMessageIngressSource,
} from '../src/connectivity/rideMessageIngress';
import { createGatewayAdvertisementMessage } from '../src/connectivity/protocol/gatewayAdvertisement';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import { createRideMessage, type RideMessage } from '../src/connectivity/protocol/rideMessage';
import { encodeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';

const WALL = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';
const GW = 'rider-c';

function route(
  nextHopNodeId: string,
  hopCount: number,
  gatewayNodeId = GW,
  transportId = 'nearby',
): GatewayRouteCandidate {
  return { gatewayNodeId, nextHopNodeId, transportId, hopCount, observedAt: MONO };
}

type Topology = Record<string, readonly GatewayRouteCandidate[]>;

interface Walk {
  path: string[];
  distances: number[];
  stop: 'delivered' | Extract<GatewayForwardingDecision, { ok: false }>['reason'];
}

function walk(topology: Topology, start: string, gatewayNodeId?: string): Walk {
  const path = [start];
  const distances: number[] = [];
  let at = start;
  let received: GatewayForwardingContext['received'];
  for (let step = 0; step < 64; step++) {
    const decision = selectGatewayForwardingRoute(topology[at] ?? [], { gatewayNodeId, received });
    if (!decision.ok) {
      return { path, distances, stop: decision.reason };
    }
    distances.push(decision.distance);
    const next = decision.route.nextHopNodeId;
    path.push(next);
    if (next === decision.route.gatewayNodeId) {
      return { path, distances, stop: 'delivered' };
    }
    received = { fromNodeId: at, distanceBound: decision.distance };
    at = next;
  }
  throw new Error(`walk did not terminate: ${path.join(' -> ')}`);
}

function expectStrictlyDecreasing(distances: number[]) {
  for (let i = 1; i < distances.length; i++) {
    expect(distances[i]).toBeLessThan(distances[i - 1]);
  }
}

describe('hop and distance semantics', () => {
  test('hopCount is the next hop’s distance; this node’s distance is hopCount + 1', () => {
    expect(gatewayRouteDistance(route(GW, 0))).toBe(1);
    expect(gatewayRouteDistance(route('rider-b', 1))).toBe(2);
    expect(gatewayRouteDistance(route('rider-d', 3))).toBe(4);
  });
});

describe('strict progress', () => {
  test('a direct gateway is valid and terminal', () => {
    const decision = selectGatewayForwardingRoute([route(GW, 0)], {
      received: { fromNodeId: 'rider-a', distanceBound: 2 },
    });
    expect(decision).toEqual({ ok: true, route: route(GW, 0), distance: 1 });
  });

  test('a strictly smaller distance is accepted', () => {
    expect(
      selectGatewayForwardingRoute([route('rider-b', 1)], {
        received: { fromNodeId: 'rider-a', distanceBound: 3 },
      }),
    ).toMatchObject({ ok: true, distance: 2 });
  });

  test('an equal distance across a forwarding edge is rejected', () => {
    expect(
      selectGatewayForwardingRoute([route('rider-b', 1)], {
        received: { fromNodeId: 'rider-a', distanceBound: 2 },
      }),
    ).toEqual({ ok: false, reason: 'no_progress' });
  });

  test('an increasing distance is rejected', () => {
    expect(
      selectGatewayForwardingRoute([route('rider-b', 3)], {
        received: { fromNodeId: 'rider-a', distanceBound: 2 },
      }),
    ).toEqual({ ok: false, reason: 'no_progress' });
  });

  test('only progressing routes are eligible; the best of them is chosen', () => {
    const decision = selectGatewayForwardingRoute(
      [route('rider-b', 3), route('rider-e', 1), route('rider-d', 2)],
      { received: { fromNodeId: 'rider-a', distanceBound: 3 } },
    );
    expect(decision).toEqual({ ok: true, route: route('rider-e', 1), distance: 2 });
  });

  test.each<[string, number | undefined]>([
    ['missing', undefined],
    ['NaN', NaN],
    ['negative', -1],
    ['fractional', 1.5],
    ['infinite', Infinity],
  ])('an unknown (%s) distance bound fails closed', (_label, distanceBound) => {
    expect(
      selectGatewayForwardingRoute([route(GW, 0)], {
        received: { fromNodeId: 'rider-a', distanceBound },
      }),
    ).toEqual({ ok: false, reason: 'unknown_progress' });
  });

  test('a bound of 0 admits nothing: no route has distance below zero', () => {
    expect(
      selectGatewayForwardingRoute([route(GW, 0)], {
        received: { fromNodeId: 'rider-a', distanceBound: 0 },
      }),
    ).toEqual({ ok: false, reason: 'no_progress' });
  });

  test('no candidates (or none for the target gateway) is no_route', () => {
    expect(selectGatewayForwardingRoute([])).toEqual({ ok: false, reason: 'no_route' });
    expect(
      selectGatewayForwardingRoute([route('rider-b', 1, 'rider-e')], { gatewayNodeId: GW }),
    ).toEqual({ ok: false, reason: 'no_route' });
  });
});

describe('split horizon', () => {
  test('never forwards straight back to the previous hop', () => {
    expect(
      selectGatewayForwardingRoute([route('rider-b', 0, 'rider-b')], {
        received: { fromNodeId: 'rider-b', distanceBound: 5 },
      }),
    ).toEqual({ ok: false, reason: 'previous_hop_only' });
  });

  test('another route is used when the previous hop is excluded', () => {
    expect(
      selectGatewayForwardingRoute([route('rider-b', 1), route('rider-d', 1)], {
        received: { fromNodeId: 'rider-b', distanceBound: 3 },
      }),
    ).toMatchObject({ ok: true, route: { nextHopNodeId: 'rider-d' } });
  });

  test('an unresolved previous hop fails closed', () => {
    expect(
      selectGatewayForwardingRoute([route('rider-b', 1)], {
        received: { fromNodeId: undefined, distanceBound: 3 },
      }),
    ).toEqual({ ok: false, reason: 'unknown_previous_hop' });
  });

  test('the previous hop comes from the link map, never from the packet origin', () => {
    const links = createDirectLinkIdentityMap({ localNodeId: 'rider-a' });
    links.observe('nearby', 'endpoint-B', 'rider-b', MONO);

    expect(resolvePreviousHop({ transportId: 'nearby', peerId: 'endpoint-B' }, links, MONO)).toBe(
      'rider-b',
    );
    expect(resolvePreviousHop({ transportId: 'nearby' }, links, MONO)).toBeUndefined();
    expect(
      resolvePreviousHop({ transportId: 'nearby', peerId: 'endpoint-?' }, links, MONO),
    ).toBeUndefined();
    const viaB = { transportId: 'nearby', peerId: 'endpoint-B' };
    expect(resolvePreviousHop(viaB, links, MONO + 15_000)).toBeUndefined();
  });
});

describe('origin choice without forwarding context (Step 12 behaviour)', () => {
  test('matches selectGatewayRoute and reports the distance to hand on as the bound', () => {
    const candidates = [route('rider-d', 1), route('rider-b', 1), route('rider-e', 2)];
    expect(selectGatewayForwardingRoute(candidates)).toEqual({
      ok: true,
      route: selectGatewayRoute(candidates),
      distance: 2,
    });
  });

  test('equal-cost choice at one node is deterministic by next-hop id', () => {
    const a = [route('rider-d', 1), route('rider-b', 1)];
    const b = [route('rider-b', 1), route('rider-d', 1)];
    expect(selectGatewayForwardingRoute(a)).toEqual(selectGatewayForwardingRoute(b));
    expect(selectGatewayForwardingRoute(a)).toMatchObject({ route: { nextHopNodeId: 'rider-b' } });
  });
});

describe('loop prevention', () => {
  test('normal A → B → C makes progress at every edge and is delivered', () => {
    const topology: Topology = {
      'rider-a': [route('rider-b', 1)],
      'rider-b': [route(GW, 0)],
    };
    expect(walk(topology, 'rider-a')).toEqual({
      path: ['rider-a', 'rider-b', GW],
      distances: [2, 1],
      stop: 'delivered',
    });
  });

  test('stale mutual routes (A via B, B via A) never complete a loop from either side', () => {
    const topology: Topology = {
      'rider-a': [route('rider-b', 1)],
      'rider-b': [route('rider-a', 1)],
    };
    expect(walk(topology, 'rider-a')).toEqual({
      path: ['rider-a', 'rider-b'],
      distances: [2],
      stop: 'previous_hop_only',
    });
    expect(walk(topology, 'rider-b')).toEqual({
      path: ['rider-b', 'rider-a'],
      distances: [2],
      stop: 'previous_hop_only',
    });

    expect(
      selectGatewayForwardingRoute(topology['rider-b'], {
        received: { fromNodeId: 'someone-else', distanceBound: 2 },
      }),
    ).toEqual({ ok: false, reason: 'no_progress' });
  });

  test('a stale three-node cycle A → B → D → A cannot complete', () => {
    const topology: Topology = {
      'rider-a': [route('rider-b', 1)],
      'rider-b': [route('rider-d', 1)],
      'rider-d': [route('rider-a', 1)],
    };
    for (const start of ['rider-a', 'rider-b', 'rider-d']) {
      const result = walk(topology, start);
      expect(result.stop).toBe('no_progress');
      expect(result.path).toHaveLength(2);
    }

    const skewed: Topology = {
      'rider-a': [route('rider-b', 3)],
      'rider-b': [route('rider-d', 2)],
      'rider-d': [route('rider-a', 1)],
    };
    const result = walk(skewed, 'rider-a');
    expect(result).toEqual({
      path: ['rider-a', 'rider-b', 'rider-d', 'rider-a'],
      distances: [4, 3, 2],
      stop: 'no_progress',
    });
  });

  test('every three-node stale configuration terminates with strictly decreasing distance', () => {
    const nodes = ['rider-a', 'rider-b', 'rider-d'];
    const hops = [1, 2, 3];
    let walks = 0;
    for (let combo = 0; combo < hops.length ** 6; combo++) {
      const pick = (i: number) => hops[Math.floor(combo / hops.length ** i) % hops.length];
      const topology: Topology = {};
      nodes.forEach((n, i) => {
        const others = nodes.filter(o => o !== n);
        topology[n] = [route(others[0], pick(2 * i)), route(others[1], pick(2 * i + 1))];
      });
      for (const start of nodes) {
        const result = walk(topology, start);
        walks++;
        expect(result.stop).not.toBe('delivered');
        expectStrictlyDecreasing(result.distances);
        expect(result.distances.length).toBeLessThanOrEqual(result.distances[0] ?? 0);
      }
    }
    expect(walks).toBe(3 * 729);
  });

  test('equal-cost paths are fine at one node but not across an edge', () => {
    const healthy: Topology = {
      'rider-a': [route('rider-d', 1), route('rider-b', 1)],
      'rider-b': [route(GW, 0)],
      'rider-d': [route(GW, 0)],
    };
    expect(walk(healthy, 'rider-a')).toEqual({
      path: ['rider-a', 'rider-b', GW],
      distances: [2, 1],
      stop: 'delivered',
    });

    const flat: Topology = { ...healthy, 'rider-b': [route('rider-e', 1)] };
    expect(walk(flat, 'rider-a')).toMatchObject({
      path: ['rider-a', 'rider-b'],
      stop: 'no_progress',
    });
  });

  test('targets only the requested gateway, so bounds never mix gateways', () => {
    const topology: Topology = {
      'rider-a': [route('rider-b', 1), route('rider-e', 0, 'rider-e')],
      'rider-b': [route(GW, 0)],
    };
    expect(walk(topology, 'rider-a', GW).path).toEqual(['rider-a', 'rider-b', GW]);
    expect(walk(topology, 'rider-a').path).toEqual(['rider-a', 'rider-e']);
  });
});

function node(localNodeId: string) {
  const ingress = createRideMessageIngress({
    rideId: RIDE,
    localNodeId,
    seenMessages: createSeenMessageCache(),
    clock: () => WALL + 50,
  });
  const peers = createPeerTable({ localNodeId });
  const links = createDirectLinkIdentityMap({ localNodeId });
  const gateways = createGatewayState({ localNodeId });
  const receive = (message: RideMessage<unknown>, source: RideMessageIngressSource) => {
    const result = ingress.ingest(encodeRideMessage(message), source);
    if (!result.accepted) {
      throw new Error(`ingress rejected: ${result.reason}`);
    }
    return result;
  };
  const candidates = (now: number) =>
    getGatewayRouteCandidates({ localNodeId, gatewayState: gateways, linkIdentities: links, now });
  return { peers, links, gateways, receive, candidates };
}

let ids = 0;
const heartbeatFrom = (originId: string) =>
  createHeartbeatMessage({ id: `hb-${++ids}`, rideId: RIDE, originId, createdAt: WALL });

describe('end to end with real state: A ↔ B ↔ C', () => {
  test('A forwards via B; B, given A as previous hop and bound 2, forwards to C', () => {
    const a = node('rider-a');
    const b = node('rider-b');

    handleHeartbeat(
      a.receive(heartbeatFrom('rider-b'), { transportId: 'nearby', peerId: 'endpoint-B' }),
      MONO,
      a.peers,
      a.links,
    );
    handleHeartbeat(
      b.receive(heartbeatFrom('rider-a'), { transportId: 'nearby', peerId: 'endpoint-A' }),
      MONO,
      b.peers,
      b.links,
    );
    handleHeartbeat(
      b.receive(heartbeatFrom(GW), { transportId: 'nearby', peerId: 'endpoint-C' }),
      MONO,
      b.peers,
      b.links,
    );
    const atB = b.receive(
      createGatewayAdvertisementMessage({
        id: 'gw-1',
        rideId: RIDE,
        originId: GW,
        createdAt: WALL,
      }),
      { transportId: 'nearby', peerId: 'endpoint-C' },
    );
    expect(atB.message.hopCount).toBe(0);
    handleGatewayAdvertisement(atB, MONO, b.gateways, b.links);
    const relay = decideRelay(atB.message, WALL + 50);
    if (!relay.relay) {
      throw new Error('expected relay');
    }
    const atA = a.receive(relay.message, { transportId: 'nearby', peerId: 'endpoint-B' });
    expect(atA.message.hopCount).toBe(1);
    handleGatewayAdvertisement(atA, MONO, a.gateways, a.links);

    const atAChoice = selectGatewayForwardingRoute(a.candidates(MONO), { gatewayNodeId: GW });
    expect(atAChoice).toMatchObject({
      ok: true,
      route: { nextHopNodeId: 'rider-b', transportId: 'nearby', hopCount: 1 },
      distance: 2,
    });

    const cloudBound = createRideMessage({
      id: 'cloud-1',
      rideId: RIDE,
      originId: 'rider-a',
      type: 'ride_state',
      priority: 'normal',
      payload: {},
      ttlMs: 30_000,
      maxHops: 4,
      now: WALL,
    });
    const atBPacket = b.receive(cloudBound, { transportId: 'nearby', peerId: 'endpoint-A' });
    const previousHop = resolvePreviousHop(atBPacket.source, b.links, MONO);
    expect(previousHop).toBe('rider-a');
    const atBChoice = selectGatewayForwardingRoute(b.candidates(MONO), {
      gatewayNodeId: GW,
      received: { fromNodeId: previousHop, distanceBound: atAChoice.ok ? atAChoice.distance : 0 },
    });
    expect(atBChoice).toEqual({
      ok: true,
      route: {
        gatewayNodeId: GW,
        nextHopNodeId: GW,
        transportId: 'nearby',
        hopCount: 0,
        observedAt: MONO,
      },
      distance: 1,
    });

    expect(b.gateways.getGateway(GW, MONO)?.observations.map(o => o.viaNodeId)).toEqual([GW]);
    expect(
      selectGatewayForwardingRoute(b.candidates(MONO), {
        gatewayNodeId: GW,
        received: { fromNodeId: previousHop, distanceBound: undefined },
      }),
    ).toEqual({ ok: false, reason: 'unknown_progress' });
  });

  test('stale mutual state in real structures: neither A nor B completes a loop', () => {
    const a = node('rider-a');
    const b = node('rider-b');
    a.links.observe('nearby', 'endpoint-B', 'rider-b', MONO);
    a.gateways.observe(GW, 'nearby', 1, MONO, 'rider-b');
    b.links.observe('nearby', 'endpoint-A', 'rider-a', MONO);
    b.gateways.observe(GW, 'nearby', 1, MONO, 'rider-a');

    const fromA = selectGatewayForwardingRoute(a.candidates(MONO), { gatewayNodeId: GW });
    expect(fromA).toMatchObject({ ok: true, route: { nextHopNodeId: 'rider-b' }, distance: 2 });
    expect(
      selectGatewayForwardingRoute(b.candidates(MONO), {
        gatewayNodeId: GW,
        received: { fromNodeId: 'rider-a', distanceBound: 2 },
      }),
    ).toEqual({ ok: false, reason: 'previous_hop_only' });

    expect(a.gateways.isKnownGateway(GW, MONO)).toBe(true);
    expect(b.gateways.isKnownGateway(GW, MONO)).toBe(true);
  });
});

describe('purity', () => {
  test('forwarding decisions never mutate state or candidates', () => {
    const a = node('rider-a');
    a.links.observe('nearby', 'endpoint-B', 'rider-b', MONO);
    a.gateways.observe(GW, 'nearby', 1, MONO, 'rider-b');
    const candidates = a.candidates(MONO);
    const before = JSON.stringify(candidates);

    selectGatewayForwardingRoute(candidates, {
      received: { fromNodeId: 'rider-b', distanceBound: 1 },
    });
    selectGatewayForwardingRoute(candidates);
    a.candidates(MONO + 100_000);

    expect(JSON.stringify(candidates)).toBe(before);
    expect(a.candidates(MONO + 1)).toHaveLength(1);
    expect(a.links.resolve('nearby', 'endpoint-B', MONO + 1)).toBe('rider-b');
  });

  test('no timers or network-facing modules', () => {
    const timers = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      walk({ 'rider-a': [route('rider-b', 1)], 'rider-b': [route(GW, 0)] }, 'rider-a');
      for (const spy of timers) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      timers.forEach(spy => spy.mockRestore());
    }
    jest.isolateModules(() => {
      for (const name of [
        'react-native',
        'livekit-client',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/connectivity/heartbeatEmitter',
      ]) {
        jest.doMock(name, () => {
          throw new Error(`routing must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/gatewayRouting')).not.toThrow();
    });
  });
});
