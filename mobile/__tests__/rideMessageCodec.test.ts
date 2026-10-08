import {
  RIDE_MESSAGE_MAX_FUTURE_SKEW_MS,
  RIDE_MESSAGE_MAX_WIRE_BYTES,
  encodeRideMessage,
  parseRideMessage,
  serializeRideMessage,
} from '../src/connectivity/protocol/rideMessageCodec';
import { MAX_JSON_VALUE_DEPTH } from '../src/connectivity/protocol/jsonValue';
import {
  RIDE_MESSAGE_MAX_HOP_LIMIT,
  RIDE_MESSAGE_MAX_ID_LENGTH,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  RIDE_MESSAGE_MAX_RIDE_ID_LENGTH,
  RIDE_MESSAGE_MAX_TTL_MS,
  createRideMessage,
  relayRideMessage,
  type RideMessage,
} from '../src/connectivity/protocol/rideMessage';

const NOW = 1_700_000_000_000;
const TTL = 30_000;

function message(overrides: Partial<Parameters<typeof createRideMessage>[0]> = {}) {
  return createRideMessage({
    id: 'msg-1',
    rideId: '12345',
    originId: 'node-a',
    type: 'hazard',
    priority: 'high',
    payload: { hazard: 'pothole' } as Record<string, unknown>,
    ttlMs: TTL,
    maxHops: 3,
    now: NOW,
    ...overrides,
  });
}

/** A raw wire object, bypassing serializeRideMessage so invalid shapes can be produced. */
function rawWire(overrides: Record<string, unknown> = {}, omit: string[] = []): string {
  const wire: Record<string, unknown> = {
    v: 1,
    id: 'msg-1',
    rideId: '12345',
    originId: 'node-a',
    type: 'hazard',
    priority: 'high',
    createdAt: NOW,
    expiresAt: NOW + TTL,
    hopCount: 0,
    maxHops: 3,
    payload: { hazard: 'pothole' },
    ...overrides,
  };
  for (const key of omit) {
    delete wire[key];
  }
  return JSON.stringify(wire);
}

function nested(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  return value;
}

describe('RideMessage codec: outbound', () => {
  test('serializes the exact golden v1 wire form in fixed field order', () => {
    expect(serializeRideMessage(message())).toBe(
      `{"v":1,"id":"msg-1","rideId":"12345","originId":"node-a","type":"hazard",` +
        `"priority":"high","createdAt":${NOW},"expiresAt":${NOW + TTL},"hopCount":0,` +
        `"maxHops":3,"payload":{"hazard":"pothole"}}`,
    );
  });

  test('does not leak non-protocol fields from the in-memory object', () => {
    const withExtra = { ...message(), secret: 'local-only' } as RideMessage;
    expect(serializeRideMessage(withExtra)).not.toContain('secret');
  });

  test('encodes UTF-8 bytes of the serialized form', () => {
    const m = message({ payload: { note: 'Café ⚠️' } });
    expect(new TextDecoder().decode(encodeRideMessage(m))).toBe(serializeRideMessage(m));
  });

  test.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['function', () => 1],
    ['NaN', NaN],
    ['Date', new Date(NOW)],
    ['Map', new Map()],
    ['BigInt', BigInt(1)],
    ['nested undefined', { a: undefined }],
  ])('throws TypeError for a %s payload', (_label, payload) => {
    expect(() => serializeRideMessage({ ...message(), payload })).toThrow(TypeError);
  });

  test('throws TypeError for a cyclic payload', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serializeRideMessage({ ...message(), payload: cyclic })).toThrow(TypeError);
  });

  test('throws TypeError for a structurally invalid envelope', () => {
    expect(() => serializeRideMessage({ ...message(), hopCount: 4 })).toThrow(TypeError);
    expect(() => serializeRideMessage({ ...message(), priority: 'urgent' } as never)).toThrow(
      TypeError,
    );
  });
});

describe('RideMessage codec: round-trip', () => {
  test('string round-trip', () => {
    const m = message();
    expect(parseRideMessage(serializeRideMessage(m), NOW)).toEqual(m);
  });

  test('Uint8Array round-trip, including multi-byte payload text', () => {
    const m = message({ type: 'sos', priority: 'critical', payload: { note: 'Café ⚠️ 🏍️' } });
    expect(parseRideMessage(encodeRideMessage(m), NOW)).toEqual(m);
  });

  test('relayed copy round-trips with its hop count', () => {
    const relayed = relayRideMessage(message(), NOW)!;
    expect(parseRideMessage(encodeRideMessage(relayed), NOW)).toEqual({ ...relayed, hopCount: 1 });
  });

  test('accepts scalar and empty payloads', () => {
    for (const payload of [{}, [], 0, false, '']) {
      expect(parseRideMessage(rawWire({ payload }), NOW)?.payload).toEqual(payload);
    }
  });

  test('drops unknown top-level fields', () => {
    const parsed = parseRideMessage(rawWire({ extra: 'x' }), NOW)!;
    expect(parsed).not.toHaveProperty('extra');
    expect(Object.keys(parsed)).toHaveLength(11);
  });
});

describe('RideMessage codec: ingress structural validation', () => {
  test('accepts the baseline raw wire object', () => {
    expect(parseRideMessage(rawWire(), NOW)).not.toBeNull();
  });

  test.each(['{', '{"v":1', 'not json', '', '\u0000', "{'v':1}", '{"v":1,}'])(
    'rejects malformed JSON %p',
    text => {
      expect(parseRideMessage(text, NOW)).toBeNull();
    },
  );

  test.each(['null', '[]', '"msg"', '42', 'true'])('rejects non-object top level %p', text => {
    expect(parseRideMessage(text, NOW)).toBeNull();
  });

  test.each([0, 2, '1', null, true])('rejects protocol version %p', v => {
    expect(parseRideMessage(rawWire({ v }), NOW)).toBeNull();
  });

  test('rejects a missing protocol version', () => {
    expect(parseRideMessage(rawWire({}, ['v']), NOW)).toBeNull();
  });

  test.each(['unknown', 'HAZARD', '', 1, null, 'constructor', '__proto__', 'toString'])(
    'rejects message type %p',
    type => {
      expect(parseRideMessage(rawWire({ type }), NOW)).toBeNull();
    },
  );

  test.each(['urgent', 'CRITICAL', '', 0, null])('rejects priority %p', priority => {
    expect(parseRideMessage(rawWire({ priority }), NOW)).toBeNull();
  });

  describe.each([
    ['id', RIDE_MESSAGE_MAX_ID_LENGTH],
    ['rideId', RIDE_MESSAGE_MAX_RIDE_ID_LENGTH],
    ['originId', RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH],
  ] as const)('%s', (field, max) => {
    test(`accepts exactly ${max} characters`, () => {
      expect(parseRideMessage(rawWire({ [field]: 'x'.repeat(max) }), NOW)?.[field]).toBe(
        'x'.repeat(max),
      );
    });

    test.each<unknown>(['', 'x'.repeat(max + 1), 123, null, ['a'], { a: 1 }])(
      'rejects %p',
      value => {
        expect(parseRideMessage(rawWire({ [field]: value }), NOW)).toBeNull();
      },
    );

    test('rejects when missing', () => {
      expect(parseRideMessage(rawWire({}, [field]), NOW)).toBeNull();
    });
  });

  describe.each(['createdAt', 'expiresAt'] as const)('%s', field => {
    test.each<unknown>([-1, 1.5, String(NOW), null, true, 2 ** 53])('rejects %p', value => {
      expect(parseRideMessage(rawWire({ [field]: value }), NOW)).toBeNull();
    });

    test('rejects an overflowing number literal (parses to Infinity)', () => {
      const text = rawWire({ [field]: 'SENTINEL' }).replace('"SENTINEL"', '1e999');
      expect(text).toContain(`"${field}":1e999`);
      expect(parseRideMessage(text, NOW)).toBeNull();
    });

    test('rejects when missing', () => {
      expect(parseRideMessage(rawWire({}, [field]), NOW)).toBeNull();
    });
  });

  test('requires expiresAt strictly after createdAt', () => {
    expect(parseRideMessage(rawWire({ expiresAt: NOW }), NOW)).toBeNull();
    expect(parseRideMessage(rawWire({ expiresAt: NOW - 1 }), NOW)).toBeNull();
    expect(parseRideMessage(rawWire({ expiresAt: NOW + 1 }), NOW)?.expiresAt).toBe(NOW + 1);
  });

  test('accepts TTL exactly at the protocol maximum and rejects 1 ms above it', () => {
    expect(
      parseRideMessage(rawWire({ expiresAt: NOW + RIDE_MESSAGE_MAX_TTL_MS }), NOW),
    ).not.toBeNull();
    expect(
      parseRideMessage(rawWire({ expiresAt: NOW + RIDE_MESSAGE_MAX_TTL_MS + 1 }), NOW),
    ).toBeNull();
  });

  test.each<unknown>([-1, 1.5, '0', null])('rejects hopCount %p', hopCount => {
    expect(parseRideMessage(rawWire({ hopCount }), NOW)).toBeNull();
  });

  test('rejects a missing hopCount', () => {
    expect(parseRideMessage(rawWire({}, ['hopCount']), NOW)).toBeNull();
  });

  test('accepts hopCount == maxHops and rejects hopCount > maxHops', () => {
    expect(parseRideMessage(rawWire({ hopCount: 3, maxHops: 3 }), NOW)?.hopCount).toBe(3);
    expect(parseRideMessage(rawWire({ hopCount: 4, maxHops: 3 }), NOW)).toBeNull();
  });

  test('accepts maxHops at both protocol limits', () => {
    expect(parseRideMessage(rawWire({ maxHops: 0 }), NOW)?.maxHops).toBe(0);
    expect(
      parseRideMessage(rawWire({ maxHops: RIDE_MESSAGE_MAX_HOP_LIMIT }), NOW)?.maxHops,
    ).toBe(RIDE_MESSAGE_MAX_HOP_LIMIT);
  });

  test.each<unknown>([-1, RIDE_MESSAGE_MAX_HOP_LIMIT + 1, 1.5, '3', null])(
    'rejects maxHops %p',
    maxHops => {
      expect(parseRideMessage(rawWire({ maxHops }), NOW)).toBeNull();
    },
  );

  test('rejects a missing or null payload', () => {
    expect(parseRideMessage(rawWire({}, ['payload']), NOW)).toBeNull();
    expect(parseRideMessage(rawWire({ payload: null }), NOW)).toBeNull();
  });

  test('bounds payload nesting depth', () => {
    expect(parseRideMessage(rawWire({ payload: nested(MAX_JSON_VALUE_DEPTH) }), NOW)).not.toBeNull();
    expect(parseRideMessage(rawWire({ payload: nested(MAX_JSON_VALUE_DEPTH + 1) }), NOW)).toBeNull();
  });

  test('rejects a payload number literal that overflows to Infinity', () => {
    const text = rawWire({ payload: { n: 1 } }).replace('"n":1', '"n":1e999');
    expect(text).toContain('"n":1e999');
    expect(parseRideMessage(text, NOW)).toBeNull();
  });
});

describe('RideMessage codec: clock skew and expiry', () => {
  test('accepts createdAt exactly RIDE_MESSAGE_MAX_FUTURE_SKEW_MS ahead, unchanged', () => {
    const ahead = message({ now: NOW + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS });
    const parsed = parseRideMessage(serializeRideMessage(ahead), NOW);

    expect(parsed).toEqual(ahead);
    expect(parsed?.expiresAt).toBe(NOW + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS + TTL);
  });

  test('rejects createdAt 1 ms beyond the future-skew tolerance', () => {
    const ahead = message({ now: NOW + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS + 1 });
    expect(parseRideMessage(serializeRideMessage(ahead), NOW)).toBeNull();
  });

  test('accepts one ms before expiresAt and rejects exactly at it', () => {
    const encoded = serializeRideMessage(message());

    expect(parseRideMessage(encoded, NOW + TTL - 1)).not.toBeNull();
    expect(parseRideMessage(encoded, NOW + TTL)).toBeNull();
    expect(parseRideMessage(encoded, NOW + TTL + 1)).toBeNull();
  });

  test('applies no expiry grace to a sender whose clock lags by the full TTL', () => {
    expect(parseRideMessage(serializeRideMessage(message({ now: NOW - TTL })), NOW)).toBeNull();
    expect(
      parseRideMessage(serializeRideMessage(message({ now: NOW - TTL + 1 })), NOW),
    ).not.toBeNull();
  });

  test('skew plus maximum TTL bounds how long a message can stay acceptable', () => {
    const latest = NOW + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS;
    const encoded = serializeRideMessage(
      message({ now: latest, ttlMs: RIDE_MESSAGE_MAX_TTL_MS }),
    );
    const bound = NOW + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS + RIDE_MESSAGE_MAX_TTL_MS;

    expect(parseRideMessage(encoded, NOW)?.expiresAt).toBe(bound);
    expect(parseRideMessage(encoded, bound - 1)).not.toBeNull();
    expect(parseRideMessage(encoded, bound)).toBeNull();
  });

  test.each([NaN, Infinity, -1, 1.5])('rejects everything when receiver now is %p', now => {
    expect(parseRideMessage(serializeRideMessage(message()), now)).toBeNull();
  });
});

describe('RideMessage codec: wire size bound', () => {
  /** A valid message whose ASCII encoding is exactly `bytes` long. */
  function messageOfSize(bytes: number, padChar = 'x') {
    const base = serializeRideMessage(message({ payload: { pad: '' } })).length;
    return message({ payload: { pad: padChar.repeat(bytes - base) } });
  }

  test('accepts a packet of exactly RIDE_MESSAGE_MAX_WIRE_BYTES', () => {
    const m = messageOfSize(RIDE_MESSAGE_MAX_WIRE_BYTES);
    const encoded = encodeRideMessage(m);

    expect(encoded.byteLength).toBe(RIDE_MESSAGE_MAX_WIRE_BYTES);
    expect(parseRideMessage(encoded, NOW)).toEqual(m);
    expect(parseRideMessage(serializeRideMessage(m), NOW)).toEqual(m);
  });

  test('refuses to serialize one byte over the limit', () => {
    expect(() => serializeRideMessage(messageOfSize(RIDE_MESSAGE_MAX_WIRE_BYTES + 1))).toThrow(
      RangeError,
    );
  });

  test('rejects a wire packet one byte over the limit, as string and bytes', () => {
    const tooBig = rawWire().replace(/}$/, ' }');
    const padded = tooBig.replace(
      '"pothole"',
      `"pothole${'x'.repeat(RIDE_MESSAGE_MAX_WIRE_BYTES + 1 - tooBig.length)}"`,
    );
    expect(new TextEncoder().encode(padded).byteLength).toBe(RIDE_MESSAGE_MAX_WIRE_BYTES + 1);

    expect(parseRideMessage(padded, NOW)).toBeNull();
    expect(parseRideMessage(new TextEncoder().encode(padded), NOW)).toBeNull();
  });

  test('measures strings in UTF-8 bytes, not code units', () => {
    // Fits by .length but each "é" is two UTF-8 bytes.
    const base = serializeRideMessage(message({ payload: { pad: '' } })).length;
    const text = rawWire({ payload: { pad: 'é'.repeat(RIDE_MESSAGE_MAX_WIRE_BYTES - base) } });

    expect(text.length).toBe(RIDE_MESSAGE_MAX_WIRE_BYTES);
    expect(parseRideMessage(text, NOW)).toBeNull();
  });

  test('rejects an oversized byte array without needing valid content', () => {
    expect(parseRideMessage(new Uint8Array(RIDE_MESSAGE_MAX_WIRE_BYTES + 1), NOW)).toBeNull();
  });
});

describe('RideMessage codec: parser never throws', () => {
  const malformed: unknown[] = [
    '',
    ' ',
    'null',
    'undefined',
    '{"__proto__":{"polluted":true}}',
    `{"payload":${'['.repeat(10_000)}`,
    '['.repeat(RIDE_MESSAGE_MAX_WIRE_BYTES),
    'x'.repeat(10 * RIDE_MESSAGE_MAX_WIRE_BYTES),
    new Uint8Array(0),
    new Uint8Array([0xff, 0xfe, 0xfd]),
    new Uint8Array([0x7b, 0xc3]), // "{" then a truncated two-byte sequence
    new Uint16Array([0x7b7b]),
    null,
    undefined,
    42,
    {},
    [],
  ];

  test.each(malformed)('returns null for %p', input => {
    expect(() => parseRideMessage(input as string, NOW)).not.toThrow();
    expect(parseRideMessage(input as string, NOW)).toBeNull();
  });

  test('does not pollute Object.prototype', () => {
    parseRideMessage('{"__proto__":{"polluted":true}}', NOW);
    parseRideMessage(rawWire().replace('"payload":{', '"payload":{"__proto__":{"polluted":true},'), NOW);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('rejects invalid UTF-8 inside an otherwise valid packet', () => {
    const bytes = new TextEncoder().encode(rawWire());
    const idStart = new TextDecoder().decode(bytes).indexOf('msg-1');
    const corrupted = bytes.slice();
    corrupted[idStart] = 0xff;

    expect(parseRideMessage(corrupted, NOW)).toBeNull();
  });

  test('every truncation of a valid packet returns null without throwing', () => {
    const bytes = encodeRideMessage(message());
    const text = serializeRideMessage(message());
    for (let length = 0; length < bytes.byteLength; length++) {
      expect(parseRideMessage(bytes.subarray(0, length), NOW)).toBeNull();
      expect(parseRideMessage(text.slice(0, length), NOW)).toBeNull();
    }
  });
});
