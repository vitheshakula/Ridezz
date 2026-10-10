import {
  createRideConnectivityClient,
  RideConnectivityClientError,
  type RideConnectivityClientAdapter,
  type RideConnectivityDeliveryStatus,
  type RideConnectivityErrorEvent,
  type RideConnectivityMessageInput,
  type RideConnectivityPeerStatus,
} from '../src/connectivity/rideConnectivityClient';
import type { ConnectivityApplicationMessage } from '../src/connectivity/connectivityReceiver';
import { createRideMessage, type RideMessage } from '../src/connectivity/protocol/rideMessage';
import type {
  RideConnectivityRuntime,
  RideConnectivitySendResult,
} from '../src/connectivity/rideConnectivityRuntime';
import type { TransportStatus } from '../src/transports/Transport';

const NOW = 1_700_000_000_000;
const RIDE = 'RIDE1';
const CONTEXT = Object.freeze({ rideId: RIDE, riderName: 'Alex' });

const acceptedResult = (): RideConnectivitySendResult =>
  ({
    status: 'sent',
    message: {},
    route: {},
    endpointId: 'endpoint-B',
  }) as RideConnectivitySendResult;

const validInput = (overrides: Partial<RideConnectivityMessageInput> = {}) => ({
  rideId: RIDE,
  type: 'sos' as const,
  priority: 'critical' as const,
  payload: { reason: 'manual' },
  ttlMs: 30_000,
  maxHops: 4,
  ...overrides,
});

function harness() {
  let messageCounter = 0;
  let nodeCounter = 0;
  let now = NOW;
  let runtimeStartFailures = 0;
  let invalidNodeId = false;
  const statusListeners = new Set<(status: TransportStatus) => void>();
  const peerListeners = new Set<(count: number) => void>();
  const applicationCallbacks: ((received: ConnectivityApplicationMessage) => void)[] = [];
  const runtimes: Array<
    RideConnectivityRuntime & {
      start: jest.Mock;
      stop: jest.Mock;
      sendToGateway: jest.Mock<Promise<RideConnectivitySendResult>, [RideMessage<unknown>, string?]>;
    }
  > = [];
  const sendResults: RideConnectivitySendResult[] = [];

  const transport = {
    capabilities: {
      broadcast: true,
      targeted: true,
      peerIdentity: true,
      linkMetrics: false,
      deliveryAck: false,
    },
    start: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    broadcast: jest.fn(() => Promise.resolve()),
    sendTo: jest.fn(() => Promise.resolve()),
    onPayload: jest.fn(() => () => {}),
    onPayloadFrom: jest.fn(() => () => {}),
    onStatus: jest.fn((listener: (status: TransportStatus) => void) => {
      statusListeners.add(listener);
      return jest.fn(() => statusListeners.delete(listener));
    }),
    onPeerCountChanged: jest.fn((listener: (count: number) => void) => {
      peerListeners.add(listener);
      return jest.fn(() => peerListeners.delete(listener));
    }),
  };

  const adapter: RideConnectivityClientAdapter = {
    transportId: 'nearby',
    transport,
    clock: () => now,
    createNodeIdentity: jest.fn(() => ({
      generateMessageId: () => `message-${++messageCounter}`,
      nodeIdFor: () => (invalidNodeId ? '' : `node-${++nodeCounter}`),
    })),
    createRuntime: jest.fn(options => {
      applicationCallbacks.push(options.onApplicationMessage);
      let running = false;
      const runtime = {
        start: jest.fn(() => {
          if (runtimeStartFailures > 0) {
            runtimeStartFailures--;
            throw new Error('runtime failed');
          }
          running = true;
        }),
        stop: jest.fn(() => {
          running = false;
        }),
        get running() {
          return running;
        },
        sendToGateway: jest.fn((_message: RideMessage<unknown>, _gatewayNodeId?: string) =>
          Promise.resolve(sendResults.shift() ?? acceptedResult()),
        ),
        getGatewayRoute: jest.fn(() => ({ ok: false as const, reason: 'no_route' as const })),
      };
      runtimes.push(runtime);
      return runtime;
    }),
  };
  const client = createRideConnectivityClient(adapter);

  return {
    client,
    adapter,
    transport,
    runtimes,
    sendResults,
    setNow(value: number) {
      now = value;
    },
    failRuntimeStarts(count = 1) {
      runtimeStartFailures = count;
    },
    useInvalidNodeId(value = true) {
      invalidNodeId = value;
    },
    emitTransportStatus(status: TransportStatus) {
      [...statusListeners].forEach(listener => listener(status));
    },
    emitPeerCount(count: number) {
      [...peerListeners].forEach(listener => listener(count));
    },
    emitApplication(received: ConnectivityApplicationMessage, generation = -1) {
      applicationCallbacks.at(generation)?.(received);
    },
    listenerCounts() {
      return { status: statusListeners.size, peers: peerListeners.size };
    },
  };
}

function receivedMessage(id = 'remote-message'): ConnectivityApplicationMessage {
  return {
    delivery: 'local',
    message: createRideMessage({
      id,
      rideId: RIDE,
      originId: 'remote-node',
      type: 'sos',
      priority: 'critical',
      payload: { reason: 'remote' },
      ttlMs: 30_000,
      maxHops: 4,
      now: NOW,
    }),
  };
}

describe('RideConnectivityClient lifecycle', () => {
  test('rejects an invalid ride context before touching the transport', async () => {
    const h = harness();

    await expect(h.client.start({ rideId: '', riderName: 'Alex' })).rejects.toMatchObject({
      code: 'lifecycle_error',
    });
    expect(h.transport.start).not.toHaveBeenCalled();
    expect(h.adapter.createRuntime).not.toHaveBeenCalled();
  });

  test('starts once for repeated and concurrent same-ride requests', async () => {
    const h = harness();

    await Promise.all([h.client.start(CONTEXT), h.client.start(CONTEXT), h.client.start(CONTEXT)]);
    await h.client.start({ ...CONTEXT, riderName: 'A changed display name' });

    expect(h.transport.start).toHaveBeenCalledTimes(1);
    expect(h.transport.start).toHaveBeenCalledWith({ roomCode: RIDE, riderName: 'Alex' });
    expect(h.adapter.createRuntime).toHaveBeenCalledTimes(1);
    expect(h.runtimes[0].start).toHaveBeenCalledTimes(1);
    expect(h.listenerCounts()).toEqual({ status: 1, peers: 1 });
  });

  test('stop is idempotent and a later start creates a fresh runtime without leaked listeners', async () => {
    const h = harness();
    await h.client.start(CONTEXT);

    await Promise.all([h.client.stop(), h.client.stop()]);
    expect(h.runtimes[0].stop).toHaveBeenCalledTimes(1);
    expect(h.transport.stop).toHaveBeenCalledTimes(1);
    expect(h.listenerCounts()).toEqual({ status: 0, peers: 0 });

    await h.client.start(CONTEXT);
    expect(h.adapter.createRuntime).toHaveBeenCalledTimes(2);
    expect(h.runtimes[1]).not.toBe(h.runtimes[0]);
    expect(h.listenerCounts()).toEqual({ status: 1, peers: 1 });
    await h.client.stop();
  });

  test('rejects a different ride while active without disturbing the current runtime', async () => {
    const h = harness();
    const errors: RideConnectivityErrorEvent[] = [];
    h.client.onError(error => errors.push(error));
    await h.client.start(CONTEXT);

    await expect(h.client.start({ rideId: 'RIDE2', riderName: 'Alex' })).rejects.toMatchObject({
      code: 'lifecycle_error',
    });
    expect(h.transport.start).toHaveBeenCalledTimes(1);
    expect(h.runtimes[0].running).toBe(true);
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'lifecycle_error', reason: 'different_ride_active' }),
    );
    await h.client.stop();
  });

  test('serializes a concurrent start then stop deterministically', async () => {
    const h = harness();

    const starting = h.client.start(CONTEXT);
    const stopping = h.client.stop();
    await Promise.all([starting, stopping]);

    expect(h.transport.start).toHaveBeenCalledTimes(1);
    expect(h.runtimes[0].stop).toHaveBeenCalledTimes(1);
    expect(h.transport.stop).toHaveBeenCalledTimes(1);
    expect(h.listenerCounts()).toEqual({ status: 0, peers: 0 });
  });

  test('recovers after transport and runtime initialization failures', async () => {
    const h = harness();
    h.transport.start.mockRejectedValueOnce(new Error('secret raw detail'));
    await expect(h.client.start(CONTEXT)).rejects.toMatchObject({ code: 'transport_unavailable' });
    expect(h.listenerCounts()).toEqual({ status: 0, peers: 0 });

    h.failRuntimeStarts();
    await expect(h.client.start(CONTEXT)).rejects.toMatchObject({ code: 'initialization_error' });
    expect(h.transport.stop).toHaveBeenCalledTimes(1);
    expect(h.listenerCounts()).toEqual({ status: 0, peers: 0 });

    await expect(h.client.start(CONTEXT)).resolves.toBeUndefined();
    expect(h.runtimes).toHaveLength(2);
    await h.client.stop();
  });

  test('rejects an invalid generated sender identity and remains recoverable', async () => {
    const h = harness();
    h.useInvalidNodeId();
    await expect(h.client.start(CONTEXT)).rejects.toMatchObject({ code: 'initialization_error' });
    h.useInvalidNodeId(false);
    await expect(h.client.start(CONTEXT)).resolves.toBeUndefined();
    await h.client.stop();
  });
});

describe('RideConnectivityClient message submission and delivery status', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('validates, creates and submits a protocol message with deterministic status order', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const h = harness();
    const statuses: RideConnectivityDeliveryStatus[] = [];
    h.client.onDeliveryStatus(status => statuses.push(status));
    await h.client.start(CONTEXT);

    const submission = await h.client.sendMessage(validInput({ ttlMs: 1_000 }));

    expect(submission.messageId).toBe('message-1');
    expect(h.runtimes[0].sendToGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        id: submission.messageId,
        rideId: RIDE,
        originId: 'node-1',
        type: 'sos',
        priority: 'critical',
      }),
      undefined,
    );
    expect(statuses.map(status => status.state)).toEqual([
      'queued',
      'sending',
      'transport_accepted',
    ]);
    expect(statuses).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'destination_delivered' })]),
    );

    h.setNow(NOW + 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(statuses.map(status => status.state)).toEqual([
      'queued',
      'sending',
      'transport_accepted',
      'expired',
    ]);
    await h.client.stop();
  });

  test.each([
    ['type', { type: 'heartbeat' }],
    ['priority', { priority: 'urgent' }],
    ['payload', { payload: { broken: undefined } }],
    ['null payload', { payload: null }],
    ['ttl', { ttlMs: 0 }],
    ['hop limit', { maxHops: 17 }],
    ['destination', { destination: { kind: 'gateway', gatewayNodeId: '' } }],
    ['ride context', { rideId: 'OTHER' }],
  ])('rejects invalid %s before runtime submission', async (_label, override) => {
    const h = harness();
    await h.client.start(CONTEXT);

    await expect(
      h.client.sendMessage(validInput(override as Partial<RideConnectivityMessageInput>)),
    ).rejects.toBeInstanceOf(RideConnectivityClientError);
    expect(h.runtimes[0].sendToGateway).not.toHaveBeenCalled();
    await h.client.stop();
  });

  test('rejects a message whose final routed wire form would be oversized', async () => {
    const h = harness();
    await h.client.start(CONTEXT);

    await expect(
      h.client.sendMessage(validInput({ payload: { text: 'x'.repeat(5_000) } })),
    ).rejects.toMatchObject({ code: 'invalid_message_input' });
    expect(h.runtimes[0].sendToGateway).not.toHaveBeenCalled();
    await h.client.stop();
  });

  test('reports timeout ambiguity without transport acceptance or destination delivery', async () => {
    const h = harness();
    const statuses: RideConnectivityDeliveryStatus[] = [];
    const errors: RideConnectivityErrorEvent[] = [];
    h.client.onDeliveryStatus(status => statuses.push(status));
    h.client.onError(error => errors.push(error));
    h.sendResults.push({
      status: 'send_timeout',
      message: {} as RideMessage<unknown>,
      route: {} as never,
      endpointId: 'endpoint-B',
    });
    await h.client.start(CONTEXT);

    await h.client.sendMessage(validInput());

    expect(statuses.map(status => status.state)).toEqual(['queued', 'sending', 'failed']);
    expect(statuses.at(-1)).toMatchObject({
      state: 'failed',
      reason: 'send_timeout',
      outcome: 'unknown',
    });
    expect(errors).toContainEqual(expect.objectContaining({ code: 'send_timeout' }));
    expect(statuses.some(status => status.state === 'destination_delivered')).toBe(false);
    await h.client.stop();
  });

  test('reports transport rejection and unavailable-client sends', async () => {
    const h = harness();
    await expect(h.client.sendMessage(validInput())).rejects.toMatchObject({
      code: 'lifecycle_error',
    });
    h.sendResults.push({
      status: 'transport_error',
      error: 'raw native error is not exposed',
      message: {} as RideMessage<unknown>,
      route: {} as never,
      endpointId: 'endpoint-B',
    });
    const statuses: RideConnectivityDeliveryStatus[] = [];
    h.client.onDeliveryStatus(status => statuses.push(status));
    await h.client.start(CONTEXT);

    await h.client.sendMessage(validInput());

    expect(statuses.at(-1)).toMatchObject({
      state: 'failed',
      reason: 'transport_unavailable',
      outcome: 'not_sent',
    });
    await h.client.stop();
  });

  test('reports a thrown runtime send as outcome unknown and never retries', async () => {
    const h = harness();
    const statuses: RideConnectivityDeliveryStatus[] = [];
    const errors: RideConnectivityErrorEvent[] = [];
    h.client.onDeliveryStatus(status => statuses.push(status));
    h.client.onError(error => errors.push(error));
    await h.client.start(CONTEXT);
    h.runtimes[0].sendToGateway.mockRejectedValueOnce(new Error('unexpected runtime failure'));

    await h.client.sendMessage(validInput({ destination: { kind: 'gateway', gatewayNodeId: 'gw' } }));

    expect(h.runtimes[0].sendToGateway).toHaveBeenCalledTimes(1);
    expect(h.runtimes[0].sendToGateway).toHaveBeenCalledWith(expect.any(Object), 'gw');
    expect(statuses.at(-1)).toMatchObject({
      state: 'failed',
      reason: 'runtime_unavailable',
      outcome: 'unknown',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'runtime_error', reason: 'runtime_send_failed' }),
    );
    await h.client.stop();
  });
});

describe('RideConnectivityClient subscriptions and peer status', () => {
  test('delivers public application messages, isolates subscriber failures, and unsubscribes', async () => {
    const h = harness();
    const errors: RideConnectivityErrorEvent[] = [];
    const received: string[] = [];
    h.client.onError(error => errors.push(error));
    h.client.onMessage(() => {
      throw new Error('consumer bug');
    });
    const unsubscribe = h.client.onMessage(message => received.push(message.id));
    await h.client.start(CONTEXT);

    h.emitApplication(receivedMessage('first'));
    unsubscribe();
    h.emitApplication(receivedMessage('second'));

    expect(received).toEqual(['first']);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_error',
          operation: 'listener',
          reason: 'message_listener_failed',
        }),
      ]),
    );
    await h.client.stop();
  });

  test('an old runtime generation cannot deliver after stop or after a restart', async () => {
    const h = harness();
    const received: string[] = [];
    h.client.onMessage(message => received.push(message.id));
    await h.client.start(CONTEXT);
    await h.client.stop();

    h.emitApplication(receivedMessage('after-stop'), 0);
    await h.client.start(CONTEXT);
    h.emitApplication(receivedMessage('old-generation'), 0);
    h.emitApplication(receivedMessage('new-generation'), 1);

    expect(received).toEqual(['new-generation']);
    await h.client.stop();
  });

  test('reports transport and direct-peer observations and cleans native listeners on stop', async () => {
    const h = harness();
    const statuses: RideConnectivityPeerStatus[] = [];
    const unsubscribe = h.client.onPeerStatus(status => statuses.push(status));
    await h.client.start(CONTEXT);

    h.emitPeerCount(2);
    h.emitTransportStatus({ active: true, peers: 3, error: null });
    h.emitTransportStatus({ active: false, peers: 0, error: 'native detail' });

    expect(statuses.map(status => [status.state, status.directPeerCount])).toEqual([
      ['inactive', 0],
      ['starting', 0],
      ['active', 0],
      ['active', 2],
      ['active', 3],
      ['error', 0],
    ]);
    await h.client.stop();
    expect(statuses.at(-1)).toMatchObject({ state: 'inactive', directPeerCount: 0 });
    expect(h.listenerCounts()).toEqual({ status: 0, peers: 0 });

    const count = statuses.length;
    h.emitPeerCount(5);
    expect(statuses).toHaveLength(count);
    unsubscribe();
  });

  test('does not include payloads or raw transport errors in structured errors', async () => {
    const h = harness();
    const errors: RideConnectivityErrorEvent[] = [];
    h.client.onError(error => errors.push(error));
    h.transport.start.mockRejectedValueOnce(new Error('token=do-not-leak'));

    await expect(h.client.start(CONTEXT)).rejects.toBeDefined();

    expect(JSON.stringify(errors)).not.toContain('do-not-leak');
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'transport_unavailable',
        reason: 'transport_start_failed',
      }),
    ]);
  });
});
