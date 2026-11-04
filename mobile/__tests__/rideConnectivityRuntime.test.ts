import {
  createRideConnectivityRuntime,
  type RideConnectivityEvent,
} from '../src/connectivity/rideConnectivityRuntime';
import { createRideMessageIdGenerator } from '../src/connectivity/protocol/rideMessageId';
import { createRideMessage, type RideMessage } from '../src/connectivity/protocol/rideMessage';
import { serializeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { HEARTBEAT_INTERVAL_MS } from '../src/connectivity/protocol/heartbeat';
import { GATEWAY_ADVERTISEMENT_INTERVAL_MS } from '../src/connectivity/protocol/gatewayAdvertisement';

const WALL = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';
const NEARBY = 'nearby';
const GW = 'rider-c';

const ep = (nodeId: string) => `endpoint-${nodeId.slice(-1).toUpperCase()}`;

let counter = 0;
function secureIds() {
  return jest.fn(
    createRideMessageIdGenerator(array => {
      array.fill(0);
      new DataView(array.buffer).setUint32(0, ++counter);
      return array;
    }),
  );
}

interface Delivery {
  from: string;
  to: string;
  payload: string;
}

function createNetwork() {
  const listeners = new Map<string, (source: { endpointId: string }, payload: string) => void>();
  const edges = new Set<string>();
  const queue: Delivery[] = [];
  const nodes = new Map<string, ReturnType<typeof makeNode>>();
  let delivered = 0;
  let received = 0;
  const t0 = Date.now();

  const neighbours = (id: string) =>
    [...nodes.keys()].filter(n => edges.has([id, n].sort().join('|')));

  function makeNode(id: string, options: { reachable?: boolean; rideId?: string } = {}) {
    let reachable = options.reachable ?? false;
    const events: RideConnectivityEvent[] = [];
    const applicationMessages: RideMessage<unknown>[] = [];
    const unsubscribes: jest.Mock[] = [];
    const transport = {
      broadcast: jest.fn((payload: string) => {
        for (const n of neighbours(id)) {
          queue.push({ from: id, to: n, payload });
        }
        return Promise.resolve();
      }),
      sendTo: jest.fn((endpointId: string, payload: string) => {
        const target = neighbours(id).find(n => ep(n) === endpointId);
        if (!target) {
          return Promise.reject(new Error(`no confirmed endpoint ${endpointId}`));
        }
        queue.push({ from: id, to: target, payload });
        return Promise.resolve();
      }),
      onPayloadFrom: jest.fn((cb: (source: { endpointId: string }, payload: string) => void) => {
        listeners.set(id, cb);
        const unsubscribe = jest.fn(() => {
          listeners.delete(id);
        });
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      }),
      onPayload: jest.fn(),
    };
    const generateMessageId = secureIds();
    const runtime = createRideConnectivityRuntime({
      rideId: options.rideId ?? RIDE,
      localNodeId: id,
      transportId: NEARBY,
      transport,
      generateMessageId,
      wallClock: () => WALL + (Date.now() - t0),
      monotonicClock: () => MONO + (Date.now() - t0),
      isCloudReachable: () => reachable,
      onEvent: event => {
        events.push(event);
        if (event.kind === 'receive') {
          received++;
        }
      },
      onApplicationMessage: receivedMessage => {
        applicationMessages.push(receivedMessage.message);
      },
    });
    const node = {
      id,
      runtime,
      transport,
      events,
      applicationMessages,
      unsubscribes,
      generateMessageId,
      setReachable: (value: boolean) => (reachable = value),
      receives: () => events.flatMap(e => (e.kind === 'receive' ? [e.result] : [])),
    };
    nodes.set(id, node);
    return node;
  }

  return {
    makeNode,
    connect(x: string, y: string) {
      edges.add([x, y].sort().join('|'));
    },
    async settle() {
      for (let round = 0; round < 200; round++) {
        while (queue.length > 0) {
          const d = queue.shift()!;
          const listener = listeners.get(d.to);
          if (listener) {
            delivered++;
            listener({ endpointId: ep(d.from) }, d.payload);
          }
        }
        await jest.advanceTimersByTimeAsync(0);
        if (queue.length === 0 && received === delivered) {
          return;
        }
      }
      throw new Error('network did not settle');
    },
  };
}

type SimNode = ReturnType<ReturnType<typeof createNetwork>['makeNode']>;

const decode = (payload: string) => JSON.parse(payload) as RideMessage<unknown>;

function dataPlaneBroadcasts(node: SimNode) {
  return node.transport.broadcast.mock.calls
    .map(([payload]) => decode(payload).type)
    .filter(type => type !== 'heartbeat' && type !== 'gateway_advertisement');
}

function ownAdvertisements(node: SimNode) {
  return node.transport.broadcast.mock.calls
    .map(([payload]) => decode(payload))
    .filter(m => m.type === 'gateway_advertisement' && m.originId === node.id && m.hopCount === 0);
}

function application(originId: string) {
  return createRideMessage({
    id: `app-${++counter}`,
    rideId: RIDE,
    originId,
    type: 'sos',
    priority: 'critical',
    payload: { lat: 12.97, lon: 77.59 },
    ttlMs: 30_000,
    maxHops: 4,
    now: WALL,
  });
}

let started: SimNode[] = [];
function start(...nodes: SimNode[]) {
  for (const n of nodes) {
    n.runtime.start();
    started.push(n);
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  started = [];
});

afterEach(() => {
  for (const n of started) {
    n.runtime.stop();
  }
  jest.useRealTimers();
});

describe('runtime lifecycle', () => {
  test('start subscribes once; one heartbeat; no advert id while unreachable', async () => {
    const net = createNetwork();
    const a = net.makeNode('rider-a');

    start(a);

    expect(a.transport.onPayloadFrom).toHaveBeenCalledTimes(1);
    expect(a.transport.onPayload).not.toHaveBeenCalled();
    expect(a.transport.broadcast).toHaveBeenCalledTimes(1);
    expect(decode(a.transport.broadcast.mock.calls[0][0])).toMatchObject({
      type: 'heartbeat',
      originId: 'rider-a',
      hopCount: 0,
      maxHops: 0,
    });
    expect(a.generateMessageId).toHaveBeenCalledTimes(1);
    expect(a.runtime.running).toBe(true);
  });

  test('repeated start does not duplicate listeners or schedulers', async () => {
    const net = createNetwork();
    const a = net.makeNode('rider-a');
    start(a);
    a.runtime.start();
    a.runtime.start();

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(a.transport.onPayloadFrom).toHaveBeenCalledTimes(1);
    expect(a.transport.broadcast).toHaveBeenCalledTimes(2);
  });

  test('stop unsubscribes once, leaves no timers and does no further work', async () => {
    const net = createNetwork();
    const a = net.makeNode('rider-a', { reachable: true });
    start(a);
    await jest.advanceTimersByTimeAsync(0);
    const sends = a.transport.broadcast.mock.calls.length;

    a.runtime.stop();
    a.runtime.stop();

    expect(a.unsubscribes).toHaveLength(1);
    expect(a.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * GATEWAY_ADVERTISEMENT_INTERVAL_MS);
    expect(a.transport.broadcast).toHaveBeenCalledTimes(sends);
    expect(a.runtime.running).toBe(false);
    expect(await a.runtime.sendToGateway(application('rider-a'))).toEqual({
      status: 'runtime_not_running',
    });
    expect(() => a.runtime.start()).toThrow('cannot be restarted');
  });

  test('sending before start does nothing', async () => {
    const net = createNetwork();
    const a = net.makeNode('rider-a');
    expect(await a.runtime.sendToGateway(application('rider-a'))).toEqual({
      status: 'runtime_not_running',
    });
    expect(a.transport.sendTo).not.toHaveBeenCalled();
    a.runtime.stop();
  });

  test('every own heartbeat and advertisement id comes from the secure generator', async () => {
    const net = createNetwork();
    const c = net.makeNode(GW, { reachable: true });
    start(c);
    await jest.advanceTimersByTimeAsync(GATEWAY_ADVERTISEMENT_INTERVAL_MS);

    const sentIds = c.transport.broadcast.mock.calls.map(([p]) => decode(p).id);
    const generated = c.generateMessageId.mock.results.map(r => r.value);
    expect(sentIds.sort()).toEqual([...generated].sort());
    expect(new Set(sentIds).size).toBe(sentIds.length);
  });

  test('runtime instances keep separate session state', async () => {
    const net = createNetwork();
    const a = net.makeNode('rider-a');
    const b = net.makeNode('rider-b');
    const bOtherRide = net.makeNode('rider-z', { rideId: '54321' });
    net.connect('rider-a', 'rider-b');
    net.connect('rider-a', 'rider-z');
    start(a, b, bOtherRide);
    await net.settle();

    const heard = (n: SimNode) =>
      n.receives().flatMap(r => (r.stage === 'heartbeat' ? [r.result] : []));
    expect(heard(b)).toMatchObject([{ observed: true, nodeId: 'rider-a' }]);
    expect(bOtherRide.receives()).toEqual([{ stage: 'ingress_rejected', reason: 'wrong_ride' }]);
  });

  test('does not depend on React Native, LiveKit or the concrete Nearby adapter', () => {
    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'livekit-client',
        '@livekit/react-native',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/hazards/HazardCoordinator',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`runtime must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/rideConnectivityRuntime')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });
});

describe('A ↔ B heartbeats through the runtimes', () => {
  test('each learns the other’s presence and (nearby, endpoint) → node link', async () => {
    const net = createNetwork();
    const a = net.makeNode('rider-a');
    const b = net.makeNode('rider-b');
    net.connect('rider-a', 'rider-b');
    start(a, b);

    await net.settle();

    expect(b.receives()).toEqual([
      {
        stage: 'heartbeat',
        result: {
          observed: true,
          nodeId: 'rider-a',
          transportId: NEARBY,
          change: 'new_peer',
          link: { observed: true, change: 'new_link' },
        },
      },
    ]);
    expect(a.receives()).toMatchObject([
      { stage: 'heartbeat', result: { nodeId: 'rider-b', link: { change: 'new_link' } } },
    ]);
    expect(a.transport.broadcast).toHaveBeenCalledTimes(1);
    expect(b.transport.broadcast).toHaveBeenCalledTimes(1);
  });

  test('accepted local application messages are delivered once; expired copies are rejected', async () => {
    const net = createNetwork();
    const a = net.makeNode('rider-a');
    const b = net.makeNode('rider-b');
    net.connect('rider-a', 'rider-b');
    start(a, b);
    await net.settle();

    const app = application('rider-a');
    const expired = createRideMessage({
      id: `expired-${++counter}`,
      rideId: RIDE,
      originId: 'rider-a',
      type: 'sos',
      priority: 'critical',
      payload: { reason: 'test' },
      ttlMs: 1_000,
      maxHops: 1,
      now: WALL - 2_000,
    });
    await a.transport.broadcast(serializeRideMessage(app));
    await a.transport.broadcast(serializeRideMessage(app));
    await a.transport.broadcast(serializeRideMessage(expired));
    await net.settle();

    expect(b.applicationMessages.map(message => message.id)).toEqual([app.id]);
    expect(b.receives()).toEqual(
      expect.arrayContaining([
        { stage: 'unrouted' },
        { stage: 'ingress_rejected', reason: 'duplicate' },
        { stage: 'ingress_rejected', reason: 'invalid' },
      ]),
    );
  });
});

describe('A ↔ B ↔ C: gateway discovery and routed delivery through the runtimes', () => {
  async function abc() {
    const net = createNetwork();
    const a = net.makeNode('rider-a');
    const b = net.makeNode('rider-b');
    const c = net.makeNode(GW, { reachable: true });
    net.connect('rider-a', 'rider-b');
    net.connect('rider-b', GW);
    start(a, b, c);
    await net.settle();
    return { net, a, b, c };
  }

  test('C advertises automatically; B propagates; A learns C via B', async () => {
    const { a, b, c } = await abc();

    expect(ownAdvertisements(c)).toHaveLength(1);
    expect(ownAdvertisements(a)).toHaveLength(0);
    expect(ownAdvertisements(b)).toHaveLength(0);
    expect(b.receives()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'gateway_advertisement',
          result: expect.objectContaining({ gatewayNodeId: GW, hopCount: 0 }),
          relay: expect.objectContaining({ status: 'relayed' }),
        }),
      ]),
    );
    expect(a.runtime.getGatewayRoute()).toEqual({
      ok: true,
      route: {
        gatewayNodeId: GW,
        nextHopNodeId: 'rider-b',
        transportId: NEARBY,
        hopCount: 1,
        observedAt: expect.any(Number),
      },
      distance: 2,
    });
  });

  test('C stops advertising once it is no longer cloud reachable', async () => {
    const { net, c } = await abc();
    expect(ownAdvertisements(c)).toHaveLength(1);

    c.setReachable(false);
    await jest.advanceTimersByTimeAsync(3 * GATEWAY_ADVERTISEMENT_INTERVAL_MS);
    await net.settle();

    expect(ownAdvertisements(c)).toHaveLength(1);
    const cycles = c.events.filter(e => e.kind === 'gateway_advertisement_cycle');
    expect(
      cycles.slice(1).every(e => e.outcome.ok && e.outcome.value.status === 'not_reachable'),
    ).toBe(true);
  });

  test('full path: A → B → C gateway_reached, targeted only, same id', async () => {
    const { net, a, b, c } = await abc();
    const app = application('rider-a');

    expect(await a.runtime.sendToGateway(app)).toMatchObject({
      status: 'sent',
      endpointId: 'endpoint-B',
      message: {
        id: app.id,
        hopCount: 0,
        gatewayRouting: { targetGatewayId: GW, forwarderDistance: 2 },
      },
    });
    await net.settle();

    const atB = b.receives().filter(r => r.stage === 'routed');
    const atC = c.receives().filter(r => r.stage === 'routed');
    expect(atB).toMatchObject([
      {
        result: {
          status: 'sent',
          endpointId: 'endpoint-C',
          message: {
            id: app.id,
            hopCount: 1,
            gatewayRouting: { targetGatewayId: GW, forwarderDistance: 1 },
          },
        },
      },
    ]);
    expect(atC).toMatchObject([
      { result: { status: 'gateway_reached', targetGatewayId: GW, message: { id: app.id } } },
    ]);
    expect(b.applicationMessages).toEqual([]);
    expect(c.applicationMessages).toMatchObject([{ id: app.id }]);

    expect(a.transport.sendTo).toHaveBeenCalledTimes(1);
    expect(b.transport.sendTo).toHaveBeenCalledTimes(1);
    expect(c.transport.sendTo).not.toHaveBeenCalled();
    for (const node of [a, b, c]) {
      expect(dataPlaneBroadcasts(node)).toEqual([]);
      expect(node.transport.onPayload).not.toHaveBeenCalled();
    }
  });

  test('a cloud-reachable node does not route its own message over Nearby', async () => {
    const { c } = await abc();
    expect(await c.runtime.sendToGateway(application(GW))).toEqual({ status: 'local_gateway' });
    expect(c.transport.sendTo).not.toHaveBeenCalled();
  });
});
