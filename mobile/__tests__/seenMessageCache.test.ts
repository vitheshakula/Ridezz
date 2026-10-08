import {
  SEEN_MESSAGE_CACHE_DEFAULT_CAPACITY,
  SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS,
  createSeenMessageCache,
  type SeenMessageClaimResult,
} from '../src/connectivity/protocol/seenMessageCache';
import {
  encodeRideMessage,
  parseRideMessage,
  serializeRideMessage,
} from '../src/connectivity/protocol/rideMessageCodec';
import {
  RIDE_MESSAGE_MAX_ID_LENGTH,
  createRideMessage,
  relayRideMessage,
} from '../src/connectivity/protocol/rideMessage';

const NOW = 1_700_000_000_000;
const TTL = 30_000;
const EXPIRES = NOW + TTL;

describe('SeenMessageCache: claims', () => {
  test('first claim is accepted and recorded', () => {
    const cache = createSeenMessageCache();

    expect(cache.claim('m1', EXPIRES, NOW)).toBe('accepted');
    expect(cache.size).toBe(1);
  });

  test('second claim of the same id is a duplicate and records nothing new', () => {
    const cache = createSeenMessageCache();
    cache.claim('m1', EXPIRES, NOW);

    expect(cache.claim('m1', EXPIRES, NOW + 5)).toBe('duplicate');
    expect(cache.claim('m1', EXPIRES, NOW + 10)).toBe('duplicate');
    expect(cache.size).toBe(1);
  });

  test('tracks multiple ids independently', () => {
    const cache = createSeenMessageCache();

    expect(cache.claim('m1', EXPIRES, NOW)).toBe('accepted');
    expect(cache.claim('m2', EXPIRES + 10, NOW)).toBe('accepted');
    expect(cache.claim('m1', EXPIRES, NOW)).toBe('duplicate');
    expect(cache.claim('m3', EXPIRES, NOW)).toBe('accepted');
    expect(cache.claim('m2', EXPIRES + 10, NOW)).toBe('duplicate');
    expect(cache.size).toBe(3);
  });

  test('separate nodes keep separate caches', () => {
    // A sends M1; B and C each accept it; B then hears M1 again via C.
    const b = createSeenMessageCache();
    const c = createSeenMessageCache();

    expect(b.claim('M1', EXPIRES, NOW)).toBe('accepted');
    expect(c.claim('M1', EXPIRES, NOW + 3)).toBe('accepted');
    expect(b.claim('M1', EXPIRES, NOW + 7)).toBe('duplicate');
  });
});

describe('SeenMessageCache: path and transport independence', () => {
  const original = createRideMessage({
    id: 'sos-from-a',
    rideId: '12345',
    originId: 'node-a',
    type: 'sos',
    priority: 'critical',
    payload: {},
    ttlMs: TTL,
    maxHops: 4,
    now: NOW,
  });

  test('D accepts a message via A→B→D once and rejects the copy via A→C→D', () => {
    // Topology: A reaches D over two paths, A→B→D and A→C→D. Each relay produces a copy with a
    // different hopCount, carried over whatever transport each link happens to use. D must
    // process exactly one copy: dedup keys on the message id, never on path or transport.
    const viaB = relayRideMessage(relayRideMessage(original, NOW + 100)!, NOW + 200)!;
    const viaC = relayRideMessage(relayRideMessage(original, NOW + 150)!, NOW + 400)!;
    expect(viaB.hopCount).toBe(2);
    expect(viaC.hopCount).toBe(2);

    // e.g. B→D over a byte transport, C→D over a string transport.
    const atDFromB = parseRideMessage(encodeRideMessage(viaB), NOW + 250)!;
    const atDFromC = parseRideMessage(serializeRideMessage(viaC), NOW + 450)!;
    const d = createSeenMessageCache();

    expect(d.claim(atDFromB.id, atDFromB.expiresAt, NOW + 250)).toBe('accepted');
    expect(d.claim(atDFromC.id, atDFromC.expiresAt, NOW + 450)).toBe('duplicate');
  });

  test('a copy with a different hop count is still a duplicate', () => {
    const relayed = relayRideMessage(original, NOW)!;
    const cache = createSeenMessageCache();

    expect(cache.claim(original.id, original.expiresAt, NOW)).toBe('accepted');
    expect(cache.claim(relayed.id, relayed.expiresAt, NOW + 1)).toBe('duplicate');
  });
});

describe('SeenMessageCache: expiry', () => {
  test('entry is live one ms before expiresAt', () => {
    const cache = createSeenMessageCache();
    cache.claim('m1', EXPIRES, NOW);

    expect(cache.claim('m1', EXPIRES + 1_000, EXPIRES - 1)).toBe('duplicate');
  });

  test('entry is gone exactly at expiresAt and the id can be claimed again', () => {
    const cache = createSeenMessageCache();
    cache.claim('m1', EXPIRES, NOW);

    cache.prune(EXPIRES);
    expect(cache.size).toBe(0);
    // Only a copy that is itself still live can re-enter.
    expect(cache.claim('m1', EXPIRES + 1_000, EXPIRES)).toBe('accepted');
  });

  test('a claim at exactly expiresAt is expired and creates no entry', () => {
    const cache = createSeenMessageCache();

    expect(cache.claim('m1', EXPIRES, EXPIRES)).toBe('expired');
    expect(cache.claim('m1', EXPIRES, EXPIRES + 1)).toBe('expired');
    expect(cache.size).toBe(0);
  });

  test('an expired copy of a recorded id is reported expired, not duplicate', () => {
    const cache = createSeenMessageCache();
    cache.claim('m1', EXPIRES, NOW);

    expect(cache.claim('m1', NOW + 10, NOW + 10)).toBe('expired');
    expect(cache.claim('m1', EXPIRES, NOW + 10)).toBe('duplicate');
  });

  test('a duplicate with a later expiry does not extend the original entry', () => {
    const cache = createSeenMessageCache();

    expect(cache.claim('M1', EXPIRES, NOW)).toBe('accepted');
    expect(cache.claim('M1', EXPIRES + 10_000, NOW + 1)).toBe('duplicate');

    // Stored lifetime is still EXPIRES: live one ms before it, gone exactly at it.
    cache.prune(EXPIRES - 1);
    expect(cache.size).toBe(1);
    cache.prune(EXPIRES);
    expect(cache.size).toBe(0);
    expect(cache.claim('M1', EXPIRES + 10_000, EXPIRES)).toBe('accepted');
  });

  test('a duplicate with a shorter expiry does not shorten the original entry', () => {
    const cache = createSeenMessageCache();

    expect(cache.claim('M1', EXPIRES, NOW)).toBe('accepted');
    expect(cache.claim('M1', NOW + 500, NOW + 1)).toBe('duplicate');

    cache.prune(NOW + 500);
    expect(cache.size).toBe(1);
    expect(cache.claim('M1', EXPIRES, EXPIRES - 1)).toBe('duplicate');
    expect(cache.claim('M1', EXPIRES + 1_000, EXPIRES)).toBe('accepted');
  });

  test('claims clean up expired entries as a side effect', () => {
    const cache = createSeenMessageCache();
    cache.claim('short', NOW + 10, NOW);
    cache.claim('long', NOW + 1_000, NOW);

    cache.claim('new', NOW + 2_000, NOW + 10);

    expect(cache.size).toBe(2);
    expect(cache.claim('long', NOW + 1_000, NOW + 10)).toBe('duplicate');
  });

  test('prune removes only expired entries', () => {
    const cache = createSeenMessageCache();
    cache.claim('a', NOW + 10, NOW);
    cache.claim('b', NOW + 20, NOW);
    cache.claim('c', NOW + 30, NOW);

    cache.prune(NOW + 9);
    expect(cache.size).toBe(3);
    cache.prune(NOW + 20);
    expect(cache.size).toBe(1);
    expect(cache.claim('c', NOW + 30, NOW + 20)).toBe('duplicate');
    expect(cache.claim('a', NOW + 40, NOW + 20)).toBe('accepted');
  });

  test('repeated cleanup is stable', () => {
    const cache = createSeenMessageCache();
    cache.claim('a', NOW + 10, NOW);
    cache.claim('b', NOW + 20, NOW);

    for (let i = 0; i < 5; i++) {
      cache.prune(NOW + 15);
      expect(cache.size).toBe(1);
    }
    cache.prune(NOW + 5); // clock stepping backwards neither restores nor removes entries
    expect(cache.size).toBe(1);
    expect(cache.claim('b', NOW + 20, NOW + 15)).toBe('duplicate');
    for (let i = 0; i < 3; i++) {
      cache.prune(NOW + 20);
      expect(cache.size).toBe(0);
    }
  });

  test('accepts expiresAt exactly at the protocol horizon and rejects 1 ms beyond', () => {
    const cache = createSeenMessageCache();

    expect(cache.claim('edge', NOW + SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS, NOW)).toBe('accepted');
    expect(cache.claim('beyond', NOW + SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS + 1, NOW)).toBe(
      'invalid',
    );
    expect(cache.size).toBe(1);
  });
});

describe('SeenMessageCache: capacity and eviction', () => {
  test('rejects invalid capacity', () => {
    for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => createSeenMessageCache(capacity)).toThrow(RangeError);
    }
    expect(createSeenMessageCache().size).toBe(0);
    expect(SEEN_MESSAGE_CACHE_DEFAULT_CAPACITY).toBe(2048);
  });

  test('size never exceeds capacity under a flood of unique live ids', () => {
    const cache = createSeenMessageCache(100);
    for (let i = 0; i < 10_000; i++) {
      expect(cache.claim(`flood-${i}`, NOW + SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS, NOW + i)).toBe(
        'accepted',
      );
      expect(cache.size).toBeLessThanOrEqual(100);
    }
    expect(cache.size).toBe(100);
  });

  test('evicts the earliest claim when full of live entries', () => {
    const cache = createSeenMessageCache(3);
    cache.claim('a', EXPIRES, NOW);
    cache.claim('b', EXPIRES, NOW + 1);
    cache.claim('c', EXPIRES, NOW + 2);

    expect(cache.claim('d', EXPIRES, NOW + 3)).toBe('accepted');
    expect(cache.size).toBe(3);
    expect(cache.claim('b', EXPIRES, NOW + 4)).toBe('duplicate');
    expect(cache.claim('c', EXPIRES, NOW + 4)).toBe('duplicate');
    expect(cache.claim('d', EXPIRES, NOW + 4)).toBe('duplicate');
    // 'a' lost its protection, so it is accepted again (evicting 'b', the next earliest).
    expect(cache.claim('a', EXPIRES, NOW + 4)).toBe('accepted');
    expect(cache.claim('b', EXPIRES, NOW + 5)).toBe('accepted');
  });

  test('eviction order follows first claim, not remaining lifetime', () => {
    const cache = createSeenMessageCache(2);
    cache.claim('long-lived', NOW + SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS, NOW);
    cache.claim('short-lived', NOW + 100, NOW);

    cache.claim('new', NOW + 100, NOW + 1);

    expect(cache.claim('short-lived', NOW + 100, NOW + 2)).toBe('duplicate');
    expect(cache.claim('new', NOW + 100, NOW + 2)).toBe('duplicate');
    expect(cache.claim('long-lived', NOW + SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS, NOW + 2)).toBe(
      'accepted',
    );
  });

  test('a burst of maximum-TTL ids cannot pin out later short-lived claims', () => {
    const cache = createSeenMessageCache(10);
    for (let i = 0; i < 10; i++) {
      cache.claim(`burst-${i}`, NOW + SEEN_MESSAGE_MAX_EXPIRY_HORIZON_MS, NOW);
    }
    for (let i = 0; i < 5; i++) {
      cache.claim(`legit-${i}`, NOW + 1_000 + TTL, NOW + 1_000);
    }
    for (let i = 0; i < 5; i++) {
      expect(cache.claim(`legit-${i}`, NOW + 1_000 + TTL, NOW + 1_001)).toBe('duplicate');
    }
  });

  test('a duplicate does not refresh its eviction position', () => {
    const cache = createSeenMessageCache(2);
    cache.claim('a', EXPIRES, NOW);
    cache.claim('b', EXPIRES, NOW);
    cache.claim('a', EXPIRES, NOW + 1);

    cache.claim('c', EXPIRES, NOW + 2);

    expect(cache.claim('b', EXPIRES, NOW + 3)).toBe('duplicate');
    expect(cache.claim('a', EXPIRES, NOW + 3)).toBe('accepted');
  });

  test('duplicates carrying a different expiry do not change eviction order', () => {
    const cache = createSeenMessageCache(2);
    cache.claim('a', EXPIRES, NOW);
    cache.claim('b', EXPIRES, NOW);
    expect(cache.claim('a', EXPIRES + 10_000, NOW + 1)).toBe('duplicate');
    expect(cache.claim('a', NOW + 100, NOW + 1)).toBe('duplicate');

    cache.claim('c', EXPIRES, NOW + 2); // evicts 'a', still the earliest claim

    expect(cache.size).toBe(2);
    expect(cache.claim('b', EXPIRES, NOW + 3)).toBe('duplicate');
    expect(cache.claim('c', EXPIRES, NOW + 3)).toBe('duplicate');
    expect(cache.claim('a', EXPIRES, NOW + 3)).toBe('accepted');
  });

  test('expired entries are removed before any live entry is evicted', () => {
    const cache = createSeenMessageCache(2);
    cache.claim('first-but-long', NOW + 1_000, NOW);
    cache.claim('second-but-short', NOW + 10, NOW);

    expect(cache.claim('third', NOW + 1_000, NOW + 10)).toBe('accepted');
    expect(cache.size).toBe(2);
    expect(cache.claim('first-but-long', NOW + 1_000, NOW + 11)).toBe('duplicate');
  });

  test('remains correct when eviction removed the earliest-expiring entry', () => {
    const cache = createSeenMessageCache(1);
    cache.claim('a', NOW + 10, NOW);
    cache.claim('b', NOW + 1_000, NOW); // evicts 'a', the earliest expiry

    expect(cache.claim('b', NOW + 1_000, NOW + 20)).toBe('duplicate');
    expect(cache.size).toBe(1);
    expect(cache.claim('b', NOW + 1_000, NOW + 999)).toBe('duplicate');
    expect(cache.claim('b', NOW + 2_000, NOW + 1_000)).toBe('accepted');
  });

  test('identical claim sequences produce identical results', () => {
    const run = (): SeenMessageClaimResult[] => {
      const cache = createSeenMessageCache(4);
      const results: SeenMessageClaimResult[] = [];
      for (let i = 0; i < 50; i++) {
        const id = `m${(i * 7) % 11}`;
        results.push(cache.claim(id, NOW + 100 + ((i * 13) % 17), NOW + i * 3));
      }
      return results;
    };
    expect(run()).toEqual(run());
  });
});

describe('SeenMessageCache: invalid input', () => {
  test.each<unknown>(['', 'x'.repeat(RIDE_MESSAGE_MAX_ID_LENGTH + 1), 42, null, undefined, {}])(
    'rejects message id %p without recording it',
    id => {
      const cache = createSeenMessageCache();
      expect(cache.claim(id as string, EXPIRES, NOW)).toBe('invalid');
      expect(cache.size).toBe(0);
    },
  );

  test('accepts an id of exactly the maximum length', () => {
    expect(
      createSeenMessageCache().claim('x'.repeat(RIDE_MESSAGE_MAX_ID_LENGTH), EXPIRES, NOW),
    ).toBe('accepted');
  });

  test.each<unknown>([NaN, Infinity, -Infinity, -1, 1.5, '1700000030000', null, 2 ** 53])(
    'rejects expiresAt %p, so no immortal entry can be created',
    expiresAt => {
      const cache = createSeenMessageCache();
      expect(cache.claim('m1', expiresAt as number, NOW)).toBe('invalid');
      expect(cache.size).toBe(0);
    },
  );

  test.each<unknown>([NaN, Infinity, -Infinity, -1, 1.5, String(NOW), null])(
    'rejects now %p without recording or pruning',
    now => {
      const cache = createSeenMessageCache();
      cache.claim('kept', NOW + 10, NOW);

      expect(cache.claim('m1', EXPIRES, now as number)).toBe('invalid');
      cache.prune(now as number);
      expect(cache.size).toBe(1);
    },
  );

  test('invalid input never throws', () => {
    const cache = createSeenMessageCache();
    expect(() => cache.claim(undefined as never, undefined as never, undefined as never)).not
      .toThrow();
    expect(() => cache.prune(undefined as never)).not.toThrow();
  });
});

describe('SeenMessageCache: no background work', () => {
  test('never schedules timers', () => {
    const spies = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      const cache = createSeenMessageCache(2);
      cache.claim('a', NOW + 10, NOW);
      cache.claim('b', NOW + 20, NOW);
      cache.claim('c', NOW + 30, NOW + 1);
      cache.claim('a', NOW + 40, NOW + 15);
      cache.prune(NOW + 100);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });

  test('nothing changes between operations as time passes', () => {
    const cache = createSeenMessageCache();
    cache.claim('a', NOW + 10, NOW);
    // Without an operation at a later `now`, the expired entry is still held.
    expect(cache.size).toBe(1);
    cache.prune(NOW + 10);
    expect(cache.size).toBe(0);
  });
});
