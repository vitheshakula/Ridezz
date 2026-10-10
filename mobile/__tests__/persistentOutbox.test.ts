import {
  createPersistentOutbox,
  type PersistentOutboxStore,
} from '../src/connectivity/persistentOutbox';
import { createRideMessage } from '../src/connectivity/protocol/rideMessage';

const NOW = 1_700_000_000_000;

function message(
  id: string,
  priority: 'critical' | 'high' | 'normal' | 'low' = 'normal',
  ttlMs = 30_000,
) {
  return createRideMessage({
    id,
    rideId: '54321',
    originId: 'node-a',
    type: 'sos',
    priority,
    payload: { reason: 'test' },
    ttlMs,
    maxHops: 4,
    now: NOW,
  });
}

function memoryStore(initial: string | null = null): PersistentOutboxStore & { value: () => string | null } {
  let value = initial;
  return {
    load: jest.fn(async () => value),
    save: jest.fn(async serialized => {
      value = serialized;
    }),
    value: () => value,
  };
}

describe('PersistentOutbox', () => {
  test('recovers queued messages after a new engine instance initializes', async () => {
    const store = memoryStore();
    const first = createPersistentOutbox({ store, random: () => 0 });
    await first.initialize(NOW);
    await first.enqueue(message('message-1'), undefined, NOW);
    await first.recordAttempt('message-1', NOW);

    const restarted = createPersistentOutbox({ store, random: () => 0 });
    await expect(restarted.initialize(NOW + 1)).resolves.toEqual({ recovered: 1, corrupted: false });
    expect(restarted.size).toBe(1);
    expect(restarted.due(NOW + 999)).toEqual([]);
    expect(restarted.due(NOW + 1_000)[0]).toMatchObject({
      message: { id: 'message-1' },
      attempts: 1,
    });
  });

  test('preserves message IDs and suppresses duplicate enqueue', async () => {
    const outbox = createPersistentOutbox({ store: memoryStore() });
    await outbox.initialize(NOW);
    expect(await outbox.enqueue(message('same-id'), 'gateway-1', NOW)).toEqual({ accepted: true });
    expect(await outbox.enqueue(message('same-id'), 'gateway-1', NOW)).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    expect(outbox.due(NOW)[0]).toMatchObject({
      message: { id: 'same-id' },
      destinationGatewayId: 'gateway-1',
    });
  });

  test('orders due work by priority before creation order', async () => {
    const outbox = createPersistentOutbox({ store: memoryStore() });
    await outbox.initialize(NOW);
    await outbox.enqueue(message('low', 'low'), undefined, NOW);
    await outbox.enqueue(message('critical', 'critical'), undefined, NOW);
    await outbox.enqueue(message('high', 'high'), undefined, NOW);
    expect(outbox.due(NOW).map(record => record.message.id)).toEqual(['critical', 'high', 'low']);
  });

  test('uses bounded exponential backoff with jitter and stops at retry exhaustion', async () => {
    const outbox = createPersistentOutbox({
      store: memoryStore(),
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      random: () => 0.5,
    });
    await outbox.initialize(NOW);
    await outbox.enqueue(message('retry'), undefined, NOW);
    await expect(outbox.recordAttempt('retry', NOW)).resolves.toEqual({
      state: 'scheduled',
      attempts: 1,
      nextAttemptAt: NOW + 1_100,
    });
    await expect(outbox.recordAttempt('retry', NOW + 1_100)).resolves.toEqual({
      state: 'scheduled',
      attempts: 2,
      nextAttemptAt: NOW + 3_300,
    });
    await expect(outbox.recordAttempt('retry', NOW + 3_300)).resolves.toEqual({
      state: 'exhausted',
      attempts: 3,
    });
    expect(outbox.size).toBe(0);
  });

  test('rejects overflow and never enqueues an already expired message', async () => {
    const outbox = createPersistentOutbox({ store: memoryStore(), capacity: 1 });
    await outbox.initialize(NOW);
    expect(await outbox.enqueue(message('first'), undefined, NOW)).toEqual({ accepted: true });
    expect(await outbox.enqueue(message('overflow'), undefined, NOW)).toEqual({
      accepted: false,
      reason: 'queue_full',
    });
    await outbox.remove('first');
    expect(await outbox.enqueue(message('expired', 'normal', 1), undefined, NOW + 1)).toEqual({
      accepted: false,
      reason: 'expired',
    });
  });

  test('removes acknowledged and expired records', async () => {
    const outbox = createPersistentOutbox({ store: memoryStore() });
    await outbox.initialize(NOW);
    await outbox.enqueue(message('acknowledged'), undefined, NOW);
    await outbox.enqueue(message('expires', 'normal', 10), undefined, NOW);
    expect(await outbox.acknowledge('acknowledged')).toBe(true);
    await expect(outbox.expire(NOW + 10)).resolves.toEqual(['expires']);
    expect(outbox.size).toBe(0);
  });

  test('salvages valid records and rewrites corrupted persisted state', async () => {
    const goodStore = memoryStore();
    const seed = createPersistentOutbox({ store: goodStore });
    await seed.initialize(NOW);
    await seed.enqueue(message('valid'), undefined, NOW);
    const serialized = JSON.parse(goodStore.value()!) as unknown[];
    const store = memoryStore(JSON.stringify([...serialized, { broken: true }]));
    const recovered = createPersistentOutbox({ store });

    await expect(recovered.initialize(NOW)).resolves.toEqual({ recovered: 1, corrupted: true });
    expect(recovered.due(NOW).map(record => record.message.id)).toEqual(['valid']);
    expect(JSON.parse(store.value()!)).toHaveLength(1);
  });
});
