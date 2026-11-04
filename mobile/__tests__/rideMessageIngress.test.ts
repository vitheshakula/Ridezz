import {
  createRideMessageIngress,
  type RideMessageIngressOptions,
  type RideMessageIngressSource,
} from '../src/connectivity/rideMessageIngress';
import {
  createRideMessage,
  relayRideMessage,
  type CreateRideMessageInput,
  type RideMessageType,
} from '../src/connectivity/protocol/rideMessage';
import {
  RIDE_MESSAGE_MAX_FUTURE_SKEW_MS,
  encodeRideMessage,
  serializeRideMessage,
} from '../src/connectivity/protocol/rideMessageCodec';
import {
  createSeenMessageCache,
  type SeenMessageCache,
} from '../src/connectivity/protocol/seenMessageCache';

const NOW = 1_700_000_000_000;
const TTL = 30_000;
const RIDE = '12345';
const LOCAL = 'node-d';
const SOURCE: RideMessageIngressSource = { transportId: 'transport-1' };

function message(overrides: Partial<CreateRideMessageInput<unknown, RideMessageType>> = {}) {
  return createRideMessage<unknown, RideMessageType>({
    id: 'msg-1',
    rideId: RIDE,
    originId: 'node-a',
    type: 'hazard',
    priority: 'high',
    payload: { hazard: 'pothole' },
    ttlMs: TTL,
    maxHops: 3,
    now: NOW,
    ...overrides,
  });
}

function setup(overrides: Partial<RideMessageIngressOptions> = {}) {
  const seenMessages = overrides.seenMessages ?? createSeenMessageCache();
  const clock = overrides.clock ?? jest.fn(() => NOW);
  const ingress = createRideMessageIngress({
    rideId: RIDE,
    localNodeId: LOCAL,
    seenMessages,
    clock,
    ...overrides,
  });
  return { ingress, seenMessages, clock };
}

describe('RideMessage ingress: acceptance', () => {
  test('accepts a valid message with its validated envelope and source', () => {
    const { ingress, seenMessages } = setup();
    const m = message();

    expect(ingress.ingest(encodeRideMessage(m), SOURCE)).toEqual({
      accepted: true,
      message: m,
      source: { transportId: 'transport-1' },
    });
    expect(seenMessages.size).toBe(1);
  });

  test('accepts string payloads as well as bytes', () => {
    const { ingress } = setup();
    expect(ingress.ingest(serializeRideMessage(message()), SOURCE)).toMatchObject({
      accepted: true,
    });
  });

  test('preserves transportId and optional peerId exactly', () => {
    const { ingress } = setup();
    const result = ingress.ingest(encodeRideMessage(message()), {
      transportId: 'opaque:link/7',
      peerId: 'peer-xyz',
    });

    expect(result.source).toEqual({ transportId: 'opaque:link/7', peerId: 'peer-xyz' });
  });

  test('omits peerId from the source when it was not provided', () => {
    const { ingress } = setup();
    expect(ingress.ingest(encodeRideMessage(message()), SOURCE).source).not.toHaveProperty(
      'peerId',
    );
  });

  test('accepts valid messages from other origins independently', () => {
    const { ingress } = setup();

    expect(ingress.ingest(encodeRideMessage(message()), SOURCE).accepted).toBe(true);
    expect(
      ingress.ingest(encodeRideMessage(message({ id: 'msg-2', originId: 'node-b' })), SOURCE)
        .accepted,
    ).toBe(true);
  });

  test('accepts a message with no relay budget left; relaying is not its concern', () => {
    const { ingress } = setup();
    const exhausted = relayRideMessage(message({ maxHops: 1 }), NOW)!;

    expect(ingress.ingest(encodeRideMessage(exhausted), SOURCE)).toMatchObject({
      accepted: true,
      message: { hopCount: 1, maxHops: 1 },
    });
  });
});

describe('RideMessage ingress: dedup across paths and transports', () => {
  test('the same message over two transport ids is accepted once', () => {
    const { ingress } = setup();
    const bytes = encodeRideMessage(message());

    expect(ingress.ingest(bytes, { transportId: 'transport-1' }).accepted).toBe(true);
    expect(ingress.ingest(bytes, { transportId: 'transport-2' })).toEqual({
      accepted: false,
      reason: 'duplicate',
      source: { transportId: 'transport-2' },
    });
  });

  test('the same message from two peer ids is accepted once', () => {
    const { ingress } = setup();
    const bytes = encodeRideMessage(message());

    expect(ingress.ingest(bytes, { transportId: 'transport-1', peerId: 'p1' }).accepted).toBe(true);
    expect(ingress.ingest(bytes, { transportId: 'transport-1', peerId: 'p2' })).toMatchObject({
      accepted: false,
      reason: 'duplicate',
    });
  });

  test('SOS-123 via A→B→D is accepted; the copy via A→C→D is a duplicate', () => {
    const sos = message({ id: 'SOS-123', type: 'sos', priority: 'critical', payload: {} });
    const viaB = relayRideMessage(sos, NOW)!;
    const viaC = relayRideMessage(sos, NOW)!;
    const { ingress } = setup();

    const first = ingress.ingest(encodeRideMessage(viaB), {
      transportId: 'transport-1',
      peerId: 'node-b',
    });
    const second = ingress.ingest(serializeRideMessage(viaC), {
      transportId: 'transport-2',
      peerId: 'node-c',
    });

    expect(first).toMatchObject({
      accepted: true,
      message: { id: 'SOS-123', originId: 'node-a', hopCount: 1 },
      source: { peerId: 'node-b' },
    });
    expect(second).toEqual({
      accepted: false,
      reason: 'duplicate',
      source: { transportId: 'transport-2', peerId: 'node-c' },
    });
  });

  test('a subsequent valid copy after acceptance is a duplicate', () => {
    const { ingress, seenMessages } = setup();
    const bytes = encodeRideMessage(message());

    ingress.ingest(bytes, SOURCE);
    expect(ingress.ingest(bytes, SOURCE)).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(seenMessages.size).toBe(1);
  });
});

describe('RideMessage ingress: rejections', () => {
  test.each<[string, string | Uint8Array]>([
    ['empty string', ''],
    ['malformed JSON', '{"v":1'],
    ['garbage bytes', new Uint8Array([0xff, 0x00, 0x13])],
    ['non-object JSON', '[]'],
  ])('rejects %s as invalid without claiming', (_label, payload) => {
    const { ingress, seenMessages } = setup();

    expect(ingress.ingest(payload, SOURCE)).toEqual({
      accepted: false,
      reason: 'invalid',
      source: SOURCE,
    });
    expect(seenMessages.size).toBe(0);
  });

  test('rejects a wrong protocol version through the codec', () => {
    const { ingress, seenMessages } = setup();
    const v2 = serializeRideMessage(message()).replace('"v":1', '"v":2');

    expect(ingress.ingest(v2, SOURCE)).toMatchObject({ accepted: false, reason: 'invalid' });
    expect(seenMessages.size).toBe(0);
  });

  test('rejects an expired packet through the codec without claiming', () => {
    const { ingress, seenMessages } = setup({ clock: () => NOW + TTL });

    expect(ingress.ingest(encodeRideMessage(message()), SOURCE)).toMatchObject({
      accepted: false,
      reason: 'invalid',
    });
    expect(seenMessages.size).toBe(0);
  });

  test('rejects a packet dated beyond the future-skew tolerance through the codec', () => {
    const { ingress } = setup();
    const ahead = message({ now: NOW + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS + 1 });

    expect(ingress.ingest(encodeRideMessage(ahead), SOURCE)).toMatchObject({
      accepted: false,
      reason: 'invalid',
    });
  });

  test('rejects another ride without consuming the cache', () => {
    const { ingress, seenMessages } = setup();
    const foreign = message({ rideId: '99999' });

    expect(ingress.ingest(encodeRideMessage(foreign), SOURCE)).toEqual({
      accepted: false,
      reason: 'wrong_ride',
      source: SOURCE,
    });
    expect(seenMessages.size).toBe(0);
    expect(ingress.ingest(encodeRideMessage(message()), SOURCE).accepted).toBe(true);
  });

  test.each(['12345 ', ' 12345', '012345', '1234', '12346'])(
    'requires the exact ride id (rejects %p)',
    rideId => {
      const { ingress } = setup();
      expect(ingress.ingest(encodeRideMessage(message({ rideId })), SOURCE)).toMatchObject({
        accepted: false,
        reason: 'wrong_ride',
      });
    },
  );

  test('ride id comparison is case-sensitive', () => {
    const { ingress } = setup({ rideId: 'Ride-A' });
    expect(ingress.ingest(encodeRideMessage(message({ rideId: 'ride-a' })), SOURCE)).toMatchObject({
      accepted: false,
      reason: 'wrong_ride',
    });
  });

  test('rejects a locally originated packet without consuming the cache', () => {
    const { ingress, seenMessages } = setup();
    const bounced = relayRideMessage(message({ originId: LOCAL }), NOW)!;

    expect(ingress.ingest(encodeRideMessage(bounced), SOURCE)).toEqual({
      accepted: false,
      reason: 'local_origin',
      source: SOURCE,
    });
    expect(seenMessages.size).toBe(0);
  });

  test('checks ride before local origin', () => {
    const { ingress } = setup();
    const foreignOwn = message({ rideId: '99999', originId: LOCAL });

    expect(ingress.ingest(encodeRideMessage(foreignOwn), SOURCE)).toMatchObject({
      reason: 'wrong_ride',
    });
  });

  test('rejected packets never evict live dedup entries', () => {
    const { ingress } = setup({ seenMessages: createSeenMessageCache(1) });
    const bytes = encodeRideMessage(message());
    ingress.ingest(bytes, SOURCE);

    for (let i = 0; i < 5; i++) {
      ingress.ingest(encodeRideMessage(message({ id: `foreign-${i}`, rideId: '99999' })), SOURCE);
      ingress.ingest(encodeRideMessage(message({ id: `own-${i}`, originId: LOCAL })), SOURCE);
      ingress.ingest(`{"v":1,"id":"junk-${i}"}`, SOURCE);
    }

    expect(ingress.ingest(bytes, SOURCE)).toMatchObject({ reason: 'duplicate' });
  });

  test('a cache result other than accepted/duplicate fails closed as invalid', () => {
    const cache: SeenMessageCache = { claim: () => 'expired', prune: () => {}, size: 0 };
    const { ingress } = setup({ seenMessages: cache });

    expect(ingress.ingest(encodeRideMessage(message()), SOURCE)).toMatchObject({
      accepted: false,
      reason: 'invalid',
    });
  });

  test('rejected results expose only the reason and source, never packet contents', () => {
    const { ingress } = setup();
    const results = [
      ingress.ingest('{"v":1', SOURCE),
      ingress.ingest(encodeRideMessage(message({ rideId: '99999' })), SOURCE),
      ingress.ingest(encodeRideMessage(message({ originId: LOCAL })), SOURCE),
    ];
    ingress.ingest(encodeRideMessage(message()), SOURCE);
    results.push(ingress.ingest(encodeRideMessage(message()), SOURCE));

    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(['accepted', 'reason', 'source']);
    }
  });
});

describe('RideMessage ingress: source metadata', () => {
  test('source metadata does not become part of the RideMessage', () => {
    const { ingress } = setup();
    const m = message();
    const result = ingress.ingest(encodeRideMessage(m), { transportId: 't', peerId: 'p' });
    if (!result.accepted) {
      throw new Error('expected acceptance');
    }

    expect(result.message).not.toHaveProperty('transportId');
    expect(result.message).not.toHaveProperty('peerId');
    expect(Object.keys(result.message)).toHaveLength(11);
    expect(serializeRideMessage(result.message)).toBe(serializeRideMessage(m));
  });

  test('returns a copy of the source, unaffected by later caller mutation', () => {
    const { ingress } = setup();
    const source = { transportId: 'transport-1', peerId: 'p1', extra: 'ignored' };
    const result = ingress.ingest(encodeRideMessage(message()), source);

    source.transportId = 'changed';
    source.peerId = 'changed';
    expect(result.source).toEqual({ transportId: 'transport-1', peerId: 'p1' });
  });

  test.each<unknown>([
    null,
    {},
    { transportId: '' },
    { transportId: 7 },
    { transportId: 't', peerId: '' },
    { transportId: 't', peerId: 3 },
  ])('throws TypeError for a malformed source %p, without claiming', source => {
    const { ingress, seenMessages, clock } = setup();

    expect(() =>
      ingress.ingest(encodeRideMessage(message()), source as RideMessageIngressSource),
    ).toThrow(TypeError);
    expect(seenMessages.size).toBe(0);
    expect(clock).not.toHaveBeenCalled();
  });
});

describe('RideMessage ingress: purity and determinism', () => {
  test('does not mutate the input bytes or the original message', () => {
    const { ingress } = setup();
    const m = message();
    const snapshot = JSON.parse(JSON.stringify(m));
    const bytes = encodeRideMessage(m);
    const bytesSnapshot = Array.from(bytes);

    const result = ingress.ingest(bytes, SOURCE);

    expect(Array.from(bytes)).toEqual(bytesSnapshot);
    expect(m).toEqual(snapshot);
    expect(result.accepted && result.message).not.toBe(m);
  });

  test('reads the injected clock once and uses that instant for parse and claim', () => {
    const real = createSeenMessageCache();
    const claim = jest.fn(real.claim);
    const clock = jest.fn(() => NOW + TTL - 1);
    const { ingress } = setup({ seenMessages: { ...real, claim }, clock });

    expect(ingress.ingest(encodeRideMessage(message()), SOURCE).accepted).toBe(true);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith('msg-1', NOW + TTL, NOW + TTL - 1);
  });

  test('the same packet at a later injected time is judged at that time', () => {
    let now = NOW;
    const { ingress } = setup({ clock: () => now });
    const bytes = encodeRideMessage(message());

    expect(ingress.ingest(bytes, SOURCE).accepted).toBe(true);
    now = NOW + TTL;
    expect(ingress.ingest(bytes, SOURCE)).toMatchObject({ reason: 'invalid' });
  });

  test('performs no transport sends or background work', () => {
    const transport = { broadcast: jest.fn(), send: jest.fn() };
    const timers = [
      jest.spyOn(globalThis, 'setTimeout'),
      jest.spyOn(globalThis, 'setInterval'),
      jest.spyOn(globalThis, 'setImmediate'),
    ];
    try {
      const { ingress } = setup();
      const result = ingress.ingest(encodeRideMessage(message()), SOURCE);

      expect(result.accepted).toBe(true);
      expect(transport.broadcast).not.toHaveBeenCalled();
      expect(transport.send).not.toHaveBeenCalled();
      for (const spy of timers) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      timers.forEach(spy => spy.mockRestore());
    }
  });

  test('does not depend on any transport or React Native module', () => {
    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'livekit-client',
        '../src/transports/Transport',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`ingress must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/rideMessageIngress')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });
});

describe('RideMessage ingress: session scoping', () => {
  test('rejects invalid configuration', () => {
    expect(() => setup({ rideId: '' })).toThrow(TypeError);
    expect(() => setup({ rideId: 'x'.repeat(65) })).toThrow(TypeError);
    expect(() => setup({ localNodeId: '' })).toThrow(TypeError);
    expect(() => setup({ localNodeId: 'x'.repeat(65) })).toThrow(TypeError);
  });

  test('processors with separate caches do not share dedup state', () => {
    const d1 = setup();
    const d2 = setup({ localNodeId: 'node-e' });
    const bytes = encodeRideMessage(message());

    expect(d1.ingress.ingest(bytes, SOURCE).accepted).toBe(true);
    expect(d2.ingress.ingest(bytes, SOURCE).accepted).toBe(true);
    expect(d1.ingress.ingest(bytes, SOURCE)).toMatchObject({ reason: 'duplicate' });
    expect(d2.ingress.ingest(bytes, SOURCE)).toMatchObject({ reason: 'duplicate' });
  });

  test('a new ride session with a new cache accepts an id seen in the old session', () => {
    const oldRide = setup({ rideId: '11111' });
    expect(
      oldRide.ingress.ingest(encodeRideMessage(message({ id: 'X', rideId: '11111' })), SOURCE)
        .accepted,
    ).toBe(true);

    const newRide = setup({ rideId: '22222' });
    const inNewRide = encodeRideMessage(message({ id: 'X', rideId: '22222' }));

    expect(newRide.ingress.ingest(inNewRide, SOURCE).accepted).toBe(true);
    expect(oldRide.ingress.ingest(inNewRide, SOURCE)).toMatchObject({ reason: 'wrong_ride' });
  });
});
