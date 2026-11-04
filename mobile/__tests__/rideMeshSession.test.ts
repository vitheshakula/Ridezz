import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  RIDE_MESH_RETRY_MS,
  createRideMeshSessionOwner,
  sanitizeRideMeshRiderName,
  type NearbyStartError,
  type RideMeshSessionCallbacks,
} from '../src/services/rideMeshSession';

interface Deferred {
  resolve(): void;
  reject(error: unknown): void;
}

function lifecycleHarness({ withClient = true } = {}) {
  const calls: string[] = [];
  const pending: Record<string, Deferred[]> = {};
  const deferredCall = (name: string) =>
    jest.fn((..._args: unknown[]) => {
      calls.push(name);
      return new Promise<void>((resolve, reject) => {
        (pending[name] ??= []).push({ resolve, reject });
      });
    });
  const client = {
    start: deferredCall('client.start'),
    stop: jest.fn(() => {
      calls.push('client.stop');
      return Promise.resolve();
    }),
  };
  const fallbackTransport = {
    start: deferredCall('fallback.start'),
    stop: jest.fn(() => {
      calls.push('fallback.stop');
      return Promise.resolve();
    }),
  };
  let lastStartError: NearbyStartError | null = null;
  const log = jest.fn();
  const owner = createRideMeshSessionOwner({
    client: withClient ? client : null,
    fallbackTransport,
    getLastStartError: () => lastStartError,
    log,
  });

  const callbacks = (overrides: Partial<RideMeshSessionCallbacks> = {}) => ({
    rideId: 'ABC123',
    riderName: 'Alex',
    onStarted: jest.fn(),
    onStopping: jest.fn(),
    onError: jest.fn(),
    ...overrides,
  });

  const next = (name: string): Deferred => {
    const deferred = pending[name]?.shift();
    if (!deferred) {
      throw new Error(`no pending ${name}`);
    }
    return deferred;
  };

  return {
    owner,
    client,
    fallbackTransport,
    calls,
    log,
    callbacks,
    settle: () => jest.advanceTimersByTimeAsync(0),
    resolve: async (name: string) => {
      await jest.advanceTimersByTimeAsync(0);
      next(name).resolve();
      await jest.advanceTimersByTimeAsync(0);
    },
    reject: async (name: string, error: unknown, nativeError: NearbyStartError | null = null) => {
      await jest.advanceTimersByTimeAsync(0);
      lastStartError = nativeError;
      next(name).reject(error);
      await jest.advanceTimersByTimeAsync(0);
    },
  };
}

const clientError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('sanitizeRideMeshRiderName (mirrors NearbyMeshModule)', () => {
  test('replaces every pipe with a space and cuts to 24 UTF-16 units', () => {
    expect(sanitizeRideMeshRiderName('a|b|c')).toBe('a b c');
    expect(sanitizeRideMeshRiderName('Akula Vithesh Yadav Kumar Reddy')).toBe(
      'Akula Vithesh Yadav Kuma',
    );
    expect(sanitizeRideMeshRiderName('x'.repeat(24))).toBe('x'.repeat(24));
    expect(sanitizeRideMeshRiderName('Alex')).toBe('Alex');
  });

  test('a blank result gets a non-blank name the client accepts', () => {
    expect(sanitizeRideMeshRiderName('')).toBe('Rider');
    expect(sanitizeRideMeshRiderName('|||')).toBe('Rider');
    expect(sanitizeRideMeshRiderName('   ')).toBe('Rider');
  });
});

describe('ride mesh session owner: protocol mode', () => {
  test('starts Nearby once through the client with a sanitized context', async () => {
    const h = lifecycleHarness();
    const cb = h.callbacks({ riderName: 'Long|Name Exceeding The Native Bound' });
    const dispose = h.owner.start(cb);
    await h.settle();

    expect(h.client.start).toHaveBeenCalledTimes(1);
    expect(h.client.start).toHaveBeenCalledWith({
      rideId: 'ABC123',
      riderName: 'Long Name Exceeding The ',
    });
    expect(cb.onStarted).not.toHaveBeenCalled();

    await h.resolve('client.start');
    expect(cb.onStarted).toHaveBeenCalledTimes(1);
    expect(cb.onStarted).toHaveBeenCalledWith('protocol');
    expect(h.fallbackTransport.start).not.toHaveBeenCalled();

    dispose();
    dispose();
    await h.settle();
    expect(cb.onStopping).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['client.start', 'client.stop']);
    expect(h.fallbackTransport.stop).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a failed transport start reports the native message and retries through the client', async () => {
    const h = lifecycleHarness();
    const cb = h.callbacks();
    const dispose = h.owner.start(cb);
    await h.settle();

    await h.reject('client.start', clientError('transport_unavailable'), {
      code: 'mesh_bluetooth_off',
      message: 'Bluetooth is off. Turn it on for the offline mesh.',
    });
    expect(cb.onError).toHaveBeenCalledWith('Bluetooth is off. Turn it on for the offline mesh.');
    expect(cb.onStarted).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(RIDE_MESH_RETRY_MS - 1);
    expect(h.client.start).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.client.start).toHaveBeenCalledTimes(2);

    await h.resolve('client.start');
    expect(cb.onStarted).toHaveBeenCalledWith('protocol');
    expect(h.fallbackTransport.start).not.toHaveBeenCalled();
    dispose();
    await h.settle();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('without a native message the error reads "unavailable"; mesh_unsupported is not retried', async () => {
    const h = lifecycleHarness();
    const cb = h.callbacks();
    h.owner.start(cb);
    await h.settle();

    await h.reject('client.start', clientError('transport_unavailable'), {
      code: 'mesh_unsupported',
    });
    expect(cb.onError).toHaveBeenCalledWith('unavailable');
    await jest.advanceTimersByTimeAsync(RIDE_MESH_RETRY_MS * 3);
    expect(h.client.start).toHaveBeenCalledTimes(1);
  });
});

describe('ride mesh session owner: Phase 1 fallback', () => {
  test('protocol initialization failure keeps Phase 1 Nearby running without the client', async () => {
    const h = lifecycleHarness();
    const cb = h.callbacks();
    const dispose = h.owner.start(cb);
    await h.settle();

    await h.reject('client.start', clientError('initialization_error'));
    expect(h.fallbackTransport.start).toHaveBeenCalledTimes(1);
    expect(h.fallbackTransport.start).toHaveBeenCalledWith({
      roomCode: 'ABC123',
      riderName: 'Alex',
    });
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('protocol off: initialization_error'),
    );

    await h.resolve('fallback.start');
    expect(cb.onStarted).toHaveBeenCalledTimes(1);
    expect(cb.onStarted).toHaveBeenCalledWith('phase1_only');

    dispose();
    await h.settle();
    expect(h.calls).toEqual(['client.start', 'fallback.start', 'client.stop', 'fallback.stop']);
  });

  test('once the protocol is off, retries never go back to the client (no flapping)', async () => {
    const h = lifecycleHarness();
    const cb = h.callbacks();
    const dispose = h.owner.start(cb);
    await h.settle();
    await h.reject('client.start', clientError('initialization_error'));

    await h.reject('fallback.start', {
      code: 'mesh_start_failed',
      message: 'startDiscovery: busy',
    });
    expect(cb.onError).toHaveBeenCalledWith('startDiscovery: busy');
    await jest.advanceTimersByTimeAsync(RIDE_MESH_RETRY_MS);
    expect(h.fallbackTransport.start).toHaveBeenCalledTimes(2);
    expect(h.client.start).toHaveBeenCalledTimes(1);

    await h.resolve('fallback.start');
    expect(cb.onStarted).toHaveBeenCalledWith('phase1_only');
    dispose();
    await h.settle();
  });

  test('any non-transport client failure turns the protocol off rather than losing Nearby', async () => {
    const h = lifecycleHarness();
    const cb = h.callbacks();
    h.owner.start(cb);
    await h.settle();
    await h.reject('client.start', clientError('lifecycle_error'));
    expect(h.fallbackTransport.start).toHaveBeenCalledTimes(1);
  });

  test('no client at all starts Phase 1 Nearby directly', async () => {
    const h = lifecycleHarness({ withClient: false });
    const cb = h.callbacks();
    const dispose = h.owner.start(cb);
    await h.settle();
    expect(h.calls).toEqual(['fallback.start']);
    await h.resolve('fallback.start');
    expect(cb.onStarted).toHaveBeenCalledWith('phase1_only');
    dispose();
    await h.settle();
    expect(h.calls).toEqual(['fallback.start', 'fallback.stop']);
  });
});

describe('ride mesh session owner: rapid transitions', () => {
  test('dispose during a pending start: no start callback, and the stop follows the start', async () => {
    const h = lifecycleHarness();
    const cb = h.callbacks();
    const dispose = h.owner.start(cb);
    await h.settle();

    dispose();
    await h.settle();
    expect(h.client.stop).not.toHaveBeenCalled();

    await h.resolve('client.start');
    expect(cb.onStarted).not.toHaveBeenCalled();
    expect(cb.onStopping).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['client.start', 'client.stop']);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a new screen start waits for the previous screen stop (strict start/stop alternation)', async () => {
    const h = lifecycleHarness();
    const first = h.callbacks();
    const second = h.callbacks();
    const third = h.callbacks();

    const disposeFirst = h.owner.start(first);
    await h.settle();
    disposeFirst();
    const disposeSecond = h.owner.start(second);
    await h.settle();
    expect(h.calls).toEqual(['client.start']);

    await h.resolve('client.start');
    expect(h.calls).toEqual(['client.start', 'client.stop', 'client.start']);
    disposeSecond();
    const disposeThird = h.owner.start(third);
    await h.resolve('client.start');
    await h.resolve('client.start');

    expect(h.calls).toEqual([
      'client.start',
      'client.stop',
      'client.start',
      'client.stop',
      'client.start',
    ]);
    expect(first.onStarted).not.toHaveBeenCalled();
    expect(second.onStarted).not.toHaveBeenCalled();
    expect(third.onStarted).toHaveBeenCalledTimes(1);
    disposeThird();
    await h.settle();
  });

  test('a session disposed while its start is still queued never reaches the client', async () => {
    const h = lifecycleHarness();
    const first = h.callbacks();
    const skipped = h.callbacks();
    const last = h.callbacks();

    const disposeFirst = h.owner.start(first);
    await h.settle();
    disposeFirst();
    h.owner.start(skipped)();
    h.owner.start(last);
    await h.resolve('client.start');

    expect(h.calls).toEqual(['client.start', 'client.stop', 'client.stop', 'client.start']);
    expect(skipped.onStarted).not.toHaveBeenCalled();
    expect(skipped.onError).not.toHaveBeenCalled();
    await h.resolve('client.start');
    expect(last.onStarted).toHaveBeenCalledWith('protocol');
  });

  test('the fallback stop is ordered before the next screen start', async () => {
    const h = lifecycleHarness();
    const dispose = h.owner.start(h.callbacks());
    await h.settle();
    await h.reject('client.start', clientError('initialization_error'));
    dispose();
    const next = h.callbacks();
    h.owner.start(next);
    await h.resolve('fallback.start');

    expect(h.calls).toEqual([
      'client.start',
      'fallback.start',
      'client.stop',
      'fallback.stop',
      'client.start',
    ]);
  });

  test('starting while a session is live supersedes it, stopping it first', async () => {
    const h = lifecycleHarness();
    const first = h.callbacks();
    const disposeFirst = h.owner.start(first);
    await h.resolve('client.start');
    expect(first.onStarted).toHaveBeenCalledTimes(1);

    const second = h.callbacks();
    h.owner.start(second);
    await h.settle();
    expect(first.onStopping).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['client.start', 'client.stop', 'client.start']);

    disposeFirst();
    await h.settle();
    expect(first.onStopping).toHaveBeenCalledTimes(1);
    expect(h.client.stop).toHaveBeenCalledTimes(1);
  });

  test('a pending retry is cancelled by dispose', async () => {
    const h = lifecycleHarness();
    const dispose = h.owner.start(h.callbacks());
    await h.settle();
    await h.reject('client.start', clientError('transport_unavailable'));
    expect(jest.getTimerCount()).toBe(1);
    dispose();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(RIDE_MESH_RETRY_MS * 2);
    expect(h.client.start).toHaveBeenCalledTimes(1);
  });

  test('throwing callbacks cannot break the lifecycle', async () => {
    const h = lifecycleHarness();
    const dispose = h.owner.start(
      h.callbacks({
        onStarted: () => {
          throw new Error('boom');
        },
        onStopping: () => {
          throw new Error('boom');
        },
      }),
    );
    await h.resolve('client.start');
    dispose();
    await h.settle();
    expect(h.calls).toEqual(['client.start', 'client.stop']);
  });
});

describe('app ride mesh session (real client and runtime, mocked native modules)', () => {
  const originalOS = Platform.OS;
  const EVENTS = [
    'onPayloadReceivedFrom',
    'onHazardReceived',
    'onMeshStatus',
    'onPeerCountChanged',
  ];
  let service: typeof import('../src/services/rideConnectivityService');
  let startMeshSession: jest.Mock;
  let stopMeshSession: jest.Mock;
  let nativeCalls: string[];

  const counts = () =>
    Object.fromEntries(EVENTS.map(event => [event, DeviceEventEmitter.listenerCount(event)]));

  function loadService(mockLifecycle?: () => void) {
    jest.isolateModules(() => {
      mockLifecycle?.();
      service = require('../src/services/rideConnectivityService');
    });
  }

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'android';
    nativeCalls = [];
    startMeshSession = jest.fn((_room: string, _name: string) => {
      nativeCalls.push('start');
      return Promise.resolve();
    });
    stopMeshSession = jest.fn(() => {
      nativeCalls.push('stop');
      return Promise.resolve();
    });
    let stored: string | null = null;
    (NativeModules as Record<string, unknown>).NearbyMeshModule = {
      startMeshSession,
      stopMeshSession,
      broadcastHazard: jest.fn(() => Promise.resolve()),
      sendPayloadTo: jest.fn(() => Promise.resolve()),
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
    loadService();
  });

  afterEach(() => {
    jest.dontMock('../src/connectivity/rideConnectivityLifecycle');
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
    delete (NativeModules as Record<string, unknown>).RideazeSecureOutbox;
  });

  const appCallbacks = (overrides: Partial<RideMeshSessionCallbacks> = {}) => ({
    rideId: 'ABC123',
    riderName: 'Alex',
    onStarted: jest.fn(),
    onStopping: jest.fn(),
    onError: jest.fn(),
    ...overrides,
  });

  test('one application-wide client instance', () => {
    expect(service.getAppRideConnectivityClient()).toBe(service.getAppRideConnectivityClient());
    expect((service as Record<string, unknown>).createAppRideConnectivityClient).toBeUndefined();
  });

  test('starts native Nearby once, adds exactly one protocol receiver, and cleans every listener', async () => {
    const before = counts();
    const cb = appCallbacks();
    const dispose = service.startAppRideMeshSession(cb);
    await jest.advanceTimersByTimeAsync(0);

    expect(startMeshSession).toHaveBeenCalledTimes(1);
    expect(cb.onStarted).toHaveBeenCalledWith('protocol');
    expect(counts()).toEqual({
      ...before,
      onPayloadReceivedFrom: before.onPayloadReceivedFrom + 1,
      onMeshStatus: before.onMeshStatus + 1,
      onPeerCountChanged: before.onPeerCountChanged + 1,
      onHazardReceived: before.onHazardReceived,
    });

    dispose();
    await jest.advanceTimersByTimeAsync(0);
    expect(stopMeshSession).toHaveBeenCalledTimes(1);
    expect(nativeCalls).toEqual(['start', 'stop']);
    expect(counts()).toEqual(before);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(counts()).toEqual(before);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a long or piped rider name reaches native sanitized instead of failing the start', async () => {
    const cb = appCallbacks({ riderName: 'Akula|Vithesh Yadav Kumar Reddy' });
    const dispose = service.startAppRideMeshSession(cb);
    await jest.advanceTimersByTimeAsync(0);
    expect(startMeshSession).toHaveBeenCalledWith('ABC123', 'Akula Vithesh Yadav Kuma');
    expect(cb.onStarted).toHaveBeenCalledWith('protocol');
    expect(cb.onError).not.toHaveBeenCalled();
    dispose();
    await jest.advanceTimersByTimeAsync(0);
  });

  test('the native Bluetooth message survives the client and the start is retried', async () => {
    startMeshSession.mockImplementationOnce(() => {
      nativeCalls.push('start');
      return Promise.reject(
        Object.assign(new Error('Bluetooth is off. Turn it on for the offline mesh.'), {
          code: 'mesh_bluetooth_off',
        }),
      );
    });
    const before = counts();
    const cb = appCallbacks();
    const dispose = service.startAppRideMeshSession(cb);
    await jest.advanceTimersByTimeAsync(0);

    expect(cb.onError).toHaveBeenCalledWith('Bluetooth is off. Turn it on for the offline mesh.');
    expect(cb.onStarted).not.toHaveBeenCalled();
    expect(counts()).toEqual(before);

    await jest.advanceTimersByTimeAsync(RIDE_MESH_RETRY_MS);
    expect(startMeshSession).toHaveBeenCalledTimes(2);
    expect(cb.onStarted).toHaveBeenCalledWith('protocol');
    dispose();
    await jest.advanceTimersByTimeAsync(0);
  });

  test('rapid screen transitions leave exactly one live session and alternate native calls', async () => {
    const before = counts();
    for (let i = 0; i < 3; i++) {
      service.startAppRideMeshSession(appCallbacks())();
    }
    const live = appCallbacks();
    const dispose = service.startAppRideMeshSession(live);
    await jest.advanceTimersByTimeAsync(0);

    expect(live.onStarted).toHaveBeenCalledTimes(1);
    expect(nativeCalls).toEqual(['start']);
    expect(counts().onPayloadReceivedFrom).toBe(before.onPayloadReceivedFrom + 1);

    dispose();
    await jest.advanceTimersByTimeAsync(0);
    expect(nativeCalls).toEqual(['start', 'stop']);
    expect(counts()).toEqual(before);
  });

  test('protocol initialization failure falls back to a Phase 1-only Nearby session', async () => {
    loadService(() => {
      jest.doMock('../src/connectivity/rideConnectivityLifecycle', () => ({
        ...jest.requireActual('../src/connectivity/rideConnectivityLifecycle'),
        createMonotonicClock: () => {
          throw new TypeError(
            'performance.now is unavailable: no monotonic clock for the protocol',
          );
        },
      }));
    });
    const before = counts();
    const cb = appCallbacks();
    const dispose = service.startAppRideMeshSession(cb);
    await jest.advanceTimersByTimeAsync(0);

    expect(nativeCalls).toEqual(['start', 'stop', 'start']);
    expect(cb.onStarted).toHaveBeenCalledTimes(1);
    expect(cb.onStarted).toHaveBeenCalledWith('phase1_only');
    expect(cb.onError).not.toHaveBeenCalled();
    expect(counts()).toEqual(before);

    await jest.advanceTimersByTimeAsync(RIDE_MESH_RETRY_MS * 3);
    expect(startMeshSession).toHaveBeenCalledTimes(2);

    dispose();
    await jest.advanceTimersByTimeAsync(0);
    expect(nativeCalls).toEqual(['start', 'stop', 'start', 'stop']);
  });
});

describe('single Nearby lifecycle owner (source guard)', () => {
  const fs: {
    readFileSync(file: string, encoding: 'utf8'): string;
    readdirSync(
      dir: string,
      options: { withFileTypes: true },
    ): { name: string; isDirectory(): boolean }[];
  } = require('fs');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return sourceFiles(full);
      }
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  test('RideScreen uses the session owner and never the legacy Nearby lifecycle', () => {
    const rideScreen = fs.readFileSync('src/screens/RideScreen.tsx', 'utf8');
    expect(rideScreen).not.toMatch(/createNearbyRideConnectivity/);
    expect(rideScreen.match(/startAppRideMeshSession\(/g)).toHaveLength(1);
  });

  test('only the connectivity composition starts or stops Nearby', () => {
    const allowed = new Set([
      'src/services/rideConnectivityService.ts',
      'src/services/NearbyMeshService.ts',
    ]);
    const files = sourceFiles('src');
    expect(files).toContain('src/screens/RideScreen.tsx');
    const offenders = files
      .filter(file => !allowed.has(file))
      .filter(file =>
        /\b(nearbyTransport|nearbyMeshService)\s*\.\s*(start|stop)\s*\(/.test(
          fs.readFileSync(file, 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
