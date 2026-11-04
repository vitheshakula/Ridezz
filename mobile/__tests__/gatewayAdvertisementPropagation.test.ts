import { createConnectivityReceiver } from '../src/connectivity/connectivityReceiver';
import { createRoutedForwarder } from '../src/connectivity/routedForwarder';
import {
  getGatewayRouteCandidates,
  selectGatewayForwardingRoute,
} from '../src/connectivity/gatewayRouting';
import { createDirectLinkIdentityMap } from '../src/connectivity/directLinkIdentityMap';
import { createGatewayState } from '../src/connectivity/gatewayState';
import { createPeerTable } from '../src/connectivity/peerTable';
import { createRideMessageIngress } from '../src/connectivity/rideMessageIngress';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import {
  GATEWAY_ADVERTISEMENT_MAX_HOPS,
  createGatewayAdvertisementMessage,
} from '../src/connectivity/protocol/gatewayAdvertisement';
import {
  createRideMessage,
  withGatewayRouting,
  type RideMessage,
} from '../src/connectivity/protocol/rideMessage';
import {
  parseRideMessage,
  serializeRideMessage,
} from '../src/connectivity/protocol/rideMessageCodec';
import { OPERATIONAL_SEND_TIMEOUT_MS } from '../src/connectivity/boundedSend';

const WALL = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';
const NEARBY = 'nearby';
const GW = 'rider-c';

const ep = (nodeId: string) => `endpoint-${nodeId.slice(-1).toUpperCase()}`;
const decode = (payload: string) => parseRideMessage(payload, WALL + 50)!;

let ids = 0;
const nextId = (prefix: string) => `${prefix}-${++ids}`;

interface NodeOptions {
  wall?: () => number;
  broadcast?: (payload: string) => Promise<void>;
}

interface Delivery {
  from: string;
  to: string;
  payload: string;
}

function createNetwork() {
  const nodes = new Map<string, ReturnType<typeof makeNode>>();
  const edges = new Set<string>();
  const queue: Delivery[] = [];
  type ReceiveResult = Awaited<ReturnType<ReturnType<typeof makeNode>['receive']>>;
  const log: (Delivery & { result: ReceiveResult })[] = [];

  const neighbours = (id: string) =>
    [...nodes.keys()].filter(n => edges.has([id, n].sort().join('|')));

  function makeNode(id: string, options: NodeOptions = {}) {
    const wall = options.wall ?? (() => WALL + 50);
    const ingress = createRideMessageIngress({
      rideId: RIDE,
      localNodeId: id,
      seenMessages: createSeenMessageCache(),
      clock: () => WALL + 50,
    });
    const peers = createPeerTable({ localNodeId: id });
    const links = createDirectLinkIdentityMap({ localNodeId: id });
    const gateways = createGatewayState({ localNodeId: id });
    const transport = {
      broadcast: jest.fn(
        options.broadcast ??
          ((payload: string) => {
            for (const n of neighbours(id)) {
              queue.push({ from: id, to: n, payload });
            }
            return Promise.resolve();
          }),
      ),
      sendTo: jest.fn((endpointId: string, payload: string) => {
        const target = neighbours(id).find(n => ep(n) === endpointId);
        if (!target) {
          return Promise.reject(new Error(`no confirmed endpoint ${endpointId}`));
        }
        queue.push({ from: id, to: target, payload });
        return Promise.resolve();
      }),
    };
    const forwarder = createRoutedForwarder({
      localNodeId: id,
      transportId: NEARBY,
      transport,
      gatewayState: gateways,
      linkIdentities: links,
      monotonicClock: () => MONO,
      wallClock: wall,
    });
    const receiver = createConnectivityReceiver({
      transportId: NEARBY,
      ingress,
      peerTable: peers,
      linkIdentities: links,
      gatewayState: gateways,
      forwarder,
      controlTransport: transport,
      monotonicClock: () => MONO,
      wallClock: wall,
    });
    const receive = (from: string, payload: string) =>
      receiver.handlePayload({ endpointId: ep(from) }, payload);
    const node = { id, peers, links, gateways, transport, forwarder, receiver, receive };
    nodes.set(id, node);
    return node;
  }

  return {
    nodes,
    log,
    makeNode,
    connect(x: string, y: string) {
      edges.add([x, y].sort().join('|'));
    },
    async settle(maxDeliveries = 500) {
      let delivered = 0;
      while (queue.length > 0) {
        if (++delivered > maxDeliveries) {
          throw new Error('network did not settle: a flood is circulating');
        }
        const d = queue.shift()!;
        const result = await nodes.get(d.to)!.receive(d.from, d.payload);
        log.push({ ...d, result });
      }
      return delivered;
    },
  };
}

type Network = ReturnType<typeof createNetwork>;
type SimNode = ReturnType<Network['makeNode']>;

const heartbeat = (originId: string) =>
  createHeartbeatMessage({ id: nextId('hb'), rideId: RIDE, originId, createdAt: WALL });

const advertisement = (originId: string) =>
  createGatewayAdvertisementMessage({
    id: nextId('gw'),
    rideId: RIDE,
    originId,
    createdAt: WALL,
  });

function application(originId: string, maxHops = 4) {
  return createRideMessage({
    id: nextId('app'),
    rideId: RIDE,
    originId,
    type: 'sos',
    priority: 'critical',
    payload: { lat: 12.97 },
    ttlMs: 30_000,
    maxHops,
    now: WALL,
  });
}

async function heartbeatAll(net: Network) {
  for (const node of net.nodes.values()) {
    await node.transport.broadcast(serializeRideMessage(heartbeat(node.id)));
  }
  await net.settle();
}

function acceptedAt(net: Network, to: string, id: string) {
  return net.log.filter(
    e => e.to === to && e.result.stage !== 'ingress_rejected' && decode(e.payload).id === id,
  );
}

function broadcastsOf(node: SimNode, id: string) {
  return node.transport.broadcast.mock.calls
    .map(([payload]) => decode(payload))
    .filter(m => m.id === id);
}

function nonControlBroadcasts(node: SimNode) {
  return node.transport.broadcast.mock.calls
    .map(([payload]) => decode(payload).type)
    .filter(type => type !== 'gateway_advertisement' && type !== 'heartbeat');
}

describe('A ↔ B ↔ C: automatic gateway discovery through the receivers', () => {
  async function line() {
    const net = createNetwork();
    const a = net.makeNode('rider-a');
    const b = net.makeNode('rider-b');
    const c = net.makeNode(GW);
    net.connect('rider-a', 'rider-b');
    net.connect('rider-b', GW);
    await heartbeatAll(net);
    return { net, a, b, c };
  }

  test('C’s advertisement reaches A via B with the same id, and A learns C via B', async () => {
    const { net, a, b, c } = await line();
    const g1 = advertisement(GW);

    await c.transport.broadcast(serializeRideMessage(g1));
    await net.settle();

    expect(acceptedAt(net, 'rider-b', g1.id)).toHaveLength(1);
    expect(acceptedAt(net, 'rider-b', g1.id)[0]).toMatchObject({
      from: GW,
      result: {
        stage: 'gateway_advertisement',
        result: { observed: true, gatewayNodeId: GW, hopCount: 0, via: { nodeId: GW } },
        relay: { status: 'relayed', message: { id: g1.id, originId: GW, hopCount: 1 } },
      },
    });
    expect(broadcastsOf(b, g1.id)).toEqual([{ ...g1, hopCount: 1 }]);

    expect(acceptedAt(net, 'rider-a', g1.id)).toHaveLength(1);
    expect(acceptedAt(net, 'rider-a', g1.id)[0]).toMatchObject({
      from: 'rider-b',
      result: {
        result: { observed: true, gatewayNodeId: GW, hopCount: 1, via: { nodeId: 'rider-b' } },
        relay: { status: 'relayed', message: { id: g1.id, hopCount: 2 } },
      },
    });

    expect(net.log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'rider-b',
          to: GW,
          result: { stage: 'ingress_rejected', reason: 'local_origin' },
        }),
        expect.objectContaining({
          from: 'rider-a',
          to: 'rider-b',
          result: { stage: 'ingress_rejected', reason: 'duplicate' },
        }),
      ]),
    );

    const choice = selectGatewayForwardingRoute(
      getGatewayRouteCandidates({
        localNodeId: 'rider-a',
        gatewayState: a.gateways,
        linkIdentities: a.links,
        now: MONO,
      }),
    );
    expect(choice).toEqual({
      ok: true,
      route: {
        gatewayNodeId: GW,
        nextHopNodeId: 'rider-b',
        transportId: NEARBY,
        hopCount: 1,
        observedAt: MONO,
      },
      distance: 2,
    });
    expect(a.peers.isDirectPeer(GW, MONO)).toBe(false);
  });

  test('discovered state feeds routed traffic: A → B → C, targeted only', async () => {
    const { net, a, b, c } = await line();
    await c.transport.broadcast(serializeRideMessage(advertisement(GW)));
    await net.settle();
    const logBefore = net.log.length;

    const app = application('rider-a');
    expect(await a.forwarder.sendOriginated(app)).toMatchObject({
      status: 'sent',
      endpointId: 'endpoint-B',
      message: { gatewayRouting: { targetGatewayId: GW, forwarderDistance: 2 } },
    });
    await net.settle();

    const appTrail = net.log.slice(logBefore);
    expect(appTrail.map(e => [e.from, e.to])).toEqual([
      ['rider-a', 'rider-b'],
      ['rider-b', GW],
    ]);
    expect(appTrail[0].result).toMatchObject({
      stage: 'routed',
      result: {
        status: 'sent',
        endpointId: 'endpoint-C',
        message: { id: app.id, hopCount: 1, gatewayRouting: { forwarderDistance: 1 } },
      },
    });
    expect(appTrail[1].result).toMatchObject({
      stage: 'routed',
      result: { status: 'gateway_reached', targetGatewayId: GW, message: { id: app.id } },
    });

    expect(a.transport.sendTo).toHaveBeenCalledTimes(1);
    expect(b.transport.sendTo).toHaveBeenCalledTimes(1);
    expect(c.transport.sendTo).not.toHaveBeenCalled();
    for (const node of [a, b, c]) {
      expect(nonControlBroadcasts(node)).toEqual([]);
    }
  });
});

describe('flood termination', () => {
  test('triangle: G1 is accepted at most once per node and the flood settles', async () => {
    const net = createNetwork();
    const a = net.makeNode('rider-a');
    const b = net.makeNode('rider-b');
    const c = net.makeNode(GW);
    net.connect('rider-a', 'rider-b');
    net.connect('rider-b', GW);
    net.connect('rider-a', GW);
    await heartbeatAll(net);
    const g1 = advertisement(GW);

    await c.transport.broadcast(serializeRideMessage(g1));
    const delivered = await net.settle();

    const g1Deliveries = net.log.filter(e => decode(e.payload).type === 'gateway_advertisement');
    expect(new Set(g1Deliveries.map(e => decode(e.payload).id))).toEqual(new Set([g1.id]));
    expect(acceptedAt(net, 'rider-a', g1.id)).toHaveLength(1);
    expect(acceptedAt(net, 'rider-b', g1.id)).toHaveLength(1);
    expect(acceptedAt(net, GW, g1.id)).toHaveLength(0);
    expect(broadcastsOf(a, g1.id)).toHaveLength(1);
    expect(broadcastsOf(b, g1.id)).toHaveLength(1);
    const rejected = g1Deliveries.filter(e => e.result.stage === 'ingress_rejected');
    expect(rejected.map(e => (e.result as { reason: string }).reason).sort()).toEqual([
      'duplicate',
      'duplicate',
      'local_origin',
      'local_origin',
    ]);
    expect(g1Deliveries).toHaveLength(6);
    expect(Math.max(...g1Deliveries.map(e => decode(e.payload).hopCount))).toBeLessThanOrEqual(
      GATEWAY_ADVERTISEMENT_MAX_HOPS,
    );
    expect(delivered).toBe(6);
    for (const node of [a, b]) {
      expect(node.gateways.getGateway(GW, MONO)?.observations.map(o => o.hopCount)).toEqual([0]);
    }
  });
});

describe('advertisement relay failures and refusals', () => {
  async function nodeB(options: NodeOptions = {}) {
    const net = createNetwork();
    const b = net.makeNode('rider-b', options);
    const a = net.makeNode('rider-a');
    const c = net.makeNode(GW);
    net.connect('rider-a', 'rider-b');
    net.connect('rider-b', GW);
    await a.transport.broadcast(serializeRideMessage(heartbeat('rider-a')));
    await c.transport.broadcast(serializeRideMessage(heartbeat(GW)));
    await net.settle();
    b.transport.broadcast.mockClear();
    return { net, b };
  }

  test('an invalid packet is rejected and not relayed', async () => {
    const { b } = await nodeB();
    expect(await b.receive(GW, 'garbage')).toEqual({
      stage: 'ingress_rejected',
      reason: 'invalid',
    });
    expect(b.transport.broadcast).not.toHaveBeenCalled();
  });

  test('a malformed advertisement payload is neither recorded nor relayed', async () => {
    const { b } = await nodeB();
    const odd = createRideMessage({
      id: nextId('gw'),
      rideId: RIDE,
      originId: GW,
      type: 'gateway_advertisement',
      priority: 'normal',
      payload: ['not', 'an', 'object'],
      ttlMs: 30_000,
      maxHops: 4,
      now: WALL,
    });
    expect(await b.receive(GW, serializeRideMessage(odd))).toEqual({
      stage: 'gateway_advertisement',
      result: { observed: false, reason: 'invalid_payload' },
      relay: { status: 'not_relayed', reason: 'invalid_payload' },
    });
    expect(b.transport.broadcast).not.toHaveBeenCalled();
  });

  test('duplicate, wrong-ride and local-origin advertisements are rejected', async () => {
    const { b } = await nodeB();
    const payload = serializeRideMessage(advertisement(GW));
    await b.receive(GW, payload);
    expect(await b.receive(GW, payload)).toEqual({
      stage: 'ingress_rejected',
      reason: 'duplicate',
    });
    const otherRide = createGatewayAdvertisementMessage({
      id: nextId('gw'),
      rideId: '99999',
      originId: GW,
      createdAt: WALL,
    });
    expect(await b.receive(GW, serializeRideMessage(otherRide))).toMatchObject({
      reason: 'wrong_ride',
    });
    expect(await b.receive(GW, serializeRideMessage(advertisement('rider-b')))).toMatchObject({
      reason: 'local_origin',
    });
    expect(b.transport.broadcast).toHaveBeenCalledTimes(1);
  });

  test('an expired advertisement is rejected at ingress', async () => {
    const { b } = await nodeB();
    const old = createGatewayAdvertisementMessage({
      id: nextId('gw'),
      rideId: RIDE,
      originId: GW,
      createdAt: WALL - 30_000,
    });
    expect(await b.receive(GW, serializeRideMessage(old))).toEqual({
      stage: 'ingress_rejected',
      reason: 'invalid',
    });
    expect(b.transport.broadcast).not.toHaveBeenCalled();
  });

  test('expiring between ingress and relay: recorded, not relayed', async () => {
    const { b } = await nodeB({ wall: () => WALL + 30_000 });
    expect(await b.receive(GW, serializeRideMessage(advertisement(GW)))).toMatchObject({
      result: { observed: true },
      relay: { status: 'not_relayed', reason: 'expired' },
    });
    expect(b.gateways.isKnownGateway(GW, MONO)).toBe(true);
    expect(b.transport.broadcast).not.toHaveBeenCalled();
  });

  test('an advertisement at its hop limit is recorded but not relayed', async () => {
    const { b } = await nodeB();
    const atLimit: RideMessage<unknown> = {
      ...advertisement(GW),
      hopCount: GATEWAY_ADVERTISEMENT_MAX_HOPS,
    };
    expect(await b.receive(GW, serializeRideMessage(atLimit))).toMatchObject({
      result: { observed: true, hopCount: GATEWAY_ADVERTISEMENT_MAX_HOPS },
      relay: { status: 'not_relayed', reason: 'hop_limit' },
    });
    expect(b.transport.broadcast).not.toHaveBeenCalled();
  });

  test('a rejected relay broadcast keeps the gateway observation', async () => {
    const { b } = await nodeB({ broadcast: () => Promise.reject(new Error('radio busy')) });
    const g1 = advertisement(GW);
    expect(await b.receive(GW, serializeRideMessage(g1))).toMatchObject({
      result: { observed: true },
      relay: { status: 'relay_error', error: 'radio busy', message: { id: g1.id, hopCount: 1 } },
    });
    expect(b.gateways.isKnownGateway(GW, MONO)).toBe(true);
    expect(b.transport.broadcast).toHaveBeenCalledTimes(1);
  });

  test('a hung relay broadcast times out as unknown; the gateway was recorded first', async () => {
    const { b } = await nodeB({ broadcast: () => new Promise<void>(() => {}) });
    jest.useFakeTimers();
    try {
      let settled: unknown;
      b.receive(GW, serializeRideMessage(advertisement(GW))).then(r => (settled = r));
      await Promise.resolve();
      expect(b.gateways.isKnownGateway(GW, MONO)).toBe(true);

      await jest.advanceTimersByTimeAsync(OPERATIONAL_SEND_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({
        result: { observed: true },
        relay: { status: 'relay_timeout' },
      });
      expect(b.transport.broadcast).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a heartbeat is never relayed', async () => {
    const { b } = await nodeB();
    expect(await b.receive('rider-a', serializeRideMessage(heartbeat('rider-a')))).toMatchObject({
      stage: 'heartbeat',
    });
    expect(b.transport.broadcast).not.toHaveBeenCalled();
  });

  test('a routed application message is sent targeted and never broadcast', async () => {
    const { b } = await nodeB();
    await b.receive(GW, serializeRideMessage(advertisement(GW)));
    b.transport.broadcast.mockClear();
    const routed = withGatewayRouting(application('rider-a'), {
      targetGatewayId: GW,
      forwarderDistance: 2,
    });

    expect(await b.receive('rider-a', serializeRideMessage(routed))).toMatchObject({
      stage: 'routed',
      result: { status: 'sent', endpointId: 'endpoint-C' },
    });
    expect(b.transport.sendTo).toHaveBeenCalledTimes(1);
    expect(b.transport.broadcast).not.toHaveBeenCalled();
  });

  test('an unrouted application message is not flooded', async () => {
    const { b } = await nodeB();
    expect(await b.receive('rider-a', serializeRideMessage(application('rider-a')))).toEqual({
      stage: 'unrouted',
    });
    expect(b.transport.broadcast).not.toHaveBeenCalled();
    expect(b.transport.sendTo).not.toHaveBeenCalled();
  });

  test('rejects an invalid relay timeout', () => {
    expect(() =>
      createConnectivityReceiver({
        transportId: NEARBY,
        ingress: createRideMessageIngress({
          rideId: RIDE,
          localNodeId: 'x',
          seenMessages: createSeenMessageCache(),
          clock: () => WALL,
        }),
        peerTable: createPeerTable({ localNodeId: 'x' }),
        linkIdentities: createDirectLinkIdentityMap({ localNodeId: 'x' }),
        gatewayState: createGatewayState({ localNodeId: 'x' }),
        forwarder: { sendOriginated: jest.fn(), forwardAccepted: jest.fn() },
        controlTransport: { broadcast: jest.fn() },
        monotonicClock: () => MONO,
        wallClock: () => WALL,
        relayTimeoutMs: 0,
      }),
    ).toThrow(RangeError);
  });
});
