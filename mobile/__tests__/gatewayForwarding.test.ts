import {
  decideGatewayForward,
  originateGatewayRouted,
  requiredRelayBudget,
  type GatewayForwardDecision,
} from '../src/connectivity/gatewayForwarding';
import { resolvePreviousHop, type GatewayRouteContext } from '../src/connectivity/gatewayRouting';
import { createDirectLinkIdentityMap } from '../src/connectivity/directLinkIdentityMap';
import { createGatewayState } from '../src/connectivity/gatewayState';
import { createRideMessageIngress } from '../src/connectivity/rideMessageIngress';
import {
  createRideMessage,
  withGatewayRouting,
  type RideMessage,
} from '../src/connectivity/protocol/rideMessage';
import { encodeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';

const WALL = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';
const GW = 'rider-c';

/** Each node's view: routes to gateways as [gateway, via, hopCount]. */
type Routes = readonly (readonly [string, string, number])[];

/** A node with real GatewayState, DirectLinkIdentityMap and ingress. Links exist to `neighbours`
 * as (nearby, endpoint-<id>), so previous hops resolve through the identity map. */
function makeNode(id: string, neighbours: readonly string[], routes: Routes) {
  const gatewayState = createGatewayState({ localNodeId: id });
  const linkIdentities = createDirectLinkIdentityMap({ localNodeId: id });
  for (const n of neighbours) {
    linkIdentities.observe('nearby', `endpoint-${n}`, n, MONO);
  }
  for (const [gateway, via, hopCount] of routes) {
    gatewayState.observe(gateway, 'nearby', hopCount, MONO, via);
  }
  const ingress = createRideMessageIngress({
    rideId: RIDE,
    localNodeId: id,
    seenMessages: createSeenMessageCache(),
    clock: () => WALL + 50,
  });
  const context: GatewayRouteContext = {
    localNodeId: id,
    gatewayState,
    linkIdentities,
    now: MONO,
  };
  return { id, gatewayState, linkIdentities, ingress, context };
}

type Node = ReturnType<typeof makeNode>;

function cloudBound(originId: string, id = `cloud-${originId}`) {
  return createRideMessage({
    id,
    rideId: RIDE,
    originId,
    type: 'ride_state',
    priority: 'normal',
    payload: { note: 'to the cloud' },
    ttlMs: 30_000,
    maxHops: 16,
    now: WALL,
  });
}

/** X's cloud-bound message already carrying routing toward C. */
function routedFromX(forwarderDistance: number) {
  return withGatewayRouting(cloudBound('rider-x'), { targetGatewayId: GW, forwarderDistance });
}

interface Hop {
  node: string;
  hopCount: number;
  forwarderDistance: number;
}

interface Trace {
  hops: Hop[];
  stop: string;
}

/**
 * Originates a routed message at `start` and carries it hop by hop: encode → receiver's real
 * ingress (dedup, local origin) → previous hop resolved through the receiver's link map →
 * decideGatewayForward. Records the metadata each node sends on.
 */
function route(nodes: Record<string, Node>, start: string, gateway?: string): Trace {
  const origin = originateGatewayRouted(cloudBound(start), nodes[start].context, gateway);
  if (!origin.ok) {
    return { hops: [], stop: `origin:${origin.reason}` };
  }
  let message: RideMessage<unknown> = origin.message;
  let from = start;
  let to = origin.route.nextHopNodeId;
  const hops: Hop[] = [
    {
      node: start,
      hopCount: message.hopCount,
      forwarderDistance: message.gatewayRouting!.forwarderDistance,
    },
  ];
  for (let step = 0; step < 64; step++) {
    const receiver = nodes[to];
    if (!receiver) {
      return { hops, stop: `unknown_node:${to}` };
    }
    const accepted = receiver.ingress.ingest(encodeRideMessage(message), {
      transportId: 'nearby',
      peerId: `endpoint-${from}`,
    });
    if (!accepted.accepted) {
      return { hops, stop: `ingress:${accepted.reason}` };
    }
    const previousHop = resolvePreviousHop(accepted.source, receiver.linkIdentities, MONO);
    const decision: GatewayForwardDecision<unknown, RideMessage['type']> = decideGatewayForward(
      accepted.message,
      receiver.context,
      previousHop,
      WALL + 50,
    );
    if (decision.outcome === 'gateway_reached') {
      return { hops, stop: `gateway_reached:${to}` };
    }
    if (decision.outcome === 'failed') {
      return { hops, stop: `${to}:${decision.reason}` };
    }
    message = decision.message;
    hops.push({
      node: to,
      hopCount: message.hopCount,
      forwarderDistance: message.gatewayRouting!.forwarderDistance,
    });
    from = to;
    to = decision.route.nextHopNodeId;
  }
  throw new Error('routed message did not terminate');
}

/** X → A → B → C, distances 3, 2, 1. */
function chain() {
  return {
    'rider-x': makeNode('rider-x', ['rider-a'], [[GW, 'rider-a', 2]]),
    'rider-a': makeNode('rider-a', ['rider-x', 'rider-b'], [[GW, 'rider-b', 1]]),
    'rider-b': makeNode('rider-b', ['rider-a', GW], [[GW, GW, 0]]),
    [GW]: makeNode(GW, ['rider-b'], []),
  } as Record<string, Node>;
}

describe('origin', () => {
  test('X selects C at distance 3 and stamps targetGatewayId C, forwarderDistance 3', () => {
    const nodes = chain();
    const original = cloudBound('rider-x');
    const result = originateGatewayRouted(original, nodes['rider-x'].context);

    expect(result).toMatchObject({
      ok: true,
      route: { gatewayNodeId: GW, nextHopNodeId: 'rider-a', hopCount: 2 },
    });
    if (!result.ok) {
      throw new Error('expected origin');
    }
    expect(result.message.gatewayRouting).toEqual({ targetGatewayId: GW, forwarderDistance: 3 });
    expect(result.message.hopCount).toBe(0);
    expect(original).not.toHaveProperty('gatewayRouting');
  });

  test('origin refuses non-local, already-routed and control-plane messages', () => {
    const ctx = chain()['rider-x'].context;
    expect(originateGatewayRouted(cloudBound('rider-a'), ctx)).toEqual({
      ok: false,
      reason: 'not_local_origin',
    });
    const already = withGatewayRouting(cloudBound('rider-x'), {
      targetGatewayId: GW,
      forwarderDistance: 3,
    });
    expect(originateGatewayRouted(already, ctx)).toEqual({ ok: false, reason: 'already_routed' });
    const hb = createHeartbeatMessage({ id: 'h', rideId: RIDE, originId: 'rider-x', createdAt: 1 });
    expect(originateGatewayRouted(hb, ctx)).toEqual({ ok: false, reason: 'not_routable_type' });
  });

  test('origin with no route fails closed', () => {
    const lonely = makeNode('rider-x', [], []);
    expect(originateGatewayRouted(cloudBound('rider-x'), lonely.context)).toEqual({
      ok: false,
      reason: 'no_route',
    });
  });
});

describe('origin hop budget', () => {
  /** X with a single route to C at the given distance (via C itself when distance is 1). */
  function originWithDistance(distance: number) {
    const via = distance === 1 ? GW : 'rider-a';
    return makeNode('rider-x', [via], [[GW, via, distance - 1]]);
  }

  function withMaxHops(maxHops: number) {
    return createRideMessage({
      id: `budget-${maxHops}`,
      rideId: RIDE,
      originId: 'rider-x',
      type: 'sos',
      priority: 'critical',
      payload: {},
      ttlMs: 30_000,
      maxHops,
      now: WALL,
    });
  }

  test('requiredRelayBudget = routeDistance - 1', () => {
    expect([1, 2, 3, 17].map(requiredRelayBudget)).toEqual([0, 1, 2, 16]);
  });

  test.each([
    [1, 0],
    [2, 1],
    [3, 2],
    [17, 16],
  ])('distance %i with maxHops %i originates', (distance, maxHops) => {
    const origin = originWithDistance(distance);
    const result = originateGatewayRouted(withMaxHops(maxHops), origin.context);
    expect(result).toMatchObject({
      ok: true,
      message: { maxHops, gatewayRouting: { targetGatewayId: GW, forwarderDistance: distance } },
    });
  });

  test.each([
    [2, 0],
    [3, 1],
  ])('distance %i with maxHops %i fails closed', (distance, maxHops) => {
    const original = withMaxHops(maxHops);
    const snapshot = JSON.stringify(original);

    expect(originateGatewayRouted(original, originWithDistance(distance).context)).toEqual({
      ok: false,
      reason: 'insufficient_hop_budget',
    });
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(original).not.toHaveProperty('gatewayRouting');
    expect(original.maxHops).toBe(maxHops);
  });
});

describe('forward', () => {
  function receivedAt(node: Node, from: string, distance: number, hopCount = 0) {
    let m: RideMessage<unknown> = withGatewayRouting(cloudBound('rider-x'), {
      targetGatewayId: GW,
      forwarderDistance: distance,
    });
    m = { ...m, hopCount };
    return decideGatewayForward(m, node.context, from, WALL + 50);
  }

  test('A receives C/3, selects distance 2, forwards C/2 with hopCount + 1', () => {
    const decision = receivedAt(chain()['rider-a'], 'rider-x', 3);
    expect(decision).toMatchObject({
      outcome: 'forward',
      route: { nextHopNodeId: 'rider-b' },
      message: { hopCount: 1, gatewayRouting: { targetGatewayId: GW, forwarderDistance: 2 } },
    });
  });

  test('B receives C/2, selects distance 1, forwards C/1', () => {
    const decision = receivedAt(chain()['rider-b'], 'rider-a', 2, 1);
    expect(decision).toMatchObject({
      outcome: 'forward',
      route: { nextHopNodeId: GW, hopCount: 0 },
      message: { hopCount: 2, gatewayRouting: { targetGatewayId: GW, forwarderDistance: 1 } },
    });
  });

  test('the target gateway recognises itself without any route lookup', () => {
    const c = makeNode(GW, [], []); // no routes at all
    expect(receivedAt(c, 'rider-b', 1, 2)).toEqual({
      outcome: 'gateway_reached',
      targetGatewayId: GW,
    });
  });

  test('no route with distance below the received bound fails closed', () => {
    const a = makeNode('rider-a', ['rider-x', 'rider-b', 'rider-d'], [
      [GW, 'rider-b', 1],
      [GW, 'rider-d', 2],
    ]);
    expect(receivedAt(a, 'rider-x', 2)).toEqual({ outcome: 'failed', reason: 'no_progress' });
  });

  test('never switches to another gateway when the target has no route', () => {
    const a = makeNode('rider-a', ['rider-x', 'rider-e'], [['rider-e', 'rider-e', 0]]);
    const decision = receivedAt(a, 'rider-x', 5);
    expect(decision).toEqual({ outcome: 'failed', reason: 'no_route' });
  });

  test('an unresolved previous hop fails closed', () => {
    const a = chain()['rider-a'];
    const m = routedFromX(3);
    expect(decideGatewayForward(m, a.context, undefined, WALL + 50)).toEqual({
      outcome: 'failed',
      reason: 'unknown_previous_hop',
    });
  });

  test('expired, exhausted or non-routed messages are not forwarded', () => {
    const a = chain()['rider-a'];
    const m = routedFromX(3);
    expect(decideGatewayForward(m, a.context, 'rider-x', WALL + 30_000)).toEqual({
      outcome: 'failed',
      reason: 'expired',
    });
    expect(decideGatewayForward({ ...m, hopCount: 16 }, a.context, 'rider-x', WALL)).toEqual({
      outcome: 'failed',
      reason: 'hop_limit',
    });
    expect(decideGatewayForward(cloudBound('rider-x'), a.context, 'rider-x', WALL)).toEqual({
      outcome: 'failed',
      reason: 'not_routed',
    });
  });

  test('forwarding never mutates the received message or its routing', () => {
    const a = chain()['rider-a'];
    const m = routedFromX(3);
    const before = JSON.stringify(m);
    const decision = decideGatewayForward(m, a.context, 'rider-x', WALL + 50);

    expect(JSON.stringify(m)).toBe(before);
    expect(decision.outcome === 'forward' && decision.message).not.toBe(m);
    expect(decision.outcome === 'forward' && decision.message.gatewayRouting).not.toBe(
      m.gatewayRouting,
    );
    expect(decision.outcome === 'forward' && decision.message.id).toBe(m.id);
    expect(decision.outcome === 'forward' && decision.message.originId).toBe('rider-x');
  });
});

describe('end to end through codec and ingress', () => {
  test('X → A → B → C: hopCount counts up while forwarderDistance counts down', () => {
    expect(route(chain(), 'rider-x')).toEqual({
      hops: [
        { node: 'rider-x', hopCount: 0, forwarderDistance: 3 },
        { node: 'rider-a', hopCount: 1, forwarderDistance: 2 },
        { node: 'rider-b', hopCount: 2, forwarderDistance: 1 },
      ],
      stop: `gateway_reached:${GW}`,
    });
  });

  test('target stays fixed even when a relay knows a closer gateway', () => {
    const nodes = chain();
    // B also knows gateway gw-e directly. It ties with C on distance and sorts first, so an
    // untargeted choice at B would pick it; the packet still goes to its target C.
    nodes['rider-b'] = makeNode('rider-b', ['rider-a', GW, 'gw-e'], [
      [GW, GW, 0],
      ['gw-e', 'gw-e', 0],
    ]);
    expect(
      originateGatewayRouted(cloudBound('rider-b'), nodes['rider-b'].context),
    ).toMatchObject({ ok: true, route: { gatewayNodeId: 'gw-e' } });

    const trace = route(nodes, 'rider-x');
    expect(trace.stop).toBe(`gateway_reached:${GW}`);
  });
});

describe('loop safety with real routed metadata', () => {
  test('stale mutual A/B routes stop without a loop', () => {
    const nodes: Record<string, Node> = {
      'rider-a': makeNode('rider-a', ['rider-b'], [[GW, 'rider-b', 1]]),
      'rider-b': makeNode('rider-b', ['rider-a'], [[GW, 'rider-a', 1]]),
    };
    expect(route(nodes, 'rider-a')).toEqual({
      hops: [{ node: 'rider-a', hopCount: 0, forwarderDistance: 2 }],
      stop: 'rider-b:previous_hop_only',
    });
    expect(route(nodes, 'rider-b')).toEqual({
      hops: [{ node: 'rider-b', hopCount: 0, forwarderDistance: 2 }],
      stop: 'rider-a:previous_hop_only',
    });
  });

  test('a stale three-node cycle cannot complete', () => {
    const cycle = (ha: number, hb: number, hd: number): Record<string, Node> => ({
      'rider-a': makeNode('rider-a', ['rider-b', 'rider-d'], [[GW, 'rider-b', ha]]),
      'rider-b': makeNode('rider-b', ['rider-a', 'rider-d'], [[GW, 'rider-d', hb]]),
      'rider-d': makeNode('rider-d', ['rider-a', 'rider-b'], [[GW, 'rider-a', hd]]),
    });

    expect(route(cycle(1, 1, 1), 'rider-a').stop).toBe('rider-b:no_progress');
    // Skewed stale hop counts let the packet travel further, but never back into A's forwarding.
    expect(route(cycle(3, 2, 1), 'rider-a')).toEqual({
      hops: [
        { node: 'rider-a', hopCount: 0, forwarderDistance: 4 },
        { node: 'rider-b', hopCount: 1, forwarderDistance: 3 },
        { node: 'rider-d', hopCount: 2, forwarderDistance: 2 },
      ],
      stop: 'ingress:local_origin',
    });
  });

  test('every three-node stale configuration terminates with strictly decreasing distance', () => {
    const ids = ['rider-a', 'rider-b', 'rider-d'];
    const hopValues = [1, 2, 3];
    let walks = 0;
    for (let combo = 0; combo < hopValues.length ** 6; combo++) {
      const pick = (i: number) =>
        hopValues[Math.floor(combo / hopValues.length ** i) % hopValues.length];
      const nodes: Record<string, Node> = {};
      ids.forEach((id, i) => {
        const others = ids.filter(o => o !== id);
        nodes[id] = makeNode(id, others, [
          [GW, others[0], pick(2 * i)],
          [GW, others[1], pick(2 * i + 1)],
        ]);
      });
      for (const start of ids) {
        const trace = route(nodes, start);
        walks++;
        expect(trace.stop).not.toMatch(/^gateway_reached/);
        for (let i = 1; i < trace.hops.length; i++) {
          expect(trace.hops[i].forwarderDistance).toBeLessThan(trace.hops[i - 1].forwarderDistance);
          expect(trace.hops[i].hopCount).toBe(trace.hops[i - 1].hopCount + 1);
        }
      }
    }
    expect(walks).toBe(3 * 729);
  });
});

describe('isolation', () => {
  test('no timers, no transports, no React Native', () => {
    const timers = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      route(chain(), 'rider-x');
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
        '@livekit/react-native',
        '../src/transports/Transport',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/connectivity/heartbeatEmitter',
        '../src/connectivity/cycleScheduler',
      ]) {
        jest.doMock(name, () => {
          throw new Error(`gateway forwarding must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/gatewayForwarding')).not.toThrow();
    });
  });
});
