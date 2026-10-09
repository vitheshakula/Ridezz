import {
  handleHeartbeat,
  type AcceptedRideMessageIngress,
} from '../src/connectivity/heartbeatHandler';
import { createPeerTable, type PeerTable } from '../src/connectivity/peerTable';
import { decideRelay } from '../src/connectivity/relayPolicy';
import {
  createRideMessageIngress,
  type RideMessageIngressSource,
} from '../src/connectivity/rideMessageIngress';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import {
  createRideMessage,
  relayRideMessage,
  type RideMessage,
  type RideMessageType,
} from '../src/connectivity/protocol/rideMessage';
import {
  encodeRideMessage,
  serializeRideMessage,
} from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';

/** Protocol (wall) clock: shared across devices. */
const WALL = 1_700_000_000_000;
/** Peer-freshness (monotonic) clock: local to B. */
const MONO = 50_000;
const RIDE = '12345';

function heartbeatFrom(originId: string, id = `hb-${originId}-1`, createdAt = WALL) {
  return createHeartbeatMessage({ id, rideId: RIDE, originId, createdAt });
}

/** Node B's receive side: real ingress (wall clock) and a real PeerTable (monotonic clock). */
function nodeB(peerTable: PeerTable = createPeerTable({ localNodeId: 'rider-b' })) {
  const ingress = createRideMessageIngress({
    rideId: RIDE,
    localNodeId: 'rider-b',
    seenMessages: createSeenMessageCache(),
    clock: () => WALL,
  });
  const receive = (packet: string | Uint8Array, source: RideMessageIngressSource) => {
    const result = ingress.ingest(packet, source);
    if (!result.accepted) {
      throw new Error(`ingress rejected: ${result.reason}`);
    }
    return result;
  };
  return { peerTable, receive };
}

describe('heartbeat handler: end to end', () => {
  test('A → B: ingress accepts, presence refreshes A, relay policy refuses to forward', () => {
    const { peerTable, receive } = nodeB();
    const original = heartbeatFrom('rider-a');

    // A sends the heartbeat exactly as created: hopCount 0, maxHops 0, no decideRelay.
    expect(original).toMatchObject({ hopCount: 0, maxHops: 0 });
    const accepted = receive(encodeRideMessage(original), { transportId: 'transport-x' });
    expect(accepted.message).toEqual(original);

    expect(handleHeartbeat(accepted, MONO, peerTable)).toEqual({
      observed: true,
      nodeId: 'rider-a',
      transportId: 'transport-x',
      change: 'new_peer',
    });
    expect(peerTable.isDirectPeer('rider-a', MONO)).toBe(true);

    // B cannot propagate A's heartbeat to C. maxHops 0 is checked before message type.
    expect(decideRelay(accepted.message, WALL)).toEqual({ relay: false, reason: 'hop_limit' });
    // Even with hop budget, heartbeat type policy forbids relaying.
    const withBudget = createRideMessage({
      ...original,
      type: 'heartbeat',
      ttlMs: 10_000,
      maxHops: 3,
      now: WALL,
    });
    expect(decideRelay(withBudget, WALL)).toEqual({ relay: false, reason: 'message_policy' });
  });

  test('a repeat heartbeat refreshes the same peer', () => {
    const { peerTable, receive } = nodeB();
    const first = receive(encodeRideMessage(heartbeatFrom('rider-a', 'hb-1')), {
      transportId: 'transport-x',
    });
    const second = receive(encodeRideMessage(heartbeatFrom('rider-a', 'hb-2')), {
      transportId: 'transport-x',
    });

    handleHeartbeat(first, MONO, peerTable);
    expect(handleHeartbeat(second, MONO + 5_000, peerTable)).toMatchObject({
      observed: true,
      change: 'refreshed',
    });
    expect(peerTable.getPeer('rider-a', MONO + 5_000)?.lastSeenAt).toBe(MONO + 5_000);
  });
});

describe('heartbeat handler: identity mapping', () => {
  test('uses originId as the node id, never the transport-local peerId', () => {
    const { peerTable, receive } = nodeB();
    const accepted = receive(serializeRideMessage(heartbeatFrom('rider-a')), {
      transportId: 'nearby',
      peerId: 'nearby-endpoint-123',
    });

    expect(handleHeartbeat(accepted, MONO, peerTable)).toMatchObject({
      nodeId: 'rider-a',
      transportId: 'nearby',
    });
    expect(peerTable.getPeers(MONO).map(p => p.nodeId)).toEqual(['rider-a']);
    expect(peerTable.isDirectPeer('nearby-endpoint-123', MONO)).toBe(false);
    expect(peerTable.getPeer('rider-a', MONO)?.transports).toEqual([
      { transportId: 'nearby', lastSeenAt: MONO },
    ]);
  });

  test('separate heartbeats over two transports give one peer with two observations', () => {
    const { peerTable, receive } = nodeB();
    const viaX = receive(encodeRideMessage(heartbeatFrom('rider-a', 'hb-x')), {
      transportId: 'transport-x',
      peerId: 'endpoint-1',
    });
    const viaY = receive(encodeRideMessage(heartbeatFrom('rider-a', 'hb-y')), {
      transportId: 'transport-y',
      peerId: 'aa:bb:cc',
    });

    handleHeartbeat(viaX, MONO, peerTable);
    expect(handleHeartbeat(viaY, MONO + 10, peerTable)).toMatchObject({
      change: 'new_transport',
    });
    expect(peerTable.getPeers(MONO + 10)).toEqual([
      {
        nodeId: 'rider-a',
        lastSeenAt: MONO + 10,
        transports: [
          { transportId: 'transport-x', lastSeenAt: MONO },
          { transportId: 'transport-y', lastSeenAt: MONO + 10 },
        ],
      },
    ]);
  });

  test('the SAME heartbeat over a second transport is deduplicated before presence', () => {
    // Documents a current limitation: ingress collapses the copy, so transport-y is not learned
    // from it. Per-transport presence needs a distinct heartbeat id per transport.
    const ingress = createRideMessageIngress({
      rideId: RIDE,
      localNodeId: 'rider-b',
      seenMessages: createSeenMessageCache(),
      clock: () => WALL,
    });
    const peerTable = createPeerTable({ localNodeId: 'rider-b' });
    const bytes = encodeRideMessage(heartbeatFrom('rider-a'));

    const viaX = ingress.ingest(bytes, { transportId: 'transport-x' });
    const viaY = ingress.ingest(bytes, { transportId: 'transport-y' });
    if (viaX.accepted) {
      handleHeartbeat(viaX, MONO, peerTable);
    }

    expect(viaY).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(peerTable.getPeer('rider-a', MONO)?.transports.map(t => t.transportId)).toEqual([
      'transport-x',
    ]);
  });
});

describe('heartbeat handler: clock domains', () => {
  test('records the monotonic observation time, not the wall-clock envelope', () => {
    const { peerTable, receive } = nodeB();
    const accepted = receive(encodeRideMessage(heartbeatFrom('rider-a')), {
      transportId: 'transport-x',
    });

    handleHeartbeat(accepted, 50_000, peerTable);

    const peer = peerTable.getPeer('rider-a', 50_000)!;
    expect(peer.lastSeenAt).toBe(50_000);
    expect(peer.transports[0].lastSeenAt).toBe(50_000);
    expect(peer.lastSeenAt).not.toBe(accepted.message.createdAt);
    expect(peer.lastSeenAt).not.toBe(accepted.message.expiresAt);
  });

  test('freshness follows the monotonic clock regardless of message expiry', () => {
    const { peerTable, receive } = nodeB();
    handleHeartbeat(
      receive(encodeRideMessage(heartbeatFrom('rider-a')), { transportId: 'transport-x' }),
      MONO,
      peerTable,
    );

    expect(peerTable.isDirectPeer('rider-a', MONO + 14_999)).toBe(true);
    expect(peerTable.isDirectPeer('rider-a', MONO + 15_000)).toBe(false);
  });
});

describe('heartbeat handler: directness', () => {
  test('a relayed heartbeat (hopCount > 0) is rejected and leaves the table unchanged', () => {
    // Built from valid parts so it passes real ingress: a misbehaving node with hop budget
    // relayed it. Production validation is not weakened to construct this case.
    const withBudget = createRideMessage({
      id: 'hb-relayed',
      rideId: RIDE,
      originId: 'rider-a',
      type: 'heartbeat',
      priority: 'low',
      payload: {},
      ttlMs: 10_000,
      maxHops: 2,
      now: WALL,
    });
    const relayed = relayRideMessage(withBudget, WALL)!;
    const { peerTable, receive } = nodeB();
    const accepted = receive(encodeRideMessage(relayed), {
      transportId: 'transport-x',
      peerId: 'rider-c-endpoint',
    });

    expect(accepted.message.hopCount).toBe(1);
    expect(handleHeartbeat(accepted, MONO, peerTable)).toEqual({
      observed: false,
      reason: 'not_direct',
    });
    expect(peerTable.getPeers(MONO)).toEqual([]);
  });

  test('a heartbeat with a non-object payload is rejected', () => {
    const odd = createRideMessage({
      id: 'hb-odd',
      rideId: RIDE,
      originId: 'rider-a',
      type: 'heartbeat',
      priority: 'low',
      payload: 'present',
      ttlMs: 10_000,
      maxHops: 0,
      now: WALL,
    });
    const { peerTable, receive } = nodeB();

    expect(
      handleHeartbeat(receive(encodeRideMessage(odd), { transportId: 'x' }), MONO, peerTable),
    ).toEqual({ observed: false, reason: 'invalid_payload' });
    expect(peerTable.getPeers(MONO)).toEqual([]);
  });
});

describe('heartbeat handler: other message types', () => {
  test.each<RideMessageType>(['sos', 'hazard', 'ack', 'location', 'ride_state', 'gateway_advertisement'])(
    'an accepted direct %s does not refresh presence',
    type => {
      const m = createRideMessage({
        id: `m-${type}`,
        rideId: RIDE,
        originId: 'rider-a',
        type,
        priority: 'normal',
        payload: {},
        ttlMs: 10_000,
        maxHops: 3,
        now: WALL,
      });
      const { peerTable, receive } = nodeB();

      expect(
        handleHeartbeat(receive(encodeRideMessage(m), { transportId: 'x' }), MONO, peerTable),
      ).toEqual({ observed: false, reason: 'not_heartbeat' });
      expect(peerTable.getPeers(MONO)).toEqual([]);
    },
  );
});

describe('heartbeat handler: PeerTable rejections', () => {
  function accepted(message: RideMessage<unknown>, transportId = 'transport-x') {
    return {
      accepted: true,
      message,
      source: { transportId },
    } as AcceptedRideMessageIngress;
  }

  test('a heartbeat claiming the local node id is rejected by the table', () => {
    // Ingress would drop this as local_origin; the table still guards independently.
    const peerTable = createPeerTable({ localNodeId: 'rider-b' });

    expect(handleHeartbeat(accepted(heartbeatFrom('rider-b')), MONO, peerTable)).toEqual({
      observed: false,
      reason: 'peer_rejected',
      peerRejection: 'local_node',
    });
    expect(peerTable.getPeers(MONO)).toEqual([]);
  });

  test('a new peer is rejected when the table is full', () => {
    const peerTable = createPeerTable({ localNodeId: 'rider-b', maxPeers: 1 });
    handleHeartbeat(accepted(heartbeatFrom('rider-a')), MONO, peerTable);

    expect(handleHeartbeat(accepted(heartbeatFrom('rider-c')), MONO, peerTable)).toEqual({
      observed: false,
      reason: 'peer_rejected',
      peerRejection: 'table_full',
    });
    expect(peerTable.getPeers(MONO).map(p => p.nodeId)).toEqual(['rider-a']);
  });

  test('an invalid monotonic time or transport id is rejected by the table', () => {
    const peerTable = createPeerTable({ localNodeId: 'rider-b' });

    expect(handleHeartbeat(accepted(heartbeatFrom('rider-a')), NaN, peerTable)).toMatchObject({
      reason: 'peer_rejected',
      peerRejection: 'invalid',
    });
    expect(
      handleHeartbeat(accepted(heartbeatFrom('rider-a'), 'x'.repeat(65)), MONO, peerTable),
    ).toMatchObject({ reason: 'peer_rejected', peerRejection: 'invalid' });
    expect(peerTable.getPeers(MONO)).toEqual([]);
  });
});

describe('heartbeat handler: isolation', () => {
  test('never schedules timers or reads the wall clock', () => {
    const spies = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    const peerTable = createPeerTable({ localNodeId: 'rider-b' });
    const message = heartbeatFrom('rider-a');
    const dateNow = jest.spyOn(Date, 'now');
    try {
      handleHeartbeat(
        { accepted: true, message, source: { transportId: 'transport-x' } },
        MONO,
        peerTable,
      );
      for (const spy of [...spies, dateNow]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      [...spies, dateNow].forEach(spy => spy.mockRestore());
    }
  });

  test('does not depend on transports, React Native, the codec or the cache', () => {
    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'livekit-client',
        '../src/transports/Transport',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/connectivity/protocol/rideMessageCodec',
        '../src/connectivity/protocol/seenMessageCache',
        '../src/connectivity/relayPolicy',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`heartbeat modules must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/heartbeatHandler')).not.toThrow();
      expect(() => require('../src/connectivity/protocol/heartbeat')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });
});
