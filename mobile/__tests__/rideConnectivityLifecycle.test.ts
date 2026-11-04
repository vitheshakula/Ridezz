import { DeviceEventEmitter, DevSettings, NativeModules, Platform } from 'react-native';
import {
  createConnectivityDiagnostics,
  createMonotonicClock,
  createRideConnectivityController,
  createRideNodeIdentity,
} from '../src/connectivity/rideConnectivityLifecycle';
import {
  FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST,
  isRideCloudReachable,
  setDevMenuGatewayForced,
} from '../src/connectivity/debugGatewayOverride';
import type {
  RideConnectivityEvent,
  RideConnectivityRuntime,
} from '../src/connectivity/rideConnectivityRuntime';
import { RIDE_MESSAGE_ID_PATTERN } from '../src/connectivity/protocol/rideMessageId';

const PAYLOAD_EVENT = 'onPayloadReceivedFrom';

function fakeRuntime() {
  return {
    start: jest.fn(),
    stop: jest.fn(),
    running: true,
    sendToGateway: jest.fn(),
    getGatewayRoute: jest.fn(),
  } as unknown as RideConnectivityRuntime & { start: jest.Mock; stop: jest.Mock };
}

describe('ride node identity', () => {
  test('one id per ride key, stable across repeated calls (e.g. Nearby retries)', () => {
    let n = 0;
    const generate = jest.fn(() => `id-${++n}`);
    const identity = createRideNodeIdentity(generate);

    expect(identity.nodeIdFor('12345')).toBe('id-1');
    expect(identity.nodeIdFor('12345')).toBe('id-1');
    expect(identity.nodeIdFor('12345')).toBe('id-1');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('a different ride gets a new id; a new session identity gets a new id', () => {
    let n = 0;
    const generate = () => `id-${++n}`;
    const first = createRideNodeIdentity(generate);
    expect(first.nodeIdFor('12345')).toBe('id-1');
    expect(first.nodeIdFor('54321')).toBe('id-2');
    expect(createRideNodeIdentity(generate).nodeIdFor('12345')).toBe('id-3');
  });

  test('the app identity uses the secure generator, never Math.random', () => {
    const random = jest.spyOn(Math, 'random');
    try {
      const { createAppRideNodeIdentity } = require('../src/services/rideConnectivityService');
      const nodeId = createAppRideNodeIdentity().nodeIdFor('12345');
      expect(nodeId).toMatch(RIDE_MESSAGE_ID_PATTERN);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});

describe('monotonic clock', () => {
  test('wraps performance.now with the right receiver', () => {
    const perf = {
      base: 1000,
      now(this: { base: number }) {
        return this.base + 5;
      },
    };
    expect(createMonotonicClock({ performance: perf })()).toBe(1005);
  });

  test('fails closed without performance.now and never uses Date.now', () => {
    const dateNow = jest.spyOn(Date, 'now');
    try {
      expect(() => createMonotonicClock({})).toThrow('performance.now is unavailable');
      expect(() => createMonotonicClock({ performance: { now: 1 } })).toThrow(TypeError);
      expect(dateNow).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe('connectivity controller', () => {
  test('transport start creates and starts exactly one runtime; repeats are ignored', () => {
    const runtime = fakeRuntime();
    const createRuntime = jest.fn(() => runtime);
    const controller = createRideConnectivityController({ createRuntime });

    controller.transportStarted();
    controller.transportStarted();
    controller.transportStarted();

    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(controller.runtime).toBe(runtime);
  });

  test('dispose stops the runtime once and is idempotent', () => {
    const runtime = fakeRuntime();
    const controller = createRideConnectivityController({ createRuntime: () => runtime });
    controller.transportStarted();

    controller.dispose();
    controller.dispose();

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(controller.runtime).toBeNull();
  });

  test('a start completing after cleanup creates nothing (unmount during async start)', () => {
    const createRuntime = jest.fn(fakeRuntime);
    const controller = createRideConnectivityController({ createRuntime });

    controller.dispose();
    controller.transportStarted();

    expect(createRuntime).not.toHaveBeenCalled();
    expect(controller.runtime).toBeNull();
  });

  test('creation or start failure leaves no running runtime and is reported', () => {
    const onError = jest.fn();
    const failingCreate = createRideConnectivityController({
      createRuntime: () => {
        throw new Error('performance.now is unavailable');
      },
      onError,
    });
    failingCreate.transportStarted();
    expect(failingCreate.runtime).toBeNull();
    expect(onError).toHaveBeenCalledWith(new Error('performance.now is unavailable'));

    const runtime = fakeRuntime();
    runtime.start.mockImplementation(() => {
      throw new Error('start failed');
    });
    const failingStart = createRideConnectivityController({
      createRuntime: () => runtime,
      onError,
    });
    failingStart.transportStarted();
    expect(failingStart.runtime).toBeNull();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });
});

describe('app integration lifecycle (RideScreen effect sequence, real runtime)', () => {
  const originalOS = Platform.OS;
  let service: typeof import('../src/services/rideConnectivityService');
  let start: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    (Platform as { OS: string }).OS = 'android';
    start = jest.fn(() => Promise.resolve());
    (NativeModules as Record<string, unknown>).NearbyMeshModule = {
      startMeshSession: start,
      stopMeshSession: jest.fn(() => Promise.resolve()),
      broadcastHazard: jest.fn(() => Promise.resolve()),
      sendPayloadTo: jest.fn(() => Promise.resolve()),
    };
    jest.isolateModules(() => {
      service = require('../src/services/rideConnectivityService');
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
  });

  const listeners = () => DeviceEventEmitter.listenerCount(PAYLOAD_EVENT);

  function effectRun(roomCode: string, identityRef: { current: unknown }) {
    const connectivity = service.createNearbyRideConnectivity({
      roomCode,
      getNodeIdentity: () =>
        (identityRef.current ??= service.createAppRideNodeIdentity()) as ReturnType<
          typeof service.createAppRideNodeIdentity
        >,
    });
    return connectivity;
  }

  test('failed start, retry, success, cleanup: one runtime, one listener, then none', async () => {
    const before = listeners();
    const identityRef: { current: unknown } = { current: null };
    const connectivity = effectRun('12345', identityRef);

    expect(connectivity.runtime).toBeNull();
    connectivity.transportStarted();
    expect(connectivity.runtime?.running).toBe(true);
    expect(listeners()).toBe(before + 1);

    connectivity.dispose();
    expect(listeners()).toBe(before);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(listeners()).toBe(before);
  });

  test('re-running the effect (rider-name change) keeps the node id and leaves one runtime', () => {
    const before = listeners();
    const identityRef: { current: unknown } = { current: null };
    const first = effectRun('12345', identityRef);
    first.transportStarted();
    const nodeId = (identityRef.current as { nodeIdFor(k: string): string }).nodeIdFor('12345');

    first.dispose();
    const second = effectRun('12345', identityRef);
    second.transportStarted();

    expect(listeners()).toBe(before + 1);
    expect((identityRef.current as { nodeIdFor(k: string): string }).nodeIdFor('12345')).toBe(
      nodeId,
    );
    second.dispose();
    expect(listeners()).toBe(before);
  });

  test('a new mounted ride session gets a new node id', () => {
    const mountA: { current: unknown } = { current: null };
    const mountB: { current: unknown } = { current: null };
    effectRun('12345', mountA).dispose();
    const a = effectRun('12345', mountA);
    a.transportStarted();
    const b = effectRun('12345', mountB);
    b.transportStarted();

    const idOf = (ref: { current: unknown }) =>
      (ref.current as { nodeIdFor(k: string): string }).nodeIdFor('12345');
    expect(idOf(mountA)).toMatch(RIDE_MESSAGE_ID_PATTERN);
    expect(idOf(mountB)).not.toBe(idOf(mountA));
    a.dispose();
    b.dispose();
  });

  test('a cleanup before the async start resolves leaks nothing', () => {
    const before = listeners();
    const connectivity = effectRun('12345', { current: null });

    connectivity.dispose();
    connectivity.transportStarted();

    expect(connectivity.runtime).toBeNull();
    expect(listeners()).toBe(before);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('cloud reachability and the device-test override', () => {
  afterEach(() => setDevMenuGatewayForced(false));

  test('production default is false and the build switch is committed off', () => {
    expect(FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST).toBe(false);
    expect(isRideCloudReachable()).toBe(false);
  });

  test('the dev-menu override is explicit, per process, and reversible', () => {
    setDevMenuGatewayForced(true);
    expect(isRideCloudReachable()).toBe(true);
    setDevMenuGatewayForced(false);
    expect(isRideCloudReachable()).toBe(false);
  });

  test('the dev-menu item is registered once and toggles this phone only', () => {
    jest.isolateModules(() => {
      const isolatedDevSettings: typeof DevSettings = require('react-native').DevSettings;
      const addMenuItem = jest
        .spyOn(isolatedDevSettings, 'addMenuItem')
        .mockImplementation(() => {});
      try {
        const isolatedService = require('../src/services/rideConnectivityService');
        const isolatedOverride = require('../src/connectivity/debugGatewayOverride');
        isolatedService.registerRideConnectivityDevMenu();
        isolatedService.registerRideConnectivityDevMenu();

        expect(addMenuItem).toHaveBeenCalledTimes(1);
        const [title, handler] = addMenuItem.mock.calls[0];
        expect(title).toBe('Rideaze: toggle test cloud gateway');
        expect(isolatedOverride.isRideCloudReachable()).toBe(false);
        (handler as () => void)();
        expect(isolatedOverride.isRideCloudReachable()).toBe(true);
        (handler as () => void)();
        expect(isolatedOverride.isRideCloudReachable()).toBe(false);
      } finally {
        addMenuItem.mockRestore();
      }
    });
  });
});

describe('connectivity diagnostics', () => {
  function diagnostics(route = { ok: false as const, reason: 'no_route' as const }) {
    const lines: string[] = [];
    type Route = ReturnType<Parameters<typeof createConnectivityDiagnostics>[0]['getRoute']>;
    let current: Route = route;
    const onEvent = createConnectivityDiagnostics({
      log: line => lines.push(line),
      getRoute: () => current,
    });
    return { lines, onEvent, setRoute: (r: typeof current) => (current = r) };
  }

  const heartbeat = (change: 'new_peer' | 'refreshed', link?: unknown): RideConnectivityEvent => ({
    kind: 'receive',
    result: {
      stage: 'heartbeat',
      result: {
        observed: true,
        nodeId: '0123456789abcdef-node',
        transportId: 'nearby',
        change,
        ...(link ? { link } : {}),
      } as never,
    },
  });

  test('logs new peers and links, not refreshes, with truncated ids', () => {
    const { lines, onEvent } = diagnostics();
    onEvent(heartbeat('new_peer', { observed: true, change: 'new_link' }));
    onEvent(heartbeat('refreshed', { observed: true, change: 'refreshed' }));

    expect(lines).toEqual(['peer 01234567 on nearby (new_peer)', 'link learned -> 01234567']);
  });

  test('logs cycle outcomes only when they change, and stays quiet when healthy', () => {
    const { lines, onEvent } = diagnostics();
    const cycle = (status: string): RideConnectivityEvent =>
      ({ kind: 'gateway_advertisement_cycle', outcome: { ok: true, value: { status } } } as never);
    onEvent(cycle('not_reachable'));
    onEvent(cycle('not_reachable'));
    onEvent(cycle('sent'));
    onEvent(cycle('sent'));
    onEvent(cycle('not_reachable'));

    expect(lines).toEqual(['advertising as cloud gateway', 'not a cloud gateway']);
  });

  test('logs gateway route changes after advertisements', () => {
    const { lines, onEvent, setRoute } = diagnostics();
    setRoute({
      ok: true,
      route: {
        gatewayNodeId: 'cccccccc-gateway',
        nextHopNodeId: 'bbbbbbbb-relay',
        transportId: 'nearby',
        hopCount: 1,
        observedAt: 1,
      },
      distance: 2,
    } as never);
    const advert: RideConnectivityEvent = {
      kind: 'receive',
      result: {
        stage: 'gateway_advertisement',
        result: {
          observed: true,
          gatewayNodeId: 'cccccccc-gateway',
          transportId: 'nearby',
          hopCount: 1,
          change: 'new_gateway',
          via: { resolved: true, nodeId: 'bbbbbbbb-relay' },
        },
        relay: { status: 'relayed', message: { hopCount: 2 } as never },
      },
    };
    onEvent(advert);
    onEvent(advert);

    expect(lines).toEqual([
      'gateway cccccccc seen via bbbbbbbb, hop 1',
      'advertisement relayed (hop 2)',
      'gateway route: cccccccc via bbbbbbbb on nearby, distance 2',
      'gateway cccccccc seen via bbbbbbbb, hop 1',
      'advertisement relayed (hop 2)',
    ]);
  });
});
