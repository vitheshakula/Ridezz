import { createDeliveryAcknowledgementTracker } from '../src/connectivity/deliveryAcknowledgementTracker';
import {
  DELIVERY_ACK_VERSION,
  deliveryAcknowledgementSigningInput,
  type DeliveryAcknowledgementMessage,
  type DeliveryAcknowledgementVerifier,
} from '../src/connectivity/protocol/deliveryAcknowledgement';
import { createRideMessage } from '../src/connectivity/protocol/rideMessage';

const RIDE = '54321';
const ORIGIN = 'node-origin';
const DESTINATION = 'node-gateway';
const NOW = 1_700_000_000_000;

function acknowledgement({
  id = 'ack-1',
  rideId = RIDE,
  originalMessageId = 'message-1',
  originalOriginId = ORIGIN,
  destinationNodeId = DESTINATION,
  hopCount = 0,
  signature = 'valid-signature',
}: Partial<{
  id: string;
  rideId: string;
  originalMessageId: string;
  originalOriginId: string;
  destinationNodeId: string;
  hopCount: number;
  signature: string;
}> = {}): DeliveryAcknowledgementMessage {
  const created = createRideMessage({
    id,
    rideId,
    originId: destinationNodeId,
    type: 'ack',
    priority: 'critical',
    payload: {
      v: DELIVERY_ACK_VERSION,
      originalMessageId,
      originalOriginId,
      destinationNodeId,
      acknowledgedAt: NOW,
      keyId: 'member-key-1',
      nonce: `nonce-${id}`,
      signature,
    },
    ttlMs: 30_000,
    maxHops: 4,
    now: NOW,
  });
  return { ...created, hopCount };
}

function setup(now = NOW) {
  let clock = now;
  const tracker = createDeliveryAcknowledgementTracker({
    rideId: RIDE,
    localNodeId: ORIGIN,
    clock: () => clock,
  });
  tracker.track({
    rideId: RIDE,
    originalMessageId: 'message-1',
    originalOriginId: ORIGIN,
    destinationNodeId: DESTINATION,
    expiresAt: NOW + 20_000,
  });
  const verifier: DeliveryAcknowledgementVerifier = {
    verify: jest.fn(async ack => ack.payload.signature === 'valid-signature'),
  };
  return { tracker, verifier, setNow: (value: number) => (clock = value) };
}

describe('DeliveryAcknowledgementTracker', () => {
  test('accepts a verified direct ACK and correlates the original message', async () => {
    const { tracker, verifier } = setup();
    await expect(tracker.handle(acknowledgement(), verifier)).resolves.toEqual({
      accepted: true,
      originalMessageId: 'message-1',
      acknowledgementId: 'ack-1',
    });
  });

  test('accepts a verified ACK after multiple return hops without changing correlation', async () => {
    const { tracker, verifier } = setup();
    await expect(
      tracker.handle(acknowledgement({ id: 'ack-multihop', hopCount: 2 }), verifier),
    ).resolves.toMatchObject({ accepted: true, originalMessageId: 'message-1' });
  });

  test('rejects duplicate and unknown acknowledgements', async () => {
    const { tracker, verifier } = setup();
    const ack = acknowledgement();
    expect((await tracker.handle(ack, verifier)).accepted).toBe(true);
    await expect(tracker.handle(ack, verifier)).resolves.toEqual({
      accepted: false,
      reason: 'duplicate_ack',
    });
    await expect(
      tracker.handle(acknowledgement({ id: 'ack-unknown', originalMessageId: 'unknown' }), verifier),
    ).resolves.toEqual({ accepted: false, reason: 'unknown_ack' });
  });

  test('rejects forged or unverifiable acknowledgements', async () => {
    const { tracker, verifier } = setup();
    await expect(
      tracker.handle(acknowledgement({ signature: 'forged' }), verifier),
    ).resolves.toEqual({ accepted: false, reason: 'unauthenticated_ack' });
    await expect(tracker.handle(acknowledgement({ id: 'ack-no-verifier' }), undefined)).resolves.toEqual({
      accepted: false,
      reason: 'unauthenticated_ack',
    });
  });

  test('rejects late, wrong-ride, wrong-origin and wrong-destination ACKs', async () => {
    const late = setup();
    late.setNow(NOW + 20_000);
    await expect(late.tracker.handle(acknowledgement(), late.verifier)).resolves.toEqual({
      accepted: false,
      reason: 'late_ack',
    });

    const wrongRide = setup();
    await expect(
      wrongRide.tracker.handle(acknowledgement({ rideId: '99999' }), wrongRide.verifier),
    ).resolves.toEqual({ accepted: false, reason: 'wrong_ride' });

    const wrongOrigin = setup();
    await expect(
      wrongOrigin.tracker.handle(
        acknowledgement({ originalOriginId: 'different-origin' }),
        wrongOrigin.verifier,
      ),
    ).resolves.toEqual({ accepted: false, reason: 'wrong_origin' });

    const wrongDestination = setup();
    await expect(
      wrongDestination.tracker.handle(
        acknowledgement({ destinationNodeId: 'different-gateway' }),
        wrongDestination.verifier,
      ),
    ).resolves.toEqual({ accepted: false, reason: 'wrong_destination' });
  });

  test('builds a deterministic signature input without mutable routing fields', () => {
    const ack = acknowledgement();
    const { signature: _signature, ...unsigned } = ack.payload;
    const first = deliveryAcknowledgementSigningInput(unsigned, ack.rideId);
    const second = deliveryAcknowledgementSigningInput(unsigned, ack.rideId);
    expect(first).toBe(second);
    expect(first).not.toContain('hopCount');
    expect(first).not.toContain('forwarderDistance');
  });
});
