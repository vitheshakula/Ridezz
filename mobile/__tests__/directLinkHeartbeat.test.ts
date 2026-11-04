import { handleHeartbeat } from '../src/connectivity/heartbeatHandler';
import { handleGatewayAdvertisement } from '../src/connectivity/gatewayAdvertisementHandler';
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
import {
  createRideMessage,
  relayRideMessage,
  type RideMessage,
  type RideMessageType,
} from '../src/connectivity/protocol/rideMessage';
import { encodeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';

const WALL = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';

let ids = 0;
function heartbeatFrom(originId: string) {
  return createHeartbeatMessage({ id: `hb-${++ids}`, rideId: RIDE, originId, createdAt: WALL });
}

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
  return { peers, links, gateways, receive };
}

describe('heartbeat → PeerTable + DirectLinkIdentityMap', () => {
  test('a direct heartbeat records presence and the link claim', () => {
    const a = node('rider-a');
    const hb = a.receive(heartbeatFrom('rider-b'), {
      transportId: 'nearby',
      peerId: 'endpoint-7291',
    });

    expect(handleHeartbeat(hb, MONO, a.peers, a.links)).toEqual({
      observed: true,
      nodeId: 'rider-b',
      transportId: 'nearby',
      change: 'new_peer',
      link: { observed: true, change: 'new_link' },
    });
    expect(a.peers.getPeer('rider-b', MONO)?.transports).toEqual([
      { transportId: 'nearby', lastSeenAt: MONO },
    ]);
    expect(a.links.resolve('nearby', 'endpoint-7291', MONO)).toBe('rider-b');
    expect(JSON.stringify(a.peers.getPeers(MONO))).not.toContain('endpoint-7291');
    expect(a.peers.isDirectPeer('endpoint-7291', MONO)).toBe(false);
  });

  test('without source.peerId presence is refreshed exactly as before; no link is made', () => {
    const withMap = node('rider-a');
    const withoutMap = node('rider-a');
    const message = heartbeatFrom('rider-b');

    const mapped = handleHeartbeat(
      withMap.receive(message, { transportId: 'nearby' }),
      MONO,
      withMap.peers,
      withMap.links,
    );
    const plain = handleHeartbeat(
      withoutMap.receive(message, { transportId: 'nearby' }),
      MONO,
      withoutMap.peers,
    );

    expect(mapped).toEqual({ ...plain, link: { observed: false, reason: 'no_transport_peer_id' } });
    expect(withMap.peers.getPeers(MONO)).toEqual(withoutMap.peers.getPeers(MONO));
    expect(withMap.links.getLinksForNode('rider-b', MONO)).toEqual([]);
  });

  test('without a map the result is unchanged from Step 7', () => {
    const a = node('rider-a');
    const result = handleHeartbeat(
      a.receive(heartbeatFrom('rider-b'), { transportId: 'nearby', peerId: 'ep' }),
      MONO,
      a.peers,
    );
    expect(result).not.toHaveProperty('link');
  });

  test('a rejected link claim does not affect presence', () => {
    const a = node('rider-a');
    const result = handleHeartbeat(
      a.receive(heartbeatFrom('rider-b'), { transportId: 'nearby', peerId: 'x'.repeat(65) }),
      MONO,
      a.peers,
      a.links,
    );

    expect(result).toMatchObject({ observed: true, link: { observed: false, reason: 'invalid' } });
    expect(a.peers.isDirectPeer('rider-b', MONO)).toBe(true);
  });

  test('a heartbeat rejected by PeerTable records no link', () => {
    const peers = createPeerTable({ localNodeId: 'rider-a', maxPeers: 1 });
    const links = createDirectLinkIdentityMap({ localNodeId: 'rider-a' });
    const a = node('rider-a');
    handleHeartbeat(
      a.receive(heartbeatFrom('rider-b'), { transportId: 'nearby', peerId: 'ep-b' }),
      MONO,
      peers,
      links,
    );

    const refused = handleHeartbeat(
      a.receive(heartbeatFrom('rider-c'), { transportId: 'nearby', peerId: 'ep-c' }),
      MONO,
      peers,
      links,
    );
    expect(refused).toMatchObject({ observed: false, peerRejection: 'table_full' });
    expect(links.resolve('nearby', 'ep-c', MONO)).toBeUndefined();
  });

  test('a relayed heartbeat establishes no link', () => {
    const a = node('rider-a');
    const withBudget = createRideMessage({
      id: 'hb-relayed',
      rideId: RIDE,
      originId: 'rider-c',
      type: 'heartbeat',
      priority: 'low',
      payload: {},
      ttlMs: 10_000,
      maxHops: 2,
      now: WALL,
    });
    const relayed = a.receive(relayRideMessage(withBudget, WALL)!, {
      transportId: 'nearby',
      peerId: 'endpoint-B',
    });

    expect(handleHeartbeat(relayed, MONO, a.peers, a.links)).toEqual({
      observed: false,
      reason: 'not_direct',
    });
    expect(a.links.resolve('nearby', 'endpoint-B', MONO)).toBeUndefined();
  });

  const nonHeartbeatTypes: RideMessageType[] = [
    'gateway_advertisement',
    'sos',
    'hazard',
    'location',
    'ack',
    'ride_state',
  ];
  test.each(nonHeartbeatTypes)('a direct %s establishes no link', type => {
    const a = node('rider-a');
    const m = createRideMessage({
      id: `m-${type}`,
      rideId: RIDE,
      originId: 'rider-b',
      type,
      priority: 'normal',
      payload: {},
      ttlMs: 10_000,
      maxHops: 3,
      now: WALL,
    });
    const accepted = a.receive(m, { transportId: 'nearby', peerId: 'endpoint-B' });

    expect(handleHeartbeat(accepted, MONO, a.peers, a.links)).toMatchObject({
      reason: 'not_heartbeat',
    });
    if (type === 'gateway_advertisement') {
      handleGatewayAdvertisement(accepted, MONO, a.gateways);
    }
    expect(a.links.resolve('nearby', 'endpoint-B', MONO)).toBeUndefined();
  });

  test('an endpoint reassigned by a newer heartbeat resolves to the new node', () => {
    const a = node('rider-a');
    const source = { transportId: 'nearby', peerId: 'endpoint-E' };
    handleHeartbeat(a.receive(heartbeatFrom('rider-b'), source), MONO, a.peers, a.links);

    const second = handleHeartbeat(
      a.receive(heartbeatFrom('rider-c'), source),
      MONO + 2_000,
      a.peers,
      a.links,
    );

    expect(second).toMatchObject({
      link: { observed: true, change: 'reassigned', previousNodeId: 'rider-b' },
    });
    expect(a.links.resolve('nearby', 'endpoint-E', MONO + 2_000)).toBe('rider-c');
  });
});

describe('A ↔ B ↔ C: the information routing needs now exists', () => {
  test('A resolves gateway rider-c and the direct neighbour rider-b that handed it over', () => {
    const a = node('rider-a');
    const b = node('rider-b');

    const hb = a.receive(heartbeatFrom('rider-b'), { transportId: 'nearby', peerId: 'endpoint-B' });
    expect(handleHeartbeat(hb, MONO, a.peers, a.links)).toMatchObject({ observed: true });

    const atB = b.receive(
      createGatewayAdvertisementMessage({
        id: 'gw-c-1',
        rideId: RIDE,
        originId: 'rider-c',
        createdAt: WALL,
      }),
      { transportId: 'nearby', peerId: 'endpoint-C' },
    );
    const relay = decideRelay(atB.message, WALL + 50);
    if (!relay.relay) {
      throw new Error('expected B to relay');
    }
    const atA = a.receive(relay.message, { transportId: 'nearby', peerId: 'endpoint-B' });
    expect(handleGatewayAdvertisement(atA, MONO + 100, a.gateways)).toMatchObject({
      observed: true,
    });

    const origin = atA.message.originId;
    const directSender = a.links.resolve(atA.source.transportId, atA.source.peerId!, MONO + 100);
    expect(origin).toBe('rider-c');
    expect(directSender).toBe('rider-b');
    expect(directSender).not.toBe(origin);
    expect(atA.message.hopCount).toBe(1);
    expect(atA.source.transportId).toBe('nearby');

    expect(a.gateways.getGateways(MONO + 100)).toEqual([
      {
        nodeId: 'rider-c',
        lastSeenAt: MONO + 100,
        observations: [{ transportId: 'nearby', hopCount: 1, lastSeenAt: MONO + 100 }],
      },
    ]);
    expect(a.peers.getPeers(MONO + 100).map(p => p.nodeId)).toEqual(['rider-b']);
    expect(a.peers.isDirectPeer('rider-c', MONO + 100)).toBe(false);
    expect(a.links.getLinksForNode('rider-b', MONO + 100)).toEqual([
      { transportId: 'nearby', transportPeerId: 'endpoint-B', nodeId: 'rider-b', lastSeenAt: MONO },
    ]);
    expect(a.links.getLinksForNode('rider-c', MONO + 100)).toEqual([]);
  });

  test('without a fresh heartbeat on that link, the direct sender is unknown', () => {
    const a = node('rider-a');
    const hb = a.receive(heartbeatFrom('rider-b'), { transportId: 'nearby', peerId: 'endpoint-B' });
    handleHeartbeat(hb, MONO, a.peers, a.links);

    expect(a.links.resolve('nearby', 'endpoint-B', MONO + 15_000)).toBeUndefined();
    expect(a.links.resolve('nearby', 'endpoint-X', MONO)).toBeUndefined();
  });
});
