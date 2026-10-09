import {
  RIDE_MESSAGE_ID_PATTERN,
  RIDE_MESSAGE_ID_RANDOM_BYTES,
  createRideMessageIdGenerator,
  formatRideMessageId,
  type SecureRandomValues,
} from '../src/connectivity/protocol/rideMessageId';
import { createRuntimeRideMessageIdGenerator } from '../src/connectivity/rideMessageIdRuntime';
import {
  RIDE_MESSAGE_MAX_ID_LENGTH,
  isValidRideMessageIdentifier,
} from '../src/connectivity/protocol/rideMessage';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import { encodeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';
import { createRideMessageIngress } from '../src/connectivity/rideMessageIngress';
import { handleHeartbeat } from '../src/connectivity/heartbeatHandler';
import { createPeerTable } from '../src/connectivity/peerTable';

const ASCENDING = Uint8Array.from({ length: 16 }, (_, i) => i);

/** A deterministic stand-in for crypto.getRandomValues, yielding the given blocks in order. */
function sequenceSource(...blocks: number[][]) {
  let next = 0;
  return jest.fn<Uint8Array, [Uint8Array]>(array => {
    array.set(blocks[next++]);
    return array;
  });
}

function bytes(fill: (i: number) => number): number[] {
  return Array.from({ length: 16 }, (_, i) => fill(i));
}

describe('RideMessage id construction', () => {
  test('fixed bytes produce the exact expected UUID', () => {
    expect(formatRideMessageId(ASCENDING)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(formatRideMessageId(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
    expect(formatRideMessageId(new Uint8Array(16).fill(0xff))).toBe(
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    );
  });

  test('is lowercase, 36 characters, with canonical hyphens', () => {
    const id = formatRideMessageId(new Uint8Array(16).fill(0xab));

    expect(id).toBe(id.toLowerCase());
    expect(id).toHaveLength(36);
    expect([8, 13, 18, 23].map(i => id[i])).toEqual(['-', '-', '-', '-']);
    expect(id.replace(/-/g, '')).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toMatch(RIDE_MESSAGE_ID_PATTERN);
  });

  test('version nibble is always 4 and variant bits are always 10', () => {
    for (let value = 0; value < 256; value++) {
      const id = formatRideMessageId(Uint8Array.from(bytes(() => value)));
      expect(id[14]).toBe('4');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
      expect(id).toMatch(RIDE_MESSAGE_ID_PATTERN);
    }
  });

  test('preserves every non-version, non-variant random bit', () => {
    for (let value = 0; value < 256; value++) {
      for (let position = 0; position < 16; position++) {
        const input = new Uint8Array(16);
        input[position] = value;
        const hex = formatRideMessageId(input).replace(/-/g, '');
        const out = parseInt(hex.slice(position * 2, position * 2 + 2), 16);

        /* eslint-disable no-bitwise -- expected values are defined by UUID bit layout */
        if (position === 6) {
          expect(out).toBe(0x40 | (value & 0x0f));
        } else if (position === 8) {
          expect(out).toBe(0x80 | (value & 0x3f));
        } else {
          /* eslint-enable no-bitwise */
          expect(out).toBe(value);
        }
      }
    }
  });

  test('does not modify the caller-supplied bytes', () => {
    const input = new Uint8Array(16).fill(0xff);
    formatRideMessageId(input);
    expect(Array.from(input)).toEqual(Array(16).fill(0xff));
  });

  test('rejects anything other than exactly 16 bytes', () => {
    expect(() => formatRideMessageId(new Uint8Array(15))).toThrow(RangeError);
    expect(() => formatRideMessageId(new Uint8Array(17))).toThrow(RangeError);
  });

  test('satisfies the RideMessage identifier rules', () => {
    const id = formatRideMessageId(ASCENDING);
    expect(isValidRideMessageIdentifier(id, RIDE_MESSAGE_MAX_ID_LENGTH)).toBe(true);
    expect(RIDE_MESSAGE_ID_RANDOM_BYTES).toBe(16);
  });
});

describe('RideMessage id generator', () => {
  test('takes only a random source; ids take no inputs', () => {
    const generate = createRideMessageIdGenerator(sequenceSource(Array.from(ASCENDING)));
    expect(createRideMessageIdGenerator.length).toBe(1);
    expect(generate.length).toBe(0);
    expect(generate()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  test('requests fresh 16-byte buffers, once per id', () => {
    const source = sequenceSource(
      bytes(() => 0x11),
      bytes(() => 0x22),
    );
    const generate = createRideMessageIdGenerator(source);

    expect(generate()).toBe('11111111-1111-4111-9111-111111111111');
    expect(generate()).toBe('22222222-2222-4222-a222-222222222222');
    expect(source).toHaveBeenCalledTimes(2);
    const [first, second] = source.mock.calls.map(([array]) => array);
    expect(first).not.toBe(second);
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.length).toBe(16);
  });

  test('a throwing source fails closed', () => {
    const generate = createRideMessageIdGenerator(() => {
      throw new Error('native module unavailable');
    });
    expect(() => generate()).toThrow('native module unavailable');
  });

  test('a source that does not fill and return the given buffer fails closed', () => {
    const returnsCopy: SecureRandomValues = array => Uint8Array.from(array).fill(7);
    const returnsNothing = (() => undefined) as unknown as SecureRandomValues;

    expect(() => createRideMessageIdGenerator(returnsCopy)()).toThrow(TypeError);
    expect(() => createRideMessageIdGenerator(returnsNothing)()).toThrow(TypeError);
  });

  test('rejects a missing source at creation', () => {
    for (const source of [undefined, null, 42, {}]) {
      expect(() => createRideMessageIdGenerator(source as unknown as SecureRandomValues)).toThrow(
        TypeError,
      );
    }
  });

  test('never uses Math.random or Date.now', () => {
    const random = jest.spyOn(Math, 'random');
    const now = jest.spyOn(Date, 'now');
    try {
      const generate = createRideMessageIdGenerator(sequenceSource(bytes(i => i)));
      generate();
      expect(random).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
  });

  test('two calls give two independent heartbeat ids for transports X and Y', () => {
    // The future scheduler sends a separate heartbeat per transport. Ids are not transport
    // specific: they are simply two independently generated ids.
    const generate = createRideMessageIdGenerator(
      sequenceSource(
        bytes(() => 0x01),
        bytes(() => 0x02),
      ),
    );
    const WALL = 1_700_000_000_000;
    const heartbeat = (id: string) =>
      createHeartbeatMessage({ id, rideId: '12345', originId: 'rider-a', createdAt: WALL });
    const h1 = heartbeat(generate());
    const h2 = heartbeat(generate());
    expect(h1.id).not.toBe(h2.id);

    const ingress = createRideMessageIngress({
      rideId: '12345',
      localNodeId: 'rider-b',
      seenMessages: createSeenMessageCache(),
      clock: () => WALL,
    });
    const peers = createPeerTable({ localNodeId: 'rider-b' });
    for (const [message, transportId] of [
      [h1, 'transport-x'],
      [h2, 'transport-y'],
    ] as const) {
      const result = ingress.ingest(encodeRideMessage(message), { transportId });
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        handleHeartbeat(result, 50_000, peers);
      }
    }

    expect(peers.getPeer('rider-a', 50_000)?.transports.map(t => t.transportId)).toEqual([
      'transport-x',
      'transport-y',
    ]);
  });
});

describe('runtime RideMessage id generator', () => {
  test('binds to crypto.getRandomValues with crypto as this, never randomUUID', () => {
    const randomUUID = jest.fn(() => 'insecure-shim');
    const crypto = {
      randomUUID,
      getRandomValues(this: unknown, array: Uint8Array) {
        if (this !== crypto) {
          throw new TypeError('Illegal invocation');
        }
        array.set(ASCENDING);
        return array;
      },
    };

    const generate = createRuntimeRideMessageIdGenerator({ crypto });

    expect(generate()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(randomUUID).not.toHaveBeenCalled();
  });

  test.each<[string, unknown]>([
    ['no crypto', undefined],
    ['null crypto', null],
    ['crypto without getRandomValues', {}],
    ['only randomUUID (the LiveKit shim)', { randomUUID: () => 'x' }],
    ['non-callable getRandomValues', { getRandomValues: 'yes' }],
  ])('fails closed with %s', (_label, crypto) => {
    expect(() => createRuntimeRideMessageIdGenerator({ crypto })).toThrow(TypeError);
  });

  test('a later replacement of crypto.getRandomValues does not affect a created generator', () => {
    const crypto = {
      getRandomValues: jest.fn((array: Uint8Array) => {
        array.set(ASCENDING);
        return array;
      }),
    };
    const generate = createRuntimeRideMessageIdGenerator({ crypto });
    const weak = jest.fn((array: Uint8Array) => array.fill(0));
    crypto.getRandomValues = weak;

    expect(generate()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(weak).not.toHaveBeenCalled();
  });

  test('a failure in the bound runtime source fails closed', () => {
    const generate = createRuntimeRideMessageIdGenerator({
      crypto: {
        getRandomValues: () => {
          throw new Error("TurboModuleRegistry.getEnforcing(...): 'RNGetRandomValues' not found");
        },
      },
    });
    expect(() => generate()).toThrow('RNGetRandomValues');
  });

  test('defaults to globalThis.crypto', () => {
    // Jest runs on Node, whose built-in Web Crypto stands in for the device polyfill here.
    expect(createRuntimeRideMessageIdGenerator()()).toMatch(RIDE_MESSAGE_ID_PATTERN);
  });
});

describe('startup polyfill ordering', () => {
  test('loads the secure random polyfill after the existing polyfills', () => {
    const order: string[] = [];
    jest.isolateModules(() => {
      jest.doMock('../src/polyfills/domException', () => order.push('domException'));
      jest.doMock('../src/polyfills/textEncoding', () => order.push('textEncoding'));
      jest.doMock('react-native-get-random-values', () => order.push('getRandomValues'));
      require('../src/polyfills');
    });
    expect(order).toEqual(['domException', 'textEncoding', 'getRandomValues']);
  });
});

describe('RideMessage id isolation', () => {
  test('neither module depends on React Native, transports or protocol orchestration', () => {
    jest.isolateModules(() => {
      const forbidden = [
        'react-native',
        'react-native-get-random-values',
        'livekit-client',
        '@livekit/react-native',
        '../src/transports/Transport',
        '../src/transports/NearbyTransport',
        '../src/transports/LiveKitHazardTransport',
        '../src/connectivity/rideMessageIngress',
        '../src/connectivity/relayPolicy',
        '../src/connectivity/peerTable',
        '../src/connectivity/heartbeatHandler',
        '../src/connectivity/protocol/rideMessage',
        '../src/connectivity/protocol/rideMessageCodec',
        '../src/connectivity/protocol/seenMessageCache',
        '../src/connectivity/protocol/heartbeat',
      ];
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`id generation must not import ${name}`);
        });
      }
      expect(() => require('../src/connectivity/protocol/rideMessageId')).not.toThrow();
      expect(() => require('../src/connectivity/rideMessageIdRuntime')).not.toThrow();
      for (const name of forbidden) {
        jest.dontMock(name);
      }
    });
  });
});
