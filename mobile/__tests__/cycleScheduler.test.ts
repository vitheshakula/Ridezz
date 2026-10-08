import { createCycleScheduler, type CycleOutcome } from '../src/connectivity/cycleScheduler';
import {
  createHeartbeatEmitter,
  createHeartbeatScheduler,
  type HeartbeatCycleResult,
  type HeartbeatTransport,
} from '../src/connectivity/heartbeatEmitter';
import { HEARTBEAT_INTERVAL_MS } from '../src/connectivity/protocol/heartbeat';
import { createRideMessageIdGenerator } from '../src/connectivity/protocol/rideMessageId';

const INTERVAL = 5_000;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A cycle that settles immediately, counting invocations. */
function instantCycle() {
  return jest.fn(() => Promise.resolve('done'));
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('cycle scheduler: timing', () => {
  test('start runs the first cycle immediately', () => {
    const runCycle = instantCycle();
    const scheduler = createCycleScheduler({ runCycle, intervalMs: INTERVAL });

    scheduler.start();

    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(scheduler.running).toBe(true);
    scheduler.stop();
  });

  test('the next cycle runs intervalMs after the previous one settles', async () => {
    const runCycle = instantCycle();
    const scheduler = createCycleScheduler({ runCycle, intervalMs: INTERVAL });
    scheduler.start();

    await jest.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(runCycle).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(runCycle).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(runCycle).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  test('start twice does not create a second loop', async () => {
    const runCycle = instantCycle();
    const scheduler = createCycleScheduler({ runCycle, intervalMs: INTERVAL });

    scheduler.start();
    scheduler.start();
    await jest.advanceTimersByTimeAsync(3 * INTERVAL);

    expect(runCycle).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(1);
    scheduler.stop();
  });

  test('rejects an invalid interval', () => {
    for (const intervalMs of [0, -1, 1.5, NaN]) {
      expect(() => createCycleScheduler({ runCycle: instantCycle(), intervalMs })).toThrow(
        RangeError,
      );
    }
  });
});

describe('cycle scheduler: stop', () => {
  test('stop prevents future cycles and leaves no timers', async () => {
    const runCycle = instantCycle();
    const scheduler = createCycleScheduler({ runCycle, intervalMs: INTERVAL });
    scheduler.start();
    await jest.advanceTimersByTimeAsync(0);

    scheduler.stop();
    await jest.advanceTimersByTimeAsync(10 * INTERVAL);

    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(scheduler.running).toBe(false);
  });

  test('stop is safe to call repeatedly, and before start', () => {
    const scheduler = createCycleScheduler({ runCycle: instantCycle(), intervalMs: INTERVAL });
    expect(() => {
      scheduler.stop();
      scheduler.start();
      scheduler.stop();
      scheduler.stop();
    }).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('stop during an in-flight cycle lets it settle but schedules nothing after', async () => {
    const pending = deferred<string>();
    const runCycle = jest.fn(() => pending.promise);
    const settled = jest.fn();
    const scheduler = createCycleScheduler({
      runCycle,
      intervalMs: INTERVAL,
      onCycleSettled: settled,
    });
    scheduler.start();

    scheduler.stop();
    pending.resolve('late');
    await jest.advanceTimersByTimeAsync(10 * INTERVAL);

    expect(settled).toHaveBeenCalledWith({ ok: true, value: 'late' });
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('stop then start while a cycle is in flight never overlaps it', async () => {
    const pending = deferred<string>();
    let calls = 0;
    const runCycle = jest.fn(() => (++calls === 1 ? pending.promise : Promise.resolve('next')));
    const scheduler = createCycleScheduler({ runCycle, intervalMs: INTERVAL });
    scheduler.start();
    scheduler.stop();

    scheduler.start();
    expect(runCycle).toHaveBeenCalledTimes(1);

    pending.resolve('first');
    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(runCycle).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});

describe('cycle scheduler: non-overlap', () => {
  test('a slow cycle delays the next and never queues overlapping cycles', async () => {
    const slow = deferred<string>();
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const runCycle = jest.fn(async (): Promise<string> => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        return ++calls === 1 ? await slow.promise : 'fast';
      } finally {
        concurrent--;
      }
    });
    const scheduler = createCycleScheduler({ runCycle, intervalMs: INTERVAL });
    scheduler.start();

    await jest.advanceTimersByTimeAsync(6 * INTERVAL);
    expect(runCycle).toHaveBeenCalledTimes(1);

    slow.resolve('slow');
    await jest.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(runCycle).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(runCycle).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
    scheduler.stop();
  });
});

describe('cycle scheduler: resilience', () => {
  test('a rejected cycle is reported and the loop continues', async () => {
    const outcomes: CycleOutcome<string>[] = [];
    const runCycle = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('cycle failed'))
      .mockResolvedValue('ok');
    const scheduler = createCycleScheduler({
      runCycle,
      intervalMs: INTERVAL,
      onCycleSettled: o => outcomes.push(o),
    });
    scheduler.start();

    await jest.advanceTimersByTimeAsync(INTERVAL);

    expect(outcomes).toEqual([
      { ok: false, error: new Error('cycle failed') },
      { ok: true, value: 'ok' },
    ]);
    scheduler.stop();
  });

  test('a synchronously throwing cycle and a throwing observer do not break the loop', async () => {
    let first = true;
    const runCycle = jest.fn(() => {
      if (first) {
        first = false;
        throw new Error('sync');
      }
      return Promise.resolve('ok');
    });
    const scheduler = createCycleScheduler({
      runCycle,
      intervalMs: INTERVAL,
      onCycleSettled: () => {
        throw new Error('observer bug');
      },
    });
    scheduler.start();

    await jest.advanceTimersByTimeAsync(2 * INTERVAL);

    expect(runCycle).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
});

describe('heartbeat scheduler', () => {
  function bytesSource() {
    let n = 0;
    return (array: Uint8Array) => array.fill(++n);
  }

  test('uses HEARTBEAT_INTERVAL_MS and picks up transport changes between cycles', async () => {
    const sentOn: string[] = [];
    const transport = (id: string): HeartbeatTransport => ({
      id,
      payload: 'string',
      broadcast: async () => {
        sentOn.push(id);
      },
    });
    let active = [transport('transport-x')];
    const results: HeartbeatCycleResult[] = [];
    const emitter = createHeartbeatEmitter({
      rideId: '12345',
      localNodeId: 'rider-a',
      getActiveTransports: () => active,
      generateMessageId: createRideMessageIdGenerator(bytesSource()),
      wallClock: () => 1_700_000_000_000,
    });
    const scheduler = createHeartbeatScheduler(emitter, {
      onCycleSettled: o => o.ok && results.push(o.value),
    });

    scheduler.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(sentOn).toEqual(['transport-x']);

    active = [transport('transport-y')];
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 1);
    expect(sentOn).toEqual(['transport-x']);
    await jest.advanceTimersByTimeAsync(1);
    expect(sentOn).toEqual(['transport-x', 'transport-y']);

    active = [];
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(sentOn).toHaveLength(2);
    expect(results.map(r => r.ok && r.transmissions.length)).toEqual([1, 1, 0]);

    scheduler.stop();
    expect(jest.getTimerCount()).toBe(0);
  });
});
