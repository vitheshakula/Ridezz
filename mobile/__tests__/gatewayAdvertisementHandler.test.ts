import { handleGatewayAdvertisement } from '../src/connectivity/gatewayAdvertisementHandler';
import { createGatewayState, type GatewayState } from '../src/connectivity/gatewayState';
import { createPeerTable } from '../src/connectivity/peerTable';
import { decideRelay } from '../src/connectivity/relayPolicy';
import {
  createRideMessageIngress,
  type RideMessageIngressResult,
  type RideMessageIngressSource,
} from '../src/connectivity/rideMessageIngress';
import {
  createGatewayAdvertisementMessage,
} from '../src/connectivity/protocol/gatewayAdvertisement';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import {
  createRideMessage,
  type RideMessage,
  type RideMessageType,
} from '../src/connectivity/protocol/rideMessage';
import {
  encodeRideMessage,
  serializeRideMessage,
} from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';

/** Wall clock (protocol) and monotonic clock (local freshness) are deliberately different. */
const WALL = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';

type Accepted = Extract<RideMessageIngressResult, { accepted: true }>;

function advertFrom(originId: string, id = `gw-${originId}-1`) {
  return createGatewayAdvertisementMessage({ id, rideId: RIDE, originId, createdAt: WALL });
}

/** A node's receive side: real ingress (wall clock) plus its own gateway state and peer table. */
function node(localNodeId: string) {
  const ingress = createRideMessageIngress({
    rideId: RIDE,
    localNodeId,
    seenMessages: createSeenMessageCache(),
    clock: () => WALL + 50,
  });
  const gateways = createGatewayState({ localNodeId });
  const peers = createPeerTable({ localNodeId });
  const receive = (message: RideMessage<unknown>, source: RideMessageIngressSource) => {
    const result = ingress.ingest(encodeRideMessage(message), source);
    if (!result.accepted) {
      throw new Error(`ingress rejected: ${result.reason}`);
    }
    return result;
  };
  return { ingress, gateways, peers, receive };
}

function accepted(message: RideMessage<unknown>, transportId = 'transport-x'): Accepted {
  return { accepted: true, message, source: { transportId } } as Accepted;
}

describe('gateway advertisement handler: C → B → A', () => {
  test('A records gateway C at hop 1 via its local transport; PeerTable untouched', () => {
    const b = node('rider-b');
    const a = node('rider-a');

    // C advertises (hop 0). B accepts it and records C as a direct-hop gateway.
    const atB = b.receive(advertFrom('rider-c'), { transportId: 'b-link', peerId: 'ep-c' });
    expect(handleGatewayAdvertisement(atB, MONO, b.gateways)).toMatchObject({
      observed: true,
      gatewayNodeId: 'rider-c',
      hopCount: 0,
    });

    // B relays through the existing relay policy; A accepts the hop-1 copy from B.
    const relay = decideRelay(atB.message, WALL + 50);
    if (!relay.relay) {
      throw new Error('expected relay');
    }
    const atA = a.receive(relay.message, { transportId: 'transport-x', peerId: 'nearby-ep-77' });

    expect(atA.message).toMatchObject({ originId: 'rider-c', hopCount: 1 });
    expect(handleGatewayAdvertisement(atA, MONO, a.gateways)).toEqual({
      observed: true,
      gatewayNodeId: 'rider-c',
      transportId: 'transport-x',
      hopCount: 1,
      change: 'new_gateway',
    });
    expect(a.gateways.getGateways(MONO)).toEqual([
      {
        nodeId: 'rider-c',
        lastSeenAt: MONO,
        observations: [{ transportId: 'transport-x', hopCount: 1, lastSeenAt: MONO }],
      },
    ]);
    // Neither the gateway nor the relay endpoint becomes a direct peer, nor a gateway.
    expect(a.peers.getPeers(MONO)).toEqual([]);
    expect(a.gateways.isKnownGateway('nearby-ep-77', MONO)).toBe(false);
    expect(a.gateways.isKnownGateway('rider-b', MONO)).toBe(false);
  });

  test('records relayed hop counts up to maxHops, after which relay stops', () => {
    let message: RideMessage<unknown> = advertFrom('rider-c');
    const gateways = createGatewayState({ localNodeId: 'rider-z' });
    for (let hop = 0; hop <= 4; hop++) {
      expect(handleGatewayAdvertisement(accepted(message), MONO + hop, gateways)).toMatchObject({
        observed: true,
        hopCount: hop,
      });
      const next = decideRelay(message, WALL + hop);
      if (hop < 4) {
        expect(next.relay).toBe(true);
        message = next.relay ? next.message : message;
      } else {
        expect(next).toEqual({ relay: false, reason: 'hop_limit' });
      }
    }
    expect(gateways.getGateway('rider-c', MONO + 4)?.observations.map(o => o.hopCount)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

describe('gateway advertisement handler: behaviour', () => {
  test('uses the monotonic observation time, not the wall-clock envelope', () => {
    const gateways = createGatewayState({ localNodeId: 'rider-a' });
    const ad = advertFrom('rider-c');

    handleGatewayAdvertisement(accepted(ad), 50_000, gateways);

    const gw = gateways.getGateway('rider-c', 50_000)!;
    expect(gw.lastSeenAt).toBe(50_000);
    expect(gw.lastSeenAt).not.toBe(ad.createdAt);
    expect(gw.lastSeenAt).not.toBe(ad.expiresAt);
  });

  test('preserves source.transportId; source.peerId is never an identity', () => {
    const a = node('rider-a');
    const result = a.receive(advertFrom('rider-c'), {
      transportId: 'nearby',
      peerId: 'nearby-endpoint-123',
    });

    expect(handleGatewayAdvertisement(result, MONO, a.gateways)).toMatchObject({
      gatewayNodeId: 'rider-c',
      transportId: 'nearby',
    });
    expect(a.gateways.getGateways(MONO).map(g => g.nodeId)).toEqual(['rider-c']);
    expect(a.gateways.isKnownGateway('nearby-endpoint-123', MONO)).toBe(false);
  });

  test('separate advertisements via X and Y give one gateway with two observations', () => {
    const a = node('rider-a');
    const viaX = a.receive(advertFrom('rider-c', 'gw-1'), { transportId: 'transport-x' });
    const relayed = decideRelay(advertFrom('rider-c', 'gw-2'), WALL);
    const viaY = a.receive(relayed.relay ? relayed.message : advertFrom('x'), {
      transportId: 'transport-y',
    });

    handleGatewayAdvertisement(viaX, MONO, a.gateways);
    expect(handleGatewayAdvertisement(viaY, MONO + 1, a.gateways)).toMatchObject({
      change: 'new_observation',
    });
    expect(a.gateways.getGateway('rider-c', MONO + 1)?.observations).toEqual([
      { transportId: 'transport-x', hopCount: 0, lastSeenAt: MONO },
      { transportId: 'transport-y', hopCount: 1, lastSeenAt: MONO + 1 },
    ]);
  });

  test('the SAME advertisement over a second path is deduplicated by ingress first', () => {
    // Documents the dedup implication: only the first-arriving path of one advertisement id is
    // observed. Later advertisement cycles carry new ids and can reveal other paths.
    const a = node('rider-a');
    const bytes = encodeRideMessage(advertFrom('rider-c'));
    const first = a.ingress.ingest(bytes, { transportId: 'transport-x' });
    const second = a.ingress.ingest(bytes, { transportId: 'transport-y' });
    if (first.accepted) {
      handleGatewayAdvertisement(first, MONO, a.gateways);
    }

    expect(second).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(a.gateways.getGateway('rider-c', MONO)?.observations).toHaveLength(1);
  });

  test.each<RideMessageType>(['sos', 'hazard', 'ack', 'location', 'ride_state'])(
    'an accepted %s does not update gateway state',
    type => {
      const gateways = createGatewayState({ localNodeId: 'rider-a' });
      const m = createRideMessage({
        id: `m-${type}`,
        rideId: RIDE,
        originId: 'rider-c',
        type,
        priority: 'normal',
        payload: {},
        ttlMs: 10_000,
        maxHops: 3,
        now: WALL,
      });
      expect(handleGatewayAdvertisement(accepted(m), MONO, gateways)).toEqual({
        observed: false,
        reason: 'not_gateway_advertisement',
      });
      expect(gateways.getGateways(MONO)).toEqual([]);
    },
  );

  test('a heartbeat does not update gateway state', () => {
    const gateways = createGatewayState({ localNodeId: 'rider-a' });
    const hb = createHeartbeatMessage({
      id: 'hb',
      rideId: RIDE,
      originId: 'rider-c',
      createdAt: WALL,
    });
    expect(handleGatewayAdvertisement(accepted(hb), MONO, gateways)).toMatchObject({
      reason: 'not_gateway_advertisement',
    });
  });

  test('an invalid payload is rejected without updating state', () => {
    const gateways = createGatewayState({ localNodeId: 'rider-a' });
    const odd = createRideMessage({
      id: 'gw-odd',
      rideId: RIDE,
      originId: 'rider-c',
      type: 'gateway_advertisement',
      priority: 'normal',
      payload: ['not', 'an', 'object'],
      ttlMs: 30_000,
      maxHops: 4,
      now: WALL,
    });
    // It is a valid envelope, so real ingress accepts it; the handler validates the payload.
    const a = node('rider-a');
    const result = a.ingress.ingest(serializeRideMessage(odd), { transportId: 't' });
    if (!result.accepted) {
      throw new Error(`ingress rejected: ${result.reason}`);
    }

    expect(handleGatewayAdvertisement(result, MONO, gateways)).toEqual({
      observed: false,
      reason: 'invalid_payload',
    });
    expect(gateways.getGateways(MONO)).toEqual([]);
  });

  test('state rejections are surfaced cleanly', () => {
    const local = createGatewayState({ localNodeId: 'rider-c' });
    expect(handleGatewayAdvertisement(accepted(advertFrom('rider-c')), MONO, local)).toEqual({
      observed: false,
      reason: 'gateway_rejected',
      gatewayRejection: 'local_node',
    });

    const full = createGatewayState({ localNodeId: 'rider-a', maxGateways: 1 });
    handleGatewayAdvertisement(accepted(advertFrom('rider-c')), MONO, full);
    expect(handleGatewayAdvertisement(accepted(advertFrom('rider-d')), MONO, full)).toEqual({
      observed: false,
      reason: 'gateway_rejected',
      gatewayRejection: 'table_full',
    });
  });
});

describe('gateway advertisement handler: ingress owns ride, origin and dedup checks', () => {
  test('wrong-ride, local-origin and duplicate packets never reach the handler', () => {
    const a = node('rider-a');
    const observe = jest.fn();
    const spyState = { ...a.gateways, observe } as GatewayState;
    const results = [
      a.ingress.ingest(
        encodeRideMessage(
          createGatewayAdvertisementMessage({
            id: 'other-ride',
            rideId: '99999',
            originId: 'rider-c',
            createdAt: WALL,
          }),
        ),
        { transportId: 't' },
      ),
      a.ingress.ingest(encodeRideMessage(advertFrom('rider-a')), { transportId: 't' }),
    ];
    const bytes = encodeRideMessage(advertFrom('rider-c'));
    a.ingress.ingest(bytes, { transportId: 't' });
    results.push(a.ingress.ingest(bytes, { transportId: 't' }));

    expect(results.map(r => !r.accepted && r.reason)).toEqual([
      'wrong_ride',
      'local_origin',
      'duplicate',
    ]);
    // The handler's input type only admits accepted results, so these cannot be passed to it.
    for (const r of results) {
      if (r.accepted) {
        handleGatewayAdvertisement(r, MONO, spyState);
      }
    }
    expect(observe).not.toHaveBeenCalled();
  });
});

describe('gateway modules: isolation', () => {
  test('no React Native, transport, PeerTable or timer dependencies', () => {
    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'livekit-client',
        '@livekit/react-native',
        'react-native-get-random-values',
        '../src/transports/Transport',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/connectivity/peerTable',
        '../src/connectivity/heartbeatHandler',
        '../src/connectivity/relayPolicy',
        '../src/connectivity/cycleScheduler',
        '../src/connectivity/protocol/rideMessageCodec',
        '../src/connectivity/protocol/seenMessageCache',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`gateway modules must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/gatewayState')).not.toThrow();
      expect(() => require('../src/connectivity/gatewayAdvertisementHandler')).not.toThrow();
      expect(() => require('../src/connectivity/protocol/gatewayAdvertisement')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });

  test('never schedules timers', () => {
    const timers = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      const gateways = createGatewayState({ localNodeId: 'rider-a' });
      handleGatewayAdvertisement(accepted(advertFrom('rider-c')), MONO, gateways);
      gateways.getGateways(MONO);
      gateways.prune(MONO + 100_000);
      for (const spy of timers) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      timers.forEach(spy => spy.mockRestore());
    }
  });
});
