import {
  RIDE_MESSAGE_MAX_HOP_LIMIT,
  RIDE_MESSAGE_MAX_ID_LENGTH,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  RIDE_MESSAGE_MAX_RIDE_ID_LENGTH,
  RIDE_MESSAGE_MAX_TTL_MS,
  RIDE_MESSAGE_PRIORITIES,
  RIDE_MESSAGE_TYPES,
  RIDE_PROTOCOL_VERSION,
  canRelayRideMessage,
  createRideMessage,
  isRideMessageExpired,
  relayRideMessage,
  type CreateRideMessageInput,
  type RideMessage,
} from '../src/connectivity/protocol/rideMessage';

const NOW = 1_700_000_000_000;
const TTL = 30_000;

interface HazardPayload {
  hazard: string;
}

function input(
  overrides: Partial<CreateRideMessageInput<HazardPayload, 'hazard'>> = {},
): CreateRideMessageInput<HazardPayload, 'hazard'> {
  return {
    id: 'msg-1',
    rideId: 'ride-1',
    originId: 'node-a',
    type: 'hazard',
    priority: 'high',
    payload: { hazard: 'pothole' },
    ttlMs: TTL,
    maxHops: 3,
    now: NOW,
    ...overrides,
  };
}

function withHops(hopCount: number, maxHops: number): RideMessage<HazardPayload, 'hazard'> {
  return { ...createRideMessage(input({ maxHops })), hopCount };
}

describe('RideMessage creation', () => {
  test('creates the exact origin envelope', () => {
    expect(createRideMessage(input())).toEqual({
      v: 1,
      id: 'msg-1',
      rideId: 'ride-1',
      originId: 'node-a',
      type: 'hazard',
      priority: 'high',
      createdAt: NOW,
      expiresAt: NOW + TTL,
      hopCount: 0,
      maxHops: 3,
      payload: { hazard: 'pothole' },
    });
    expect(RIDE_PROTOCOL_VERSION).toBe(1);
  });

  test('declares the initial message types and priorities', () => {
    expect(RIDE_MESSAGE_TYPES).toEqual([
      'hazard',
      'sos',
      'ack',
      'heartbeat',
      'gateway_advertisement',
      'location',
      'ride_state',
    ]);
    expect(RIDE_MESSAGE_PRIORITIES).toEqual(['critical', 'high', 'normal', 'low']);
  });

  test('accepts every message type and priority', () => {
    for (const type of RIDE_MESSAGE_TYPES) {
      for (const priority of RIDE_MESSAGE_PRIORITIES) {
        const message = createRideMessage({ ...input(), type, priority });
        expect(message.type).toBe(type);
        expect(message.priority).toBe(priority);
      }
    }
  });

  test.each(['id', 'rideId', 'originId'] as const)('rejects an empty %s', field => {
    expect(() => createRideMessage(input({ [field]: '' }))).toThrow(TypeError);
  });

  test.each([
    ['id', RIDE_MESSAGE_MAX_ID_LENGTH],
    ['rideId', RIDE_MESSAGE_MAX_RIDE_ID_LENGTH],
    ['originId', RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH],
  ] as const)('bounds %s at %i characters', (field, max) => {
    expect(createRideMessage(input({ [field]: 'x'.repeat(max) }))[field]).toHaveLength(max);
    expect(() => createRideMessage(input({ [field]: 'x'.repeat(max + 1) }))).toThrow(TypeError);
  });

  test.each([-1, 1.5, NaN, Infinity])('rejects invalid now %p', now => {
    expect(() => createRideMessage(input({ now }))).toThrow(RangeError);
  });
});

describe('RideMessage TTL', () => {
  test('is alive one ms before expiresAt and expired exactly at it', () => {
    const message = createRideMessage(input());

    expect(isRideMessageExpired(message, NOW)).toBe(false);
    expect(isRideMessageExpired(message, NOW + TTL - 1)).toBe(false);
    expect(isRideMessageExpired(message, NOW + TTL)).toBe(true);
    expect(isRideMessageExpired(message, NOW + TTL + 1)).toBe(true);
  });

  test('accepts the TTL bounds', () => {
    expect(createRideMessage(input({ ttlMs: 1 })).expiresAt).toBe(NOW + 1);
    expect(createRideMessage(input({ ttlMs: RIDE_MESSAGE_MAX_TTL_MS })).expiresAt).toBe(
      NOW + RIDE_MESSAGE_MAX_TTL_MS,
    );
  });

  test.each([0, -1, 1.5, NaN, Infinity, -Infinity, RIDE_MESSAGE_MAX_TTL_MS + 1])(
    'rejects invalid ttlMs %p',
    ttlMs => {
      expect(() => createRideMessage(input({ ttlMs }))).toThrow(RangeError);
    },
  );

  test('cannot relay an expired message even with hop budget left', () => {
    const message = createRideMessage(input({ maxHops: 5 }));

    expect(canRelayRideMessage(message, NOW + TTL - 1)).toBe(true);
    expect(canRelayRideMessage(message, NOW + TTL)).toBe(false);
    expect(relayRideMessage(message, NOW + TTL)).toBeNull();
  });
});

describe('RideMessage hop limit', () => {
  test('relays while hopCount < maxHops and stops at the limit', () => {
    expect(canRelayRideMessage(withHops(2, 3), NOW)).toBe(true);
    expect(canRelayRideMessage(withHops(3, 3), NOW)).toBe(false);
    expect(canRelayRideMessage(withHops(4, 3), NOW)).toBe(false);
  });

  test('maxHops 0 is valid but never relayable', () => {
    const message = createRideMessage(input({ maxHops: 0 }));

    expect(message.maxHops).toBe(0);
    expect(canRelayRideMessage(message, NOW)).toBe(false);
    expect(relayRideMessage(message, NOW)).toBeNull();
  });

  test('accepts the maximum hop limit', () => {
    expect(createRideMessage(input({ maxHops: RIDE_MESSAGE_MAX_HOP_LIMIT })).maxHops).toBe(
      RIDE_MESSAGE_MAX_HOP_LIMIT,
    );
  });

  test.each([-1, 1.5, NaN, Infinity, RIDE_MESSAGE_MAX_HOP_LIMIT + 1])(
    'rejects invalid maxHops %p',
    maxHops => {
      expect(() => createRideMessage(input({ maxHops }))).toThrow(RangeError);
    },
  );

  test('successive relays exhaust the budget exactly at maxHops', () => {
    let message: RideMessage<HazardPayload, 'hazard'> | null = createRideMessage(
      input({ maxHops: 2 }),
    );
    const hops: number[] = [];
    while (message) {
      hops.push(message.hopCount);
      message = relayRideMessage(message, NOW);
    }
    expect(hops).toEqual([0, 1, 2]);
  });
});

describe('RideMessage relay immutability', () => {
  test('returns a new object with only hopCount incremented', () => {
    const original = createRideMessage(input());
    const snapshot = JSON.parse(JSON.stringify(original));

    const relayed = relayRideMessage(original, NOW + 1_000);

    expect(relayed).not.toBe(original);
    expect(relayed).toEqual({ ...snapshot, hopCount: 1 });
    expect(original).toEqual(snapshot);
  });

  test('preserves id, origin and absolute expiry across relays', () => {
    const original = createRideMessage(input());
    const relayed = relayRideMessage(original, NOW + 10_000)!;

    expect(relayed.id).toBe(original.id);
    expect(relayed.originId).toBe(original.originId);
    expect(relayed.createdAt).toBe(original.createdAt);
    expect(relayed.expiresAt).toBe(original.expiresAt);
  });

  test('works on a frozen message', () => {
    const original = Object.freeze(createRideMessage(input()));

    expect(relayRideMessage(original, NOW)?.hopCount).toBe(1);
    expect(original.hopCount).toBe(0);
  });
});
