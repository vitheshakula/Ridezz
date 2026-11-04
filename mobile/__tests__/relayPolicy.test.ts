import {
  RIDE_MESSAGE_RELAY_POLICY,
  decideRelay,
  isRelayableMessageType,
  type RelayDecision,
} from '../src/connectivity/relayPolicy';
import { createRideMessageIngress } from '../src/connectivity/rideMessageIngress';
import {
  RIDE_MESSAGE_TYPES,
  createRideMessage,
  type CreateRideMessageInput,
  type RideMessage,
  type RideMessageType,
} from '../src/connectivity/protocol/rideMessage';
import { encodeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';

const NOW = 1_700_000_000_000;
const TTL = 30_000;
const EXPIRES = NOW + TTL;

function message(overrides: Partial<CreateRideMessageInput<unknown, RideMessageType>> = {}) {
  return createRideMessage<unknown, RideMessageType>({
    id: 'msg-1',
    rideId: '12345',
    originId: 'node-a',
    type: 'hazard',
    priority: 'high',
    payload: { hazard: 'pothole', at: [12.5, 77.6] },
    ttlMs: TTL,
    maxHops: 5,
    now: NOW,
    ...overrides,
  });
}

function withHops<T extends RideMessage<unknown>>(m: T, hopCount: number): T {
  return { ...m, hopCount };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function relayed<P, T extends RideMessageType>(decision: RelayDecision<P, T>): RideMessage<P, T> {
  if (!decision.relay) {
    throw new Error(`expected relay, got ${decision.reason}`);
  }
  return decision.message;
}

describe('relay policy: relayed copy', () => {
  test('an eligible message produces a copy with hopCount + 1', () => {
    const original = withHops(message(), 2);

    expect(decideRelay(original, NOW)).toEqual({
      relay: true,
      message: { ...original, hopCount: 3 },
    });
  });

  test('only hopCount changes, by exactly one', () => {
    const original = message({ type: 'sos', priority: 'critical' });
    const copy = relayed(decideRelay(original, NOW + 1_000));

    const { hopCount: originalHops, ...originalRest } = original;
    const { hopCount: copyHops, ...copyRest } = copy;
    expect(copyHops).toBe(originalHops + 1);
    expect(copyRest).toEqual(originalRest);
    expect(Object.keys(copy).sort()).toEqual(Object.keys(original).sort());
    for (const field of [
      'v',
      'id',
      'rideId',
      'originId',
      'createdAt',
      'expiresAt',
      'type',
      'priority',
      'maxHops',
    ] as const) {
      expect(copy[field]).toBe(original[field]);
    }
  });

  test('never mutates the original, even when deeply frozen', () => {
    const original = deepFreeze(message());
    const snapshot = JSON.parse(JSON.stringify(original));

    const copy = relayed(decideRelay(original, NOW));

    expect(copy).not.toBe(original);
    expect(original).toEqual(snapshot);
    expect(original.hopCount).toBe(0);
  });

  test('payload is carried by reference with content untouched', () => {
    const original = deepFreeze(message());
    const copy = relayed(decideRelay(original, NOW));

    expect(copy.payload).toBe(original.payload);
    expect(copy.payload).toEqual({ hazard: 'pothole', at: [12.5, 77.6] });
  });

  test('a locally created message with hopCount 0 is relay-eligible', () => {
    const local = message({ originId: 'node-self', type: 'sos', priority: 'critical' });
    expect(relayed(decideRelay(local, NOW)).hopCount).toBe(1);
  });

  test('throws RangeError for an invalid now', () => {
    for (const now of [NaN, Infinity, -1, 1.5]) {
      expect(() => decideRelay(message(), now)).toThrow(RangeError);
    }
  });
});

describe('relay policy: TTL', () => {
  test('eligible one ms before expiry', () => {
    expect(decideRelay(message(), EXPIRES - 1).relay).toBe(true);
  });

  test('rejected as expired exactly at expiry and after', () => {
    expect(decideRelay(message(), EXPIRES)).toEqual({ relay: false, reason: 'expired' });
    expect(decideRelay(message(), EXPIRES + 1)).toEqual({ relay: false, reason: 'expired' });
  });

  test('expired wins over hop limit and message policy', () => {
    const exhaustedHeartbeat = withHops(message({ type: 'heartbeat', maxHops: 2 }), 2);

    expect(decideRelay(withHops(message({ maxHops: 2 }), 2), EXPIRES)).toEqual({
      relay: false,
      reason: 'expired',
    });
    expect(decideRelay(message({ type: 'heartbeat' }), EXPIRES)).toEqual({
      relay: false,
      reason: 'expired',
    });
    expect(decideRelay(exhaustedHeartbeat, EXPIRES)).toEqual({ relay: false, reason: 'expired' });
  });
});

describe('relay policy: hop limit', () => {
  test('hopCount below maxHops is eligible', () => {
    expect(relayed(decideRelay(withHops(message({ maxHops: 3 }), 2), NOW)).hopCount).toBe(3);
  });

  test('hopCount equal to maxHops is rejected', () => {
    expect(decideRelay(withHops(message({ maxHops: 3 }), 3), NOW)).toEqual({
      relay: false,
      reason: 'hop_limit',
    });
  });

  test('maxHops 0 (direct neighbours only) is never relayed', () => {
    expect(decideRelay(message({ maxHops: 0 }), NOW)).toEqual({
      relay: false,
      reason: 'hop_limit',
    });
  });

  test('a malformed hopCount above maxHops is rejected as hop_limit', () => {
    expect(decideRelay(withHops(message({ maxHops: 3 }), 4), NOW)).toEqual({
      relay: false,
      reason: 'hop_limit',
    });
  });

  test('hop limit wins over message policy', () => {
    const exhaustedHeartbeat = withHops(message({ type: 'heartbeat', maxHops: 1 }), 1);
    expect(decideRelay(exhaustedHeartbeat, NOW)).toEqual({ relay: false, reason: 'hop_limit' });
  });
});

describe('relay policy: message types', () => {
  test.each<[RideMessageType, boolean]>([
    ['sos', true],
    ['hazard', true],
    ['ack', true],
    ['gateway_advertisement', true],
    ['location', true],
    ['ride_state', true],
    ['heartbeat', false],
  ])('%s → relay %p', (type, expected) => {
    const decision = decideRelay(message({ type }), NOW);

    expect(decision.relay).toBe(expected);
    if (expected) {
      expect(relayed(decision).type).toBe(type);
    } else {
      expect(decision).toEqual({ relay: false, reason: 'message_policy' });
    }
  });

  test('the policy table covers exactly the protocol message types and is frozen', () => {
    expect(Object.keys(RIDE_MESSAGE_RELAY_POLICY).sort()).toEqual([...RIDE_MESSAGE_TYPES].sort());
    expect(Object.isFrozen(RIDE_MESSAGE_RELAY_POLICY)).toBe(true);
  });

  test('unknown types fail closed, including prototype keys', () => {
    for (const type of ['unknown', 'constructor', 'toString', '__proto__', '', null, 1]) {
      expect(isRelayableMessageType(type)).toBe(false);
    }
    const forged = { ...message(), type: 'constructor' } as unknown as RideMessage<unknown>;
    expect(decideRelay(forged, NOW)).toEqual({ relay: false, reason: 'message_policy' });
  });
});

describe('relay policy: multi-hop', () => {
  test('SOS-123 travels A→B→C→D and stops at the hop limit', () => {
    const atA = message({
      id: 'SOS-123',
      originId: 'node-a',
      type: 'sos',
      priority: 'critical',
      payload: { lat: 12.97, lon: 77.59 },
      maxHops: 3,
    });
    const fromB = relayed(decideRelay(atA, NOW + 100));
    const fromC = relayed(decideRelay(fromB, NOW + 200));
    const fromD = relayed(decideRelay(fromC, NOW + 300));

    expect([atA, fromB, fromC, fromD].map(m => m.hopCount)).toEqual([0, 1, 2, 3]);
    for (const m of [fromB, fromC, fromD]) {
      expect(m.id).toBe('SOS-123');
      expect(m.originId).toBe('node-a');
      expect(m.expiresAt).toBe(atA.expiresAt);
      expect(m.payload).toBe(atA.payload);
    }

    const ingress = createRideMessageIngress({
      rideId: '12345',
      localNodeId: 'node-e',
      seenMessages: createSeenMessageCache(),
      clock: () => NOW + 400,
    });
    expect(ingress.ingest(encodeRideMessage(fromD), { transportId: 't' })).toMatchObject({
      accepted: true,
      message: { id: 'SOS-123', hopCount: 3 },
    });
    expect(decideRelay(fromD, NOW + 400)).toEqual({ relay: false, reason: 'hop_limit' });
  });

  test('paths A→B→D and A→C→D converge on equivalent copies of the same message', () => {
    const atA = message({ id: 'SOS-123', type: 'sos', priority: 'critical', maxHops: 3 });
    const fromB = relayed(decideRelay(atA, NOW + 100));
    const fromC = relayed(decideRelay(atA, NOW + 150));
    const fromDviaB = relayed(decideRelay(fromB, NOW + 200));
    const fromDviaC = relayed(decideRelay(fromC, NOW + 250));

    expect(fromB).toEqual(fromC);
    expect(fromB.hopCount).toBe(1);
    expect(fromDviaB).toEqual(fromDviaC);
    expect(fromDviaB.hopCount).toBe(2);
    expect(fromDviaB).toMatchObject({ id: 'SOS-123', originId: 'node-a' });
  });

  test('repeated decisions are deterministic and independent', () => {
    const atA = message();
    expect(decideRelay(atA, NOW)).toEqual(decideRelay(atA, NOW));
    expect(relayed(decideRelay(atA, NOW)).hopCount).toBe(1);
    expect(relayed(decideRelay(atA, NOW)).hopCount).toBe(1);
  });
});

describe('relay policy: isolation', () => {
  test('does not depend on any transport or React Native module', () => {
    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'livekit-client',
        '../src/transports/Transport',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/connectivity/protocol/seenMessageCache',
        '../src/connectivity/rideMessageIngress',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`relay policy must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/relayPolicy')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });

  test('performs no background work', () => {
    const timers = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      decideRelay(message(), NOW);
      decideRelay(message({ type: 'heartbeat' }), NOW);
      for (const spy of timers) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      timers.forEach(spy => spy.mockRestore());
    }
  });
});
