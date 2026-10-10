import { createPersistentOutbox, type PersistentOutboxStore } from '../src/connectivity/persistentOutbox';
import { createReliableDeliveryEngine, type ReliableDeliveryEvent } from '../src/connectivity/reliableDeliveryEngine';
import { createRideMessage } from '../src/connectivity/protocol/rideMessage';

const NOW = 1_700_000_000_000;

function memoryStore(): PersistentOutboxStore {
  let value: string | null = null;
  return {
    load: async () => value,
    save: async serialized => {
      value = serialized;
    },
  };
}

function message(id = 'message-1') {
  return createRideMessage({
    id,
    rideId: '54321',
    originId: 'node-a',
    type: 'sos',
    priority: 'critical',
    payload: { reason: 'test' },
    ttlMs: 30_000,
    maxHops: 4,
    now: NOW,
  });
}

describe('ReliableDeliveryEngine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('retries a temporary failure and removes the message only after destination evidence', async () => {
    const outcomes = [
      { state: 'retry' as const, reason: 'route_unavailable' },
      { state: 'destination_delivered' as const },
    ];
    const attempt = jest.fn(async () => outcomes.shift()!);
    const events: ReliableDeliveryEvent[] = [];
    const outbox = createPersistentOutbox({ store: memoryStore(), random: () => 0 });
    const engine = createReliableDeliveryEngine({ outbox, attempt, onEvent: event => events.push(event) });
    await engine.start();
    await engine.submit(message());
    await jest.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outbox.size).toBe(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(outbox.size).toBe(0);
    expect(events).toContainEqual({ kind: 'destination_delivered', messageId: 'message-1' });
    engine.stop();
  });

  test('connectivity recovery triggers due work without creating concurrent duplicate attempts', async () => {
    let resolveAttempt: (() => void) | undefined;
    const attempt = jest.fn(
      () => new Promise<{ state: 'retry'; reason: string }>(resolve => {
        resolveAttempt = () => resolve({ state: 'retry', reason: 'offline' });
      }),
    );
    const engine = createReliableDeliveryEngine({
      outbox: createPersistentOutbox({ store: memoryStore(), random: () => 0 }),
      attempt,
    });
    await engine.start();
    await engine.submit(message());
    await jest.advanceTimersByTimeAsync(0);
    engine.connectivityAvailable();
    engine.connectivityAvailable();
    expect(attempt).toHaveBeenCalledTimes(1);
    resolveAttempt?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempt).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  test('recovers persisted work in a new engine after process restart', async () => {
    const store = memoryStore();
    const firstOutbox = createPersistentOutbox({ store, random: () => 0 });
    const first = createReliableDeliveryEngine({
      outbox: firstOutbox,
      attempt: async () => ({ state: 'retry', reason: 'offline' }),
    });
    await first.start();
    await first.submit(message('survives-restart'));
    await jest.advanceTimersByTimeAsync(0);
    first.stop();

    jest.setSystemTime(NOW + 1_000);
    const attempt = jest.fn(async () => ({ state: 'destination_delivered' as const }));
    const events: ReliableDeliveryEvent[] = [];
    const restarted = createReliableDeliveryEngine({
      outbox: createPersistentOutbox({ store, random: () => 0 }),
      attempt,
      onEvent: event => events.push(event),
    });
    await restarted.start();
    expect(events[0]).toEqual({ kind: 'recovered', count: 1, corrupted: false });
    expect(attempt).toHaveBeenCalledTimes(1);
    restarted.stop();
  });

  test('expires stale work without attempting it', async () => {
    const store = memoryStore();
    const seed = createPersistentOutbox({ store });
    await seed.initialize(NOW);
    await seed.enqueue(message('expires'), undefined, NOW);
    jest.setSystemTime(NOW + 30_000);
    const attempt = jest.fn();
    const events: ReliableDeliveryEvent[] = [];
    const engine = createReliableDeliveryEngine({
      outbox: createPersistentOutbox({ store }),
      attempt,
      onEvent: event => events.push(event),
    });
    await engine.start();
    expect(attempt).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: 'expired', messageId: 'expires' });
    engine.stop();
  });
});
