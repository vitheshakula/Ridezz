import {
  createHeartbeatEmitter,
  type HeartbeatEmitterOptions,
  type HeartbeatTransport,
} from '../src/connectivity/heartbeatEmitter';
import { handleHeartbeat } from '../src/connectivity/heartbeatHandler';
import { createPeerTable } from '../src/connectivity/peerTable';
import { createRideMessageIngress } from '../src/connectivity/rideMessageIngress';
import { HEARTBEAT_TTL_MS } from '../src/connectivity/protocol/heartbeat';
import {
  RIDE_MESSAGE_ID_PATTERN,
  createRideMessageIdGenerator,
} from '../src/connectivity/protocol/rideMessageId';
import { parseRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';

const WALL = 1_700_000_000_000;
const RIDE = '12345';
const ORIGIN = 'rider-a';

interface FakeTransport {
  transport: HeartbeatTransport;
  broadcast: jest.Mock<Promise<void>, [string | Uint8Array]>;
  sent: (string | Uint8Array)[];
}

function fakeTransport(
  id: string,
  payload: 'string' | 'bytes' = 'string',
  behaviour: () => Promise<void> = () => Promise.resolve(),
): FakeTransport {
  const sent: (string | Uint8Array)[] = [];
  const broadcast = jest.fn((p: string | Uint8Array) => {
    sent.push(p);
    return behaviour();
  });
  return { transport: { id, payload, broadcast } as HeartbeatTransport, broadcast, sent };
}

function deterministicIds() {
  let n = 0;
  const source = jest.fn((array: Uint8Array) => array.fill(++n));
  return { generate: jest.fn(createRideMessageIdGenerator(source)), source };
}

function emitter(overrides: Partial<HeartbeatEmitterOptions> = {}) {
  const ids = deterministicIds();
  const options: HeartbeatEmitterOptions = {
    rideId: RIDE,
    localNodeId: ORIGIN,
    getActiveTransports: () => [],
    generateMessageId: ids.generate,
    wallClock: () => WALL,
    ...overrides,
  };
  return { emitter: createHeartbeatEmitter(options), ids };
}

function decode(payload: string | Uint8Array, now = WALL) {
  const message = parseRideMessage(payload, now);
  if (!message) {
    throw new Error('payload did not parse');
  }
  return message;
}

describe('heartbeat emitter: single cycle', () => {
  test('no active transports: succeeds, sends nothing, generates no ids, reads no clock', async () => {
    const wallClock = jest.fn(() => WALL);
    const { emitter: e, ids } = emitter({ wallClock });

    expect(await e.emitHeartbeatCycle()).toEqual({ ok: true, transmissions: [] });
    expect(ids.generate).not.toHaveBeenCalled();
    expect(wallClock).not.toHaveBeenCalled();
  });

  test('one transport: one heartbeat, sent exactly as created', async () => {
    const x = fakeTransport('transport-x');
    const { emitter: e } = emitter({ getActiveTransports: () => [x.transport] });

    const result = await e.emitHeartbeatCycle();

    expect(x.broadcast).toHaveBeenCalledTimes(1);
    const sent = decode(x.sent[0]);
    expect(result).toEqual({
      ok: true,
      transmissions: [{ transportId: 'transport-x', ok: true, messageId: sent.id }],
    });
    expect(sent).toEqual({
      v: 1,
      id: sent.id,
      rideId: RIDE,
      originId: ORIGIN,
      type: 'heartbeat',
      priority: 'low',
      createdAt: WALL,
      expiresAt: WALL + HEARTBEAT_TTL_MS,
      hopCount: 0,
      maxHops: 0,
      payload: {},
    });
    expect(sent.id).toMatch(RIDE_MESSAGE_ID_PATTERN);
  });

  test('two transports: two different ids, same ride and origin, hop 0 / maxHops 0', async () => {
    const x = fakeTransport('transport-x', 'string');
    const y = fakeTransport('transport-y', 'bytes');
    const { emitter: e, ids } = emitter({ getActiveTransports: () => [x.transport, y.transport] });

    const result = await e.emitHeartbeatCycle();

    expect(ids.generate).toHaveBeenCalledTimes(2);
    expect(typeof x.sent[0]).toBe('string');
    expect(y.sent[0]).toBeInstanceOf(Uint8Array);
    const h1 = decode(x.sent[0]);
    const h2 = decode(y.sent[0]);
    expect(h1.id).not.toBe(h2.id);
    for (const h of [h1, h2]) {
      expect(h).toMatchObject({ rideId: RIDE, originId: ORIGIN, hopCount: 0, maxHops: 0 });
    }
    expect(result).toEqual({
      ok: true,
      transmissions: [
        { transportId: 'transport-x', ok: true, messageId: h1.id },
        { transportId: 'transport-y', ok: true, messageId: h2.id },
      ],
    });
  });

  test('a new cycle uses new ids', async () => {
    const x = fakeTransport('transport-x');
    const { emitter: e } = emitter({ getActiveTransports: () => [x.transport] });

    await e.emitHeartbeatCycle();
    await e.emitHeartbeatCycle();

    expect(decode(x.sent[0]).id).not.toBe(decode(x.sent[1]).id);
  });

  test('H1 over X and H2 over Y let the receiver record rider-a on both links', async () => {
    const x = fakeTransport('transport-x', 'string');
    const y = fakeTransport('transport-y', 'bytes');
    const { emitter: e } = emitter({ getActiveTransports: () => [x.transport, y.transport] });
    await e.emitHeartbeatCycle();

    const ingress = createRideMessageIngress({
      rideId: RIDE,
      localNodeId: 'rider-b',
      seenMessages: createSeenMessageCache(),
      clock: () => WALL + 40,
    });
    const peers = createPeerTable({ localNodeId: 'rider-b' });
    for (const [payload, transportId] of [
      [x.sent[0], 'transport-x'],
      [y.sent[0], 'transport-y'],
    ] as const) {
      const accepted = ingress.ingest(payload, { transportId });
      expect(accepted.accepted).toBe(true);
      if (accepted.accepted) {
        expect(handleHeartbeat(accepted, 50_000, peers)).toMatchObject({ observed: true });
      }
    }

    expect(peers.getPeers(50_000)).toEqual([
      {
        nodeId: 'rider-a',
        lastSeenAt: 50_000,
        transports: [
          { transportId: 'transport-x', lastSeenAt: 50_000 },
          { transportId: 'transport-y', lastSeenAt: 50_000 },
        ],
      },
    ]);
  });
});

describe('heartbeat emitter: dynamic transports', () => {
  test('queries active transports afresh on every cycle', async () => {
    const x = fakeTransport('transport-x');
    const y = fakeTransport('transport-y');
    let active: HeartbeatTransport[] = [x.transport];
    const getActiveTransports = jest.fn(() => active);
    const { emitter: e } = emitter({ getActiveTransports });

    await e.emitHeartbeatCycle();
    active = [y.transport];
    await e.emitHeartbeatCycle();

    expect(getActiveTransports).toHaveBeenCalledTimes(2);
    expect(x.broadcast).toHaveBeenCalledTimes(1);
    expect(y.broadcast).toHaveBeenCalledTimes(1);
  });

  test('a returned array mutated during the cycle does not affect it', async () => {
    const x = fakeTransport('transport-x');
    const active: HeartbeatTransport[] = [x.transport];
    const { emitter: e } = emitter({
      getActiveTransports: () => active,
      wallClock: () => {
        active.push(fakeTransport('late').transport);
        return WALL;
      },
    });

    const result = await e.emitHeartbeatCycle();
    expect(result.ok && result.transmissions.map(t => t.transportId)).toEqual(['transport-x']);
  });
});

describe('heartbeat emitter: failure isolation', () => {
  test('X succeeds, Y fails, Z succeeds: all attempted, each outcome reported', async () => {
    const x = fakeTransport('transport-x');
    const y = fakeTransport('transport-y', 'string', () => Promise.reject(new Error('radio off')));
    const z = fakeTransport('transport-z', 'bytes');
    const { emitter: e } = emitter({
      getActiveTransports: () => [x.transport, y.transport, z.transport],
    });

    const result = await e.emitHeartbeatCycle();

    for (const t of [x, y, z]) {
      expect(t.broadcast).toHaveBeenCalledTimes(1);
    }
    expect(result).toEqual({
      ok: true,
      transmissions: [
        { transportId: 'transport-x', ok: true, messageId: decode(x.sent[0]).id },
        {
          transportId: 'transport-y',
          ok: false,
          stage: 'transport',
          messageId: decode(y.sent[0]).id,
          reason: 'error',
          error: 'radio off',
        },
        { transportId: 'transport-z', ok: true, messageId: decode(z.sent[0]).id },
      ],
    });
  });

  test('a transport that throws synchronously is reported, not propagated', async () => {
    const x = fakeTransport('transport-x', 'string', () => {
      throw new Error('sync boom');
    });
    const y = fakeTransport('transport-y');
    const { emitter: e } = emitter({ getActiveTransports: () => [x.transport, y.transport] });

    const result = await e.emitHeartbeatCycle();

    expect(result.ok && result.transmissions.map(t => t.ok)).toEqual([false, true]);
    expect(result.ok && result.transmissions[0]).toMatchObject({
      stage: 'transport',
      reason: 'error',
      error: 'sync boom',
    });
  });

  test('a slow transport does not delay sending on the others', async () => {
    let release: () => void = () => {};
    const slow = fakeTransport(
      'transport-slow',
      'string',
      () => new Promise<void>(resolve => (release = resolve)),
    );
    const fast = fakeTransport('transport-fast');
    const { emitter: e } = emitter({
      getActiveTransports: () => [slow.transport, fast.transport],
    });

    const cycle = e.emitHeartbeatCycle();
    await Promise.resolve();
    expect(fast.broadcast).toHaveBeenCalledTimes(1);
    release();
    expect((await cycle).ok).toBe(true);
  });
});

describe('heartbeat emitter: secure id failure', () => {
  test('a failing generator fails that transmission closed; later ones still go out', async () => {
    const x = fakeTransport('transport-x');
    const y = fakeTransport('transport-y');
    const real = deterministicIds().generate;
    let calls = 0;
    const generateMessageId = jest.fn(() => {
      if (calls++ === 0) {
        throw new Error('RNGetRandomValues unavailable');
      }
      return real();
    });
    const random = jest.spyOn(Math, 'random');
    const { emitter: e } = emitter({
      getActiveTransports: () => [x.transport, y.transport],
      generateMessageId,
    });

    try {
      const result = await e.emitHeartbeatCycle();

      expect(x.broadcast).not.toHaveBeenCalled();
      expect(y.broadcast).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        ok: true,
        transmissions: [
          {
            transportId: 'transport-x',
            ok: false,
            stage: 'message',
            error: 'RNGetRandomValues unavailable',
          },
          { transportId: 'transport-y', ok: true, messageId: decode(y.sent[0]).id },
        ],
      });
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  test('an id that violates RideMessage id rules is a message failure, not sent', async () => {
    const x = fakeTransport('transport-x');
    const { emitter: e } = emitter({
      getActiveTransports: () => [x.transport],
      generateMessageId: () => '',
    });

    const result = await e.emitHeartbeatCycle();

    expect(x.broadcast).not.toHaveBeenCalled();
    expect(result.ok && result.transmissions[0]).toMatchObject({ ok: false, stage: 'message' });
  });
});

describe('heartbeat emitter: transport list problems', () => {
  test('duplicate transport ids: none of the duplicates are sent; others are', async () => {
    const x1 = fakeTransport('transport-x');
    const x2 = fakeTransport('transport-x', 'bytes');
    const y = fakeTransport('transport-y');
    const { emitter: e, ids } = emitter({
      getActiveTransports: () => [x1.transport, y.transport, x2.transport],
    });

    const result = await e.emitHeartbeatCycle();

    expect(x1.broadcast).not.toHaveBeenCalled();
    expect(x2.broadcast).not.toHaveBeenCalled();
    expect(y.broadcast).toHaveBeenCalledTimes(1);
    expect(ids.generate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      transmissions: [
        { transportId: 'transport-x', ok: false, stage: 'duplicate_transport' },
        { transportId: 'transport-y', ok: true, messageId: decode(y.sent[0]).id },
        { transportId: 'transport-x', ok: false, stage: 'duplicate_transport' },
      ],
    });
  });

  test('unusable transport entries are reported without affecting the rest', async () => {
    const y = fakeTransport('transport-y');
    const bad = [
      null,
      { id: '', payload: 'string', broadcast: jest.fn() },
      { id: 'no-broadcast', payload: 'string' },
      { id: 'bad-payload', payload: 'json', broadcast: jest.fn() },
    ];
    const { emitter: e } = emitter({
      getActiveTransports: () => [...bad, y.transport] as unknown as HeartbeatTransport[],
    });

    const result = await e.emitHeartbeatCycle();

    expect(result.ok && result.transmissions).toEqual([
      { transportId: null, ok: false, stage: 'invalid_transport' },
      { transportId: null, ok: false, stage: 'invalid_transport' },
      { transportId: 'no-broadcast', ok: false, stage: 'invalid_transport' },
      { transportId: 'bad-payload', ok: false, stage: 'invalid_transport' },
      { transportId: 'transport-y', ok: true, messageId: decode(y.sent[0]).id },
    ]);
  });

  test('a throwing getActiveTransports fails the cycle cleanly', async () => {
    const { emitter: e, ids } = emitter({
      getActiveTransports: () => {
        throw new Error('registry offline');
      },
    });

    expect(await e.emitHeartbeatCycle()).toEqual({
      ok: false,
      reason: 'transports_unavailable',
      error: 'registry offline',
    });
    expect(ids.generate).not.toHaveBeenCalled();
  });
});

describe('heartbeat emitter: wall clock', () => {
  test('reads the injected wall clock once per cycle and stamps every heartbeat with it', async () => {
    const x = fakeTransport('transport-x');
    const y = fakeTransport('transport-y');
    const wallClock = jest.fn(() => WALL + 123);
    const dateNow = jest.spyOn(Date, 'now');
    const { emitter: e } = emitter({
      getActiveTransports: () => [x.transport, y.transport],
      wallClock,
    });

    try {
      await e.emitHeartbeatCycle();

      expect(wallClock).toHaveBeenCalledTimes(1);
      expect(dateNow).not.toHaveBeenCalled();
      for (const sent of [x.sent[0], y.sent[0]]) {
        expect(decode(sent, WALL + 123)).toMatchObject({
          createdAt: WALL + 123,
          expiresAt: WALL + 123 + HEARTBEAT_TTL_MS,
        });
      }
    } finally {
      dateNow.mockRestore();
    }
  });

  test.each([NaN, -1, 1.5, Infinity])(
    'an invalid wall clock %p fails the cycle closed',
    async t => {
      const x = fakeTransport('transport-x');
      const { emitter: e, ids } = emitter({
        getActiveTransports: () => [x.transport],
        wallClock: () => t,
      });

      expect(await e.emitHeartbeatCycle()).toEqual({ ok: false, reason: 'invalid_clock' });
      expect(ids.generate).not.toHaveBeenCalled();
      expect(x.broadcast).not.toHaveBeenCalled();
    },
  );

  test('a throwing wall clock fails the cycle closed', async () => {
    const { emitter: e } = emitter({
      getActiveTransports: () => [fakeTransport('transport-x').transport],
      wallClock: () => {
        throw new Error('clock unavailable');
      },
    });
    expect(await e.emitHeartbeatCycle()).toEqual({
      ok: false,
      reason: 'invalid_clock',
      error: 'clock unavailable',
    });
  });
});

describe('heartbeat emitter: configuration and isolation', () => {
  test('rejects invalid configuration', () => {
    expect(() => emitter({ rideId: '' })).toThrow(TypeError);
    expect(() => emitter({ localNodeId: '' })).toThrow(TypeError);
    expect(() => emitter({ generateMessageId: undefined as never })).toThrow(TypeError);
    expect(() => emitter({ wallClock: 5 as never })).toThrow(TypeError);
    expect(() => emitter({ getActiveTransports: null as never })).toThrow(TypeError);
  });

  test('does not depend on React Native, transports, PeerTable or relay policy', () => {
    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'react-native-get-random-values',
        'livekit-client',
        '@livekit/react-native',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/transports/Transport',
        '../src/connectivity/peerTable',
        '../src/connectivity/relayPolicy',
        '../src/connectivity/rideMessageIngress',
        '../src/connectivity/heartbeatHandler',
        '../src/connectivity/rideMessageIdRuntime',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`heartbeat emitter must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/heartbeatEmitter')).not.toThrow();
      expect(() => require('../src/connectivity/cycleScheduler')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });
});
