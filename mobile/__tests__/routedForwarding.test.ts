import {
  ROUTED_SEND_TIMEOUT_MS,
  createRoutedForwarder,
  type RoutedForwardResult,
} from '../src/connectivity/routedForwarder';
import {
  createConnectivityReceiver,
  type ConnectivityReceiveResult,
} from '../src/connectivity/connectivityReceiver';
import { resolveTargetEndpoint } from '../src/connectivity/gatewayRouting';
import { createDirectLinkIdentityMap } from '../src/connectivity/directLinkIdentityMap';
import { createGatewayState } from '../src/connectivity/gatewayState';
import { createPeerTable } from '../src/connectivity/peerTable';
import { createRideMessageIngress } from '../src/connectivity/rideMessageIngress';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import { createGatewayAdvertisementMessage } from '../src/connectivity/protocol/gatewayAdvertisement';
import {
  createRideMessage,
  withGatewayRouting,
  type RideMessage,
} from '../src/connectivity/protocol/rideMessage';
import {
  parseRideMessage,
  serializeRideMessage,
} from '../src/connectivity/protocol/rideMessageCodec';

const WALL = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';
const NEARBY = 'nearby';
const GW = 'rider-c';

const ep = (nodeId: string) => `endpoint-${nodeId.slice(-1).toUpperCase()}`;

let ids = 0;
const nextId = (prefix: string) => `${prefix}-${++ids}`;

function makeNode(id: string, clocks = { mono: () => MONO, wall: () => WALL + 50 }) {
  const ingress = createRideMessageIngress({
    rideId: RIDE,
    localNodeId: id,
    seenMessages: createSeenMessageCache(),
    clock: clocks.wall,
  });
  const peers = createPeerTable({ localNodeId: id });
  const links = createDirectLinkIdentityMap({ localNodeId: id });
  const gateways = createGatewayState({ localNodeId: id });
  const transport = {
    sendTo: jest.fn((_endpointId: string, _payload: string) => Promise.resolve()),
    broadcast: jest.fn((_payload: string) => Promise.resolve()),
    onPayload: jest.fn(),
    onPayloadFrom: jest.fn(),
  };
  const forwarder = createRoutedForwarder({
    localNodeId: id,
    transportId: NEARBY,
    transport,
    gatewayState: gateways,
    linkIdentities: links,
    monotonicClock: clocks.mono,
    wallClock: clocks.wall,
  });
  const receiver = createConnectivityReceiver({
    transportId: NEARBY,
    ingress,
    peerTable: peers,
    linkIdentities: links,
    gatewayState: gateways,
    forwarder,
    controlTransport: transport,
    monotonicClock: clocks.mono,
    wallClock: clocks.wall,
  });
  const receive = (fromNodeId: string, payload: string | RideMessage<unknown>) =>
    receiver.handlePayload(
      { endpointId: ep(fromNodeId) },
      typeof payload === 'string' ? payload : serializeRideMessage(payload),
    );
  return { id, ingress, peers, links, gateways, transport, forwarder, receiver, receive };
}

type Node = ReturnType<typeof makeNode>;

const heartbeat = (originId: string) =>
  createHeartbeatMessage({ id: nextId('hb'), rideId: RIDE, originId, createdAt: WALL });

const advert = (originId: string) =>
  createGatewayAdvertisementMessage({ id: nextId('gw'), rideId: RIDE, originId, createdAt: WALL });

type AppOverrides = Partial<{ maxHops: number; rideId: string }>;

function application(originId: string, overrides: AppOverrides = {}) {
  return createRideMessage({
    id: nextId('app'),
    rideId: overrides.rideId ?? RIDE,
    originId,
    type: 'sos',
    priority: 'critical',
    payload: { lat: 12.97, lon: 77.59 },
    ttlMs: 30_000,
    maxHops: overrides.maxHops ?? 4,
    now: WALL,
  });
}

async function link(x: Node, y: Node) {
  expect(await x.receive(y.id, heartbeat(y.id))).toMatchObject({ stage: 'heartbeat' });
  expect(await y.receive(x.id, heartbeat(x.id))).toMatchObject({ stage: 'heartbeat' });
}

async function abc() {
  const a = makeNode('rider-a');
  const b = makeNode('rider-b');
  const c = makeNode(GW);
  await link(a, b);
  await link(b, c);

  const ad = advert(GW);
  expect(await b.receive(GW, ad)).toMatchObject({
    stage: 'gateway_advertisement',
    result: { observed: true, hopCount: 0, via: { resolved: true, nodeId: GW } },
    relay: { status: 'relayed', message: { id: ad.id, hopCount: 1 } },
  });
  expect(b.transport.broadcast).toHaveBeenCalledTimes(1);
  const [relayedPayload] = b.transport.broadcast.mock.calls[0];
  expect(await a.receive('rider-b', relayedPayload)).toMatchObject({
    stage: 'gateway_advertisement',
    result: { observed: true, hopCount: 1, via: { resolved: true, nodeId: 'rider-b' } },
  });
  return { a, b, c };
}

function nonAdvertisementBroadcasts(node: Node) {
  return node.transport.broadcast.mock.calls
    .map(([payload]) => parseRideMessage(payload, WALL + 50)?.type ?? 'unparseable')
    .filter(type => type !== 'gateway_advertisement');
}

function onlySend(node: Node) {
  expect(node.transport.sendTo).toHaveBeenCalledTimes(1);
  const [endpointId, payload] = node.transport.sendTo.mock.calls[0];
  return { endpointId, payload, message: parseRideMessage(payload, WALL + 50)! };
}

describe('end to end: A ↔ B ↔ C(gateway) over targeted Nearby sends', () => {
  test('A → B → C with exactly one targeted send per hop and no broadcast', async () => {
    const { a, b, c } = await abc();
    const original = application('rider-a');
    const snapshot = JSON.stringify(original);

    const atA = await a.forwarder.sendOriginated(original);
    expect(atA).toMatchObject({
      status: 'sent',
      endpointId: 'endpoint-B',
      route: { gatewayNodeId: GW, nextHopNodeId: 'rider-b', transportId: NEARBY, hopCount: 1 },
    });
    const fromA = onlySend(a);
    expect(fromA.endpointId).toBe('endpoint-B');
    expect(fromA.message).toMatchObject({
      id: original.id,
      hopCount: 0,
      gatewayRouting: { targetGatewayId: GW, forwarderDistance: 2 },
    });
    expect(JSON.stringify(original)).toBe(snapshot);

    const atB = await b.receive('rider-a', fromA.payload);
    expect(atB).toMatchObject({
      stage: 'routed',
      result: { status: 'sent', endpointId: 'endpoint-C' },
    });
    const fromB = onlySend(b);
    expect(fromB.message).toMatchObject({
      id: original.id,
      originId: 'rider-a',
      hopCount: 1,
      gatewayRouting: { targetGatewayId: GW, forwarderDistance: 1 },
      payload: original.payload,
    });

    const atC = await c.receive('rider-b', fromB.payload);
    expect(atC).toMatchObject({
      stage: 'routed',
      result: { status: 'gateway_reached', targetGatewayId: GW, message: { id: original.id } },
    });

    for (const node of [a, b, c]) {
      expect(nonAdvertisementBroadcasts(node)).toEqual([]);
      expect(node.transport.onPayload).not.toHaveBeenCalled();
    }
    expect(c.transport.sendTo).not.toHaveBeenCalled();
  });

  test('counters move independently; target fixed', async () => {
    const { a, b } = await abc();
    await a.forwarder.sendOriginated(application('rider-a'));
    const fromA = onlySend(a).message;
    await b.receive('rider-a', serializeRideMessage(fromA));
    const fromB = onlySend(b).message;

    expect([fromA.hopCount, fromB.hopCount]).toEqual([0, 1]);
    expect([fromA, fromB].map(m => m.gatewayRouting?.forwarderDistance)).toEqual([2, 1]);
    expect(new Set([fromA, fromB].map(m => m.gatewayRouting?.targetGatewayId))).toEqual(
      new Set([GW]),
    );
    expect(fromB.id).toBe(fromA.id);
  });

  test('direct A → gateway C', async () => {
    const a = makeNode('rider-a');
    const c = makeNode(GW);
    await link(a, c);
    await a.receive(GW, advert(GW));

    expect(await a.forwarder.sendOriginated(application('rider-a'))).toMatchObject({
      status: 'sent',
      endpointId: 'endpoint-C',
      route: { nextHopNodeId: GW, hopCount: 0 },
    });
    const sent = onlySend(a);
    expect(sent.message.gatewayRouting).toEqual({ targetGatewayId: GW, forwarderDistance: 1 });
    expect(await c.receive('rider-a', sent.payload)).toMatchObject({
      result: { status: 'gateway_reached' },
    });
    expect(c.transport.sendTo).not.toHaveBeenCalled();
  });
});

describe('fail-closed cases', () => {
  test('stale endpoint mapping: link expired, gateway still known, nothing sent', async () => {
    let mono = MONO;
    const a = makeNode('rider-a', { mono: () => mono, wall: () => WALL + 50 });
    a.links.observe(NEARBY, 'endpoint-B', 'rider-b', MONO);
    a.gateways.observe(GW, NEARBY, 1, MONO, 'rider-b');

    mono = MONO + 15_000;
    expect(a.gateways.isKnownGateway(GW, mono)).toBe(true);
    expect(await a.forwarder.sendOriginated(application('rider-a'))).toEqual({
      status: 'not_sent',
      reason: 'no_route',
    });
    expect(a.transport.sendTo).not.toHaveBeenCalled();
  });

  test('missing endpoint for the selected next hop (link gone before send)', async () => {
    const a = makeNode('rider-a');
    a.links.observe(NEARBY, 'endpoint-B', 'rider-b', MONO);
    a.gateways.observe(GW, NEARBY, 1, MONO, 'rider-b');
    const real = a.links.getLinksForNode;
    jest
      .spyOn(a.links, 'getLinksForNode')
      .mockImplementationOnce(real)
      .mockImplementationOnce(() => Object.freeze([]));

    expect(await a.forwarder.sendOriginated(application('rider-a'))).toMatchObject({
      status: 'not_sent',
      reason: 'no_endpoint',
      route: { nextHopNodeId: 'rider-b' },
    });
    expect(a.transport.sendTo).not.toHaveBeenCalled();
  });

  test('an unsupported route is excluded and a fresh Nearby alternative is selected', async () => {
    const a = makeNode('rider-a');
    a.links.observe('future-ble', 'AA:BB', 'rider-b', MONO);
    a.gateways.observe(GW, 'future-ble', 1, MONO, 'rider-b');
    a.links.observe(NEARBY, 'endpoint-D', 'rider-d', MONO);
    a.gateways.observe(GW, NEARBY, 2, MONO, 'rider-d');

    expect(await a.forwarder.sendOriginated(application('rider-a'))).toMatchObject({
      status: 'sent',
      endpointId: 'endpoint-D',
      route: { transportId: NEARBY, nextHopNodeId: 'rider-d' },
    });
    expect(a.transport.sendTo).toHaveBeenCalledTimes(1);
  });

  test('ingress rejections stop processing (malformed/dup/ride/origin)', async () => {
    const { a, b } = await abc();
    await a.forwarder.sendOriginated(application('rider-a'));
    const { payload } = onlySend(a);

    expect(await b.receive('rider-a', 'not a ride message')).toEqual({
      stage: 'ingress_rejected',
      reason: 'invalid',
    });
    expect(await b.receive('rider-a', payload)).toMatchObject({ result: { status: 'sent' } });
    expect(await b.receive('rider-a', payload)).toEqual({
      stage: 'ingress_rejected',
      reason: 'duplicate',
    });
    const otherRide = withGatewayRouting(application('rider-a', { rideId: '99999' }), {
      targetGatewayId: GW,
      forwarderDistance: 2,
    });
    expect(await b.receive('rider-a', otherRide)).toEqual({
      stage: 'ingress_rejected',
      reason: 'wrong_ride',
    });
    expect(await a.receive('rider-b', payload)).toEqual({
      stage: 'ingress_rejected',
      reason: 'local_origin',
    });
    expect(b.transport.sendTo).toHaveBeenCalledTimes(1);
  });

  test('an expired routed packet is rejected at ingress and never forwarded', async () => {
    const { b } = await abc();
    const expired = withGatewayRouting(
      createRideMessage({
        id: nextId('old'),
        rideId: RIDE,
        originId: 'rider-a',
        type: 'sos',
        priority: 'critical',
        payload: {},
        ttlMs: 10,
        maxHops: 4,
        now: WALL,
      }),
      { targetGatewayId: GW, forwarderDistance: 2 },
    );
    expect(await b.receive('rider-a', expired)).toEqual({
      stage: 'ingress_rejected',
      reason: 'invalid',
    });
    expect(b.transport.sendTo).not.toHaveBeenCalled();
  });

  test('previous hop unresolved: an unknown endpoint fails closed', async () => {
    const { b } = await abc();
    const routed = withGatewayRouting(application('rider-a'), {
      targetGatewayId: GW,
      forwarderDistance: 2,
    });
    const result = await b.receiver.handlePayload(
      { endpointId: 'endpoint-Z' },
      serializeRideMessage(routed),
    );
    expect(result).toEqual({
      stage: 'routed',
      result: { status: 'not_sent', reason: 'unknown_previous_hop' },
    });
    expect(b.transport.sendTo).not.toHaveBeenCalled();
  });

  test('no safe route: equal distance is refused', async () => {
    const { b } = await abc();
    const routed = withGatewayRouting(application('rider-a'), {
      targetGatewayId: GW,
      forwarderDistance: 1,
    });
    expect(await b.receive('rider-a', routed)).toEqual({
      stage: 'routed',
      result: { status: 'not_sent', reason: 'no_progress' },
    });
    expect(b.transport.sendTo).not.toHaveBeenCalled();
  });

  test('hop limit reached at a relay', async () => {
    const { b } = await abc();
    const exhausted = {
      ...withGatewayRouting(application('rider-a', { maxHops: 1 }), {
        targetGatewayId: GW,
        forwarderDistance: 2,
      }),
      hopCount: 1,
    };
    expect(await b.receive('rider-a', exhausted)).toEqual({
      stage: 'routed',
      result: { status: 'not_sent', reason: 'hop_limit' },
    });
    expect(b.transport.sendTo).not.toHaveBeenCalled();
  });

  test('origin with no route or insufficient hop budget sends nothing', async () => {
    const lonely = makeNode('rider-a');
    expect(await lonely.forwarder.sendOriginated(application('rider-a'))).toEqual({
      status: 'not_sent',
      reason: 'no_route',
    });
    const { a } = await abc();
    expect(await a.forwarder.sendOriginated(application('rider-a', { maxHops: 0 }))).toEqual({
      status: 'not_sent',
      reason: 'insufficient_hop_budget',
    });
    expect(a.transport.sendTo).not.toHaveBeenCalled();
  });

  test('application messages without routing and control messages are not routed', async () => {
    const { b } = await abc();
    expect(await b.receive('rider-a', application('rider-a'))).toEqual({ stage: 'unrouted' });
    expect(await b.receive('rider-a', heartbeat('rider-a'))).toMatchObject({ stage: 'heartbeat' });
    expect(await b.receive(GW, advert(GW))).toMatchObject({ stage: 'gateway_advertisement' });
    expect(b.transport.sendTo).not.toHaveBeenCalled();
    expect(nonAdvertisementBroadcasts(b)).toEqual([]);
  });
});

describe('send failures', () => {
  test('a definitive first-route failure retries once through a different fresh route', async () => {
    const a = makeNode('rider-a');
    a.links.observe(NEARBY, 'endpoint-B', 'rider-b', MONO);
    a.links.observe(NEARBY, 'endpoint-D', 'rider-d', MONO);
    a.gateways.observe(GW, NEARBY, 1, MONO, 'rider-b');
    a.gateways.observe(GW, NEARBY, 2, MONO, 'rider-d');
    a.transport.sendTo.mockRejectedValueOnce(new Error('first route disappeared'));

    await expect(a.forwarder.sendOriginated(application('rider-a'))).resolves.toMatchObject({
      status: 'sent',
      endpointId: 'endpoint-D',
      route: { nextHopNodeId: 'rider-d' },
    });
    expect(a.transport.sendTo.mock.calls.map(([endpointId]) => endpointId)).toEqual([
      'endpoint-B',
      'endpoint-D',
    ]);
  });

  test('a rejected send is reported with retry context; nothing else tried', async () => {
    const { a } = await abc();
    a.transport.sendTo.mockImplementationOnce(() =>
      Promise.reject(new Error('Endpoint endpoint-B is not a confirmed connection')),
    );
    const original = application('rider-a');

    const result = await a.forwarder.sendOriginated(original);

    expect(result).toMatchObject({
      status: 'transport_error',
      error: 'Endpoint endpoint-B is not a confirmed connection',
      endpointId: 'endpoint-B',
      route: { nextHopNodeId: 'rider-b' },
      message: { id: original.id, gatewayRouting: { forwarderDistance: 2 } },
    });
    expect(a.transport.sendTo).toHaveBeenCalledTimes(1);
    expect(nonAdvertisementBroadcasts(a)).toEqual([]);
    expect(original).not.toHaveProperty('gatewayRouting');
  });

  test('a hung targeted send times out as "unknown"; a late rejection is absorbed', async () => {
    const { a } = await abc();
    a.links.observe(NEARBY, 'endpoint-D', 'rider-d', MONO);
    a.gateways.observe(GW, NEARBY, 2, MONO, 'rider-d');
    let rejectLate: (e: Error) => void = () => {};
    a.transport.sendTo.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectLate = reject)),
    );
    jest.useFakeTimers();
    try {
      let settled: RoutedForwardResult | undefined;
      a.forwarder.sendOriginated(application('rider-a')).then(r => (settled = r));

      await jest.advanceTimersByTimeAsync(ROUTED_SEND_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({ status: 'send_timeout', endpointId: 'endpoint-B' });

      rejectLate(new Error('native send failed later'));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(settled).toMatchObject({ status: 'send_timeout' });
      expect(a.transport.sendTo).toHaveBeenCalledTimes(1);
      expect(nonAdvertisementBroadcasts(a)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
    for (let i = 0; i < 3; i++) {
      await new Promise<void>(resolve => setImmediate(() => resolve()));
    }
  });

  test('rejects an invalid send timeout', () => {
    expect(() =>
      createRoutedForwarder({
        localNodeId: 'rider-a',
        transportId: NEARBY,
        transport: { sendTo: jest.fn() },
        gatewayState: createGatewayState({ localNodeId: 'rider-a' }),
        linkIdentities: createDirectLinkIdentityMap({ localNodeId: 'rider-a' }),
        monotonicClock: () => MONO,
        wallClock: () => WALL,
        sendTimeoutMs: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('endpoint resolution', () => {
  test('two Nearby endpoints for one node: lexically smallest gets the send', async () => {
    const a = makeNode('rider-a');
    a.links.observe(NEARBY, 'endpoint-B2', 'rider-b', MONO);
    a.links.observe(NEARBY, 'endpoint-B1', 'rider-b', MONO);
    a.gateways.observe(GW, NEARBY, 1, MONO, 'rider-b');

    expect(await a.forwarder.sendOriginated(application('rider-a'))).toMatchObject({
      status: 'sent',
      endpointId: 'endpoint-B1',
    });
    expect(a.transport.sendTo).toHaveBeenCalledTimes(1);
  });

  test('resolveTargetEndpoint never guesses', () => {
    const links = createDirectLinkIdentityMap({ localNodeId: 'rider-a' });
    links.observe(NEARBY, 'endpoint-B', 'rider-b', MONO);
    links.observe('future-ble', 'AA:BB', 'rider-d', MONO);

    expect(resolveTargetEndpoint(links, 'rider-b', NEARBY, MONO)).toBe('endpoint-B');
    expect(resolveTargetEndpoint(links, 'rider-d', NEARBY, MONO)).toBeUndefined();
    expect(resolveTargetEndpoint(links, 'rider-z', NEARBY, MONO)).toBeUndefined();
    expect(resolveTargetEndpoint(links, 'rider-b', NEARBY, MONO + 15_000)).toBeUndefined();
  });
});

describe('subscription and isolation', () => {
  test('subscribes only to the endpoint-aware event and reports each result', async () => {
    const { b } = await abc();
    let handler: ((source: { endpointId: string }, payload: string) => void) | undefined;
    const transport = {
      onPayloadFrom: jest.fn((cb: typeof handler) => {
        handler = cb;
        return () => (handler = undefined);
      }),
      onPayload: jest.fn(),
    };
    const results: ConnectivityReceiveResult[] = [];

    const unsubscribe = b.receiver.subscribe(transport, r => results.push(r));
    handler!({ endpointId: 'endpoint-A' }, serializeRideMessage(heartbeat('rider-a')));
    await new Promise<void>(resolve => setImmediate(() => resolve()));

    expect(transport.onPayloadFrom).toHaveBeenCalledTimes(1);
    expect(transport.onPayload).not.toHaveBeenCalled();
    expect(results).toMatchObject([{ stage: 'heartbeat', result: { observed: true } }]);
    unsubscribe();
    expect(handler).toBeUndefined();
  });

  test('a throwing result observer does not break receive', async () => {
    const { b } = await abc();
    let handler: ((source: { endpointId: string }, payload: string) => void) | undefined;
    b.receiver.subscribe(
      {
        onPayloadFrom: cb => {
          handler = cb;
          return () => {};
        },
      },
      () => {
        throw new Error('observer bug');
      },
    );
    handler!({ endpointId: 'endpoint-A' }, serializeRideMessage(heartbeat('rider-a')));
    await new Promise<void>(resolve => setImmediate(() => resolve()));
    expect(b.peers.isDirectPeer('rider-a', MONO)).toBe(true);
  });

  const concreteAndPhase1 = [
    'react-native',
    'livekit-client',
    '../src/transports/NearbyTransport',
    '../src/transports/LiveKitHazardTransport',
    '../src/hazards/HazardCoordinator',
    '../src/protocol/hazardPolicy',
  ];

  function requireWithForbidden(module: string, forbidden: string[]) {
    jest.isolateModules(() => {
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`${module} must not import ${name}`);
        });
      }
      expect(() => require(module)).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  }

  test('the routed forwarder never touches flood relay, concrete transports or Phase 1', () => {
    requireWithForbidden('../src/connectivity/routedForwarder', [
      ...concreteAndPhase1,
      '../src/connectivity/relayPolicy',
    ]);
  });

  test('the receiver (owns control-plane flood) has no concrete or Phase 1 deps', () => {
    requireWithForbidden('../src/connectivity/connectivityReceiver', concreteAndPhase1);
  });
});
