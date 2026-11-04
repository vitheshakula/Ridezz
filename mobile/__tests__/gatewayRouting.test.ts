import {
  compareGatewayRoutes,
  getGatewayRouteCandidates,
  selectGatewayRoute,
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
  type RideMessageIngressResult,
  type RideMessageIngressSource,
} from '../src/connectivity/rideMessageIngress';
import { createGatewayAdvertisementMessage } from '../src/connectivity/protocol/gatewayAdvertisement';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import type { RideMessage } from '../src/connectivity/protocol/rideMessage';
import { encodeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';

const WALL = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';
const LOCAL = 'rider-a';

type Accepted = Extract<RideMessageIngressResult, { accepted: true }>;

function world() {
  const gatewayState = createGatewayState({ localNodeId: LOCAL });
  const linkIdentities = createDirectLinkIdentityMap({ localNodeId: LOCAL });
  const candidates = (now = MONO, gateway?: string) =>
    getGatewayRouteCandidates({ localNodeId: LOCAL, gatewayState, linkIdentities, now }, gateway);
  return { gatewayState, linkIdentities, candidates };
}

function route(
  gatewayNodeId: string,
  nextHopNodeId: string,
  transportId: string,
  hopCount: number,
  observedAt = MONO,
): GatewayRouteCandidate {
  return { gatewayNodeId, nextHopNodeId, transportId, hopCount, observedAt };
}

describe('gateway routing: candidate construction', () => {
  test('direct gateway: A ↔ C gives gateway C via C at hop 0', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-c', 'rider-c', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 0, MONO, 'rider-c');

    expect(w.candidates()).toEqual([route('rider-c', 'rider-c', 'nearby', 0)]);
  });

  test('one relay: A ↔ B ↔ C gives gateway C via B at hop 1', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');

    expect(w.candidates()).toEqual([route('rider-c', 'rider-b', 'nearby', 1)]);
  });

  test('two paths (via B at hop 1, via D at hop 2) are both preserved', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.linkIdentities.observe('nearby', 'ep-d', 'rider-d', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 2, MONO, 'rider-d');
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO + 1, 'rider-b');

    expect(w.candidates(MONO + 1)).toEqual([
      route('rider-c', 'rider-b', 'nearby', 1, MONO + 1),
      route('rider-c', 'rider-d', 'nearby', 2, MONO),
    ]);
  });

  test('the same next hop over two transports gives two candidates', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.linkIdentities.observe('future-ble', 'AA:BB', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');
    w.gatewayState.observe('rider-c', 'future-ble', 1, MONO, 'rider-b');

    expect(w.candidates()).toEqual([
      route('rider-c', 'rider-b', 'future-ble', 1),
      route('rider-c', 'rider-b', 'nearby', 1),
    ]);
  });

  test('can be restricted to one gateway', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');
    w.gatewayState.observe('rider-e', 'nearby', 2, MONO, 'rider-b');

    expect(w.candidates(MONO, 'rider-e')).toEqual([route('rider-e', 'rider-b', 'nearby', 2)]);
    expect(w.candidates(MONO, 'rider-unknown')).toEqual([]);
  });
});

describe('gateway routing: no route without a resolved, fresh direct sender', () => {
  test('a known gateway with an unresolved sender yields no candidate', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO);

    expect(w.gatewayState.isKnownGateway('rider-c', MONO)).toBe(true);
    expect(w.candidates()).toEqual([]);
  });

  test('fresh gateway observation but stale direct link: no candidate', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO + 10_000, 'rider-b');

    expect(w.candidates(MONO + 14_999)).toHaveLength(1);
    expect(w.gatewayState.isKnownGateway('rider-c', MONO + 15_000)).toBe(true);
    expect(w.candidates(MONO + 15_000)).toEqual([]);
  });

  test('fresh direct link but stale gateway observation: no candidate', () => {
    const w = world();
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO + 20_000);

    expect(w.candidates(MONO + 24_999)).toHaveLength(1);
    expect(w.candidates(MONO + 25_000)).toEqual([]);
  });

  test('the via node linked only on a different transport is not a route on this one', () => {
    const w = world();
    w.linkIdentities.observe('future-ble', 'AA:BB', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');

    expect(w.candidates()).toEqual([]);
  });

  test('an observation whose hop count contradicts its sender is ignored', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.linkIdentities.observe('nearby', 'ep-c', 'rider-c', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 0, MONO, 'rider-b');
    w.gatewayState.observe('rider-c', 'nearby', 2, MONO, 'rider-c');

    expect(w.candidates()).toEqual([]);
  });

  test('never yields the local node as next hop or gateway', () => {
    const w = world();
    expect(w.linkIdentities.observe('nearby', 'ep', LOCAL, MONO)).toMatchObject({
      reason: 'local_node',
    });
    expect(w.gatewayState.observe(LOCAL, 'nearby', 1, MONO, 'rider-b')).toMatchObject({
      reason: 'local_node',
    });
    expect(w.gatewayState.observe('rider-c', 'nearby', 1, MONO, LOCAL)).toMatchObject({
      reason: 'invalid',
    });
    expect(w.candidates()).toEqual([]);

    const foreign = createGatewayState({ localNodeId: 'rider-z' });
    const foreignLinks = createDirectLinkIdentityMap({ localNodeId: 'rider-z' });
    foreignLinks.observe('nearby', 'ep', LOCAL, MONO);
    foreign.observe('rider-c', 'nearby', 1, MONO, LOCAL);
    foreign.observe(LOCAL, 'nearby', 0, MONO, LOCAL);
    expect(
      getGatewayRouteCandidates({
        localNodeId: LOCAL,
        gatewayState: foreign,
        linkIdentities: foreignLinks,
        now: MONO,
      }),
    ).toEqual([]);
  });

  test('an invalid now yields no candidates', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');
    expect(w.candidates(NaN)).toEqual([]);
  });
});

describe('gateway routing: endpoint reassignment', () => {
  test('a route via B dies when its endpoint is reassigned to D; it is not rewritten via D', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'endpoint-E', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');
    expect(w.candidates()).toEqual([route('rider-c', 'rider-b', 'nearby', 1)]);

    expect(w.linkIdentities.observe('nearby', 'endpoint-E', 'rider-d', MONO + 1_000)).toMatchObject(
      { change: 'reassigned' },
    );

    expect(w.gatewayState.isKnownGateway('rider-c', MONO + 1_000)).toBe(true);
    expect(w.candidates(MONO + 1_000)).toEqual([]);

    w.gatewayState.observe('rider-c', 'nearby', 1, MONO + 2_000, 'rider-d');
    expect(w.candidates(MONO + 2_000)).toEqual([
      route('rider-c', 'rider-d', 'nearby', 1, MONO + 2_000),
    ]);
  });

  test('B moving to another endpoint on the same transport keeps routes via B', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'endpoint-E', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');
    w.linkIdentities.observe('nearby', 'endpoint-E', 'rider-d', MONO + 1_000);
    w.linkIdentities.observe('nearby', 'endpoint-F', 'rider-b', MONO + 1_000);

    expect(w.candidates(MONO + 1_000)).toEqual([route('rider-c', 'rider-b', 'nearby', 1)]);
  });
});

describe('gateway routing: selection', () => {
  test('lower hop count wins', () => {
    expect(
      selectGatewayRoute([
        route('rider-c', 'rider-a2', 'nearby', 2),
        route('rider-c', 'rider-z', 'nearby', 1),
      ]),
    ).toEqual(route('rider-c', 'rider-z', 'nearby', 1));
  });

  test('equal hops: lexical next-hop id wins', () => {
    expect(
      selectGatewayRoute([
        route('rider-c', 'rider-d', 'nearby', 1),
        route('rider-c', 'rider-b', 'nearby', 1),
      ])?.nextHopNodeId,
    ).toBe('rider-b');
  });

  test('equal next hop: lexical transport id wins', () => {
    expect(
      selectGatewayRoute([
        route('rider-c', 'rider-b', 'nearby', 1),
        route('rider-c', 'rider-b', 'future-ble', 1),
      ])?.transportId,
    ).toBe('future-ble');
  });

  test('freshness is not a quality metric: an older observation can still win', () => {
    expect(
      selectGatewayRoute([
        route('rider-c', 'rider-d', 'nearby', 1, MONO + 9_000),
        route('rider-c', 'rider-b', 'nearby', 1, MONO),
      ])?.observedAt,
    ).toBe(MONO);
  });

  test('deterministic regardless of input order and across repeated calls', () => {
    const all = [
      route('rider-e', 'rider-b', 'nearby', 1),
      route('rider-c', 'rider-b', 'nearby', 1),
      route('rider-c', 'rider-d', 'nearby', 0),
      route('rider-c', 'rider-b', 'ble', 1),
    ];
    const winners = new Set<GatewayRouteCandidate | undefined>();
    for (let i = 0; i < all.length; i++) {
      const rotated = [...all.slice(i), ...all.slice(0, i)];
      winners.add(selectGatewayRoute(rotated));
      winners.add(selectGatewayRoute([...rotated].reverse()));
    }
    expect(winners.size).toBe(1);
    expect([...winners][0]).toEqual(route('rider-c', 'rider-d', 'nearby', 0));
    expect([...all].sort(compareGatewayRoutes).map(r => r.gatewayNodeId)).toEqual([
      'rider-c',
      'rider-c',
      'rider-c',
      'rider-e',
    ]);
  });

  test('no candidates selects nothing; selection does not modify its input', () => {
    expect(selectGatewayRoute([])).toBeUndefined();
    const input = Object.freeze([
      route('rider-c', 'rider-d', 'x', 2),
      route('rider-c', 'rider-b', 'x', 1),
    ]);
    selectGatewayRoute(input);
    expect(input.map(r => r.hopCount)).toEqual([2, 1]);
  });
});

describe('gateway routing: immutability and purity', () => {
  test('candidate lists and candidates are frozen', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');
    const list = w.candidates();

    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    expect(() => (list as unknown[]).push({})).toThrow(TypeError);
  });

  test('resolving candidates never prunes or mutates the underlying state', () => {
    const w = world();
    w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
    w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');

    w.candidates(MONO + 100_000);

    expect(w.candidates(MONO + 1)).toHaveLength(1);
    expect(w.linkIdentities.resolve('nearby', 'ep-b', MONO + 1)).toBe('rider-b');
  });

  test('no timers and no dependency on transports, PeerTable or React Native', () => {
    const timers = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      const w = world();
      w.linkIdentities.observe('nearby', 'ep-b', 'rider-b', MONO);
      w.gatewayState.observe('rider-c', 'nearby', 1, MONO, 'rider-b');
      selectGatewayRoute(w.candidates());
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
        '../src/connectivity/relayPolicy',
        '../src/connectivity/rideMessageIngress',
        '../src/connectivity/heartbeatEmitter',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`routing must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/gatewayRouting')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
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
  const receive = (message: RideMessage<unknown>, source: RideMessageIngressSource): Accepted => {
    const result = ingress.ingest(encodeRideMessage(message), source);
    if (!result.accepted) {
      throw new Error(`ingress rejected: ${result.reason}`);
    }
    return result;
  };
  const routes = (now: number) =>
    getGatewayRouteCandidates({ localNodeId, gatewayState: gateways, linkIdentities: links, now });
  return { peers, links, gateways, receive, routes };
}

let ids = 0;
const heartbeatFrom = (originId: string) =>
  createHeartbeatMessage({ id: `hb-${++ids}`, rideId: RIDE, originId, createdAt: WALL });
const advertFrom = (originId: string) =>
  createGatewayAdvertisementMessage({ id: `gw-${++ids}`, rideId: RIDE, originId, createdAt: WALL });

describe('gateway advertisement handler: direct-sender resolution', () => {
  test('without a link map behaviour is unchanged and nothing is routable', () => {
    const a = node(LOCAL);
    const result = handleGatewayAdvertisement(
      a.receive(advertFrom('rider-c'), { transportId: 'nearby', peerId: 'ep-c' }),
      MONO,
      a.gateways,
    );
    expect(result).not.toHaveProperty('via');
    expect(a.gateways.isKnownGateway('rider-c', MONO)).toBe(true);
    expect(a.routes(MONO)).toEqual([]);
  });

  test('missing source.peerId: gateway known, no route', () => {
    const a = node(LOCAL);
    expect(
      handleGatewayAdvertisement(
        a.receive(advertFrom('rider-c'), { transportId: 'nearby' }),
        MONO,
        a.gateways,
        a.links,
      ),
    ).toMatchObject({ observed: true, via: { resolved: false, reason: 'no_transport_peer_id' } });
    expect(a.gateways.isKnownGateway('rider-c', MONO)).toBe(true);
    expect(a.routes(MONO)).toEqual([]);
  });

  test('unknown endpoint: gateway known, no route, nothing guessed from originId', () => {
    const a = node(LOCAL);
    handleHeartbeat(
      a.receive(heartbeatFrom('rider-c'), { transportId: 'nearby' }),
      MONO,
      a.peers,
      a.links,
    );
    expect(
      handleGatewayAdvertisement(
        a.receive(advertFrom('rider-c'), { transportId: 'nearby', peerId: 'ep-c' }),
        MONO,
        a.gateways,
        a.links,
      ),
    ).toMatchObject({ via: { resolved: false, reason: 'unknown_link' } });
    expect(a.peers.isDirectPeer('rider-c', MONO)).toBe(true);
    expect(a.routes(MONO)).toEqual([]);
  });

  test('a hop-0 advertisement handed over by another node is not routable', () => {
    const a = node(LOCAL);
    handleHeartbeat(
      a.receive(heartbeatFrom('rider-b'), { transportId: 'nearby', peerId: 'ep-b' }),
      MONO,
      a.peers,
      a.links,
    );
    expect(
      handleGatewayAdvertisement(
        a.receive(advertFrom('rider-c'), { transportId: 'nearby', peerId: 'ep-b' }),
        MONO,
        a.gateways,
        a.links,
      ),
    ).toMatchObject({ via: { resolved: false, reason: 'sender_mismatch' } });
    expect(a.routes(MONO)).toEqual([]);
  });
});

describe('end to end: A ↔ B ↔ C → cloud', () => {
  test('A selects gateway C via next hop B on nearby at hop 1', () => {
    const a = node(LOCAL);
    const b = node('rider-b');

    handleHeartbeat(
      a.receive(heartbeatFrom('rider-b'), { transportId: 'nearby', peerId: 'endpoint-B' }),
      MONO,
      a.peers,
      a.links,
    );
    const atB = b.receive(advertFrom('rider-c'), { transportId: 'nearby', peerId: 'endpoint-C' });
    const relay = decideRelay(atB.message, WALL + 50);
    if (!relay.relay) {
      throw new Error('expected B to relay');
    }
    const handled = handleGatewayAdvertisement(
      a.receive(relay.message, { transportId: 'nearby', peerId: 'endpoint-B' }),
      MONO + 100,
      a.gateways,
      a.links,
    );
    expect(handled).toMatchObject({
      observed: true,
      gatewayNodeId: 'rider-c',
      hopCount: 1,
      via: { resolved: true, nodeId: 'rider-b' },
    });

    const candidates = a.routes(MONO + 100);
    expect(selectGatewayRoute(candidates)).toEqual({
      gatewayNodeId: 'rider-c',
      nextHopNodeId: 'rider-b',
      transportId: 'nearby',
      hopCount: 1,
      observedAt: MONO + 100,
    });
    expect(candidates).toHaveLength(1);
    expect(a.peers.isDirectPeer('rider-c', MONO + 100)).toBe(false);

    expect(a.gateways.isKnownGateway('rider-c', MONO + 15_000)).toBe(true);
    expect(selectGatewayRoute(a.routes(MONO + 15_000))).toBeUndefined();
  });

  test('a direct gateway beats a relayed one', () => {
    const a = node(LOCAL);
    const b = node('rider-b');
    for (const [origin, peerId] of [
      ['rider-b', 'endpoint-B'],
      ['rider-c', 'endpoint-C'],
    ] as const) {
      handleHeartbeat(
        a.receive(heartbeatFrom(origin), { transportId: 'nearby', peerId }),
        MONO,
        a.peers,
        a.links,
      );
    }
    const atB = b.receive(advertFrom('rider-e'), { transportId: 'nearby', peerId: 'ep-e' });
    const relay = decideRelay(atB.message, WALL + 50);
    handleGatewayAdvertisement(
      a.receive(relay.relay ? relay.message : atB.message, {
        transportId: 'nearby',
        peerId: 'endpoint-B',
      }),
      MONO,
      a.gateways,
      a.links,
    );
    handleGatewayAdvertisement(
      a.receive(advertFrom('rider-c'), { transportId: 'nearby', peerId: 'endpoint-C' }),
      MONO,
      a.gateways,
      a.links,
    );

    expect(a.routes(MONO).map(r => [r.gatewayNodeId, r.nextHopNodeId, r.hopCount])).toEqual([
      ['rider-c', 'rider-c', 0],
      ['rider-e', 'rider-b', 1],
    ]);
    expect(selectGatewayRoute(a.routes(MONO))?.gatewayNodeId).toBe('rider-c');
  });
});
