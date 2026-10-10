import { createConnectivityReceiver } from '../src/connectivity/connectivityReceiver';
import { createDirectLinkIdentityMap } from '../src/connectivity/directLinkIdentityMap';
import { createGatewayState } from '../src/connectivity/gatewayState';
import { createPeerTable } from '../src/connectivity/peerTable';
import { createRelayRetryTracker } from '../src/connectivity/relayRetryTracker';
import { createRideMessageIngress } from '../src/connectivity/rideMessageIngress';
import type { RoutedForwarder, RoutedForwardResult } from '../src/connectivity/routedForwarder';
import { createRideMessage, withGatewayRouting } from '../src/connectivity/protocol/rideMessage';
import { serializeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';
import type { JsonValue } from '../src/connectivity/protocol/jsonValue';

const NOW = 1_700_000_000_000;
const MONO = 50_000;
const RIDE = '12345';
const LOCAL = 'rider-b';
const ORIGIN = 'rider-a';
const GATEWAY = 'rider-c';

function routedMessage(ttlMs = 30_000, payload: JsonValue = { alert: 'test' }) {
  return withGatewayRouting(
    createRideMessage({
      id: 'same-message-id',
      rideId: RIDE,
      originId: ORIGIN,
      type: 'sos',
      priority: 'critical',
      payload,
      ttlMs,
      maxHops: 4,
      now: NOW,
    }),
    { targetGatewayId: GATEWAY, forwarderDistance: 2 },
  );
}

function sent(
  message = routedMessage(),
): Extract<RoutedForwardResult, { status: 'sent' }> {
  return {
    status: 'sent',
    message,
    endpointId: 'endpoint-c',
    route: {
      gatewayNodeId: GATEWAY,
      nextHopNodeId: GATEWAY,
      transportId: 'nearby',
      hopCount: 0,
      observedAt: MONO,
    },
  };
}

function setup(maxAttempts = 3) {
  let wallNow = NOW + 10;
  const forwardAccepted = jest.fn<
    Promise<RoutedForwardResult>,
    [Parameters<RoutedForwarder['forwardAccepted']>[0]]
  >();
  const forwarder: RoutedForwarder = {
    sendOriginated: jest.fn(),
    forwardAccepted,
  };
  const retryTracker = createRelayRetryTracker({ maxAttempts, capacity: 8 });
  const onAcceptedMessage = jest.fn();
  const onSuppressedDuplicate = jest.fn();
  const receiver = createConnectivityReceiver({
    transportId: 'nearby',
    ingress: createRideMessageIngress({
      rideId: RIDE,
      localNodeId: LOCAL,
      seenMessages: createSeenMessageCache(),
      clock: () => wallNow,
    }),
    peerTable: createPeerTable({ localNodeId: LOCAL }),
    linkIdentities: createDirectLinkIdentityMap({ localNodeId: LOCAL }),
    gatewayState: createGatewayState({ localNodeId: LOCAL }),
    forwarder,
    controlTransport: { broadcast: jest.fn(async () => {}) },
    monotonicClock: () => MONO,
    wallClock: () => wallNow,
    relayRetryTracker: retryTracker,
    onAcceptedMessage,
    onSuppressedDuplicate,
  });
  const receive = (message = routedMessage(), endpointId = 'endpoint-a') =>
    receiver.handlePayload({ endpointId }, serializeRideMessage(message));
  return {
    forwardAccepted,
    retryTracker,
    onAcceptedMessage,
    onSuppressedDuplicate,
    receive,
    setWallNow: (now: number) => {
      wallNow = now;
    },
  };
}

describe('bounded intermediate-relay retry admission', () => {
  test('a definitive forwarding failure admits one same-ID retry after route recovery', async () => {
    const h = setup();
    h.forwardAccepted
      .mockResolvedValueOnce({ status: 'not_sent', reason: 'no_route' })
      .mockResolvedValueOnce(sent());

    await expect(h.receive()).resolves.toEqual({
      stage: 'routed',
      result: { status: 'not_sent', reason: 'no_route' },
    });
    await expect(h.receive()).resolves.toMatchObject({ stage: 'routed', result: { status: 'sent' } });

    expect(h.forwardAccepted).toHaveBeenCalledTimes(2);
    expect(h.forwardAccepted.mock.calls[0][0].message.id).toBe('same-message-id');
    expect(h.forwardAccepted.mock.calls[1][0].message.id).toBe('same-message-id');
    expect(h.onAcceptedMessage).toHaveBeenCalledTimes(1);
  });

  test('duplicates are suppressed again after a successful forwarding retry', async () => {
    const h = setup();
    h.forwardAccepted
      .mockResolvedValueOnce({ ...sent(), status: 'transport_error', error: 'disconnected' })
      .mockResolvedValueOnce(sent());

    await h.receive();
    await h.receive();
    await expect(h.receive()).resolves.toEqual({
      stage: 'ingress_rejected',
      reason: 'duplicate',
    });

    expect(h.forwardAccepted).toHaveBeenCalledTimes(2);
    expect(h.onSuppressedDuplicate).toHaveBeenCalledTimes(1);
    expect(h.retryTracker.size).toBe(0);
  });

  test('an ambiguous send timeout never enables automatic retry', async () => {
    const h = setup();
    h.forwardAccepted.mockResolvedValueOnce({ ...sent(), status: 'send_timeout' });

    await h.receive();
    await expect(h.receive()).resolves.toEqual({
      stage: 'ingress_rejected',
      reason: 'duplicate',
    });

    expect(h.forwardAccepted).toHaveBeenCalledTimes(1);
    expect(h.retryTracker.size).toBe(0);
  });

  test('expired packets cannot consume retry admission or be forwarded', async () => {
    const h = setup();
    const message = routedMessage(100);
    h.forwardAccepted.mockResolvedValueOnce({ status: 'not_sent', reason: 'no_route' });

    await h.receive(message);
    h.setWallNow(NOW + 101);
    await expect(h.receive(message)).resolves.toEqual({
      stage: 'ingress_rejected',
      reason: 'invalid',
    });
    expect(h.retryTracker.beginRetry(message, NOW + 101)).toBe(false);
    expect(h.retryTracker.size).toBe(0);
    expect(h.forwardAccepted).toHaveBeenCalledTimes(1);
  });

  test('retry attempts are bounded and exhausted duplicates remain suppressed', async () => {
    const h = setup(2);
    h.forwardAccepted.mockResolvedValue({ status: 'not_sent', reason: 'no_route' });

    await h.receive(); // original
    await h.receive(); // retry 1
    await h.receive(); // retry 2
    await expect(h.receive()).resolves.toEqual({
      stage: 'ingress_rejected',
      reason: 'duplicate',
    });

    expect(h.forwardAccepted).toHaveBeenCalledTimes(3);
    expect(h.onSuppressedDuplicate).toHaveBeenCalledTimes(1);
  });

  test('relay disconnection followed by reconnection admits the origin retry from a new endpoint', async () => {
    const h = setup();
    h.forwardAccepted
      .mockResolvedValueOnce({
        ...sent(),
        status: 'transport_error',
        error: 'endpoint disconnected',
      })
      .mockResolvedValueOnce(sent());

    await h.receive(routedMessage(), 'old-endpoint-a');
    await h.receive(routedMessage(), 'new-endpoint-a');

    expect(h.forwardAccepted).toHaveBeenCalledTimes(2);
    expect(h.forwardAccepted.mock.calls[0][0].source.peerId).toBe('old-endpoint-a');
    expect(h.forwardAccepted.mock.calls[1][0].source.peerId).toBe('new-endpoint-a');
  });

  test('same id with altered content is never admitted as the failed packet retry', async () => {
    const h = setup();
    h.forwardAccepted.mockResolvedValueOnce({ status: 'not_sent', reason: 'no_route' });
    await h.receive();

    await expect(h.receive(routedMessage(30_000, { alert: 'altered' }))).resolves.toEqual({
      stage: 'ingress_rejected',
      reason: 'duplicate',
    });
    expect(h.forwardAccepted).toHaveBeenCalledTimes(1);
  });

  test('retry metadata is capacity bounded and fails closed for additional live ids', () => {
    const tracker = createRelayRetryTracker({ capacity: 1, maxAttempts: 1 });
    const first = routedMessage();
    const second = { ...routedMessage(), id: 'second-message-id' };

    tracker.recordDefinitiveFailure(first, NOW + 10);
    tracker.recordDefinitiveFailure(second, NOW + 10);

    expect(tracker.size).toBe(1);
    expect(tracker.beginRetry(first, NOW + 20)).toBe(true);
    expect(tracker.beginRetry(second, NOW + 20)).toBe(false);
  });
});
