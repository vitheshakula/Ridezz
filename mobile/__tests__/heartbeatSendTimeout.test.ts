import {
  HEARTBEAT_SEND_TIMEOUT_MS,
  createHeartbeatEmitter,
  createHeartbeatScheduler,
  type HeartbeatCycleResult,
  type HeartbeatEmitterOptions,
  type HeartbeatTransport,
} from '../src/connectivity/heartbeatEmitter';
import type { CycleOutcome } from '../src/connectivity/cycleScheduler';
import { PEER_OBSERVATION_DEFAULT_FRESHNESS_MS } from '../src/connectivity/peerTable';
import { HEARTBEAT_INTERVAL_MS } from '../src/connectivity/protocol/heartbeat';
import { createRideMessageIdGenerator } from '../src/connectivity/protocol/rideMessageId';
import { parseRideMessage } from '../src/connectivity/protocol/rideMessageCodec';

const WALL = 1_700_000_000_000;
const TIMEOUT = HEARTBEAT_SEND_TIMEOUT_MS;

interface Controlled {
  transport: HeartbeatTransport;
  broadcast: jest.Mock<Promise<void>, [string]>;
  sent: string[];
  /** Settles the most recent broadcast. */
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** A transport whose broadcasts stay pending until the test settles them (or forever). */
function controlled(id: string): Controlled {
  const sent: string[] = [];
  const self = { sent } as Controlled;
  self.resolve = () => {};
  self.reject = () => {};
  self.broadcast = jest.fn((payload: string) => {
    sent.push(payload);
    return new Promise<void>((resolve, reject) => {
      self.resolve = resolve;
      self.reject = reject;
    });
  });
  self.transport = { id, payload: 'string', broadcast: self.broadcast };
  return self;
}

function healthy(id: string) {
  const broadcast = jest.fn((_payload: string) => Promise.resolve());
  return { broadcast, transport: { id, payload: 'string', broadcast } as HeartbeatTransport };
}

function rejecting(id: string) {
  const broadcast = jest.fn((_payload: string) => Promise.reject(new Error('link down')));
  return { broadcast, transport: { id, payload: 'string', broadcast } as HeartbeatTransport };
}

function emitter(
  getActiveTransports: () => readonly HeartbeatTransport[],
  overrides: Partial<HeartbeatEmitterOptions> = {},
) {
  let n = 0;
  return createHeartbeatEmitter({
    rideId: '12345',
    localNodeId: 'rider-a',
    getActiveTransports,
    generateMessageId: createRideMessageIdGenerator(array => array.fill(++n)),
    wallClock: () => WALL,
    ...overrides,
  });
}

function idOf(payload: string): string {
  return parseRideMessage(payload, WALL)!.id;
}

function timedOut(transportId: string, payload: string) {
  const messageId = idOf(payload);
  return { transportId, ok: false, stage: 'transport', messageId, reason: 'timeout' };
}

/** Tracks when a cycle promise settles under fake time. */
function track(cycle: Promise<HeartbeatCycleResult>) {
  const state: { settled: boolean; result?: HeartbeatCycleResult } = { settled: false };
  cycle.then(result => {
    state.settled = true;
    state.result = result;
  });
  return state;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('heartbeat send timeout: constants', () => {
  test('timeout is 2 s and worst-case period stays below peer freshness', () => {
    expect(HEARTBEAT_SEND_TIMEOUT_MS).toBe(2_000);
    // 2 s bounded cycle + 5 s delay after settlement = 7 s < 15 s freshness.
    expect(HEARTBEAT_SEND_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS).toBeLessThan(
      PEER_OBSERVATION_DEFAULT_FRESHNESS_MS,
    );
  });

  test('rejects an invalid sendTimeoutMs', () => {
    for (const sendTimeoutMs of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => emitter(() => [], { sendTimeoutMs })).toThrow(RangeError);
    }
  });
});

describe('heartbeat send timeout: single cycle', () => {
  test('a hung transport times out at exactly the send timeout', async () => {
    const x = controlled('transport-x');
    const cycle = track(emitter(() => [x.transport]).emitHeartbeatCycle());

    await jest.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(cycle.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(cycle.result).toEqual({
      ok: true,
      transmissions: [
        timedOut('transport-x', x.sent[0]),
      ],
    });
  });

  test('hung X does not block healthy Y, which is sent immediately and succeeds', async () => {
    const x = controlled('transport-x');
    const y = healthy('transport-y');
    const cycle = track(emitter(() => [x.transport, y.transport]).emitHeartbeatCycle());

    // Both send attempts start before any time passes.
    expect(x.broadcast).toHaveBeenCalledTimes(1);
    expect(y.broadcast).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(cycle.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(cycle.result).toEqual({
      ok: true,
      transmissions: [
        timedOut('transport-x', x.sent[0]),
        { transportId: 'transport-y', ok: true, messageId: idOf(y.broadcast.mock.calls[0][0]) },
      ],
    });
  });

  test('hung X, rejecting Y, healthy Z: three independent results', async () => {
    const x = controlled('transport-x');
    const y = rejecting('transport-y');
    const z = healthy('transport-z');
    const all = [x.transport, y.transport, z.transport];
    const cycle = track(emitter(() => all).emitHeartbeatCycle());

    await jest.advanceTimersByTimeAsync(TIMEOUT);

    expect(cycle.result).toEqual({
      ok: true,
      transmissions: [
        timedOut('transport-x', x.sent[0]),
        {
          transportId: 'transport-y',
          ok: false,
          stage: 'transport',
          messageId: idOf(y.broadcast.mock.calls[0][0]),
          reason: 'error',
          error: 'link down',
        },
        { transportId: 'transport-z', ok: true, messageId: idOf(z.broadcast.mock.calls[0][0]) },
      ],
    });
  });

  test('three hung transports time out concurrently within one window, not three', async () => {
    const hung = ['x', 'y', 'z'].map(id => controlled(`transport-${id}`));
    const cycle = track(emitter(() => hung.map(h => h.transport)).emitHeartbeatCycle());

    await jest.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(cycle.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(cycle.result).toEqual({
      ok: true,
      transmissions: hung.map(h => timedOut(h.transport.id, h.sent[0])),
    });
  });

  test('fast sends leave no timeout timers behind', async () => {
    const y = healthy('transport-y');
    await emitter(() => [y.transport]).emitHeartbeatCycle();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('honours a configured sendTimeoutMs', async () => {
    const x = controlled('transport-x');
    const e = emitter(() => [x.transport], { sendTimeoutMs: 500 });
    const cycle = track(e.emitHeartbeatCycle());

    await jest.advanceTimersByTimeAsync(499);
    expect(cycle.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(cycle.settled).toBe(true);
  });
});

describe('heartbeat send timeout: late settlement', () => {
  test('a late success does not change or duplicate the timeout result', async () => {
    const x = controlled('transport-x');
    const outcomes: CycleOutcome<HeartbeatCycleResult>[] = [];
    const scheduler = createHeartbeatScheduler(emitter(() => [x.transport]), {
      onCycleSettled: o => outcomes.push(o),
    });
    scheduler.start();
    await jest.advanceTimersByTimeAsync(TIMEOUT);
    const first = outcomes[0];

    x.resolve(); // the abandoned native send completes later
    await jest.advanceTimersByTimeAsync(1_000);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toBe(first);
    expect(first.ok && first.value.ok && first.value.transmissions[0]).toMatchObject({
      reason: 'timeout',
    });
    expect(x.broadcast).toHaveBeenCalledTimes(1);
    expect(scheduler.running).toBe(true);
    scheduler.stop();
  });

  test('a late rejection is absorbed: no unhandled rejection, no second result', async () => {
    // Jest fails the running test if an unhandled rejection surfaces during a real macrotask turn
    // (verified with a deliberate unhandled control), so passing proves it was handled.
    const x = controlled('transport-x');
    const outcomes: CycleOutcome<HeartbeatCycleResult>[] = [];
    const scheduler = createHeartbeatScheduler(emitter(() => [x.transport]), {
      onCycleSettled: o => outcomes.push(o),
    });
    scheduler.start();
    await jest.advanceTimersByTimeAsync(TIMEOUT);

    x.reject(new Error('native send failed after timeout'));
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    // The scheduler carried on: cycle 2 started at 2 s + 5 s with a new heartbeat.
    expect(x.broadcast).toHaveBeenCalledTimes(2);
    expect(idOf(x.sent[1])).not.toBe(idOf(x.sent[0]));
    expect(outcomes).toHaveLength(1);
    scheduler.stop();

    jest.useRealTimers();
    for (let i = 0; i < 3; i++) {
      await new Promise<void>(resolve => setImmediate(() => resolve()));
    }
  });
});

describe('heartbeat send timeout: scheduler recovery', () => {
  test('a permanently hung transport cannot stop heartbeat scheduling', async () => {
    const x = controlled('transport-x');
    const outcomes: CycleOutcome<HeartbeatCycleResult>[] = [];
    const scheduler = createHeartbeatScheduler(emitter(() => [x.transport]), {
      onCycleSettled: o => outcomes.push(o),
    });

    scheduler.start();
    expect(x.broadcast).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(TIMEOUT); // t = 2 s: cycle 1 settles (timeout)
    expect(outcomes).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 1); // t = 6.999 s
    expect(x.broadcast).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); // t = 7 s: cycle 2 starts
    expect(x.broadcast).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(TIMEOUT + HEARTBEAT_INTERVAL_MS); // t = 14 s: cycle 3
    expect(x.broadcast).toHaveBeenCalledTimes(3);
    expect(new Set(x.sent.map(idOf)).size).toBe(3); // a new id every cycle, never a retry
    for (const outcome of outcomes) {
      expect(outcome.ok && outcome.value.ok && outcome.value.transmissions[0]).toMatchObject({
        reason: 'timeout',
      });
    }
    scheduler.stop();
  });

  test('stop during in-flight sends lets the cycle settle and schedules nothing more', async () => {
    const x = controlled('transport-x');
    const outcomes: CycleOutcome<HeartbeatCycleResult>[] = [];
    const scheduler = createHeartbeatScheduler(emitter(() => [x.transport]), {
      onCycleSettled: o => outcomes.push(o),
    });
    scheduler.start();

    scheduler.stop();
    await jest.advanceTimersByTimeAsync(TIMEOUT);
    expect(outcomes).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(10 * HEARTBEAT_INTERVAL_MS);
    expect(x.broadcast).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
