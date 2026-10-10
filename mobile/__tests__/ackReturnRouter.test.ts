import { createAckReturnRouter } from '../src/connectivity/ackReturnRouter';
import { DELIVERY_ACK_VERSION } from '../src/connectivity/protocol/deliveryAcknowledgement';
import { createRideMessage, withGatewayRouting } from '../src/connectivity/protocol/rideMessage';
import { parseRideMessage } from '../src/connectivity/protocol/rideMessageCodec';

const NOW = 1_700_000_000_000;
const RIDE = '54321';

function original() {
  return withGatewayRouting(
    createRideMessage({
      id: 'original-1',
      rideId: RIDE,
      originId: 'node-a',
      type: 'sos',
      priority: 'critical',
      payload: { reason: 'test' },
      ttlMs: 30_000,
      maxHops: 4,
      now: NOW,
    }),
    { targetGatewayId: 'node-c', forwarderDistance: 2 },
  );
}

function acknowledgement() {
  return createRideMessage({
    id: 'ack-1',
    rideId: RIDE,
    originId: 'node-c',
    type: 'ack',
    priority: 'critical',
    payload: {
      v: DELIVERY_ACK_VERSION,
      originalMessageId: 'original-1',
      originalOriginId: 'node-a',
      destinationNodeId: 'node-c',
      acknowledgedAt: NOW,
      keyId: 'key-c',
      nonce: 'nonce-ack-1',
      signature: 'signed-by-c',
    },
    ttlMs: 30_000,
    maxHops: 4,
    now: NOW,
  });
}

describe('AckReturnRouter', () => {
  test('returns a direct ACK along the recorded inbound endpoint', async () => {
    const sent: Array<{ endpointId: string; payload: string }> = [];
    const destination = createAckReturnRouter({
      localNodeId: 'node-c',
      wallClock: () => NOW + 1,
      sendTo: async (endpointId, payload) => {
        sent.push({ endpointId, payload });
      },
    });
    destination.remember(original(), { endpointId: 'endpoint-a' });

    await expect(destination.route(acknowledgement())).resolves.toMatchObject({
      status: 'forwarded',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].endpointId).toBe('endpoint-a');
    expect(parseRideMessage(sent[0].payload, NOW + 1)).toMatchObject({ id: 'ack-1', hopCount: 1 });
  });

  test('preserves ACK identity across a multi-hop reverse path', async () => {
    let packetToB = '';
    let packetToA = '';
    const c = createAckReturnRouter({
      localNodeId: 'node-c',
      wallClock: () => NOW + 1,
      sendTo: async (_endpoint, payload) => {
        packetToB = payload;
      },
    });
    const b = createAckReturnRouter({
      localNodeId: 'node-b',
      wallClock: () => NOW + 1,
      sendTo: async (_endpoint, payload) => {
        packetToA = payload;
      },
    });
    const a = createAckReturnRouter({
      localNodeId: 'node-a',
      wallClock: () => NOW + 1,
      sendTo: async () => {
        throw new Error('origin must not forward its ACK');
      },
    });
    b.remember(original(), { endpointId: 'endpoint-a-at-b' });
    c.remember(original(), { endpointId: 'endpoint-b-at-c' });

    expect((await c.route(acknowledgement())).status).toBe('forwarded');
    const atB = parseRideMessage(packetToB, NOW + 1);
    expect(atB).not.toBeNull();
    expect((await b.route(atB!)).status).toBe('forwarded');
    const atA = parseRideMessage(packetToA, NOW + 1);
    expect(atA).not.toBeNull();
    await expect(a.route(atA!)).resolves.toMatchObject({
      status: 'origin_reached',
      acknowledgement: { id: 'ack-1', hopCount: 2 },
    });
  });

  test('fails closed when the reverse route disappeared', async () => {
    const router = createAckReturnRouter({
      localNodeId: 'node-b',
      wallClock: () => NOW + 1,
      sendTo: jest.fn(async () => undefined),
    });
    await expect(router.route(acknowledgement())).resolves.toEqual({
      status: 'not_forwarded',
      reason: 'unknown_return_route',
    });
  });
});
