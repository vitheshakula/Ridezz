import { DeviceEventEmitter, DevSettings, NativeModules, Platform } from 'react-native';
import {
  ENABLE_CONNECTIVITY_TEST_PROBE,
  PROBE_FIELD_TEST_MAX_PER_SESSION,
  PROBE_MAX_HOPS,
  PROBE_MAX_PER_SESSION,
  PROBE_MIN_INTERVAL_MS,
  PROBE_PAYLOAD_MARKER,
  PROBE_TTL_MS,
  createConnectivityTestProbe,
  describeProbeDeliveryStatus,
  isConnectivityTestProbeAvailable,
  isConnectivityTestProbePayload,
  type ConnectivityTestProbeOptions,
} from '../src/connectivity/connectivityTestProbe';
import {
  createRideConnectivityClient,
  RideConnectivityClientError,
  type RideConnectivityDeliveryStatus,
  type RideConnectivityIncomingMessage,
  type RideConnectivityMessageInput,
} from '../src/connectivity/rideConnectivityClient';
import type { ConnectivityApplicationMessage } from '../src/connectivity/connectivityReceiver';
import {
  FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST,
  isRideCloudReachable,
} from '../src/connectivity/debugGatewayOverride';
import { createPersistentOutbox, type PersistentOutboxStore } from '../src/connectivity/persistentOutbox';
import { createRideMessage, type RideMessage } from '../src/connectivity/protocol/rideMessage';
import type {
  RideConnectivityRuntime,
  RideConnectivitySendResult,
} from '../src/connectivity/rideConnectivityRuntime';
import type { TransportStatus } from '../src/transports/Transport';

const NOW = 1_700_000_000_000;
const RIDE = 'RIDE1';
const PROBE_MODULE = '../src/connectivity/connectivityTestProbe';

// No @types/node in this project; jest runs from the mobile/ root.
const fs: { readFileSync(file: string, encoding: 'utf8'): string } = require('fs');

/** Ids whose 8-character prefixes differ, as real protocol ids do. */
const messageId = (n: number) => `id${String(n).padStart(6, '0')}-0123456789abcdef`;

function fakeClient() {
  const deliveryListeners = new Set<(status: RideConnectivityDeliveryStatus) => void>();
  const messageListeners = new Set<(message: RideConnectivityIncomingMessage) => void>();
  let n = 0;
  const emitStatus = (status: RideConnectivityDeliveryStatus) =>
    [...deliveryListeners].forEach(listener => listener(status));
  const client = {
    sendMessage: jest.fn(async (_input: RideConnectivityMessageInput) => {
      const id = messageId(++n);
      // The real client reports `queued` before sendMessage resolves.
      emitStatus({ state: 'queued', messageId: id, at: NOW });
      return { messageId: id };
    }),
    onDeliveryStatus: jest.fn((listener: (status: RideConnectivityDeliveryStatus) => void) => {
      deliveryListeners.add(listener);
      return () => {
        deliveryListeners.delete(listener);
      };
    }),
    onMessage: jest.fn((listener: (message: RideConnectivityIncomingMessage) => void) => {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    }),
  };
  return {
    client,
    emitStatus,
    emitMessage: (message: RideConnectivityIncomingMessage) =>
      [...messageListeners].forEach(listener => listener(message)),
    listenerCount: () => deliveryListeners.size + messageListeners.size,
  };
}

function probeHarness(overrides: Partial<ConnectivityTestProbeOptions> = {}) {
  const fake = fakeClient();
  let now = NOW;
  const lines: string[] = [];
  const probe = createConnectivityTestProbe({
    client: fake.client,
    enabled: true,
    isDevelopmentBuild: true,
    clock: () => now,
    log: line => lines.push(line),
    ...overrides,
  });
  return {
    ...fake,
    probe,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const incoming = (
  overrides: Partial<RideConnectivityIncomingMessage> = {},
): RideConnectivityIncomingMessage => ({
  id: messageId(42),
  rideId: RIDE,
  originId: 'originnode-1234',
  type: 'ride_state',
  priority: 'low',
  createdAt: NOW,
  expiresAt: NOW + PROBE_TTL_MS,
  payload: { probe: PROBE_PAYLOAD_MARKER, seq: 3 },
  ...overrides,
});

describe('gating', () => {
  test('the committed flag is off and production gateway defaults are untouched', () => {
    expect(ENABLE_CONNECTIVITY_TEST_PROBE).toBe(false);
    expect(FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST).toBe(false);
    expect(isRideCloudReachable()).toBe(false);
  });

  test('available only for an enabled development flag or the isolated field-test build', () => {
    expect(isConnectivityTestProbeAvailable(false, true)).toBe(false);
    expect(isConnectivityTestProbeAvailable(true, false)).toBe(false);
    expect(isConnectivityTestProbeAvailable(false, false)).toBe(false);
    expect(isConnectivityTestProbeAvailable(true, true)).toBe(true);
    expect(isConnectivityTestProbeAvailable(false, false, true)).toBe(true);
  });

  test('a disabled probe sends nothing and subscribes to nothing', async () => {
    const h = probeHarness({ enabled: false });
    h.probe.sessionStarted(RIDE);
    await expect(h.probe.send()).resolves.toEqual({ status: 'probe_disabled' });
    expect(h.client.sendMessage).not.toHaveBeenCalled();
    expect(h.listenerCount()).toBe(0);
  });

  test('a release build refuses even with the flag on', async () => {
    const h = probeHarness({ enabled: true, isDevelopmentBuild: false });
    expect(h.probe.available).toBe(false);
    h.probe.sessionStarted(RIDE);
    await expect(h.probe.send()).resolves.toEqual({ status: 'probe_disabled' });
    expect(h.client.sendMessage).not.toHaveBeenCalled();
    expect(h.listenerCount()).toBe(0);
  });

  test('field-test allowance is explicit, bounded and still manually triggered', () => {
    const h = probeHarness({
      enabled: false,
      isDevelopmentBuild: false,
      isFieldTestBuild: true,
      maxPerSession: PROBE_FIELD_TEST_MAX_PER_SESSION,
    });
    expect(h.probe.available).toBe(true);
    expect(PROBE_FIELD_TEST_MAX_PER_SESSION).toBe(50);
    expect(() =>
      probeHarness({ maxPerSession: PROBE_FIELD_TEST_MAX_PER_SESSION + 1 }),
    ).toThrow(RangeError);
  });
});

describe('probe submission', () => {
  test('refuses without an active protocol session', async () => {
    const h = probeHarness();
    await expect(h.probe.send()).resolves.toEqual({ status: 'session_inactive' });
    expect(h.client.sendMessage).not.toHaveBeenCalled();
  });

  test('one call submits exactly one valid, non-emergency ride_state message', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    const result = await h.probe.send();

    expect(result).toEqual({ status: 'submitted', seq: 1, messageId: messageId(1) });
    expect(h.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.client.sendMessage).toHaveBeenCalledWith({
      rideId: RIDE,
      type: 'ride_state',
      priority: 'low',
      payload: { probe: PROBE_PAYLOAD_MARKER, seq: 1 },
      ttlMs: 60_000,
      maxHops: 4,
      destination: { kind: 'gateway' },
    });
    expect(PROBE_TTL_MS).toBe(60_000);
    expect(PROBE_MAX_HOPS).toBe(4);
  });

  test('logs the submission and correlates statuses by message id prefix', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    await h.probe.send();
    const id = messageId(1);
    h.emitStatus({ state: 'sending', messageId: id, at: NOW });
    h.emitStatus({ state: 'transport_accepted', messageId: id, at: NOW, transportId: 'nearby' });
    h.emitStatus({
      state: 'retry_scheduled',
      messageId: id,
      at: NOW,
      nextAttemptAt: NOW + 2_000,
      lastAttempt: 'awaiting_acknowledgement',
    });
    // Another message's status is never attributed to the probe.
    h.emitStatus({ state: 'queued', messageId: messageId(99), at: NOW });
    h.emitStatus({
      state: 'failed',
      messageId: id,
      at: NOW,
      reason: 'retry_exhausted',
      outcome: 'not_sent',
      lastAttempt: 'awaiting_acknowledgement',
    });

    expect(h.lines).toEqual([
      'test probe armed for this ride (debug build)',
      'probe #1 submitted | id=id000001',
      'probe id000001 | queued',
      'probe id000001 | transport_accepted (one hop accepted; not delivery)',
      'probe id000001 | retry_scheduled in 2s | last=awaiting_acknowledgement',
      'probe id000001 | retry_exhausted | delivery_unconfirmed | last=awaiting_acknowledgement',
    ]);
  });

  test('submission errors are reported, sanitized, and still count', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    h.client.sendMessage.mockRejectedValueOnce(
      new RideConnectivityClientError('runtime_error', 'The connectivity outbox is full'),
    );
    await expect(h.probe.send()).resolves.toEqual({
      status: 'submission_failed',
      seq: 1,
      reason: 'runtime_error',
    });
    expect(h.lines).toContain('probe #1 submission_failed | runtime_error');
    h.advance(PROBE_MIN_INTERVAL_MS);
    await expect(h.probe.send()).resolves.toMatchObject({ status: 'submitted', seq: 2 });
  });

  test('an unexpected throw never escapes send()', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    h.client.sendMessage.mockImplementationOnce(() => {
      throw new Error('token=do-not-leak');
    });
    const result = await h.probe.send();
    expect(result).toEqual({ status: 'submission_failed', seq: 1, reason: 'unexpected_error' });
    expect(h.lines.join('\n')).not.toContain('do-not-leak');
  });
});

describe('rate limiting', () => {
  test('at most one probe per five seconds', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    await expect(h.probe.send()).resolves.toMatchObject({ status: 'submitted' });
    h.advance(PROBE_MIN_INTERVAL_MS - 1);
    await expect(h.probe.send()).resolves.toEqual({ status: 'rate_limited', retryAfterMs: 1 });
    h.advance(1);
    await expect(h.probe.send()).resolves.toMatchObject({ status: 'submitted', seq: 2 });
    expect(h.client.sendMessage).toHaveBeenCalledTimes(2);
  });

  test('concurrent presses produce one message', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    const [first, second] = await Promise.all([h.probe.send(), h.probe.send()]);
    expect(first).toMatchObject({ status: 'submitted' });
    expect(second).toMatchObject({ status: 'rate_limited' });
    expect(h.client.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('at most ten probes per ride session, reset by a new session', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    for (let i = 0; i < PROBE_MAX_PER_SESSION; i++) {
      await expect(h.probe.send()).resolves.toMatchObject({ status: 'submitted', seq: i + 1 });
      h.advance(PROBE_MIN_INTERVAL_MS);
    }
    await expect(h.probe.send()).resolves.toEqual({ status: 'session_limit_reached' });
    expect(h.client.sendMessage).toHaveBeenCalledTimes(PROBE_MAX_PER_SESSION);

    h.probe.sessionEnded();
    h.probe.sessionStarted(RIDE);
    await expect(h.probe.send()).resolves.toMatchObject({ status: 'submitted', seq: 1 });
  });

  test('no background timer is created', async () => {
    jest.useFakeTimers();
    try {
      const h = probeHarness();
      h.probe.sessionStarted(RIDE);
      await h.probe.send();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('session lifecycle', () => {
  test('subscribes once per session and cleans up on leaving the ride', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    h.probe.sessionStarted(RIDE); // repeated start for the same ride is a no-op
    expect(h.client.onDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(h.client.onMessage).toHaveBeenCalledTimes(1);
    await h.probe.send();

    h.probe.sessionEnded();
    h.probe.sessionEnded();
    expect(h.listenerCount()).toBe(0);
    await expect(h.probe.send()).resolves.toEqual({ status: 'session_inactive' });

    const count = h.lines.length;
    h.emitStatus({ state: 'expired', messageId: messageId(1), at: NOW, expiresAt: NOW });
    expect(h.lines).toHaveLength(count);
  });

  test('a session ending while a submission is in flight does not attribute it', async () => {
    const h = probeHarness();
    h.probe.sessionStarted(RIDE);
    let resolve: (value: { messageId: string }) => void = () => {};
    h.client.sendMessage.mockImplementationOnce(
      () => new Promise(r => (resolve = r)),
    );
    const sending = h.probe.send();
    h.probe.sessionEnded();
    resolve({ messageId: messageId(7) });
    await expect(sending).resolves.toEqual({
      status: 'submission_failed',
      seq: 1,
      reason: 'session_ended',
    });
  });
});

describe('receive-side diagnostics', () => {
  test('a gateway node labels a received probe gateway_received', () => {
    const h = probeHarness({ isCloudReachable: () => true });
    h.probe.sessionStarted(RIDE);
    h.emitMessage(incoming());
    expect(h.lines).toContain('probe id000042 | gateway_received | from originno seq=3');
  });

  test('a non-gateway node never claims gateway receipt', () => {
    const h = probeHarness({ isCloudReachable: () => false });
    h.probe.sessionStarted(RIDE);
    h.emitMessage(incoming());
    expect(h.lines).toContain('probe id000042 | received_unrouted | from originno seq=3');
  });

  test('only well-formed probe payloads are reported', () => {
    const h = probeHarness({ isCloudReachable: () => true });
    h.probe.sessionStarted(RIDE);
    const before = h.lines.length;
    h.emitMessage(incoming({ type: 'sos' }));
    h.emitMessage(incoming({ payload: { probe: PROBE_PAYLOAD_MARKER, seq: 3, lat: 1 } }));
    h.emitMessage(incoming({ payload: { probe: 'other', seq: 3 } }));
    h.emitMessage(incoming({ payload: { probe: PROBE_PAYLOAD_MARKER, seq: 999 } }));
    expect(h.lines).toHaveLength(before);
    expect(isConnectivityTestProbePayload({ probe: PROBE_PAYLOAD_MARKER, seq: 1 })).toBe(true);
  });

  test('status lines never fabricate delivery', () => {
    const lines = (
      [
        { state: 'transport_accepted', messageId: messageId(1), at: NOW, transportId: 'nearby' },
        { state: 'expired', messageId: messageId(1), at: NOW, expiresAt: NOW },
        {
          state: 'failed',
          messageId: messageId(1),
          at: NOW,
          reason: 'routing_unavailable',
          outcome: 'not_sent',
        },
      ] as RideConnectivityDeliveryStatus[]
    ).map(describeProbeDeliveryStatus);
    expect(lines).toEqual([
      'probe id000001 | transport_accepted (one hop accepted; not delivery)',
      'probe id000001 | expired | delivery_unconfirmed',
      'probe id000001 | failed | routing_unavailable | outcome=not_sent',
    ]);
    expect(lines.join('\n')).not.toMatch(/destination_delivered/);
  });
});

describe('probe on the real client, outbox and retry engine', () => {
  function memoryOutboxStore(): PersistentOutboxStore {
    let value: string | null = null;
    return {
      load: async () => value,
      save: async serialized => {
        value = serialized;
      },
    };
  }

  function realClientHarness(
    sendResult: (message: RideMessage<unknown>) => RideConnectivitySendResult,
  ) {
    let now = NOW;
    let n = 0;
    const application: ((received: ConnectivityApplicationMessage) => void)[] = [];
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
      onStatus: jest.fn((_listener: (status: TransportStatus) => void) => () => {}),
      onPeerCountChanged: jest.fn((_listener: (count: number) => void) => () => {}),
    };
    const sendToGateway = jest.fn((message: RideMessage<unknown>, _gateway?: string) =>
      Promise.resolve(sendResult(message)),
    );
    const outbox = createPersistentOutbox({ store: memoryOutboxStore(), random: () => 0 });
    const client = createRideConnectivityClient({
      transportId: 'nearby',
      transport,
      clock: () => now,
      outbox,
      // No acknowledgementVerifier, exactly as the app composes it: ACKs fail closed.
      createNodeIdentity: () => ({
        generateMessageId: () => messageId(++n),
        nodeIdFor: () => 'localnode-0001',
      }),
      createRuntime: options => {
        application.push(options.onApplicationMessage);
        let running = false;
        return {
          start: () => {
            running = true;
          },
          stop: () => {
            running = false;
          },
          get running() {
            return running;
          },
          sendToGateway,
          sendAcknowledgement: jest.fn(),
          getGatewayRoute: jest.fn(() => ({ ok: false as const, reason: 'no_route' as const })),
        } as unknown as RideConnectivityRuntime;
      },
    });
    const statuses: RideConnectivityDeliveryStatus[] = [];
    client.onDeliveryStatus(status => statuses.push(status));
    const lines: string[] = [];
    const probe = createConnectivityTestProbe({
      client,
      enabled: true,
      isDevelopmentBuild: true,
      clock: () => now,
      log: line => lines.push(line),
    });
    return {
      client,
      probe,
      lines,
      statuses,
      outbox,
      transport,
      sendToGateway,
      application,
      advance: async (ms: number) => {
        now += ms;
        await jest.advanceTimersByTimeAsync(ms);
      },
    };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const sentResult = (message: RideMessage<unknown>): RideConnectivitySendResult =>
    ({
      status: 'sent',
      message,
      route: {
        gatewayNodeId: 'gatewaynode-1',
        nextHopNodeId: 'gatewaynode-1',
        transportId: 'nearby',
        hopCount: 0,
        observedAt: 0,
      },
      endpointId: 'endpoint-B',
    }) as RideConnectivitySendResult;

  test('no gateway: the real envelope is queued, routing fails safely, retries are bounded', async () => {
    const h = realClientHarness(() => ({ status: 'not_sent', reason: 'no_route' }));
    await h.client.start({ rideId: RIDE, riderName: 'Alex' });
    h.probe.sessionStarted(RIDE);
    const result = await h.probe.send();
    expect(result).toMatchObject({ status: 'submitted', messageId: messageId(1) });
    await h.advance(0);

    const sent = h.sendToGateway.mock.calls[0][0];
    expect(sent).toMatchObject({
      v: 1,
      id: messageId(1),
      rideId: RIDE,
      originId: 'localnode-0001',
      type: 'ride_state',
      priority: 'low',
      hopCount: 0,
      maxHops: 4,
      payload: { probe: PROBE_PAYLOAD_MARKER, seq: 1 },
    });
    expect(sent.expiresAt - sent.createdAt).toBe(PROBE_TTL_MS);

    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await h.advance(delay);
    }
    expect(h.sendToGateway).toHaveBeenCalledTimes(5); // OUTBOX_DEFAULT_MAX_ATTEMPTS, never more
    expect(h.outbox.size).toBe(0);
    expect(h.lines).toEqual(
      expect.arrayContaining([
        'probe #1 submitted | id=id000001',
        'probe id000001 | queued',
        'probe id000001 | retry_scheduled in 1s | last=routing_unavailable',
        'probe id000001 | retry_exhausted | delivery_unconfirmed | last=routing_unavailable',
      ]),
    );
    expect(h.statuses.some(s => s.state === 'destination_delivered')).toBe(false);
    expect(h.transport.broadcast).not.toHaveBeenCalled();
    await h.advance(60_000);
    expect(h.sendToGateway).toHaveBeenCalledTimes(5);
    await h.client.stop();
  });

  test('a hop-accepted probe is never reported delivered without a verified ACK', async () => {
    const h = realClientHarness(sentResult);
    await h.client.start({ rideId: RIDE, riderName: 'Alex' });
    h.probe.sessionStarted(RIDE);
    await h.probe.send();
    await h.advance(0);

    // A forged, unsigned ACK for the probe: with no verifier it must fail closed.
    h.application[0]({
      delivery: 'local',
      message: createRideMessage({
        id: messageId(500),
        rideId: RIDE,
        originId: 'gatewaynode-1',
        type: 'ack',
        priority: 'critical',
        payload: {
          v: 1,
          originalMessageId: messageId(1),
          originalOriginId: 'localnode-0001',
          destinationNodeId: 'gatewaynode-1',
          acknowledgedAt: NOW,
          keyId: 'k',
          nonce: 'n',
          signature: 's',
        },
        ttlMs: 30_000,
        maxHops: 4,
        now: NOW,
      }),
    });
    for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
      await h.advance(delay);
    }

    expect(h.statuses.some(s => s.state === 'destination_delivered')).toBe(false);
    expect(h.lines).toContain('probe id000001 | transport_accepted (one hop accepted; not delivery)');
    expect(h.lines).toContain(
      'probe id000001 | retry_exhausted | delivery_unconfirmed | last=awaiting_acknowledgement',
    );
    expect(h.lines.join('\n')).not.toMatch(/destination_delivered/);
    await h.client.stop();
  });
});

describe('app wiring (real client and runtime, mocked native modules)', () => {
  const originalOS = Platform.OS;
  const g = globalThis as unknown as { __DEV__: boolean };
  const originalDev = g.__DEV__;
  const EVENTS = ['onPayloadReceivedFrom', 'onHazardReceived', 'onMeshStatus', 'onPeerCountChanged'];
  let broadcastHazard: jest.Mock;
  let sendPayloadTo: jest.Mock;

  const counts = () =>
    Object.fromEntries(EVENTS.map(event => [event, DeviceEventEmitter.listenerCount(event)]));

  /** `register: true` registers the dev menu inside the isolated registry (DevSettings is resolved
   * lazily, so a spy taken outside it would watch a different instance). */
  function load({
    probeEnabled,
    dev = true,
    register = false,
  }: {
    probeEnabled: boolean;
    dev?: boolean;
    register?: boolean;
  }) {
    const box: {
      loaded?: {
        service: typeof import('../src/services/rideConnectivityService');
        diagnostics: typeof import('../src/services/diagnosticsLog');
        createClient: jest.Mock;
        menuItems: [string, () => void][];
      };
    } = {};
    g.__DEV__ = dev;
    jest.isolateModules(() => {
      jest.doMock(PROBE_MODULE, () => ({
        ...jest.requireActual(PROBE_MODULE),
        ENABLE_CONNECTIVITY_TEST_PROBE: probeEnabled,
      }));
      const actualClient = jest.requireActual('../src/connectivity/rideConnectivityClient');
      const createClient = jest.fn(actualClient.createRideConnectivityClient);
      jest.doMock('../src/connectivity/rideConnectivityClient', () => ({
        ...actualClient,
        createRideConnectivityClient: createClient,
      }));
      const menuItems: [string, () => void][] = [];
      const service = require('../src/services/rideConnectivityService');
      if (register) {
        const devSettings: typeof DevSettings = require('react-native').DevSettings;
        const addMenuItem = jest
          .spyOn(devSettings, 'addMenuItem')
          .mockImplementation((title: string, handler: () => void) => {
            menuItems.push([title, handler]);
          });
        try {
          service.registerRideConnectivityDevMenu();
        } finally {
          addMenuItem.mockRestore();
        }
      }
      box.loaded = {
        service,
        diagnostics: require('../src/services/diagnosticsLog'),
        createClient,
        menuItems,
      };
    });
    return box.loaded!;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    (Platform as { OS: string }).OS = 'android';
    broadcastHazard = jest.fn((_payload: string) => Promise.resolve());
    sendPayloadTo = jest.fn(() => Promise.resolve());
    let stored: string | null = null;
    (NativeModules as Record<string, unknown>).NearbyMeshModule = {
      startMeshSession: jest.fn(() => Promise.resolve()),
      stopMeshSession: jest.fn(() => Promise.resolve()),
      broadcastHazard,
      sendPayloadTo,
    };
    (NativeModules as Record<string, unknown>).RideazeSecureOutbox = {
      load: jest.fn(async () => stored),
      save: jest.fn(async (value: string) => {
        stored = value;
      }),
      remove: jest.fn(async () => {
        stored = null;
      }),
    };
  });

  afterEach(() => {
    jest.dontMock(PROBE_MODULE);
    jest.dontMock('../src/connectivity/rideConnectivityClient');
    g.__DEV__ = originalDev;
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
    delete (NativeModules as Record<string, unknown>).RideazeSecureOutbox;
    jest.useRealTimers();
  });

  const callbacks = () => ({
    rideId: 'ABC123',
    riderName: 'Alex',
    onStarted: jest.fn(),
    onStopping: jest.fn(),
    onError: jest.fn(),
  });

  test('disabled (committed default): no probe, no menu item, no client created by the probe', () => {
    const app = load({ probeEnabled: false, register: true });
    expect(app.service.getAppConnectivityTestProbe()).toBeNull();
    expect(app.menuItems.map(([title]) => title)).toEqual(['Rideaze: toggle test cloud gateway']);
    expect(app.createClient).not.toHaveBeenCalled();
  });

  test('release build: flag on still yields no probe and no menu item', async () => {
    const app = load({ probeEnabled: true, dev: false, register: true });
    expect(app.service.getAppConnectivityTestProbe()).toBeNull();
    await expect(app.service.sendAppConnectivityTestProbe()).resolves.toEqual({
      status: 'probe_disabled',
    });
    expect(app.menuItems).toEqual([]);
    expect(app.createClient).not.toHaveBeenCalled();
  });

  test('self-contained field-test build keeps controls with dev-mode JS off', () => {
    (NativeModules as Record<string, unknown>).RideazeFieldTestEvidence = {
      enabled: true,
      append: jest.fn(async () => undefined),
      read: jest.fn(async () => []),
      clear: jest.fn(async () => undefined),
      printToLogcat: jest.fn(async () => 0),
    };
    try {
      const app = load({ probeEnabled: false, dev: false, register: true });
      expect(app.service.getAppConnectivityTestProbe()).not.toBeNull();
      expect(app.menuItems.map(([title]) => title)).toEqual([
        'Rideaze: toggle test cloud gateway',
        'Rideaze: send connectivity test probe',
        'Rideaze: print offline field evidence',
        'Rideaze: clear offline field evidence',
      ]);
    } finally {
      delete (NativeModules as Record<string, unknown>).RideazeFieldTestEvidence;
    }
  });

  test('enabled debug build: the menu item uses the one app client', async () => {
    const app = load({ probeEnabled: true, register: true });
    expect(app.menuItems.map(([title]) => title)).toEqual([
      'Rideaze: toggle test cloud gateway',
      'Rideaze: send connectivity test probe',
    ]);
    expect(app.service.getAppConnectivityTestProbe()).toBe(app.service.getAppConnectivityTestProbe());
    app.service.getAppRideConnectivityClient();
    expect(app.createClient).toHaveBeenCalledTimes(1);

    // No ride yet: the menu action refuses and says so.
    app.menuItems[1][1]();
    await jest.advanceTimersByTimeAsync(0);
    expect(app.diagnostics.getDiagnosticEvents().map(e => e.message)).toContain(
      'probe not sent: no active protocol session',
    );
    expect(isRideCloudReachable()).toBe(false);
  });

  test('a ride session arms the probe; it routes through the real runtime and cleans up', async () => {
    const app = load({ probeEnabled: true });
    const before = counts();
    const cb = callbacks();
    const dispose = app.service.startAppRideMeshSession(cb);
    await jest.advanceTimersByTimeAsync(0);
    expect(cb.onStarted).toHaveBeenCalledWith('protocol');

    const result = await app.service.sendAppConnectivityTestProbe();
    expect(result).toMatchObject({ status: 'submitted', seq: 1 });
    await jest.advanceTimersByTimeAsync(1_500);

    const messages = app.diagnostics.getDiagnosticEvents().map(e => e.message);
    const prefix = (result as { messageId: string }).messageId.slice(0, 8);
    expect(messages).toContain(`probe #1 submitted | id=${prefix}`);
    expect(messages).toContain(`probe ${prefix} | queued`);
    expect(messages).toContain(`probe ${prefix} | retry_scheduled in 1s | last=routing_unavailable`);

    // Only protocol heartbeats were broadcast; the probe is never broadcast, hazard-shaped, or
    // sent anywhere without a route.
    for (const [payload] of broadcastHazard.mock.calls) {
      expect(JSON.parse(payload as string).type).toBe('heartbeat');
    }
    expect(sendPayloadTo).not.toHaveBeenCalled();
    expect(app.createClient).toHaveBeenCalledTimes(1);

    dispose();
    await jest.advanceTimersByTimeAsync(0);
    expect(cb.onStopping).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual(before);
    await expect(app.service.sendAppConnectivityTestProbe()).resolves.toEqual({
      status: 'session_inactive',
    });
  });
});

describe('probe source guard', () => {
  const source = fs.readFileSync('src/connectivity/connectivityTestProbe.ts', 'utf8');
  // Comments may name what the probe avoids; only code is checked.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  test('depends on the connectivity client contract only', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
    expect(imports).toEqual(['./rideConnectivityClient']);
  });

  test('never touches emergency, hazard, braking, mesh sync, LiveKit, native or randomness', () => {
    const forbidden = [
      /HazardCoordinator|hazardProtocol|crash|brak|meshSync/,
      /LiveKit|livekit|publishData/,
      /NativeModules|nearbyTransport|Math\.random|acknowledgementVerifier/,
    ];
    for (const pattern of forbidden) {
      expect(code).not.toMatch(pattern);
    }
  });

  test('RideScreen is not modified to reach the probe', () => {
    const rideScreen = fs.readFileSync('src/screens/RideScreen.tsx', 'utf8');
    expect(rideScreen).not.toMatch(/connectivityTestProbe|ConnectivityTestProbe/);
  });
});
