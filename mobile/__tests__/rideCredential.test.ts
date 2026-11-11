/// <reference types="node" />
import {
  createHash,
  randomBytes,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'crypto';
import {
  decodeBase64Url,
  encodeBase64Url,
} from '../src/connectivity/protocol/base64url';
import { isRoomCode } from '../src/utils/roomCode';
import {
  RIDE_CREDENTIAL_DOMAIN,
  RIDE_CREDENTIAL_KEY_NO_RETIREMENT,
  RIDE_CREDENTIAL_KID_PATTERN,
  RIDE_CREDENTIAL_MAX_LIFETIME_MS,
  RIDE_CREDENTIAL_NOT_BEFORE_TOLERANCE_MS,
  RIDE_CREDENTIAL_SESSION_ID_BYTES,
  RIDE_CREDENTIAL_SESSION_ID_CHARS,
  RIDE_CREDENTIAL_VERSION,
  createRideCredentialVerifier,
  deriveRideNodeId,
  isCanonicalRideNodeId,
  isCanonicalRideSessionId,
  isValidRideCredentialKid,
  isValidRideCredentialRideId,
  parseRideCredential,
  rideCredentialSigningInput,
  type RideCredential,
  type RideCredentialRejection,
  type RideCredentialTrustedKey,
  type UnsignedRideCredential,
} from '../src/connectivity/protocol/rideCredential';

const RIDE = '54321';
const KID = 'srv-2026-11a';
/** 16 server-issued bytes 0x00..0x0f. */
const SESSION_ID = 'AAECAwQFBgcICQoLDA0ODw';
/** A different, equally valid session id (bytes 0xff..0xf0): "a previous ride of the same room". */
const OTHER_SESSION_ID = '__79_Pv6-fj39vX08_Lx8A';
const ISSUED_AT = 1_700_000_000_000;
const LIFETIME = 72 * 60 * 60 * 1000;
const EXPIRES_AT = ISSUED_AT + LIFETIME;
const TOLERANCE = RIDE_CREDENTIAL_NOT_BEFORE_TOLERANCE_MS;

// ---- real P-256 material ---------------------------------------------------------------------

interface KeyPair {
  readonly privateKey: KeyObject;
  /** 65-byte uncompressed point, as a plain Uint8Array. */
  readonly publicKey: Uint8Array;
}

function newKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(Buffer.from(jwk.x as string, 'base64url'), 1);
  point.set(Buffer.from(jwk.y as string, 'base64url'), 33);
  return { privateKey, publicKey: point };
}

function publicKeyObject(point: Uint8Array): KeyObject {
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(point.subarray(1, 33)).toString('base64url'),
      y: Buffer.from(point.subarray(33, 65)).toString('base64url'),
    },
    format: 'jwk',
  });
}

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

const verifySignature = (
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
) =>
  nodeVerify(
    'sha256',
    message,
    { key: publicKeyObject(publicKey), dsaEncoding: 'ieee-p1363' },
    signature,
  );

function signText(text: string, privateKey: KeyObject): Uint8Array {
  return new Uint8Array(
    nodeSign('sha256', Buffer.from(text, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }),
  );
}

const server = newKeyPair();
const otherServer = newKeyPair();
const device = newKeyPair();
const otherDevice = newKeyPair();

const nodeIdOf = (key: KeyPair) => deriveRideNodeId(key.publicKey, sha256);

/** A canonical-looking (43 valid characters, zero trailing bits) node id that belongs to no key. */
const WRONG_NODE_ID = 'A'.repeat(43);

const KEY_NOT_BEFORE = ISSUED_AT - 24 * 60 * 60 * 1000;
const KEY_NOT_AFTER = ISSUED_AT + 30 * 24 * 60 * 60 * 1000;

/** A trusted server key with a generous issuance window around ISSUED_AT. */
function trusted(
  key: KeyPair,
  overrides: Partial<RideCredentialTrustedKey> = {},
): RideCredentialTrustedKey {
  return {
    publicKey: key.publicKey,
    notBefore: KEY_NOT_BEFORE,
    notAfter: KEY_NOT_AFTER,
    ...overrides,
  };
}

function unsigned(
  overrides: Partial<UnsignedRideCredential> = {},
): UnsignedRideCredential {
  return {
    v: RIDE_CREDENTIAL_VERSION,
    kid: KID,
    rideId: RIDE,
    sessionId: SESSION_ID,
    nodeId: nodeIdOf(device),
    pub: encodeBase64Url(device.publicKey),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/** A credential signed by `signer` over exactly the fields given. */
function signed(
  overrides: Partial<UnsignedRideCredential> = {},
  signer: KeyPair = server,
): RideCredential {
  const body = unsigned(overrides);
  return {
    ...body,
    sig: encodeBase64Url(
      signText(rideCredentialSigningInput(body), signer.privateKey),
    ),
  };
}

function makeVerifier(
  overrides: Partial<{
    rideId: string;
    sessionId: string;
    keys: Map<string, RideCredentialTrustedKey>;
    verifySignature: jest.Mock;
    sha256: jest.Mock;
  }> = {},
) {
  const verifySpy = overrides.verifySignature ?? jest.fn(verifySignature);
  const shaSpy = overrides.sha256 ?? jest.fn(sha256);
  const verifier = createRideCredentialVerifier({
    rideId: overrides.rideId ?? RIDE,
    sessionId: overrides.sessionId ?? SESSION_ID,
    keys: overrides.keys ?? new Map([[KID, trusted(server)]]),
    verifySignature: verifySpy,
    sha256: shaSpy,
  });
  return { verifier, verifySpy, shaSpy };
}

const NOW = ISSUED_AT + 60_000;

// ---- constants -------------------------------------------------------------------------------

describe('constants', () => {
  it('match the approved design', () => {
    expect(RIDE_CREDENTIAL_VERSION).toBe(1);
    expect(RIDE_CREDENTIAL_DOMAIN).toBe('rideaze.ride-credential.v1');
    expect(RIDE_CREDENTIAL_MAX_LIFETIME_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(RIDE_CREDENTIAL_NOT_BEFORE_TOLERANCE_MS).toBe(300_000);
  });
});

// ---- signing input ---------------------------------------------------------------------------

describe('rideCredentialSigningInput', () => {
  const FIXED: UnsignedRideCredential = {
    v: 1,
    kid: 'srv-1',
    rideId: '12345',
    sessionId: 'AAECAwQFBgcICQoLDA0ODw',
    nodeId: 'node-1',
    pub: 'pub-1',
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
  };

  it('is byte-stable', () => {
    expect(rideCredentialSigningInput(FIXED)).toBe(
      '{"domain":"rideaze.ride-credential.v1","v":1,"kid":"srv-1","rideId":"12345",' +
        '"sessionId":"AAECAwQFBgcICQoLDA0ODw","nodeId":"node-1","pub":"pub-1",' +
        '"issuedAt":1700000000000,"expiresAt":1700000060000}',
    );
  });

  it('does not depend on the key order of the input object', () => {
    const reversed = Object.fromEntries(
      Object.entries(FIXED).reverse(),
    ) as unknown as UnsignedRideCredential;
    expect(rideCredentialSigningInput(reversed)).toBe(
      rideCredentialSigningInput(FIXED),
    );
  });

  it('ignores a signature or any other extra field', () => {
    const withExtras = {
      ...FIXED,
      sig: 'ignored',
      extra: 1,
    } as unknown as UnsignedRideCredential;
    expect(rideCredentialSigningInput(withExtras)).toBe(
      rideCredentialSigningInput(FIXED),
    );
  });

  it('changes when any signed field changes', () => {
    const base = rideCredentialSigningInput(FIXED);
    const changes: Partial<UnsignedRideCredential>[] = [
      { kid: 'srv-2' },
      { rideId: '12346' },
      { sessionId: OTHER_SESSION_ID },
      { nodeId: 'node-2' },
      { pub: 'pub-2' },
      { issuedAt: FIXED.issuedAt + 1 },
      { expiresAt: FIXED.expiresAt + 1 },
    ];
    for (const change of changes) {
      expect(rideCredentialSigningInput({ ...FIXED, ...change })).not.toBe(
        base,
      );
    }
  });
});

// ---- node id derivation ----------------------------------------------------------------------

describe('deriveRideNodeId', () => {
  it('is base64url(SHA-256(pub)), 43 characters', () => {
    const id = deriveRideNodeId(device.publicKey, sha256);
    expect(id).toHaveLength(43);
    expect(id).toBe(
      createHash('sha256').update(device.publicKey).digest('base64url'),
    );
  });

  it('is deterministic and distinct per key', () => {
    expect(deriveRideNodeId(device.publicKey, sha256)).toBe(
      deriveRideNodeId(Uint8Array.from(device.publicKey), sha256),
    );
    expect(deriveRideNodeId(device.publicKey, sha256)).not.toBe(
      deriveRideNodeId(otherDevice.publicKey, sha256),
    );
  });

  it('rejects keys that are not 65-byte uncompressed points', () => {
    expect(() =>
      deriveRideNodeId(device.publicKey.subarray(0, 64), sha256),
    ).toThrow(RangeError);
    expect(() => deriveRideNodeId(new Uint8Array(66).fill(4), sha256)).toThrow(
      RangeError,
    );
    const compressedPrefix = Uint8Array.from(device.publicKey);
    compressedPrefix[0] = 0x02;
    expect(() => deriveRideNodeId(compressedPrefix, sha256)).toThrow(
      RangeError,
    );
    expect(() =>
      deriveRideNodeId('key' as unknown as Uint8Array, sha256),
    ).toThrow(RangeError);
  });

  it('rejects a sha256 that is missing or returns the wrong thing', () => {
    expect(() =>
      deriveRideNodeId(device.publicKey, undefined as never),
    ).toThrow(TypeError);
    expect(() =>
      deriveRideNodeId(device.publicKey, () => new Uint8Array(31)),
    ).toThrow(TypeError);
    expect(() =>
      deriveRideNodeId(device.publicKey, () => 'digest' as never),
    ).toThrow(TypeError);
  });

  it('lets an exception from sha256 propagate (programmer error)', () => {
    expect(() =>
      deriveRideNodeId(device.publicKey, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });
});

// ---- parsing ---------------------------------------------------------------------------------

describe('parseRideCredential', () => {
  const valid = () => signed() as unknown as Record<string, unknown>;

  it('accepts a valid credential and returns a frozen copy of exactly the protocol fields', () => {
    const input = valid();
    const parsed = parseRideCredential(input);
    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.keys(parsed as object).sort()).toEqual(
      [
        'expiresAt',
        'issuedAt',
        'kid',
        'nodeId',
        'pub',
        'rideId',
        'sessionId',
        'sig',
        'v',
      ].sort(),
    );
  });

  it('returns a copy: later changes to the input do not affect the result', () => {
    const input = valid();
    const parsed = parseRideCredential(input) as RideCredential;
    input.kid = 'changed';
    expect(parsed.kid).toBe(KID);
  });

  it('accepts the exact boundaries: 1 ms and 7 days of lifetime, 64-char kid, lowest and highest room code', () => {
    expect(
      parseRideCredential({ ...valid(), expiresAt: ISSUED_AT + 1 }),
    ).not.toBeNull();
    expect(
      parseRideCredential({
        ...valid(),
        expiresAt: ISSUED_AT + RIDE_CREDENTIAL_MAX_LIFETIME_MS,
      }),
    ).not.toBeNull();
    expect(
      parseRideCredential({ ...valid(), kid: 'k'.repeat(64) }),
    ).not.toBeNull();
    expect(parseRideCredential({ ...valid(), rideId: '10000' })).not.toBeNull();
    expect(parseRideCredential({ ...valid(), rideId: '99999' })).not.toBeNull();
    expect(
      parseRideCredential({ ...valid(), nodeId: WRONG_NODE_ID }),
    ).not.toBeNull();
  });

  const u8 = (length: number, first = 0x04) => {
    const bytes = new Uint8Array(length).fill(7);
    bytes[0] = first;
    return bytes;
  };

  const malformed: [string, () => unknown][] = [
    ['null', () => null],
    ['undefined', () => undefined],
    ['a string', () => 'credential'],
    ['a number', () => 7],
    ['an array', () => [valid()]],
    ['an extra key', () => ({ ...valid(), extra: 1 })],
    ['a missing kid', () => ({ ...valid(), kid: undefined })],
    [
      'a missing sig',
      () => {
        const rest = valid();
        delete rest.sig;
        return rest;
      },
    ],
    ['version 2', () => ({ ...valid(), v: 2 })],
    ['version as a string', () => ({ ...valid(), v: '1' })],
    ['an empty kid', () => ({ ...valid(), kid: '' })],
    ['a 65-character kid', () => ({ ...valid(), kid: 'k'.repeat(65) })],
    ['a non-string kid', () => ({ ...valid(), kid: 5 })],
    ['an empty rideId', () => ({ ...valid(), rideId: '' })],
    ['a 65-character rideId', () => ({ ...valid(), rideId: 'r'.repeat(65) })],
    ['an empty nodeId', () => ({ ...valid(), nodeId: '' })],
    ['a 65-character nodeId', () => ({ ...valid(), nodeId: 'n'.repeat(65) })],
    ['a 64-byte pub', () => ({ ...valid(), pub: encodeBase64Url(u8(64)) })],
    ['a 66-byte pub', () => ({ ...valid(), pub: encodeBase64Url(u8(66)) })],
    [
      'a compressed-prefix pub',
      () => ({ ...valid(), pub: encodeBase64Url(u8(65, 0x02)) }),
    ],
    [
      'a zero-prefix pub',
      () => ({ ...valid(), pub: encodeBase64Url(u8(65, 0x00)) }),
    ],
    [
      'a padded pub',
      () => ({ ...valid(), pub: `${encodeBase64Url(u8(65))}=` }),
    ],
    ['a standard-alphabet pub', () => ({ ...valid(), pub: 'A+/'.repeat(29) })],
    ['a non-string pub', () => ({ ...valid(), pub: u8(65) })],
    ['a 63-byte sig', () => ({ ...valid(), sig: encodeBase64Url(u8(63)) })],
    ['a 65-byte sig', () => ({ ...valid(), sig: encodeBase64Url(u8(65)) })],
    ['a DER-length sig', () => ({ ...valid(), sig: encodeBase64Url(u8(71)) })],
    [
      'a padded sig',
      () => ({ ...valid(), sig: `${encodeBase64Url(u8(64))}==` }),
    ],
    ['an empty sig', () => ({ ...valid(), sig: '' })],
    ['a non-string sig', () => ({ ...valid(), sig: 5 })],
    [
      'a fractional issuedAt',
      () => ({ ...valid(), issuedAt: ISSUED_AT + 0.5 }),
    ],
    [
      'a negative issuedAt',
      () => ({ ...valid(), issuedAt: -1, expiresAt: 1000 }),
    ],
    ['a string issuedAt', () => ({ ...valid(), issuedAt: String(ISSUED_AT) })],
    ['a NaN expiresAt', () => ({ ...valid(), expiresAt: Number.NaN })],
    ['an infinite expiresAt', () => ({ ...valid(), expiresAt: Infinity })],
    [
      'expiresAt equal to issuedAt',
      () => ({ ...valid(), expiresAt: ISSUED_AT }),
    ],
    [
      'expiresAt before issuedAt',
      () => ({ ...valid(), expiresAt: ISSUED_AT - 1 }),
    ],
    [
      'a lifetime of 7 days + 1 ms',
      () => ({
        ...valid(),
        expiresAt: ISSUED_AT + RIDE_CREDENTIAL_MAX_LIFETIME_MS + 1,
      }),
    ],
    [
      'a throwing getter',
      () => {
        const hostile = { ...valid() };
        Object.defineProperty(hostile, 'kid', {
          enumerable: true,
          get() {
            throw new Error('hostile getter');
          },
        });
        return hostile;
      },
    ],
    [
      'a throwing proxy',
      () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('hostile proxy');
            },
          },
        ),
    ],
  ];

  it.each(malformed)('rejects %s without throwing', (_label, build) => {
    expect(() => parseRideCredential(build())).not.toThrow();
    expect(parseRideCredential(build())).toBeNull();
  });
});

// ---- verifier construction -------------------------------------------------------------------

describe('createRideCredentialVerifier construction', () => {
  const base = () => ({
    rideId: RIDE,
    sessionId: SESSION_ID,
    keys: new Map([[KID, trusted(server)]]),
    verifySignature,
    sha256,
  });

  it('rejects invalid options as programmer errors', () => {
    expect(() =>
      createRideCredentialVerifier({ ...base(), rideId: '' }),
    ).toThrow(TypeError);
    expect(() =>
      createRideCredentialVerifier({ ...base(), rideId: 'r'.repeat(65) }),
    ).toThrow(TypeError);
    expect(() =>
      createRideCredentialVerifier({ ...base(), keys: {} as never }),
    ).toThrow(TypeError);
    expect(() =>
      createRideCredentialVerifier({ ...base(), verifySignature: 1 as never }),
    ).toThrow(TypeError);
    expect(() =>
      createRideCredentialVerifier({ ...base(), sha256: undefined as never }),
    ).toThrow(TypeError);
  });

  it('rejects keys that are not 65-byte uncompressed points or have bad ids', () => {
    expect(() =>
      createRideCredentialVerifier({
        ...base(),
        keys: new Map([
          [
            KID,
            trusted(server, { publicKey: server.publicKey.subarray(0, 64) }),
          ],
        ]),
      }),
    ).toThrow(TypeError);
    const compressed = Uint8Array.from(server.publicKey);
    compressed[0] = 0x03;
    expect(() =>
      createRideCredentialVerifier({
        ...base(),
        keys: new Map([[KID, trusted(server, { publicKey: compressed })]]),
      }),
    ).toThrow(TypeError);
    for (const badKid of ['', '-x', 'k'.repeat(65), 'ключ']) {
      expect(() =>
        createRideCredentialVerifier({
          ...base(),
          keys: new Map([[badKid, trusted(server)]]),
        }),
      ).toThrow(TypeError);
    }
  });

  it('snapshots the key set: later changes to the caller map, entry or buffer do not alter trust', () => {
    const entry = {
      publicKey: Uint8Array.from(server.publicKey),
      notBefore: KEY_NOT_BEFORE,
      notAfter: KEY_NOT_AFTER,
    };
    const keys = new Map<string, RideCredentialTrustedKey>([[KID, entry]]);
    const { verifier } = makeVerifier({ keys });
    entry.publicKey[5] = (entry.publicKey[5] + 1) % 256;
    (entry as { notAfter: number }).notAfter = 0;
    (entry as { notBefore: number }).notBefore = Number.MAX_SAFE_INTEGER;
    keys.delete(KID);
    keys.set('attacker', trusted(otherServer));
    expect(verifier.verify(signed(), NOW).ok).toBe(true);
    expect(
      verifier.verify(signed({ kid: 'attacker' }, otherServer), NOW),
    ).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });
});

// ---- verification ----------------------------------------------------------------------------

describe('RideCredentialVerifier.verify', () => {
  it('accepts a correctly signed credential', () => {
    const { verifier, verifySpy } = makeVerifier();
    const credential = signed();
    const result = verifier.verify(credential, NOW);
    expect(result).toEqual({ ok: true, credential });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      Object.isFrozen((result as { credential: RideCredential }).credential),
    ).toBe(true);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('verifies the server key for the kid over the signing-input bytes and the decoded signature', () => {
    const { verifier, verifySpy } = makeVerifier();
    const credential = signed();
    verifier.verify(credential, NOW);
    const [publicKey, message, signature] = verifySpy.mock.calls[0];
    expect(Array.from(publicKey)).toEqual(Array.from(server.publicKey));
    expect(Buffer.from(message).toString('utf8')).toBe(
      rideCredentialSigningInput(credential),
    );
    expect(Array.from(signature)).toEqual(
      Array.from(decodeBase64Url(credential.sig) as Uint8Array),
    );
    expect(signature).toHaveLength(64);
  });

  it('selects the server key by kid when several are trusted', () => {
    const { verifier } = makeVerifier({
      keys: new Map([
        ['old', trusted(otherServer)],
        [KID, trusted(server)],
      ]),
    });
    expect(verifier.verify(signed(), NOW).ok).toBe(true);
    expect(verifier.verify(signed({ kid: 'old' }, otherServer), NOW).ok).toBe(
      true,
    );
  });

  const reason = (result: unknown) =>
    (result as { reason?: RideCredentialRejection }).reason;

  describe('rejections', () => {
    it.each([
      ['null', null],
      ['a string', 'credential'],
      ['an array', []],
      ['an object with an extra key', { ...signed(), extra: 1 }],
      [
        'an out-of-range lifetime',
        signed({ expiresAt: ISSUED_AT + RIDE_CREDENTIAL_MAX_LIFETIME_MS + 1 }),
      ],
    ])('invalid: %s', (_label, value) => {
      const { verifier, verifySpy } = makeVerifier();
      expect(verifier.verify(value, NOW)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it.each([Number.NaN, -1, 1.5, Infinity, '1700000000000'])(
      'invalid: unusable "now" (%p)',
      now => {
        const { verifier } = makeVerifier();
        expect(verifier.verify(signed(), now as number)).toEqual({
          ok: false,
          reason: 'invalid',
        });
      },
    );

    it('wrong_ride', () => {
      const { verifier } = makeVerifier();
      expect(verifier.verify(signed({ rideId: '99999' }), NOW)).toEqual({
        ok: false,
        reason: 'wrong_ride',
      });
    });

    it('unknown_key', () => {
      const { verifier } = makeVerifier();
      expect(verifier.verify(signed({ kid: 'srv-unknown' }), NOW)).toEqual({
        ok: false,
        reason: 'unknown_key',
      });
    });

    it('node_id_mismatch: validly signed, but the node id is not the hash of the key', () => {
      const { verifier, verifySpy } = makeVerifier();
      const credential = signed({ nodeId: nodeIdOf(otherDevice) });
      expect(verifier.verify(credential, NOW)).toEqual({
        ok: false,
        reason: 'node_id_mismatch',
      });
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('node_id_mismatch: an arbitrary node id cannot be claimed for a key', () => {
      const { verifier } = makeVerifier();
      expect(
        reason(verifier.verify(signed({ nodeId: WRONG_NODE_ID }), NOW)),
      ).toBe('node_id_mismatch');
    });

    describe('issuedAt boundary (not_yet_valid)', () => {
      it('accepts exactly issuedAt - tolerance', () => {
        const { verifier } = makeVerifier();
        expect(verifier.verify(signed(), ISSUED_AT - TOLERANCE).ok).toBe(true);
      });

      it('rejects one millisecond earlier', () => {
        const { verifier, verifySpy } = makeVerifier();
        expect(verifier.verify(signed(), ISSUED_AT - TOLERANCE - 1)).toEqual({
          ok: false,
          reason: 'not_yet_valid',
        });
        expect(verifySpy).not.toHaveBeenCalled();
      });

      it('accepts at issuedAt itself', () => {
        const { verifier } = makeVerifier();
        expect(verifier.verify(signed(), ISSUED_AT).ok).toBe(true);
      });
    });

    describe('expiresAt boundary (expired)', () => {
      it('accepts one millisecond before expiresAt', () => {
        const { verifier } = makeVerifier();
        expect(verifier.verify(signed(), EXPIRES_AT - 1).ok).toBe(true);
      });

      it('rejects exactly at expiresAt', () => {
        const { verifier, verifySpy } = makeVerifier();
        expect(verifier.verify(signed(), EXPIRES_AT)).toEqual({
          ok: false,
          reason: 'expired',
        });
        expect(verifySpy).not.toHaveBeenCalled();
      });

      it('rejects long after expiresAt', () => {
        const { verifier } = makeVerifier();
        expect(
          reason(
            verifier.verify(signed(), EXPIRES_AT + 30 * 24 * 60 * 60 * 1000),
          ),
        ).toBe('expired');
      });
    });

    describe('bad_signature', () => {
      it('a flipped signature byte', () => {
        const { verifier } = makeVerifier();
        const credential = signed();
        const sig = decodeBase64Url(credential.sig) as Uint8Array;
        sig[10] = (sig[10] + 1) % 256;
        expect(
          verifier.verify({ ...credential, sig: encodeBase64Url(sig) }, NOW),
        ).toEqual({ ok: false, reason: 'bad_signature' });
      });

      it('a signature by a different server key under the same kid', () => {
        const { verifier } = makeVerifier();
        expect(verifier.verify(signed({}, otherServer), NOW)).toEqual({
          ok: false,
          reason: 'bad_signature',
        });
      });

      it('a signature made by the device key instead of the server', () => {
        const { verifier } = makeVerifier();
        expect(reason(verifier.verify(signed({}, device), NOW))).toBe(
          'bad_signature',
        );
      });

      it.each([
        ['expiresAt extended', { expiresAt: EXPIRES_AT + 1000 }],
        ['issuedAt moved', { issuedAt: ISSUED_AT - 1000 }],
      ])('a field changed after signing (%s)', (_label, change) => {
        const { verifier } = makeVerifier();
        const credential = { ...signed(), ...change };
        expect(verifier.verify(credential, NOW)).toEqual({
          ok: false,
          reason: 'bad_signature',
        });
      });

      it('a different device key swapped in with its own matching node id', () => {
        const { verifier } = makeVerifier();
        const credential = {
          ...signed(),
          pub: encodeBase64Url(otherDevice.publicKey),
          nodeId: nodeIdOf(otherDevice),
        };
        expect(reason(verifier.verify(credential, NOW))).toBe('bad_signature');
      });

      it('a signature that is the right length but all zero', () => {
        const { verifier } = makeVerifier();
        const credential = {
          ...signed(),
          sig: encodeBase64Url(new Uint8Array(64)),
        };
        expect(reason(verifier.verify(credential, NOW))).toBe('bad_signature');
      });

      it('a truthy non-true result from verifySignature is not acceptance', () => {
        const { verifier } = makeVerifier({
          verifySignature: jest.fn(() => 'yes' as never),
        });
        expect(reason(verifier.verify(signed(), NOW))).toBe('bad_signature');
      });

      it('verifySignature returning false', () => {
        const { verifier } = makeVerifier({
          verifySignature: jest.fn(() => false),
        });
        expect(reason(verifier.verify(signed(), NOW))).toBe('bad_signature');
      });
    });
  });

  describe('failing closed on throwing crypto callbacks', () => {
    it('a throwing verifySignature is bad_signature, never acceptance', () => {
      const throwing = jest.fn(() => {
        throw new Error('native verifier crashed');
      });
      const { verifier } = makeVerifier({ verifySignature: throwing });
      let result: unknown;
      expect(() => {
        result = verifier.verify(signed(), NOW);
      }).not.toThrow();
      expect(result).toEqual({ ok: false, reason: 'bad_signature' });
      expect(throwing).toHaveBeenCalledTimes(1);
    });

    it('a throwing sha256 is bad_signature, never acceptance', () => {
      const throwing = jest.fn(() => {
        throw new Error('hash unavailable');
      });
      const { verifier, verifySpy } = makeVerifier({ sha256: throwing });
      expect(verifier.verify(signed(), NOW)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('a sha256 returning the wrong length is bad_signature', () => {
      const { verifier } = makeVerifier({
        sha256: jest.fn(() => new Uint8Array(16)),
      });
      expect(reason(verifier.verify(signed(), NOW))).toBe('bad_signature');
    });

    it('never throws for hostile input values', () => {
      const { verifier } = makeVerifier();
      const hostile = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('hostile');
          },
        },
      );
      expect(() => verifier.verify(hostile, NOW)).not.toThrow();
      expect(verifier.verify(hostile, NOW)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });
  });

  describe('check ordering', () => {
    // Each credential is broken in its own way AND carries a signature that does not verify, so
    // the reported reason shows which check ran first, and verifySignature must never be reached
    // for anything before bad_signature.
    const broken = (overrides: Partial<UnsignedRideCredential>): unknown => ({
      ...signed(overrides),
      sig: encodeBase64Url(new Uint8Array(64)),
    });

    it('a wrong-ride credential never reaches signature verification', () => {
      const { verifier, verifySpy, shaSpy } = makeVerifier();
      const result = verifier.verify(broken({ rideId: '99999' }), NOW);
      expect(reason(result)).toBe('wrong_ride');
      expect(verifySpy).not.toHaveBeenCalled();
      expect(shaSpy).not.toHaveBeenCalled();
    });

    it('wrong_ride is reported before unknown_key', () => {
      const { verifier } = makeVerifier();
      expect(
        reason(verifier.verify(broken({ rideId: '99999', kid: 'nope' }), NOW)),
      ).toBe('wrong_ride');
    });

    it('unknown_key is reported before node_id_mismatch, and skips hashing and verification', () => {
      const { verifier, verifySpy, shaSpy } = makeVerifier();
      const result = verifier.verify(
        broken({ kid: 'nope', nodeId: WRONG_NODE_ID }),
        NOW,
      );
      expect(reason(result)).toBe('unknown_key');
      expect(shaSpy).not.toHaveBeenCalled();
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('node_id_mismatch is reported before not_yet_valid and expired', () => {
      const { verifier, verifySpy } = makeVerifier();
      expect(
        reason(
          verifier.verify(
            broken({ nodeId: WRONG_NODE_ID }),
            ISSUED_AT - 10 * TOLERANCE,
          ),
        ),
      ).toBe('node_id_mismatch');
      expect(
        reason(
          verifier.verify(broken({ nodeId: WRONG_NODE_ID }), EXPIRES_AT + 1),
        ),
      ).toBe('node_id_mismatch');
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('not_yet_valid and expired are reported before bad_signature', () => {
      const { verifier, verifySpy } = makeVerifier();
      expect(
        reason(verifier.verify(broken({}), ISSUED_AT - TOLERANCE - 1)),
      ).toBe('not_yet_valid');
      expect(reason(verifier.verify(broken({}), EXPIRES_AT))).toBe('expired');
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('bad_signature is only reported once every earlier check has passed', () => {
      const { verifier, verifySpy } = makeVerifier();
      expect(reason(verifier.verify(broken({}), NOW))).toBe('bad_signature');
      expect(verifySpy).toHaveBeenCalledTimes(1);
    });

    it('invalid input is reported before anything else and skips all crypto', () => {
      const { verifier, verifySpy, shaSpy } = makeVerifier();
      expect(
        reason(
          verifier.verify({ ...signed(), extra: 1, rideId: '99999' }, NOW),
        ),
      ).toBe('invalid');
      expect(verifySpy).not.toHaveBeenCalled();
      expect(shaSpy).not.toHaveBeenCalled();
    });
  });
});

// =================================================================================================
// Task 1.1 hardening
// =================================================================================================

const reasonOf = (result: unknown) =>
  (result as { reason?: RideCredentialRejection }).reason;

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// ---- M1: server signing-key issuance window --------------------------------------------------

describe('trusted key shape', () => {
  const build = (entry: unknown) =>
    createRideCredentialVerifier({
      rideId: RIDE,
      sessionId: SESSION_ID,
      keys: new Map([[KID, entry as RideCredentialTrustedKey]]),
      verifySignature,
      sha256,
    });

  it('accepts a key with a finite window and one with no scheduled retirement', () => {
    expect(() => build(trusted(server))).not.toThrow();
    expect(() =>
      build(trusted(server, { notAfter: RIDE_CREDENTIAL_KEY_NO_RETIREMENT })),
    ).not.toThrow();
    expect(RIDE_CREDENTIAL_KEY_NO_RETIREMENT).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['the old raw-bytes shape', () => server.publicKey],
    ['null', () => null],
    ['a string', () => 'key'],
    ['no publicKey', () => ({ notBefore: 0, notAfter: 10 })],
    ['no notBefore', () => ({ publicKey: server.publicKey, notAfter: 10 })],
    ['no notAfter', () => ({ publicKey: server.publicKey, notBefore: 0 })],
    [
      'notBefore equal to notAfter',
      () => trusted(server, { notBefore: 5, notAfter: 5 }),
    ],
    [
      'notBefore after notAfter',
      () => trusted(server, { notBefore: 6, notAfter: 5 }),
    ],
    ['a fractional notBefore', () => trusted(server, { notBefore: 0.5 })],
    ['a negative notBefore', () => trusted(server, { notBefore: -1 })],
    ['an infinite notAfter', () => trusted(server, { notAfter: Infinity })],
    ['a NaN notAfter', () => trusted(server, { notAfter: Number.NaN })],
    ['a string notAfter', () => ({ ...trusted(server), notAfter: '9' })],
    [
      'a 64-byte publicKey',
      () => trusted(server, { publicKey: new Uint8Array(64).fill(4) }),
    ],
    [
      'an array publicKey',
      () => ({ ...trusted(server), publicKey: Array.from(server.publicKey) }),
    ],
  ])('rejects %s at construction', (_label, make) => {
    expect(() => build(make())).toThrow(TypeError);
  });
});

describe('server key issuance window: notBefore <= issuedAt < notAfter', () => {
  const WINDOW_START = ISSUED_AT;
  const WINDOW_END = ISSUED_AT + 1_000;
  const windowed = () =>
    makeVerifier({
      keys: new Map([
        [
          KID,
          trusted(server, { notBefore: WINDOW_START, notAfter: WINDOW_END }),
        ],
      ]),
    });
  const issuedAt = (at: number) =>
    signed({ issuedAt: at, expiresAt: at + LIFETIME });

  it('accepts a credential issued exactly at notBefore (inclusive)', () => {
    expect(
      windowed().verifier.verify(issuedAt(WINDOW_START), WINDOW_START + 1).ok,
    ).toBe(true);
  });

  it('rejects a credential issued one millisecond before notBefore as unknown_key', () => {
    const { verifier, verifySpy } = windowed();
    expect(
      verifier.verify(issuedAt(WINDOW_START - 1), WINDOW_START + 1),
    ).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('accepts a credential issued one millisecond before notAfter', () => {
    expect(
      windowed().verifier.verify(issuedAt(WINDOW_END - 1), WINDOW_END).ok,
    ).toBe(true);
  });

  it('rejects a credential issued exactly at notAfter (exclusive) as unknown_key', () => {
    const { verifier, verifySpy } = windowed();
    expect(verifier.verify(issuedAt(WINDOW_END), WINDOW_END + 1)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('rejects a credential dated ten years after the key was retired', () => {
    const TEN_YEARS = 10 * 365 * 24 * 60 * 60 * 1000;
    const { verifier } = windowed();
    expect(
      reasonOf(
        verifier.verify(
          issuedAt(WINDOW_END + TEN_YEARS),
          WINDOW_END + TEN_YEARS + 1,
        ),
      ),
    ).toBe('unknown_key');
  });

  it('keeps a credential issued before retirement valid after retirement, until its own expiry', () => {
    const { verifier } = windowed();
    const credential = issuedAt(WINDOW_END - 1);
    const expires = credential.expiresAt;
    expect(verifier.verify(credential, WINDOW_END).ok).toBe(true);
    expect(
      verifier.verify(credential, WINDOW_END + 24 * 60 * 60 * 1000).ok,
    ).toBe(true);
    expect(verifier.verify(credential, expires - 1).ok).toBe(true);
    expect(reasonOf(verifier.verify(credential, expires))).toBe('expired');
  });

  it("bounds a retired key's exposure to notAfter plus the maximum credential lifetime", () => {
    const { verifier } = windowed();
    const credential = signed({
      issuedAt: WINDOW_END - 1,
      expiresAt: WINDOW_END - 1 + RIDE_CREDENTIAL_MAX_LIFETIME_MS,
    });
    expect(
      verifier.verify(
        credential,
        WINDOW_END + RIDE_CREDENTIAL_MAX_LIFETIME_MS - 2,
      ).ok,
    ).toBe(true);
    expect(
      reasonOf(
        verifier.verify(
          credential,
          WINDOW_END - 1 + RIDE_CREDENTIAL_MAX_LIFETIME_MS,
        ),
      ),
    ).toBe('expired');
  });

  it("judges the window by issuedAt, not by the verifier's clock", () => {
    const { verifier } = windowed();
    const credential = issuedAt(WINDOW_START);
    expect(verifier.verify(credential, WINDOW_START - TOLERANCE).ok).toBe(true);
    expect(verifier.verify(credential, WINDOW_END + 3_600_000).ok).toBe(true);
  });

  it('a key with no scheduled retirement imposes no upper bound on issuedAt', () => {
    const { verifier } = makeVerifier({
      keys: new Map([
        [KID, trusted(server, { notAfter: RIDE_CREDENTIAL_KEY_NO_RETIREMENT })],
      ]),
    });
    const later = ISSUED_AT + 5 * 365 * 24 * 60 * 60 * 1000;
    expect(
      verifier.verify(
        signed({ issuedAt: later, expiresAt: later + LIFETIME }),
        later + 1,
      ).ok,
    ).toBe(true);
  });

  it('checks the window after wrong_ride and before the node id and signature checks', () => {
    const { verifier, verifySpy, shaSpy } = windowed();
    const outside = signed({
      issuedAt: WINDOW_END,
      expiresAt: WINDOW_END + LIFETIME,
      nodeId: WRONG_NODE_ID,
    });
    expect(reasonOf(verifier.verify(outside, WINDOW_END + 1))).toBe(
      'unknown_key',
    );
    expect(shaSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    const otherRide = signed({
      rideId: '99999',
      issuedAt: WINDOW_END,
      expiresAt: WINDOW_END + LIFETIME,
    });
    expect(reasonOf(verifier.verify(otherRide, WINDOW_END + 1))).toBe(
      'wrong_ride',
    );
  });

  it("applies each key's own window when several keys are trusted (rotation overlap)", () => {
    const { verifier } = makeVerifier({
      keys: new Map([
        [
          'old-key',
          trusted(otherServer, {
            notBefore: KEY_NOT_BEFORE,
            notAfter: ISSUED_AT + 1_000,
          }),
        ],
        [
          KID,
          trusted(server, {
            notBefore: ISSUED_AT + 1_000,
            notAfter: KEY_NOT_AFTER,
          }),
        ],
      ]),
    });
    const oldOk = signed(
      {
        kid: 'old-key',
        issuedAt: ISSUED_AT + 999,
        expiresAt: ISSUED_AT + 999 + LIFETIME,
      },
      otherServer,
    );
    const oldLate = signed(
      {
        kid: 'old-key',
        issuedAt: ISSUED_AT + 1_000,
        expiresAt: ISSUED_AT + 1_000 + LIFETIME,
      },
      otherServer,
    );
    const newOk = signed({
      issuedAt: ISSUED_AT + 1_000,
      expiresAt: ISSUED_AT + 1_000 + LIFETIME,
    });
    const newEarly = signed({
      issuedAt: ISSUED_AT + 999,
      expiresAt: ISSUED_AT + 999 + LIFETIME,
    });
    const at = ISSUED_AT + 2_000;
    expect(verifier.verify(oldOk, at).ok).toBe(true);
    expect(reasonOf(verifier.verify(oldLate, at))).toBe('unknown_key');
    expect(verifier.verify(newOk, at).ok).toBe(true);
    expect(reasonOf(verifier.verify(newEarly, at))).toBe('unknown_key');
  });
});

// ---- M2: explicit synchronous crypto contract ------------------------------------------------

describe('synchronous verifySignature contract', () => {
  it('an accidentally asynchronous callback that resolves true never authenticates', () => {
    const asyncVerify = jest.fn(async () => true);
    const { verifier } = makeVerifier({ verifySignature: asyncVerify });
    const result = verifier.verify(signed(), NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    expect(asyncVerify).toHaveBeenCalledTimes(1);
  });

  it('a callback returning a real, valid-looking Promise never authenticates', () => {
    const { verifier } = makeVerifier({
      verifySignature: jest.fn((k: Uint8Array, m: Uint8Array, sg: Uint8Array) =>
        Promise.resolve(verifySignature(k, m, sg)),
      ),
    });
    expect(verifier.verify(signed(), NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('attaches a rejection handler to a returned Promise so no unhandled rejection is left behind', () => {
    const pending = Promise.reject(new Error('async verifier failed'));
    // The test's own handler keeps a regression from crashing the worker with an unhandled
    // rejection; the spy below still proves the verifier attaches its own handler.
    pending.catch(() => undefined);
    const thenSpy = jest.spyOn(pending, 'then');
    const { verifier } = makeVerifier({
      verifySignature: jest.fn(() => pending as never),
    });
    expect(verifier.verify(signed(), NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(thenSpy).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  it('an async function that throws fails closed', () => {
    const { verifier } = makeVerifier({
      verifySignature: jest.fn(() => {
        const rejected = Promise.reject(new Error('native verifier crashed'));
        rejected.catch(() => undefined); // keeps a regression from crashing the worker
        return rejected as never;
      }),
    });
    expect(verifier.verify(signed(), NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('a thenable whose then accessor throws still fails closed', () => {
    const hostile = {
      get then(): never {
        throw new Error('hostile then');
      },
    };
    const { verifier } = makeVerifier({
      verifySignature: jest.fn(() => hostile as never),
    });
    expect(verifier.verify(signed(), NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it.each([
    ['1', 1],
    ['the string "true"', 'true'],
    ['an empty object', {}],
    ['an array', [true]],
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['a Boolean object', Object(true)],
  ])('treats %s as a failed verification', (_label, returned) => {
    const { verifier } = makeVerifier({
      verifySignature: jest.fn(() => returned as never),
    });
    expect(reasonOf(verifier.verify(signed(), NOW))).toBe('bad_signature');
  });

  it('hands the callback a fresh copy of the trusted key on every call', () => {
    const scribbling = jest.fn(
      (key: Uint8Array, m: Uint8Array, sg: Uint8Array) => {
        const ok = verifySignature(key, m, sg);
        key.fill(0);
        return ok;
      },
    );
    const { verifier } = makeVerifier({ verifySignature: scribbling });
    expect(verifier.verify(signed(), NOW).ok).toBe(true);
    expect(verifier.verify(signed(), NOW).ok).toBe(true);
  });
});

// ---- L1: each field is read exactly once -----------------------------------------------------

describe('parseRideCredential reads every field exactly once', () => {
  const FIELDS = [
    'v',
    'kid',
    'rideId',
    'sessionId',
    'nodeId',
    'pub',
    'issuedAt',
    'expiresAt',
    'sig',
  ] as const;

  /** An object whose fields are accessors answering `answers(field, readNumber)`. */
  function withGetters(
    answers: (field: (typeof FIELDS)[number], read: number) => unknown,
  ): { object: Record<string, unknown>; reads: Record<string, number> } {
    const reads: Record<string, number> = {};
    const object: Record<string, unknown> = {};
    for (const field of FIELDS) {
      reads[field] = 0;
      Object.defineProperty(object, field, {
        enumerable: true,
        get() {
          reads[field] += 1;
          return answers(field, reads[field]);
        },
      });
    }
    return { object, reads };
  }

  const good = signed() as unknown as Record<string, unknown>;

  it('reads each of the eight fields once and returns what it read', () => {
    const { object, reads } = withGetters(field => good[field]);
    expect(parseRideCredential(object)).toEqual(good);
    for (const field of FIELDS) {
      expect(reads[field]).toBe(1);
    }
  });

  it.each(FIELDS)(
    'a %s getter that is valid once and invalid afterwards cannot change the result',
    field => {
      const { object, reads } = withGetters((f, n) =>
        f === field && n > 1 ? { not: 'valid' } : good[f],
      );
      const parsed = parseRideCredential(object);
      expect(parsed).toEqual(good);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(typeof (parsed as RideCredential).pub).toBe('string');
      expect(typeof (parsed as RideCredential).issuedAt).toBe('number');
      expect(reads[field]).toBe(1);
    },
  );

  it.each(FIELDS)(
    'a %s getter that is invalid first and valid afterwards is rejected',
    field => {
      const { object } = withGetters((f, n) =>
        f === field && n === 1 ? { not: 'valid' } : good[f],
      );
      expect(parseRideCredential(object)).toBeNull();
    },
  );

  it.each(FIELDS)(
    'a throwing %s getter returns null without throwing',
    field => {
      const { object } = withGetters((f, n) => {
        if (f === field) {
          throw new Error(`hostile ${f} getter (read ${n})`);
        }
        return good[f];
      });
      expect(() => parseRideCredential(object)).not.toThrow();
      expect(parseRideCredential(object)).toBeNull();
    },
  );

  it('verify() never accepts a credential that differs from the one whose signature was checked', () => {
    const { object } = withGetters((f, n) => (n === 1 ? good[f] : 'garbage'));
    const { verifier, verifySpy } = makeVerifier();
    const result = verifier.verify(object, NOW);
    expect(result).toEqual({ ok: true, credential: good });
    const [, message] = verifySpy.mock.calls[0];
    expect(Buffer.from(message).toString('utf8')).toBe(
      rideCredentialSigningInput(good as unknown as RideCredential),
    );
  });

  it('rejects an own "__proto__" key delivered by JSON.parse', () => {
    const text = JSON.stringify(good).replace('{', '{"__proto__":{"v":1},');
    const parsedJson: unknown = JSON.parse(text);
    expect(Object.keys(parsedJson as object)).toContain('__proto__');
    expect(parseRideCredential(parsedJson)).toBeNull();
  });

  it('accepts a credential that went through JSON.stringify / JSON.parse', () => {
    expect(parseRideCredential(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it('does not accept fields inherited from a prototype', () => {
    expect(parseRideCredential(Object.create(good))).toBeNull();
  });
});

// ---- L6: identifier and encoding rules -------------------------------------------------------

describe('key id rules', () => {
  it('accepts documented ASCII key ids', () => {
    for (const kid of [
      'srv-2026-11a',
      'k',
      'A1',
      'a.b_c-d',
      '9',
      'k'.repeat(64),
      KID,
    ]) {
      expect(isValidRideCredentialKid(kid)).toBe(true);
      expect(RIDE_CREDENTIAL_KID_PATTERN.test(kid)).toBe(true);
    }
  });

  it.each([
    ['empty', ''],
    ['leading hyphen', '-srv'],
    ['leading dot', '.srv'],
    ['leading underscore', '_srv'],
    ['65 characters', 'k'.repeat(65)],
    ['a space', 'srv 1'],
    ['a slash', 'srv/1'],
    ['a quote', 'srv"1'],
    ['a backslash', 'srv\\1'],
    ['a trailing newline', 'srv-1\n'],
    ['a NUL', 'srv\u0000'],
    ['Latin-1 accents', 'kéy'],
    ['Cyrillic', 'ключ'],
    ['full-width Latin', 'ｋｅｙ１'],
    ['an emoji', 'key-\u{1F511}'],
    ['a lone surrogate', 'key-\uD800'],
  ])('rejects a key id with %s', (_label, kid) => {
    expect(isValidRideCredentialKid(kid)).toBe(false);
    expect(parseRideCredential({ ...signed(), kid })).toBeNull();
    expect(makeVerifier().verifier.verify({ ...signed(), kid }, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects non-string key ids', () => {
    for (const kid of [undefined, null, 5, ['a'], { toString: () => 'abc' }]) {
      expect(isValidRideCredentialKid(kid)).toBe(false);
    }
  });
});

describe('ride id rules: the ride id is the room code, not the database room id', () => {
  it('accepts exactly the room codes the server and the mobile app accept', () => {
    for (let n = 0; n <= 120_000; n++) {
      const text = String(n);
      expect(isValidRideCredentialRideId(text)).toBe(isRoomCode(text));
    }
  });

  it.each(['10000', '54321', '99999'])('accepts the room code %s', rideId => {
    expect(isValidRideCredentialRideId(rideId)).toBe(true);
    expect(parseRideCredential({ ...signed(), rideId })).not.toBeNull();
  });

  it.each([
    ['empty', ''],
    ['four digits', '9999'],
    ['six digits', '100000'],
    ['a leading zero', '01234'],
    ['all zeros', '00000'],
    ['a letter', '5432a'],
    ['lowercase letters', 'abcde'],
    ['the old fixture id', 'RIDE1'],
    ['a leading space', ' 54321'],
    ['a trailing newline', '54321\n'],
    ['full-width digits', '５４３２１'],
    ['Arabic-Indic digits', '٥٤٣٢١'],
    [
      'a persistent room UUID (Room.id)',
      '3f2b8c1e-9d4a-4b6f-8e21-5a7c9d0e1f23',
    ],
    ['a 64-character identifier', 'r'.repeat(64)],
  ])('rejects %s', (_label, rideId) => {
    expect(isValidRideCredentialRideId(rideId)).toBe(false);
    expect(parseRideCredential({ ...signed(), rideId })).toBeNull();
  });

  it('refuses to build a verifier for a ride id that is not a room code', () => {
    for (const rideId of [
      'RIDE1',
      '3f2b8c1e-9d4a-4b6f-8e21-5a7c9d0e1f23',
      '１２３４５',
      '',
    ]) {
      expect(() =>
        createRideCredentialVerifier({
          rideId,
          sessionId: SESSION_ID,
          keys: new Map([[KID, trusted(server)]]),
          verifySignature,
          sha256,
        }),
      ).toThrow(TypeError);
    }
  });

  it('the signed text of a valid credential is pure printable ASCII', () => {
    expect(rideCredentialSigningInput(signed())).toMatch(/^[\x20-\x7e]+$/);
  });
});

// ---- hardening: canonical node ids ------------------------------------------------------------

describe('canonical node ids', () => {
  const lastCharWithLowBitsSet = (id: string): string => {
    const index = BASE64URL_ALPHABET.indexOf(id[id.length - 1]);
    // A 43-character id carries 2 unused trailing bits that must be zero.
    const nonCanonical = BASE64URL_ALPHABET[index - (index % 4) + 1];
    return id.slice(0, -1) + nonCanonical;
  };

  it('every derived node id is canonical, 43 characters and decodes to a 32-byte digest', () => {
    for (const key of [
      device,
      otherDevice,
      server,
      otherServer,
      newKeyPair(),
      newKeyPair(),
    ]) {
      const id = nodeIdOf(key);
      expect(id).toHaveLength(43);
      expect(isCanonicalRideNodeId(id)).toBe(true);
      expect(decodeBase64Url(id)).toHaveLength(32);
    }
  });

  it('rejects ids of the wrong length, alphabet or padding', () => {
    const id = nodeIdOf(device);
    for (const bad of [
      id.slice(1),
      `${id}A`,
      `${id}=`,
      id.slice(0, 42) + '+',
      id.slice(0, 42) + '/',
      '',
      'node-1',
      'x'.repeat(64),
    ]) {
      expect(isCanonicalRideNodeId(bad)).toBe(false);
    }
    for (const bad of [undefined, null, 43, ['a']]) {
      expect(isCanonicalRideNodeId(bad)).toBe(false);
    }
  });

  it('rejects a 43-character id whose unused trailing bits are not zero', () => {
    const id = nodeIdOf(device);
    const twisted = lastCharWithLowBitsSet(id);
    expect(twisted).toHaveLength(43);
    expect(twisted).not.toBe(id);
    expect(isCanonicalRideNodeId(twisted)).toBe(false);
    expect(parseRideCredential({ ...signed(), nodeId: twisted })).toBeNull();
    expect(
      makeVerifier().verifier.verify({ ...signed(), nodeId: twisted }, NOW),
    ).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('a canonical id that belongs to a different key is node_id_mismatch, not invalid', () => {
    expect(isCanonicalRideNodeId(WRONG_NODE_ID)).toBe(true);
    expect(
      reasonOf(
        makeVerifier().verifier.verify(signed({ nodeId: WRONG_NODE_ID }), NOW),
      ),
    ).toBe('node_id_mismatch');
  });

  it('a non-canonical text form of the right digest cannot stand in for the node id', () => {
    const twisted = lastCharWithLowBitsSet(nodeIdOf(device));
    expect(decodeBase64Url(twisted)).toBeNull();
    expect(
      reasonOf(
        makeVerifier().verifier.verify(signed({ nodeId: twisted }), NOW),
      ),
    ).toBe('invalid');
  });
});

// ---- hardening: documented contracts ---------------------------------------------------------

describe('documented contracts', () => {
  it('ECDSA malleability: a second valid signature exists, so sig must never identify a credential', () => {
    const N = BigInt(
      '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
    );
    const original = signed();
    const raw = decodeBase64Url(original.sig) as Uint8Array;
    const sValue = BigInt(`0x${Buffer.from(raw.subarray(32)).toString('hex')}`);
    const flipped = new Uint8Array(64);
    flipped.set(raw.subarray(0, 32));
    flipped.set(
      Buffer.from((N - sValue).toString(16).padStart(64, '0'), 'hex'),
      32,
    );
    const mauled: RideCredential = {
      ...original,
      sig: encodeBase64Url(flipped),
    };

    const { verifier } = makeVerifier();
    expect(mauled.sig).not.toBe(original.sig);
    expect(verifier.verify(original, NOW).ok).toBe(true);
    expect(verifier.verify(mauled, NOW).ok).toBe(true);
    expect(rideCredentialSigningInput(mauled)).toBe(
      rideCredentialSigningInput(original),
    );
  });

  it('pub is not checked for curve membership by parsing or verification: the backend and the handshake crypto must', () => {
    const offCurve = new Uint8Array(65).fill(7);
    offCurve[0] = 0x04;
    const body = unsigned({
      pub: encodeBase64Url(offCurve),
      nodeId: deriveRideNodeId(offCurve, sha256),
    });
    const credential: RideCredential = {
      ...body,
      sig: encodeBase64Url(
        signText(rideCredentialSigningInput(body), server.privateKey),
      ),
    };
    // This is the documented gap: a server-signed off-curve key is structurally acceptable...
    expect(parseRideCredential(credential)).not.toBeNull();
    expect(makeVerifier().verifier.verify(credential, NOW).ok).toBe(true);
    // ...and the crypto layer that will use it rejects it, which is why that layer must be strict.
    expect(() =>
      verifySignature(offCurve, new Uint8Array(1), new Uint8Array(64)),
    ).toThrow();
  });

  it('an off-curve trusted server key fails closed through the injected crypto', () => {
    const offCurve = new Uint8Array(65).fill(7);
    offCurve[0] = 0x04;
    const { verifier } = makeVerifier({
      keys: new Map([[KID, trusted(server, { publicKey: offCurve })]]),
    });
    expect(verifier.verify(signed(), NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('an all-zero signature reaches the callback and is rejected by it', () => {
    const { verifier, verifySpy } = makeVerifier();
    const zero = { ...signed(), sig: encodeBase64Url(new Uint8Array(64)) };
    expect(reasonOf(verifier.verify(zero, NOW))).toBe('bad_signature');
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('exposes the exact base64url lengths of the fixed-size fields', () => {
    const c = signed();
    expect(c.pub).toHaveLength(87);
    expect(c.sig).toHaveLength(86);
    expect(c.nodeId).toHaveLength(43);
    expect(c.sessionId).toHaveLength(22);
  });

  it('rejects a pub or sig of the wrong character length before decoding it', () => {
    const c = signed();
    expect(parseRideCredential({ ...c, pub: `${c.pub}A` })).toBeNull();
    expect(parseRideCredential({ ...c, pub: c.pub.slice(1) })).toBeNull();
    expect(parseRideCredential({ ...c, sig: `${c.sig}A` })).toBeNull();
    expect(parseRideCredential({ ...c, sig: c.sig.slice(1) })).toBeNull();
    expect(parseRideCredential({ ...c, pub: 'A'.repeat(100_000) })).toBeNull();
  });
});

// ---- fixed P-256 interoperability vector -----------------------------------------------------

/**
 * A fixed, session-bound credential signed once with a P-256 key and recorded here. At authoring
 * time (Task 2.1) it was verified by an independent implementation (Python `cryptography` 50.0.1,
 * EllipticCurvePublicKey.verify with ECDSA/SHA-256): the signature verifies, the device key is a
 * valid point on the curve, the node id is base64url(SHA-256(pub)), and the signing input was
 * rebuilt in Python from the fields and found byte-identical. The backend and the Android signer
 * must reproduce this signing input byte for byte and produce signatures that verify against it.
 * `OTHER` is the same credential for a different session, validly signed by the same server key.
 */
describe('fixed P-256 interoperability vector', () => {
  const VECTOR_SERVER_PUB =
    'BJLqq7o74VmWXHEPrZy8LZM010NQnQyYKD5a93b4l0C1NvYxOI4KRiPZop5G0yf56lVRja8W1dXZhPKaPN9Drx4';
  const VECTOR_SERVER_PUB_HEX =
    '0492eaabba3be159965c710fad9cbc2d9334d743509d0c98283e5af776f89740b536f631388e0a4623d9a29e46d327f9ea55518daf16d5d5d984f29a3cdf43af1e';
  const VECTOR: RideCredential = {
    v: 1,
    kid: 'srv-vector-1',
    rideId: '54321',
    sessionId: 'AAECAwQFBgcICQoLDA0ODw',
    nodeId: 'k4onoNVV0PRnPub5z1P-axVFu9j6bBPfjtxtNbJn04A',
    pub: 'BLKs-ZEIDFtp6Ax91FDB4nMiC7PIHU9lnxvgfS4SEslxNbdIQXpkVXWOzvayCEYPg8RBPIT3HsrPJhjpq0QW4Nc',
    issuedAt: 1700000000000,
    expiresAt: 1700259200000,
    sig: 'xR4YulG6L38Cz4sb4QheB-rQXNWoR3G1JIv1X90GROPDjNTB2p4G8kOaPUC3p-rLwk68juBJhiwm51fTdpH-yA',
  };
  const VECTOR_SIGNING_INPUT =
    '{"domain":"rideaze.ride-credential.v1","v":1,"kid":"srv-vector-1","rideId":"54321","sessionId":"AAECAwQFBgcICQoLDA0ODw","nodeId":"k4onoNVV0PRnPub5z1P-axVFu9j6bBPfjtxtNbJn04A","pub":"BLKs-ZEIDFtp6Ax91FDB4nMiC7PIHU9lnxvgfS4SEslxNbdIQXpkVXWOzvayCEYPg8RBPIT3HsrPJhjpq0QW4Nc","issuedAt":1700000000000,"expiresAt":1700259200000}';
  const VECTOR_SIG_HEX =
    'c51e18ba51ba2f7f02cf8b1be1085e07ead05cd5a84771b5248bf55fdd0644e3c38cd4c1da9e06f2439a3d40b7a7eacbc24ebc8ee049862c26e757d37691fec8';
  const OTHER: RideCredential = {
    ...VECTOR,
    sessionId: '__79_Pv6-fj39vX08_Lx8A',
    sig: 'wBlhN-QSps6vptSwhcQ8Ak5My_9ZnnAucnXlhj692C9pnKigSfJ9zIXQqG4U3afJNT6v4kzfdi_lgPf6w28kUg',
  };

  const serverPub = decodeBase64Url(VECTOR_SERVER_PUB) as Uint8Array;
  const vectorVerifier = (overrides: Partial<RideCredentialTrustedKey> = {}) =>
    createRideCredentialVerifier({
      rideId: '54321',
      sessionId: VECTOR.sessionId,
      keys: new Map([
        [
          'srv-vector-1',
          {
            publicKey: serverPub,
            notBefore: 1_699_000_000_000,
            notAfter: 1_701_000_000_000,
            ...overrides,
          },
        ],
      ]),
      verifySignature,
      sha256,
    });

  it('decodes to the recorded key and signature bytes', () => {
    expect(Buffer.from(serverPub).toString('hex')).toBe(VECTOR_SERVER_PUB_HEX);
    expect(
      Buffer.from(decodeBase64Url(VECTOR.sig) as Uint8Array).toString('hex'),
    ).toBe(VECTOR_SIG_HEX);
    expect(encodeBase64Url(serverPub)).toBe(VECTOR_SERVER_PUB);
  });

  it('produces the recorded signing input byte for byte', () => {
    const unsignedVector: UnsignedRideCredential = {
      v: VECTOR.v,
      kid: VECTOR.kid,
      rideId: VECTOR.rideId,
      sessionId: VECTOR.sessionId,
      nodeId: VECTOR.nodeId,
      pub: VECTOR.pub,
      issuedAt: VECTOR.issuedAt,
      expiresAt: VECTOR.expiresAt,
    };
    expect(rideCredentialSigningInput(unsignedVector)).toBe(
      VECTOR_SIGNING_INPUT,
    );
    expect(rideCredentialSigningInput(VECTOR)).toBe(VECTOR_SIGNING_INPUT);
  });

  it('verifies with node:crypto independently of this module', () => {
    expect(
      verifySignature(
        serverPub,
        new TextEncoder().encode(VECTOR_SIGNING_INPUT),
        Uint8Array.from(Buffer.from(VECTOR_SIG_HEX, 'hex')),
      ),
    ).toBe(true);
  });

  it('derives the recorded node id from the recorded device key', () => {
    expect(
      deriveRideNodeId(decodeBase64Url(VECTOR.pub) as Uint8Array, sha256),
    ).toBe(VECTOR.nodeId);
    expect(isCanonicalRideNodeId(VECTOR.nodeId)).toBe(true);
  });

  it('is accepted by the verifier inside its validity window', () => {
    const verifier = vectorVerifier();
    expect(verifier.verify(VECTOR, VECTOR.issuedAt + 1)).toEqual({
      ok: true,
      credential: VECTOR,
    });
    expect(verifier.verify(VECTOR, VECTOR.issuedAt - TOLERANCE).ok).toBe(true);
    expect(verifier.verify(VECTOR, VECTOR.expiresAt - 1).ok).toBe(true);
    expect(reasonOf(verifier.verify(VECTOR, VECTOR.expiresAt))).toBe('expired');
    expect(
      reasonOf(verifier.verify(VECTOR, VECTOR.issuedAt - TOLERANCE - 1)),
    ).toBe('not_yet_valid');
  });

  it('is rejected when its issuance falls outside the trusted key window', () => {
    expect(
      reasonOf(
        vectorVerifier({ notAfter: VECTOR.issuedAt }).verify(
          VECTOR,
          VECTOR.issuedAt + 1,
        ),
      ),
    ).toBe('unknown_key');
    expect(
      reasonOf(
        vectorVerifier({ notBefore: VECTOR.issuedAt + 1 }).verify(
          VECTOR,
          VECTOR.issuedAt + 1,
        ),
      ),
    ).toBe('unknown_key');
    expect(
      vectorVerifier({ notBefore: VECTOR.issuedAt }).verify(
        VECTOR,
        VECTOR.issuedAt + 1,
      ).ok,
    ).toBe(true);
  });

  it.each([
    ['expiresAt', { expiresAt: VECTOR.expiresAt + 1 }],
    ['issuedAt', { issuedAt: VECTOR.issuedAt + 1 }],
    ['kid', { kid: 'srv-vector-2' }],
  ])('rejects a recorded credential with %s changed', (_label, change) => {
    const result = vectorVerifier().verify(
      { ...VECTOR, ...change },
      VECTOR.issuedAt + 2,
    );
    expect(result.ok).toBe(false);
  });

  it('a credential for a different session of the same ride is wrong_session, not a signature failure', () => {
    // OTHER is validly signed by the same server key, so only the session binding can reject it.
    const otherInput = VECTOR_SIGNING_INPUT.replace(
      VECTOR.sessionId,
      OTHER.sessionId,
    );
    expect(
      verifySignature(
        serverPub,
        new TextEncoder().encode(otherInput),
        decodeBase64Url(OTHER.sig) as Uint8Array,
      ),
    ).toBe(true);
    expect(rideCredentialSigningInput(OTHER)).toBe(otherInput);
    expect(vectorVerifier().verify(OTHER, OTHER.issuedAt + 1)).toEqual({
      ok: false,
      reason: 'wrong_session',
    });
  });

  it('is accepted only by a verifier of its own session', () => {
    const forOther = createRideCredentialVerifier({
      rideId: '54321',
      sessionId: OTHER.sessionId,
      keys: new Map([
        [
          'srv-vector-1',
          {
            publicKey: serverPub,
            notBefore: 1_699_000_000_000,
            notAfter: 1_701_000_000_000,
          },
        ],
      ]),
      verifySignature,
      sha256,
    });
    expect(forOther.verify(OTHER, OTHER.issuedAt + 1).ok).toBe(true);
    expect(reasonOf(forOther.verify(VECTOR, VECTOR.issuedAt + 1))).toBe(
      'wrong_session',
    );
  });

  it("the recorded signature does not verify over the other session's signing input", () => {
    expect(
      verifySignature(
        serverPub,
        new TextEncoder().encode(
          VECTOR_SIGNING_INPUT.replace(VECTOR.sessionId, OTHER.sessionId),
        ),
        decodeBase64Url(VECTOR.sig) as Uint8Array,
      ),
    ).toBe(false);
  });

  it('records the specified session id and key order', () => {
    expect(VECTOR.sessionId).toBe('AAECAwQFBgcICQoLDA0ODw');
    expect(Object.keys(JSON.parse(VECTOR_SIGNING_INPUT))).toEqual([
      'domain',
      'v',
      'kid',
      'rideId',
      'sessionId',
      'nodeId',
      'pub',
      'issuedAt',
      'expiresAt',
    ]);
  });

  it('is rejected under a different server key', () => {
    const verifier = createRideCredentialVerifier({
      rideId: '54321',
      sessionId: VECTOR.sessionId,
      keys: new Map([
        [
          'srv-vector-1',
          {
            publicKey: otherServer.publicKey,
            notBefore: 0,
            notAfter: 1_701_000_000_000,
          },
        ],
      ]),
      verifySignature,
      sha256,
    });
    expect(reasonOf(verifier.verify(VECTOR, VECTOR.issuedAt + 1))).toBe(
      'bad_signature',
    );
  });
});

// =================================================================================================
// Task 2.1: ride-session binding
// =================================================================================================

describe('ride session id format', () => {
  it('is 16 bytes encoded as exactly 22 characters', () => {
    expect(RIDE_CREDENTIAL_SESSION_ID_BYTES).toBe(16);
    expect(RIDE_CREDENTIAL_SESSION_ID_CHARS).toBe(22);
    expect(decodeBase64Url(SESSION_ID)).toEqual(
      Uint8Array.from({ length: 16 }, (_, i) => i),
    );
  });

  it('accepts canonical ids, including ones derived from random bytes', () => {
    for (const id of [SESSION_ID, OTHER_SESSION_ID, 'A'.repeat(22)]) {
      expect(isCanonicalRideSessionId(id)).toBe(true);
    }
    for (let i = 0; i < 25; i++) {
      const id = encodeBase64Url(new Uint8Array(randomBytes(16)));
      expect(id).toHaveLength(22);
      expect(isCanonicalRideSessionId(id)).toBe(true);
    }
  });

  it('the final character decides canonicity: exactly those whose alphabet index is a multiple of 16', () => {
    // 22 characters = five full groups + two characters; the last character has 4 unused bits.
    const accepted: string[] = [];
    for (let index = 0; index < BASE64URL_ALPHABET.length; index++) {
      const id = SESSION_ID.slice(0, 21) + BASE64URL_ALPHABET[index];
      const ok = isCanonicalRideSessionId(id);
      expect(ok).toBe(index % 16 === 0);
      if (ok) {
        accepted.push(BASE64URL_ALPHABET[index]);
      }
    }
    expect(accepted).toEqual(['A', 'Q', 'g', 'w']);
  });

  const MALFORMED_SESSION_IDS: [string, unknown][] = [
    ['empty', ''],
    ['21 characters', SESSION_ID.slice(1)],
    ['23 characters', `${SESSION_ID}A`],
    ['padded to 24 characters', `${SESSION_ID}==`],
    ['a single trailing padding character', `${SESSION_ID}=`],
    ['a plus sign', `${SESSION_ID.slice(0, 21)}+`],
    ['a slash', `${SESSION_ID.slice(0, 21)}/`],
    ['an embedded space', `${SESSION_ID.slice(0, 10)} ${SESSION_ID.slice(11)}`],
    ['a trailing newline in 22 characters', `${SESSION_ID.slice(0, 21)}\n`],
    ['non-canonical trailing bits', `${SESSION_ID.slice(0, 21)}x`],
    ['non-canonical trailing bits (low bit)', `${SESSION_ID.slice(0, 21)}B`],
    ['Unicode', `${SESSION_ID.slice(0, 20)}éé`],
    ['a UUID (Room.id)', '3f2b8c1e-9d4a-4b6f-8e21-5a7c9d0e1f23'],
    ['a room code', '54321'],
    ['a 32-byte value (43 characters)', encodeBase64Url(new Uint8Array(32))],
    ['a 17-byte value (23 characters)', encodeBase64Url(new Uint8Array(17))],
    ['a 15-byte value (20 characters)', encodeBase64Url(new Uint8Array(15))],
    ['undefined', undefined],
    ['null', null],
    ['a number', 1234567890123456789012],
    ['a byte array', new Uint8Array(16)],
    ['an array', [SESSION_ID]],
    ['a String object', Object(SESSION_ID)],
  ];

  it.each(MALFORMED_SESSION_IDS)('rejects %s', (_label, value) => {
    expect(isCanonicalRideSessionId(value)).toBe(false);
  });

  it.each(MALFORMED_SESSION_IDS)(
    'a credential with %s as its sessionId is invalid',
    (_label, value) => {
      const credential = { ...signed(), sessionId: value };
      expect(parseRideCredential(credential)).toBeNull();
      expect(makeVerifier().verifier.verify(credential, NOW)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    },
  );

  it('a credential without a sessionId (the previous schema) is invalid', () => {
    const legacy: Record<string, unknown> = { ...signed() };
    delete legacy.sessionId;
    expect(Object.keys(legacy)).toHaveLength(8);
    expect(parseRideCredential(legacy)).toBeNull();
    const body: Record<string, unknown> = { ...unsigned() };
    delete body.sessionId;
    const legacyText = JSON.stringify({
      domain: 'rideaze.ride-credential.v1',
      ...body,
    });
    const legacySigned = {
      ...body,
      sig: encodeBase64Url(signText(legacyText, server.privateKey)),
    };
    expect(makeVerifier().verifier.verify(legacySigned, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('a sessionId key set to undefined is invalid (the key is present but the value is not)', () => {
    expect(
      parseRideCredential({ ...signed(), sessionId: undefined }),
    ).toBeNull();
  });
});

describe('verifier requires a ride session id', () => {
  const build = (sessionId: unknown) =>
    createRideCredentialVerifier({
      rideId: RIDE,
      sessionId: sessionId as string,
      keys: new Map([[KID, trusted(server)]]),
      verifySignature,
      sha256,
    });

  it('accepts a canonical session id', () => {
    expect(() => build(SESSION_ID)).not.toThrow();
  });

  it.each(MALFORMED_SESSION_IDS_FOR_CONSTRUCTION())(
    'refuses to be built for %s',
    (_label, value) => {
      expect(() => build(value)).toThrow(TypeError);
    },
  );

  it('refuses to be built when sessionId is omitted entirely', () => {
    expect(() =>
      createRideCredentialVerifier({
        rideId: RIDE,
        keys: new Map([[KID, trusted(server)]]),
        verifySignature,
        sha256,
      } as never),
    ).toThrow(TypeError);
  });
});

function MALFORMED_SESSION_IDS_FOR_CONSTRUCTION(): [string, unknown][] {
  return [
    ['undefined', undefined],
    ['an empty string', ''],
    ['a UUID', '3f2b8c1e-9d4a-4b6f-8e21-5a7c9d0e1f23'],
    ['a room code', '54321'],
    ['21 characters', SESSION_ID.slice(1)],
    ['23 characters', `${SESSION_ID}A`],
    ['a padded id', `${SESSION_ID}==`],
    ['non-canonical trailing bits', `${SESSION_ID.slice(0, 21)}x`],
    ['a number', 7],
    ['a byte array', new Uint8Array(16)],
  ];
}

describe('session binding: a credential from a previous ride is not accepted in a later one', () => {
  /** Correct in every other respect: same room code, key, node, dates and signature scheme. */
  const previousRide = () => signed({ sessionId: OTHER_SESSION_ID });

  it('rejects a correctly signed credential from a previous session of the same room code', () => {
    const { verifier, verifySpy, shaSpy } = makeVerifier();
    const credential = previousRide();
    expect(credential.rideId).toBe(RIDE);
    // Control: the very same credential is fully valid for the session it was issued for.
    expect(
      makeVerifier({ sessionId: OTHER_SESSION_ID }).verifier.verify(
        credential,
        NOW,
      ).ok,
    ).toBe(true);
    verifySpy.mockClear();
    shaSpy.mockClear();
    expect(verifier.verify(credential, NOW)).toEqual({
      ok: false,
      reason: 'wrong_session',
    });
    expect(verifySpy).not.toHaveBeenCalled();
    expect(shaSpy).not.toHaveBeenCalled();
  });

  it("is symmetric: the current session's credential is wrong_session for a verifier of the previous session", () => {
    const { verifier } = makeVerifier({ sessionId: OTHER_SESSION_ID });
    expect(reasonOf(verifier.verify(signed(), NOW))).toBe('wrong_session');
  });

  it('a former participant stays out for the whole life of their credential', () => {
    const { verifier } = makeVerifier();
    const credential = previousRide();
    for (const at of [ISSUED_AT, NOW, EXPIRES_AT - 1]) {
      expect(reasonOf(verifier.verify(credential, at))).toBe('wrong_session');
    }
  });

  it('the session id differs by a single bit and is still rejected', () => {
    const bytes = decodeBase64Url(SESSION_ID) as Uint8Array;
    bytes[15] = bytes[15] === 0 ? 1 : 0;
    const nearby = encodeBase64Url(bytes);
    expect(nearby).not.toBe(SESSION_ID);
    expect(isCanonicalRideSessionId(nearby)).toBe(true);
    expect(
      reasonOf(
        makeVerifier().verifier.verify(signed({ sessionId: nearby }), NOW),
      ),
    ).toBe('wrong_session');
  });

  it('session ids that differ only in letter case are different sessions', () => {
    // base64url is case-sensitive: 'a' and 'A' are different 6-bit values.
    const lowerFirst = `a${SESSION_ID.slice(1)}`;
    expect(lowerFirst).not.toBe(SESSION_ID);
    expect(lowerFirst.toLowerCase()).toBe(SESSION_ID.toLowerCase());
    expect(isCanonicalRideSessionId(lowerFirst)).toBe(true);
    expect(
      reasonOf(
        makeVerifier().verifier.verify(signed({ sessionId: lowerFirst }), NOW),
      ),
    ).toBe('wrong_session');
    expect(
      reasonOf(
        makeVerifier({ sessionId: lowerFirst }).verifier.verify(signed(), NOW),
      ),
    ).toBe('wrong_session');
  });

  describe('rejection order at every boundary', () => {
    // Every credential below is broken in the named way AND is from the wrong session AND carries
    // a signature that would not verify. The reported reason shows which check ran first, and the
    // spies prove that nothing cryptographic ran before the decision.
    const wrongSession = (overrides: Partial<UnsignedRideCredential> = {}) => ({
      ...signed({ sessionId: OTHER_SESSION_ID, ...overrides }),
      sig: encodeBase64Url(new Uint8Array(64)),
    });

    it('invalid beats wrong_session', () => {
      const { verifier, verifySpy, shaSpy } = makeVerifier();
      expect(
        reasonOf(verifier.verify({ ...wrongSession(), extra: 1 }, NOW)),
      ).toBe('invalid');
      expect(reasonOf(verifier.verify(wrongSession(), Number.NaN))).toBe(
        'invalid',
      );
      expect(verifySpy).not.toHaveBeenCalled();
      expect(shaSpy).not.toHaveBeenCalled();
    });

    it('wrong_ride beats wrong_session', () => {
      const { verifier, verifySpy } = makeVerifier();
      expect(
        reasonOf(verifier.verify(wrongSession({ rideId: '99999' }), NOW)),
      ).toBe('wrong_ride');
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('wrong_session beats unknown_key (unknown kid)', () => {
      const { verifier, verifySpy, shaSpy } = makeVerifier();
      expect(
        reasonOf(verifier.verify(wrongSession({ kid: 'nobody' }), NOW)),
      ).toBe('wrong_session');
      expect(shaSpy).not.toHaveBeenCalled();
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('wrong_session beats unknown_key (key outside its issuance window)', () => {
      const { verifier } = makeVerifier({
        keys: new Map([[KID, trusted(server, { notAfter: ISSUED_AT })]]),
      });
      expect(reasonOf(verifier.verify(wrongSession(), NOW))).toBe(
        'wrong_session',
      );
      // Control: with the right session the same key window is what rejects it.
      expect(reasonOf(verifier.verify(signed(), NOW))).toBe('unknown_key');
    });

    it('wrong_session beats node_id_mismatch', () => {
      const { verifier, shaSpy } = makeVerifier();
      expect(
        reasonOf(verifier.verify(wrongSession({ nodeId: WRONG_NODE_ID }), NOW)),
      ).toBe('wrong_session');
      expect(shaSpy).not.toHaveBeenCalled();
    });

    it('wrong_session beats not_yet_valid and expired', () => {
      const { verifier, verifySpy } = makeVerifier();
      expect(
        reasonOf(verifier.verify(wrongSession(), ISSUED_AT - TOLERANCE - 1)),
      ).toBe('wrong_session');
      expect(reasonOf(verifier.verify(wrongSession(), EXPIRES_AT))).toBe(
        'wrong_session',
      );
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('wrong_session beats bad_signature', () => {
      const { verifier, verifySpy } = makeVerifier();
      expect(reasonOf(verifier.verify(wrongSession(), NOW))).toBe(
        'wrong_session',
      );
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('with the right session, each later check is reached in order', () => {
      const { verifier, verifySpy } = makeVerifier();
      const right = (overrides: Partial<UnsignedRideCredential>) => ({
        ...signed(overrides),
        sig: encodeBase64Url(new Uint8Array(64)),
      });
      expect(reasonOf(verifier.verify(right({ kid: 'nobody' }), NOW))).toBe(
        'unknown_key',
      );
      expect(
        reasonOf(verifier.verify(right({ nodeId: WRONG_NODE_ID }), NOW)),
      ).toBe('node_id_mismatch');
      expect(
        reasonOf(verifier.verify(right({}), ISSUED_AT - TOLERANCE - 1)),
      ).toBe('not_yet_valid');
      expect(reasonOf(verifier.verify(right({}), EXPIRES_AT))).toBe('expired');
      expect(verifySpy).not.toHaveBeenCalled();
      expect(reasonOf(verifier.verify(right({}), NOW))).toBe('bad_signature');
      expect(verifySpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the session id is a signed field', () => {
  it('changing only the session id changes the signing input', () => {
    const a = rideCredentialSigningInput(unsigned());
    const b = rideCredentialSigningInput(
      unsigned({ sessionId: OTHER_SESSION_ID }),
    );
    expect(a).not.toBe(b);
    expect(a.replace(SESSION_ID, OTHER_SESSION_ID)).toBe(b);
  });

  it('the signing input has the specified key order, with sessionId after rideId', () => {
    expect(
      Object.keys(JSON.parse(rideCredentialSigningInput(unsigned()))),
    ).toEqual([
      'domain',
      'v',
      'kid',
      'rideId',
      'sessionId',
      'nodeId',
      'pub',
      'issuedAt',
      'expiresAt',
    ]);
  });

  it('the credential has exactly the specified keys', () => {
    expect(Object.keys(signed()).sort()).toEqual(
      [
        'v',
        'kid',
        'rideId',
        'sessionId',
        'nodeId',
        'pub',
        'issuedAt',
        'expiresAt',
        'sig',
      ].sort(),
    );
  });

  it('a signature for one session does not verify for another session', () => {
    const forSessionA = signed();
    const inputB = rideCredentialSigningInput(
      unsigned({ sessionId: OTHER_SESSION_ID }),
    );
    // At the raw signature level...
    expect(
      verifySignature(
        server.publicKey,
        new TextEncoder().encode(inputB),
        decodeBase64Url(forSessionA.sig) as Uint8Array,
      ),
    ).toBe(false);
    // ...and through the verifier: session A's signature re-labelled as session B.
    const relabelled = { ...forSessionA, sessionId: OTHER_SESSION_ID };
    expect(
      reasonOf(
        makeVerifier({ sessionId: OTHER_SESSION_ID }).verifier.verify(
          relabelled,
          NOW,
        ),
      ),
    ).toBe('bad_signature');
    // A verifier for session A rejects the relabelled credential by session, not by signature.
    expect(reasonOf(makeVerifier().verifier.verify(relabelled, NOW))).toBe(
      'wrong_session',
    );
  });

  it('a credential cannot be moved into a new session by rewriting its sessionId', () => {
    const old = signed({ sessionId: OTHER_SESSION_ID });
    const forged = { ...old, sessionId: SESSION_ID };
    expect(reasonOf(makeVerifier().verifier.verify(forged, NOW))).toBe(
      'bad_signature',
    );
  });

  it('verification succeeds only when the session, ride and signature all agree', () => {
    const { verifier } = makeVerifier();
    expect(verifier.verify(signed(), NOW).ok).toBe(true);
    expect(
      verifier.verify(signed({ sessionId: OTHER_SESSION_ID }), NOW).ok,
    ).toBe(false);
    expect(verifier.verify(signed({ rideId: '99999' }), NOW).ok).toBe(false);
  });
});
