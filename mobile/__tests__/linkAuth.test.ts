/// <reference types="node" />
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'crypto';
import {
  decodeBase64Url,
  encodeBase64Url,
} from '../src/connectivity/protocol/base64url';
import {
  LINK_AUTH_BINDING_DOMAIN,
  LINK_AUTH_BINDING_KINDS,
  LINK_AUTH_CONFIRM_DOMAIN,
  LINK_AUTH_NONCE_BYTES,
  LINK_AUTH_NONCE_CHARS,
  LINK_AUTH_PROOF_DOMAIN,
  LINK_AUTH_SIGNATURE_BYTES,
  LINK_AUTH_SIGNATURE_CHARS,
  LINK_AUTH_TRANSCRIPT_DOMAIN,
  LINK_AUTH_TRANSCRIPT_HASH_CHARS,
  LINK_AUTH_VERSION,
  buildLinkAuthConfirm,
  buildLinkAuthHello,
  buildLinkAuthProof,
  isCanonicalLinkAuthNonce,
  isCanonicalLinkAuthSignature,
  isCanonicalLinkAuthTranscriptHash,
  linkAuthBindingDigest,
  linkAuthCredentialHash,
  linkAuthSigningInput,
  linkAuthTranscript,
  parseLinkAuthPayload,
  verifyLinkAuthSignature,
  type LinkAuthParty,
  type LinkAuthPayload,
  type LinkAuthSigningStage,
  type LocalChannelBinding,
} from '../src/connectivity/protocol/linkAuth';
import {
  createRideCredentialVerifier,
  deriveRideNodeId,
  isCanonicalRideNodeId,
  rideCredentialSigningInput,
  type RideCredential,
  type UnsignedRideCredential,
} from '../src/connectivity/protocol/rideCredential';

const RIDE = '54321';
const SESSION = 'AAECAwQFBgcICQoLDA0ODw';
const OTHER_SESSION = '__79_Pv6-fj39vX08_Lx8A';
const KID = 'srv-2026-11a';
const ISSUED_AT = 1_700_000_000_000;
const EXPIRES_AT = ISSUED_AT + 72 * 60 * 60 * 1000;
const NONCE_A = 'AAAAAAAAAAAAAAAAAAAAAA'; // 16 x 0x00
const NONCE_B = 'AQEBAQEBAQEBAQEBAQEBAQ'; // 16 x 0x01
const NONCE_C = 'AgICAgICAgICAgICAgICAg'; // 16 x 0x02
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// ---- real P-256 material ---------------------------------------------------------------------

interface KeyPair {
  readonly privateKey: KeyObject;
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

/** The injected synchronous verifier: P-256 / SHA-256, IEEE P1363, high-S accepted. */
const nodeVerifySignature = (
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

const signText = (text: string, privateKey: KeyObject): Uint8Array =>
  new Uint8Array(
    nodeSign('sha256', Buffer.from(text, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }),
  );

const P256_ORDER = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);

/** The malleated twin of a valid signature: (r, n - s). */
function maul(signature: Uint8Array): Uint8Array {
  const s = BigInt(`0x${Buffer.from(signature.subarray(32)).toString('hex')}`);
  const out = new Uint8Array(64);
  out.set(signature.subarray(0, 32));
  out.set(
    Buffer.from((P256_ORDER - s).toString(16).padStart(64, '0'), 'hex'),
    32,
  );
  return out;
}

const server = newKeyPair();
const devA = newKeyPair();
const devB = newKeyPair();
const devC = newKeyPair();

const nodeIdOf = (key: KeyPair) => deriveRideNodeId(key.publicKey, sha256);

function credentialFor(
  device: KeyPair,
  overrides: Partial<UnsignedRideCredential> = {},
): RideCredential {
  const body: UnsignedRideCredential = {
    v: 1,
    kid: KID,
    rideId: RIDE,
    sessionId: SESSION,
    nodeId: nodeIdOf(device),
    pub: encodeBase64Url(device.publicKey),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
  return {
    ...body,
    sig: encodeBase64Url(
      signText(rideCredentialSigningInput(body), server.privateKey),
    ),
  };
}

function partyFor(
  device: KeyPair,
  nonce: string,
  overrides: Partial<UnsignedRideCredential> = {},
): LinkAuthParty {
  return {
    nodeId: nodeIdOf(device),
    nonce,
    credential: credentialFor(device, overrides),
  };
}

const MATERIAL = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const DIGEST = linkAuthBindingDigest(MATERIAL, sha256);
const OTHER_DIGEST = linkAuthBindingDigest(
  Uint8Array.from({ length: 32 }, () => 2),
  sha256,
);
const BOUND: LocalChannelBinding = {
  kind: 'nearby-auth-token-v1',
  digest: DIGEST,
};
const UNBOUND: LocalChannelBinding = { kind: 'unavailable' };

const partyA = partyFor(devA, NONCE_A);
const partyB = partyFor(devB, NONCE_B);

function transcriptOf(
  overrides: Partial<{
    rideId: string;
    sessionId: string;
    binding: LocalChannelBinding;
    local: LinkAuthParty;
    peer: LinkAuthParty;
  }> = {},
) {
  return linkAuthTranscript(
    {
      rideId: RIDE,
      sessionId: SESSION,
      binding: BOUND,
      local: partyA,
      peer: partyB,
      ...overrides,
    },
    sha256,
  );
}

function deepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

/** A last character that differs from `id`'s but keeps `id`'s length (non-canonical variants). */
const withLastChar = (text: string, char: string) => text.slice(0, -1) + char;

const SIG = encodeBase64Url(signText('anything', devA.privateKey));
const TRANSCRIPT = transcriptOf().hash;

// ---- constants -------------------------------------------------------------------------------

describe('constants', () => {
  it('match the specification', () => {
    expect(LINK_AUTH_VERSION).toBe(1);
    expect(LINK_AUTH_NONCE_BYTES).toBe(16);
    expect(LINK_AUTH_NONCE_CHARS).toBe(22);
    expect(LINK_AUTH_TRANSCRIPT_HASH_CHARS).toBe(43);
    expect(LINK_AUTH_SIGNATURE_BYTES).toBe(64);
    expect(LINK_AUTH_SIGNATURE_CHARS).toBe(86);
    expect(LINK_AUTH_TRANSCRIPT_DOMAIN).toBe('rideaze.link-auth.v1.transcript');
    expect(LINK_AUTH_PROOF_DOMAIN).toBe('rideaze.link-auth.v1.proof');
    expect(LINK_AUTH_CONFIRM_DOMAIN).toBe('rideaze.link-auth.v1.confirm');
    expect(LINK_AUTH_BINDING_DOMAIN).toBe('rideaze.nearby-binding.v1');
    expect([...LINK_AUTH_BINDING_KINDS]).toEqual([
      'nearby-auth-token-v1',
      'unavailable',
    ]);
  });

  it('keeps the four domains distinct, so no signed text can be read as another', () => {
    const domains = [
      LINK_AUTH_TRANSCRIPT_DOMAIN,
      LINK_AUTH_PROOF_DOMAIN,
      LINK_AUTH_CONFIRM_DOMAIN,
      LINK_AUTH_BINDING_DOMAIN,
    ];
    expect(new Set(domains).size).toBe(4);
    expect(PROOF_AND_CONFIRM_ARE_NOT_PREFIXES()).toBe(true);
  });
});

function PROOF_AND_CONFIRM_ARE_NOT_PREFIXES(): boolean {
  // The signing inputs end the domain with a closing quote, so neither is a prefix of the other.
  return (
    !`"${LINK_AUTH_CONFIRM_DOMAIN}"`.startsWith(
      `"${LINK_AUTH_PROOF_DOMAIN}"`,
    ) &&
    !`"${LINK_AUTH_PROOF_DOMAIN}"`.startsWith(`"${LINK_AUTH_CONFIRM_DOMAIN}"`)
  );
}

// ---- canonical value checks ------------------------------------------------------------------

describe('canonical nonce, transcript hash and signature checks', () => {
  it('accept exactly the canonical forms', () => {
    for (const nonce of [NONCE_A, NONCE_B, NONCE_C]) {
      expect(isCanonicalLinkAuthNonce(nonce)).toBe(true);
    }
    for (let i = 0; i < 20; i++) {
      expect(
        isCanonicalLinkAuthNonce(
          encodeBase64Url(new Uint8Array(randomBytes(16))),
        ),
      ).toBe(true);
      expect(
        isCanonicalLinkAuthTranscriptHash(
          encodeBase64Url(new Uint8Array(randomBytes(32))),
        ),
      ).toBe(true);
      expect(
        isCanonicalLinkAuthSignature(
          encodeBase64Url(new Uint8Array(randomBytes(64))),
        ),
      ).toBe(true);
    }
  });

  const badNonces: [string, unknown][] = [
    ['empty', ''],
    ['21 characters', NONCE_A.slice(1)],
    ['23 characters', `${NONCE_A}A`],
    ['padded', `${NONCE_A}==`],
    ['a plus sign', `${NONCE_A.slice(0, 21)}+`],
    ['a slash', `${NONCE_A.slice(0, 21)}/`],
    ['whitespace', `${NONCE_A.slice(0, 21)} `],
    ['a trailing newline', `${NONCE_A.slice(0, 21)}\n`],
    ['non-canonical trailing bits', withLastChar(NONCE_A, 'B')],
    ['Unicode', `${NONCE_A.slice(0, 20)}éé`],
    ['a 32-byte value', encodeBase64Url(new Uint8Array(32))],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['a byte array', new Uint8Array(16)],
    ['a String object', Object(NONCE_A)],
  ];
  it.each(badNonces)('rejects a nonce that is %s', (_label, value) => {
    expect(isCanonicalLinkAuthNonce(value)).toBe(false);
  });

  it('the last nonce character decides canonicity: only indexes that are multiples of 16', () => {
    const accepted = [...ALPHABET].filter(char =>
      isCanonicalLinkAuthNonce(withLastChar(NONCE_A, char)),
    );
    expect(accepted).toEqual(['A', 'Q', 'g', 'w']);
  });

  const hash = encodeBase64Url(new Uint8Array(32).fill(9));
  it.each([
    ['42 characters', hash.slice(1)],
    ['44 characters', `${hash}A`],
    ['padded', `${hash}=`],
    ['non-canonical trailing bits', withLastChar(hash, 'B')],
    ['a plus sign', `${hash.slice(0, 42)}+`],
    ['a nonce-sized value', NONCE_A],
    ['a signature-sized value', SIG],
    ['not a string', 7],
  ])('rejects a transcript hash that is %s', (_label, value) => {
    expect(isCanonicalLinkAuthTranscriptHash(value)).toBe(false);
  });

  it.each([
    ['85 characters', SIG.slice(1)],
    ['87 characters', `${SIG}A`],
    ['a DER-length value (71 bytes)', encodeBase64Url(new Uint8Array(71))],
    ['63 bytes', encodeBase64Url(new Uint8Array(63))],
    ['65 bytes', encodeBase64Url(new Uint8Array(65))],
    ['padded', `${SIG}==`],
    ['non-canonical trailing bits', withLastChar(SIG, 'B')],
    ['not a string', new Uint8Array(64)],
  ])('rejects a signature that is %s', (_label, value) => {
    expect(isCanonicalLinkAuthSignature(value)).toBe(false);
  });
});

// ---- parsing and building --------------------------------------------------------------------

const GOOD_HELLO = () =>
  buildLinkAuthHello({
    credential: partyA.credential,
    nonce: NONCE_A,
    bindingKind: 'nearby-auth-token-v1',
  });
const GOOD_SIGNED = (stage: 'proof' | 'confirm') =>
  (stage === 'proof' ? buildLinkAuthProof : buildLinkAuthConfirm)({
    nonce: NONCE_A,
    peerNonce: NONCE_B,
    transcript: TRANSCRIPT,
    sig: SIG,
  });

const jsonRoundTrip = <T>(value: T): unknown =>
  JSON.parse(JSON.stringify(value));

describe('HELLO', () => {
  it('builds, round-trips through parse and JSON, and is deeply frozen', () => {
    const hello = GOOD_HELLO();
    expect(hello).toEqual({
      v: 1,
      stage: 'hello',
      credential: partyA.credential,
      nonce: NONCE_A,
      binding: { kind: 'nearby-auth-token-v1' },
    });
    expect(deepFrozen(hello)).toBe(true);
    const parsed = parseLinkAuthPayload(hello);
    expect(parsed).toEqual(hello);
    expect(deepFrozen(parsed)).toBe(true);
    expect(parseLinkAuthPayload(jsonRoundTrip(hello))).toEqual(hello);
  });

  it('has exactly the specified keys, and the binding carries only a kind', () => {
    const hello = GOOD_HELLO();
    expect(Object.keys(hello).sort()).toEqual(
      ['binding', 'credential', 'nonce', 'stage', 'v'].sort(),
    );
    expect(Object.keys(hello.binding)).toEqual(['kind']);
  });

  it('supports both binding kinds', () => {
    for (const bindingKind of LINK_AUTH_BINDING_KINDS) {
      const hello = buildLinkAuthHello({
        credential: partyA.credential,
        nonce: NONCE_A,
        bindingKind,
      });
      expect(parseLinkAuthPayload(jsonRoundTrip(hello))).toEqual(hello);
    }
  });

  it('a built HELLO fits comfortably in a wire envelope', () => {
    expect(JSON.stringify(GOOD_HELLO()).length).toBeLessThan(700);
  });

  const good = () => jsonRoundTrip(GOOD_HELLO()) as Record<string, unknown>;
  const malformed: [string, () => unknown][] = [
    ['an extra key', () => ({ ...good(), extra: 1 })],
    ['a missing credential', () => ({ ...good(), credential: undefined })],
    [
      'no binding key',
      () => {
        const h = good();
        delete h.binding;
        return h;
      },
    ],
    ['version 2', () => ({ ...good(), v: 2 })],
    ['version "1"', () => ({ ...good(), v: '1' })],
    ['an unknown stage', () => ({ ...good(), stage: 'Hello' })],
    [
      'an unknown binding kind',
      () => ({ ...good(), binding: { kind: 'tls' } }),
    ],
    [
      'a binding with a digest',
      () => ({
        ...good(),
        binding: { kind: 'nearby-auth-token-v1', digest: DIGEST },
      }),
    ],
    ['an empty binding', () => ({ ...good(), binding: {} })],
    [
      'a binding that is a string',
      () => ({ ...good(), binding: 'unavailable' }),
    ],
    ['a null binding', () => ({ ...good(), binding: null })],
    ['an array binding', () => ({ ...good(), binding: ['unavailable'] })],
    ['a short nonce', () => ({ ...good(), nonce: NONCE_A.slice(1) })],
    [
      'a non-canonical nonce',
      () => ({ ...good(), nonce: withLastChar(NONCE_A, 'B') }),
    ],
    ['a padded nonce', () => ({ ...good(), nonce: `${NONCE_A}==` })],
    ['a peerNonce key', () => ({ ...good(), peerNonce: NONCE_B })],
    [
      'a credential with an extra key',
      () => ({
        ...good(),
        credential: { ...partyA.credential, extra: 1 },
      }),
    ],
    [
      'a credential for the old schema (no sessionId)',
      () => {
        const c: Record<string, unknown> = { ...partyA.credential };
        delete c.sessionId;
        return { ...good(), credential: c };
      },
    ],
    [
      'a credential with a bad signature length',
      () => ({
        ...good(),
        credential: { ...partyA.credential, sig: SIG.slice(1) },
      }),
    ],
    [
      'a non-object credential',
      () => ({ ...good(), credential: 'credential' }),
    ],
    ['a null credential', () => ({ ...good(), credential: null })],
  ];
  it.each(malformed)('rejects %s', (_label, build) => {
    expect(parseLinkAuthPayload(build())).toBeNull();
  });

  it('builders throw on invalid input', () => {
    const credential = partyA.credential;
    expect(() =>
      buildLinkAuthHello({
        credential: { ...credential, sig: 'x' },
        nonce: NONCE_A,
        bindingKind: 'unavailable',
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildLinkAuthHello({
        credential,
        nonce: 'short',
        bindingKind: 'unavailable',
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildLinkAuthHello({
        credential,
        nonce: NONCE_A,
        bindingKind: 'tls' as never,
      }),
    ).toThrow(TypeError);
    expect(() => buildLinkAuthHello(undefined as never)).toThrow(TypeError);
  });

  it('copies the credential: later changes to the input do not affect the built payload', () => {
    const credential = { ...partyA.credential };
    const hello = buildLinkAuthHello({
      credential,
      nonce: NONCE_A,
      bindingKind: 'unavailable',
    });
    (credential as { kid: string }).kid = 'changed';
    expect(hello.credential.kid).toBe(KID);
  });
});

describe.each(['proof', 'confirm'] as const)('%s message', stage => {
  const build = stage === 'proof' ? buildLinkAuthProof : buildLinkAuthConfirm;
  const good = () =>
    jsonRoundTrip(GOOD_SIGNED(stage)) as Record<string, unknown>;

  it('builds, round-trips through parse and JSON, and is deeply frozen', () => {
    const message = GOOD_SIGNED(stage);
    expect(message).toEqual({
      v: 1,
      stage,
      nonce: NONCE_A,
      peerNonce: NONCE_B,
      transcript: TRANSCRIPT,
      sig: SIG,
    });
    expect(deepFrozen(message)).toBe(true);
    expect(parseLinkAuthPayload(message)).toEqual(message);
    expect(parseLinkAuthPayload(jsonRoundTrip(message))).toEqual(message);
    expect(Object.keys(message).sort()).toEqual(
      ['nonce', 'peerNonce', 'sig', 'stage', 'transcript', 'v'].sort(),
    );
  });

  it('is never parsed as the other stage', () => {
    const other = stage === 'proof' ? 'confirm' : 'proof';
    expect((parseLinkAuthPayload(good()) as LinkAuthPayload).stage).toBe(stage);
    expect(
      (parseLinkAuthPayload({ ...good(), stage: other }) as LinkAuthPayload)
        .stage,
    ).toBe(other);
  });

  it.each(['v', 'stage', 'nonce', 'peerNonce', 'transcript', 'sig'])(
    'rejects a message missing %s',
    key => {
      const message = good();
      delete message[key];
      expect(parseLinkAuthPayload(message)).toBeNull();
    },
  );

  const malformed: [string, (g: Record<string, unknown>) => unknown][] = [
    ['an extra key', g => ({ ...g, extra: 1 })],
    ['a credential key', g => ({ ...g, credential: partyA.credential })],
    ['a binding key', g => ({ ...g, binding: { kind: 'unavailable' } })],
    ['version 2', g => ({ ...g, v: 2 })],
    ['a nonce of 21 characters', g => ({ ...g, nonce: NONCE_A.slice(1) })],
    ['a nonce of 23 characters', g => ({ ...g, nonce: `${NONCE_A}A` })],
    ['a padded peerNonce', g => ({ ...g, peerNonce: `${NONCE_B}==` })],
    [
      'a non-canonical nonce',
      g => ({ ...g, nonce: withLastChar(NONCE_A, 'B') }),
    ],
    [
      'a plus sign in peerNonce',
      g => ({ ...g, peerNonce: `${NONCE_B.slice(0, 21)}+` }),
    ],
    [
      'a transcript of 42 characters',
      g => ({ ...g, transcript: TRANSCRIPT.slice(1) }),
    ],
    [
      'a transcript of 44 characters',
      g => ({ ...g, transcript: `${TRANSCRIPT}A` }),
    ],
    [
      'a non-canonical transcript',
      g => ({ ...g, transcript: withLastChar(TRANSCRIPT, 'B') }),
    ],
    ['a signature of 85 characters', g => ({ ...g, sig: SIG.slice(1) })],
    ['a signature of 87 characters', g => ({ ...g, sig: `${SIG}A` })],
    [
      'a DER-length signature',
      g => ({ ...g, sig: encodeBase64Url(new Uint8Array(71)) }),
    ],
    [
      'a 63-byte signature',
      g => ({ ...g, sig: encodeBase64Url(new Uint8Array(63)) }),
    ],
    [
      'a 65-byte signature',
      g => ({ ...g, sig: encodeBase64Url(new Uint8Array(65)) }),
    ],
    ['a non-canonical signature', g => ({ ...g, sig: withLastChar(SIG, 'B') })],
    ['a signature byte array', g => ({ ...g, sig: new Uint8Array(64) })],
    ['a null field', g => ({ ...g, sig: null })],
  ];
  it.each(malformed)('rejects %s', (_label, mutate) => {
    expect(parseLinkAuthPayload(mutate(good()))).toBeNull();
  });

  it('builders throw TypeError on invalid input', () => {
    const ok = {
      nonce: NONCE_A,
      peerNonce: NONCE_B,
      transcript: TRANSCRIPT,
      sig: SIG,
    };
    expect(() => build({ ...ok, nonce: 'short' })).toThrow(TypeError);
    expect(() => build({ ...ok, peerNonce: `${NONCE_B}=` })).toThrow(TypeError);
    expect(() => build({ ...ok, transcript: TRANSCRIPT.slice(1) })).toThrow(
      TypeError,
    );
    expect(() => build({ ...ok, sig: SIG.slice(1) })).toThrow(TypeError);
    expect(() =>
      build({ ...ok, sig: encodeBase64Url(new Uint8Array(71)) }),
    ).toThrow(TypeError);
    expect(() => build(undefined as never)).toThrow(TypeError);
  });
});

// ---- hostile inputs --------------------------------------------------------------------------

describe('parseLinkAuthPayload with hostile input', () => {
  type Spec = { name: string; good: () => Record<string, unknown> };
  const SPECS: Spec[] = [
    {
      name: 'hello',
      good: () => GOOD_HELLO() as unknown as Record<string, unknown>,
    },
    {
      name: 'proof',
      good: () => GOOD_SIGNED('proof') as unknown as Record<string, unknown>,
    },
    {
      name: 'confirm',
      good: () => GOOD_SIGNED('confirm') as unknown as Record<string, unknown>,
    },
  ];

  function withGetters(
    good: Record<string, unknown>,
    answers: (field: string, read: number) => unknown,
  ) {
    const reads: Record<string, number> = {};
    const object: Record<string, unknown> = {};
    for (const field of Object.keys(good)) {
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

  describe.each(SPECS)('$name', ({ good: makeGood }) => {
    const fields = Object.keys(makeGood());

    it('reads every top-level field exactly once and returns what it read', () => {
      const good = makeGood();
      const { object, reads } = withGetters(good, f => good[f]);
      expect(parseLinkAuthPayload(object)).toEqual(good);
      for (const field of fields) {
        expect(reads[field]).toBe(1);
      }
    });

    it.each(fields)(
      'a %s getter valid once then invalid cannot change the result',
      field => {
        const good = makeGood();
        const { object, reads } = withGetters(good, (f, n) =>
          f === field && n > 1 ? { not: 'valid' } : good[f],
        );
        const parsed = parseLinkAuthPayload(object);
        expect(parsed).toEqual(good);
        expect(deepFrozen(parsed)).toBe(true);
        expect(reads[field]).toBe(1);
      },
    );

    it.each(fields)(
      'a %s getter invalid first then valid is rejected',
      field => {
        const good = makeGood();
        const { object } = withGetters(good, (f, n) =>
          f === field && n === 1 ? { not: 'valid' } : good[f],
        );
        expect(parseLinkAuthPayload(object)).toBeNull();
      },
    );

    it.each(fields)(
      'a throwing %s getter returns null without throwing',
      field => {
        const good = makeGood();
        const { object } = withGetters(good, f => {
          if (f === field) {
            throw new Error(`hostile ${f}`);
          }
          return good[f];
        });
        expect(() => parseLinkAuthPayload(object)).not.toThrow();
        expect(parseLinkAuthPayload(object)).toBeNull();
      },
    );

    it('does not accept fields inherited from a prototype', () => {
      expect(parseLinkAuthPayload(Object.create(makeGood()))).toBeNull();
    });

    it('rejects an own "__proto__" key delivered by JSON.parse', () => {
      const text = JSON.stringify(makeGood()).replace(
        '{',
        '{"__proto__":{"v":1},',
      );
      const parsedJson: unknown = JSON.parse(text);
      expect(Object.keys(parsedJson as object)).toContain('__proto__');
      expect(parseLinkAuthPayload(parsedJson)).toBeNull();
    });

    it('survives a proxy whose traps throw', () => {
      const hostile = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('hostile proxy');
          },
        },
      );
      expect(() => parseLinkAuthPayload(hostile)).not.toThrow();
      expect(parseLinkAuthPayload(hostile)).toBeNull();
    });

    it('reads a proxy through its get trap once per field', () => {
      const good = makeGood();
      const reads: Record<string, number> = {};
      const proxy = new Proxy(good, {
        get(target, key) {
          reads[String(key)] = (reads[String(key)] ?? 0) + 1;
          return Reflect.get(target, key);
        },
      });
      expect(parseLinkAuthPayload(proxy)).toEqual(good);
      for (const field of fields) {
        expect(reads[field]).toBe(1);
      }
    });
  });

  it('reads the nested binding object and its kind exactly once', () => {
    const good = GOOD_HELLO() as unknown as Record<string, unknown>;
    let bindingReads = 0;
    let kindReads = 0;
    const binding = {};
    Object.defineProperty(binding, 'kind', {
      enumerable: true,
      get() {
        kindReads += 1;
        return kindReads === 1 ? 'unavailable' : 'tls';
      },
    });
    const object: Record<string, unknown> = { ...good };
    Object.defineProperty(object, 'binding', {
      enumerable: true,
      get() {
        bindingReads += 1;
        return binding;
      },
    });
    expect(parseLinkAuthPayload(object)).toEqual({
      ...good,
      binding: { kind: 'unavailable' },
    });
    expect(bindingReads).toBe(1);
    expect(kindReads).toBe(1);
  });

  it('a throwing nested binding getter returns null', () => {
    const good = GOOD_HELLO() as unknown as Record<string, unknown>;
    const binding = {};
    Object.defineProperty(binding, 'kind', {
      enumerable: true,
      get() {
        throw new Error('hostile kind');
      },
    });
    expect(parseLinkAuthPayload({ ...good, binding })).toBeNull();
  });

  it('a credential field that changes on a second read cannot corrupt the parsed HELLO', () => {
    const good = GOOD_HELLO() as unknown as Record<string, unknown>;
    const credential: Record<string, unknown> = { ...partyA.credential };
    let pubReads = 0;
    Object.defineProperty(credential, 'pub', {
      enumerable: true,
      get() {
        pubReads += 1;
        return pubReads === 1 ? partyA.credential.pub : { not: 'a string' };
      },
    });
    const parsed = parseLinkAuthPayload({ ...good, credential }) as ReturnType<
      typeof GOOD_HELLO
    >;
    expect(parsed.credential.pub).toBe(partyA.credential.pub);
    expect(pubReads).toBe(1);
  });

  it.each([null, undefined, 'hello', 7, true, [], [GOOD_HELLO()], () => 1])(
    'rejects the non-object input %p',
    value => {
      expect(parseLinkAuthPayload(value)).toBeNull();
    },
  );

  it.each([
    undefined,
    null,
    'proof ',
    'PROOF',
    'ack',
    '',
    5,
    ['proof'],
    { toString: () => 'proof' },
  ])('rejects the unknown stage %p', stage => {
    expect(parseLinkAuthPayload({ ...GOOD_SIGNED('proof'), stage })).toBeNull();
  });
});

// ---- credential hash -------------------------------------------------------------------------

describe('linkAuthCredentialHash', () => {
  const independent = (c: RideCredential) =>
    encodeBase64Url(
      sha256(new TextEncoder().encode(rideCredentialSigningInput(c))),
    );

  it('is base64url(SHA-256(signing input)), 43 characters, and deterministic', () => {
    const credential = partyA.credential;
    const hash = linkAuthCredentialHash(credential, sha256);
    expect(hash).toHaveLength(43);
    expect(isCanonicalLinkAuthTranscriptHash(hash)).toBe(true);
    expect(hash).toBe(independent(credential));
    expect(linkAuthCredentialHash({ ...credential }, sha256)).toBe(hash);
  });

  it('ignores the signature: the malleated (high-S) twin hashes the same', () => {
    const credential = partyA.credential;
    const twin: RideCredential = {
      ...credential,
      sig: encodeBase64Url(maul(decodeBase64Url(credential.sig) as Uint8Array)),
    };
    expect(twin.sig).not.toBe(credential.sig);
    expect(linkAuthCredentialHash(twin, sha256)).toBe(
      linkAuthCredentialHash(credential, sha256),
    );
    // and the mauled credential is still a genuinely valid signature
    expect(
      nodeVerifySignature(
        server.publicKey,
        new TextEncoder().encode(rideCredentialSigningInput(twin)),
        decodeBase64Url(twin.sig) as Uint8Array,
      ),
    ).toBe(true);
  });

  it('changes with every signed credential field', () => {
    const base = linkAuthCredentialHash(partyA.credential, sha256);
    const changes: Partial<UnsignedRideCredential>[] = [
      { kid: 'srv-other' },
      { rideId: '99999' },
      { sessionId: OTHER_SESSION },
      { nodeId: 'A'.repeat(43) },
      { pub: encodeBase64Url(devB.publicKey) },
      { issuedAt: ISSUED_AT + 1 },
      { expiresAt: EXPIRES_AT + 1 },
    ];
    for (const change of changes) {
      expect(
        linkAuthCredentialHash({ ...partyA.credential, ...change }, sha256),
      ).not.toBe(base);
    }
  });

  it('throws TypeError for a credential that is not structurally valid', () => {
    const c = partyA.credential;
    const noSession: Record<string, unknown> = { ...c };
    delete noSession.sessionId;
    for (const bad of [
      { ...c, extra: 1 },
      noSession,
      { ...c, sig: c.sig.slice(1) },
      null,
      'credential',
      undefined,
    ]) {
      expect(() => linkAuthCredentialHash(bad as never, sha256)).toThrow(
        TypeError,
      );
    }
  });

  it('throws TypeError when sha256 is unusable', () => {
    expect(() =>
      linkAuthCredentialHash(partyA.credential, undefined as never),
    ).toThrow(TypeError);
    expect(() =>
      linkAuthCredentialHash(partyA.credential, () => new Uint8Array(31)),
    ).toThrow(TypeError);
    expect(() =>
      linkAuthCredentialHash(partyA.credential, () => 'digest' as never),
    ).toThrow(TypeError);
  });
});

// ---- binding digest --------------------------------------------------------------------------

describe('linkAuthBindingDigest', () => {
  const plain = (bytes: Uint8Array) => encodeBase64Url(sha256(bytes));

  it('is the domain-separated digest, 43 canonical characters', () => {
    const expected = encodeBase64Url(
      sha256(
        Buffer.concat([
          Buffer.from('rideaze.nearby-binding.v1', 'utf8'),
          Buffer.from([0]),
          Buffer.from(MATERIAL),
        ]),
      ),
    );
    expect(linkAuthBindingDigest(MATERIAL, sha256)).toBe(expected);
    expect(DIGEST).toHaveLength(43);
    expect(isCanonicalLinkAuthTranscriptHash(DIGEST)).toBe(true);
  });

  it('is domain-separated from a plain hash of the same bytes and from a separator-less hash', () => {
    expect(DIGEST).not.toBe(plain(MATERIAL));
    const noSeparator = Buffer.concat([
      Buffer.from('rideaze.nearby-binding.v1'),
      Buffer.from(MATERIAL),
    ]);
    expect(DIGEST).not.toBe(plain(new Uint8Array(noSeparator)));
  });

  it('is deterministic and depends on every byte of the material', () => {
    expect(linkAuthBindingDigest(Uint8Array.from(MATERIAL), sha256)).toBe(
      DIGEST,
    );
    const flipped = Uint8Array.from(MATERIAL);
    flipped[31] = 0xff;
    expect(linkAuthBindingDigest(flipped, sha256)).not.toBe(DIGEST);
    expect(linkAuthBindingDigest(MATERIAL.subarray(0, 31), sha256)).not.toBe(
      DIGEST,
    );
  });

  it('accepts a Node Buffer', () => {
    expect(linkAuthBindingDigest(Buffer.from(MATERIAL), sha256)).toBe(DIGEST);
  });

  it('throws TypeError for empty, non-byte or unhashable input', () => {
    for (const bad of [
      new Uint8Array(0),
      'token',
      [1, 2, 3],
      null,
      undefined,
      new Uint16Array(4),
    ]) {
      expect(() => linkAuthBindingDigest(bad as never, sha256)).toThrow(
        TypeError,
      );
    }
    expect(() => linkAuthBindingDigest(MATERIAL, undefined as never)).toThrow(
      TypeError,
    );
    expect(() =>
      linkAuthBindingDigest(MATERIAL, () => new Uint8Array(20)),
    ).toThrow(TypeError);
  });
});

// ---- transcript ------------------------------------------------------------------------------

describe('linkAuthTranscript', () => {
  it('has the specified shape and key order, all printable ASCII', () => {
    const { text, hash } = transcriptOf();
    expect(text).toMatch(/^[\x20-\x7e]+$/);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([
      'domain',
      'v',
      'rideId',
      'sessionId',
      'binding',
      'a',
      'b',
    ]);
    expect(parsed.domain).toBe('rideaze.link-auth.v1.transcript');
    expect(parsed.v).toBe(1);
    expect(parsed.rideId).toBe(RIDE);
    expect(parsed.sessionId).toBe(SESSION);
    expect(Object.keys(parsed.binding)).toEqual(['kind', 'digest']);
    expect(parsed.binding).toEqual({
      kind: 'nearby-auth-token-v1',
      digest: DIGEST,
    });
    expect(Object.keys(parsed.a)).toEqual(['nodeId', 'nonce', 'credential']);
    expect(Object.keys(parsed.b)).toEqual(['nodeId', 'nonce', 'credential']);
    expect(hash).toBe(encodeBase64Url(sha256(new TextEncoder().encode(text))));
    expect(hash).toHaveLength(43);
    expect(deepFrozen(transcriptOf())).toBe(true);
  });

  it('orders the parties by node id: a is the smaller one, with its own nonce and credential hash', () => {
    const { text } = transcriptOf();
    const parsed = JSON.parse(text);
    const [first, second] = [partyA, partyB].sort((x, y) =>
      x.nodeId < y.nodeId ? -1 : 1,
    );
    expect(parsed.a).toEqual({
      nodeId: first.nodeId,
      nonce: first.nonce,
      credential: linkAuthCredentialHash(first.credential, sha256),
    });
    expect(parsed.b).toEqual({
      nodeId: second.nodeId,
      nonce: second.nonce,
      credential: linkAuthCredentialHash(second.credential, sha256),
    });
    expect(parsed.a.nodeId < parsed.b.nodeId).toBe(true);
  });

  it('is identical on both sides: swapping local and peer changes nothing', () => {
    const one = transcriptOf({ local: partyA, peer: partyB });
    const two = transcriptOf({ local: partyB, peer: partyA });
    expect(two.text).toBe(one.text);
    expect(two.hash).toBe(one.hash);
  });

  it('is deterministic', () => {
    expect(transcriptOf().hash).toBe(transcriptOf().hash);
  });

  it('does not depend on the signature of either credential', () => {
    const maulCredential = (c: RideCredential): RideCredential => ({
      ...c,
      sig: encodeBase64Url(maul(decodeBase64Url(c.sig) as Uint8Array)),
    });
    const twin = transcriptOf({
      local: { ...partyA, credential: maulCredential(partyA.credential) },
      peer: { ...partyB, credential: maulCredential(partyB.credential) },
    });
    expect(twin.hash).toBe(transcriptOf().hash);
  });

  describe('every input changes the hash', () => {
    const base = transcriptOf().hash;
    const other = (label: string, value: { hash: string }) =>
      it(`changes with ${label}`, () => expect(value.hash).not.toBe(base));

    const otherRide = (rideId: string) => ({
      rideId,
      local: partyFor(devA, NONCE_A, { rideId }),
      peer: partyFor(devB, NONCE_B, { rideId }),
    });
    other('the room code', transcriptOf(otherRide('99999')));
    other(
      'the session id',
      transcriptOf({
        sessionId: OTHER_SESSION,
        local: partyFor(devA, NONCE_A, { sessionId: OTHER_SESSION }),
        peer: partyFor(devB, NONCE_B, { sessionId: OTHER_SESSION }),
      }),
    );
    other('the binding kind', transcriptOf({ binding: UNBOUND }));
    other(
      'the binding digest',
      transcriptOf({
        binding: { kind: 'nearby-auth-token-v1', digest: OTHER_DIGEST },
      }),
    );
    other(
      'the local nonce',
      transcriptOf({ local: { ...partyA, nonce: NONCE_C } }),
    );
    other(
      'the peer nonce',
      transcriptOf({ peer: { ...partyB, nonce: NONCE_C } }),
    );
    other('the peer identity', transcriptOf({ peer: partyFor(devC, NONCE_B) }));
    other(
      'the local identity',
      transcriptOf({ local: partyFor(devC, NONCE_A) }),
    );
    other(
      "the peer's credential (same node, later expiry)",
      transcriptOf({
        peer: partyFor(devB, NONCE_B, { expiresAt: EXPIRES_AT + 1 }),
      }),
    );
    other(
      'the local credential (same node, different kid)',
      transcriptOf({ local: partyFor(devA, NONCE_A, { kid: 'srv-other' }) }),
    );

    it('serialises an unavailable binding with a null digest', () => {
      expect(
        JSON.parse(transcriptOf({ binding: UNBOUND }).text).binding,
      ).toEqual({
        kind: 'unavailable',
        digest: null,
      });
    });
  });

  describe('throws TypeError for inconsistent input', () => {
    const cases: [string, () => unknown][] = [
      [
        'a ride id that is not a room code',
        () => transcriptOf({ rideId: 'RIDE1' }),
      ],
      [
        'a UUID as the ride id',
        () => transcriptOf({ rideId: '3f2b8c1e-9d4a-4b6f-8e21-5a7c9d0e1f23' }),
      ],
      [
        'a non-canonical session id',
        () => transcriptOf({ sessionId: withLastChar(SESSION, 'x') }),
      ],
      [
        'a session id that is a room code',
        () => transcriptOf({ sessionId: RIDE }),
      ],
      [
        'a ride different from the credentials',
        () => transcriptOf({ rideId: '99999' }),
      ],
      [
        'a session different from the credentials',
        () => transcriptOf({ sessionId: OTHER_SESSION }),
      ],
      [
        'a binding that is not an object',
        () => transcriptOf({ binding: 'unavailable' as never }),
      ],
      [
        'an unknown binding kind',
        () => transcriptOf({ binding: { kind: 'tls' } as never }),
      ],
      [
        'a token binding without a digest',
        () =>
          transcriptOf({ binding: { kind: 'nearby-auth-token-v1' } as never }),
      ],
      [
        'a token binding with a non-canonical digest',
        () =>
          transcriptOf({
            binding: {
              kind: 'nearby-auth-token-v1',
              digest: withLastChar(DIGEST, 'B'),
            },
          }),
      ],
      [
        'an unavailable binding that carries a digest',
        () =>
          transcriptOf({
            binding: { kind: 'unavailable', digest: DIGEST } as never,
          }),
      ],
      [
        'an extra key on a token binding',
        () =>
          transcriptOf({
            binding: {
              kind: 'nearby-auth-token-v1',
              digest: DIGEST,
              extra: 1,
            } as never,
          }),
      ],
      [
        'equal node ids (a node talking to itself)',
        () =>
          transcriptOf({ local: partyA, peer: { ...partyA, nonce: NONCE_B } }),
      ],
      [
        'equal nonces',
        () =>
          transcriptOf({ local: partyA, peer: { ...partyB, nonce: NONCE_A } }),
      ],
      [
        'a non-canonical nonce',
        () =>
          transcriptOf({
            local: { ...partyA, nonce: withLastChar(NONCE_A, 'B') },
          }),
      ],
      [
        'a non-canonical node id',
        () =>
          transcriptOf({
            peer: { ...partyB, nodeId: withLastChar(partyB.nodeId, 'B') },
          }),
      ],
      [
        "a party's credential belonging to another node",
        () =>
          transcriptOf({ peer: { ...partyB, credential: partyA.credential } }),
      ],
      [
        'a structurally invalid credential',
        () =>
          transcriptOf({
            peer: { ...partyB, credential: { ...partyB.credential, sig: 'x' } },
          }),
      ],
      [
        'a party that is not an object',
        () => transcriptOf({ local: null as never }),
      ],
      ['a missing peer', () => transcriptOf({ peer: undefined as never })],
    ];
    it.each(cases)('%s', (_label, run) => {
      expect(run).toThrow(TypeError);
    });

    it('an unusable sha256', () => {
      const input = {
        rideId: RIDE,
        sessionId: SESSION,
        binding: BOUND,
        local: partyA,
        peer: partyB,
      };
      expect(() => linkAuthTranscript(input, undefined as never)).toThrow(
        TypeError,
      );
      expect(() => linkAuthTranscript(input, () => new Uint8Array(31))).toThrow(
        TypeError,
      );
    });
  });
});

// ---- signing input ---------------------------------------------------------------------------

describe('linkAuthSigningInput', () => {
  const SIGNER = 'A'.repeat(43);
  const PEER = `${'A'.repeat(42)}E`;
  const HASH = 'A'.repeat(43);
  const fields = { signer: SIGNER, peer: PEER, transcript: HASH };

  it('has the exact text for proof and for confirm', () => {
    expect(linkAuthSigningInput('proof', fields)).toBe(
      `{"domain":"rideaze.link-auth.v1.proof","v":1,"signer":"${SIGNER}","peer":"${PEER}","transcript":"${HASH}"}`,
    );
    expect(linkAuthSigningInput('confirm', fields)).toBe(
      `{"domain":"rideaze.link-auth.v1.confirm","v":1,"signer":"${SIGNER}","peer":"${PEER}","transcript":"${HASH}"}`,
    );
  });

  it('gives proof and confirm different text for identical fields', () => {
    expect(linkAuthSigningInput('proof', fields)).not.toBe(
      linkAuthSigningInput('confirm', fields),
    );
  });

  it('is different when the signer and the peer are swapped', () => {
    for (const stage of ['proof', 'confirm'] as const) {
      expect(linkAuthSigningInput(stage, fields)).not.toBe(
        linkAuthSigningInput(stage, {
          signer: PEER,
          peer: SIGNER,
          transcript: HASH,
        }),
      );
    }
  });

  it('depends on the transcript hash', () => {
    expect(linkAuthSigningInput('proof', fields)).not.toBe(
      linkAuthSigningInput('proof', {
        ...fields,
        transcript: `${'A'.repeat(42)}E`,
      }),
    );
  });

  it('keeps the specified key order and is printable ASCII', () => {
    const text = linkAuthSigningInput('proof', fields);
    expect(text).toMatch(/^[\x20-\x7e]+$/);
    expect(Object.keys(JSON.parse(text))).toEqual([
      'domain',
      'v',
      'signer',
      'peer',
      'transcript',
    ]);
  });

  it('throws TypeError as specified', () => {
    for (const stage of [
      'hello',
      'Proof',
      'PROOF',
      '',
      undefined,
      null,
      'proof ',
    ]) {
      expect(() => linkAuthSigningInput(stage as never, fields)).toThrow(
        TypeError,
      );
    }
    expect(() =>
      linkAuthSigningInput('proof', { ...fields, signer: 'node-1' }),
    ).toThrow(TypeError);
    expect(() =>
      linkAuthSigningInput('proof', {
        ...fields,
        peer: withLastChar(PEER, 'B'),
      }),
    ).toThrow(TypeError);
    expect(() =>
      linkAuthSigningInput('proof', { ...fields, signer: PEER }),
    ).toThrow(TypeError);
    expect(() =>
      linkAuthSigningInput('proof', { ...fields, transcript: HASH.slice(1) }),
    ).toThrow(TypeError);
    expect(() =>
      linkAuthSigningInput('proof', {
        ...fields,
        transcript: withLastChar(HASH, 'B'),
      }),
    ).toThrow(TypeError);
    expect(() => linkAuthSigningInput('proof', undefined as never)).toThrow(
      TypeError,
    );
  });
});

// ---- signature verification ------------------------------------------------------------------

describe('verifyLinkAuthSignature', () => {
  const idA = partyA.nodeId;
  const idB = partyB.nodeId;
  const { hash } = transcriptOf();

  /** device `signerKey` (named `signer`) signs for `peer`. */
  function signedBy(
    stage: LinkAuthSigningStage,
    signerKey: KeyPair,
    signer: string,
    peer: string,
  ) {
    return signText(
      linkAuthSigningInput(stage, { signer, peer, transcript: hash }),
      signerKey.privateKey,
    );
  }
  const args = (
    stage: LinkAuthSigningStage,
    over: Partial<Parameters<typeof verifyLinkAuthSignature>[0]> = {},
  ) => ({
    stage,
    signer: idA,
    peer: idB,
    transcript: hash,
    signerPublicKey: devA.publicKey,
    signature: signedBy(stage, devA, idA, idB),
    ...over,
  });

  it.each(['proof', 'confirm'] as const)(
    'accepts a valid %s signature, low-S or high-S',
    stage => {
      const a = args(stage);
      expect(verifyLinkAuthSignature(a, nodeVerifySignature, sha256)).toBe(
        true,
      );
      expect(
        verifyLinkAuthSignature(
          { ...a, signature: maul(a.signature) },
          nodeVerifySignature,
          sha256,
        ),
      ).toBe(true);
    },
  );

  it('accepts a valid signature from each side', () => {
    expect(
      verifyLinkAuthSignature(
        args('proof', {
          signer: idB,
          peer: idA,
          signerPublicKey: devB.publicKey,
          signature: signedBy('proof', devB, idB, idA),
        }),
        nodeVerifySignature,
        sha256,
      ),
    ).toBe(true);
  });

  it('rejects a signature by the wrong key', () => {
    for (const stage of ['proof', 'confirm'] as const) {
      expect(
        verifyLinkAuthSignature(
          args(stage, { signerPublicKey: devB.publicKey }),
          nodeVerifySignature,
          sha256,
        ),
      ).toBe(false);
      expect(
        verifyLinkAuthSignature(
          args(stage, { signature: signedBy(stage, devC, idA, idB) }),
          nodeVerifySignature,
          sha256,
        ),
      ).toBe(false);
    }
  });

  it('rejects a PROOF signature presented as a CONFIRM, and the reverse', () => {
    const proof = args('proof');
    const confirm = args('confirm');
    expect(
      verifyLinkAuthSignature(
        { ...proof, stage: 'confirm' },
        nodeVerifySignature,
        sha256,
      ),
    ).toBe(false);
    expect(
      verifyLinkAuthSignature(
        { ...confirm, stage: 'proof' },
        nodeVerifySignature,
        sha256,
      ),
    ).toBe(false);
  });

  it("rejects a party's own signature reflected back as the peer's", () => {
    for (const stage of ['proof', 'confirm'] as const) {
      const mine = signedBy(stage, devA, idA, idB);
      // checked against the peer's key and the peer's role
      expect(
        verifyLinkAuthSignature(
          args(stage, {
            signer: idB,
            peer: idA,
            signerPublicKey: devB.publicKey,
            signature: mine,
          }),
          nodeVerifySignature,
          sha256,
        ),
      ).toBe(false);
      // checked with my own key but the roles swapped
      expect(
        verifyLinkAuthSignature(
          args(stage, {
            signer: idB,
            peer: idA,
            signerPublicKey: devA.publicKey,
            signature: mine,
          }),
          nodeVerifySignature,
          sha256,
        ),
      ).toBe(false);
    }
  });

  it('rejects a tampered transcript hash and a signature over a different transcript', () => {
    const tampered = `${hash[0] === 'B' ? 'C' : 'B'}${hash.slice(1)}`;
    expect(isCanonicalLinkAuthTranscriptHash(tampered)).toBe(true);
    for (const stage of ['proof', 'confirm'] as const) {
      expect(
        verifyLinkAuthSignature(
          args(stage, { transcript: tampered }),
          nodeVerifySignature,
          sha256,
        ),
      ).toBe(false);
      const other = transcriptOf({ binding: UNBOUND }).hash;
      expect(
        verifyLinkAuthSignature(
          args(stage, { transcript: other }),
          nodeVerifySignature,
          sha256,
        ),
      ).toBe(false);
    }
  });

  it('rejects a signature over a transcript with a different binding', () => {
    const unbound = transcriptOf({ binding: UNBOUND }).hash;
    const signature = signText(
      linkAuthSigningInput('proof', {
        signer: idA,
        peer: idB,
        transcript: unbound,
      }),
      devA.privateKey,
    );
    expect(
      verifyLinkAuthSignature(
        args('proof', { signature }),
        nodeVerifySignature,
        sha256,
      ),
    ).toBe(false);
    expect(
      verifyLinkAuthSignature(
        args('proof', { signature, transcript: unbound }),
        nodeVerifySignature,
        sha256,
      ),
    ).toBe(true);
  });

  describe('fails closed', () => {
    it('on a throwing callback', () => {
      const cb = jest.fn(() => {
        throw new Error('native verifier crashed');
      });
      expect(verifyLinkAuthSignature(args('proof'), cb, sha256)).toBe(false);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('on a callback that returns a Promise, even one resolving true', () => {
      expect(
        verifyLinkAuthSignature(
          args('proof'),
          jest.fn(async () => true) as never,
          sha256,
        ),
      ).toBe(false);
      expect(
        verifyLinkAuthSignature(
          args('proof'),
          jest.fn((k, m, s) =>
            Promise.resolve(nodeVerifySignature(k, m, s)),
          ) as never,
          sha256,
        ),
      ).toBe(false);
    });

    it('attaches a rejection handler to a returned Promise so nothing is left unhandled', () => {
      const pending = Promise.reject(new Error('async verifier failed'));
      pending.catch(() => undefined); // the test's own handler keeps a regression from crashing the worker
      const thenSpy = jest.spyOn(pending, 'then');
      expect(
        verifyLinkAuthSignature(
          args('proof'),
          jest.fn(() => pending as never),
          sha256,
        ),
      ).toBe(false);
      expect(thenSpy).toHaveBeenCalledWith(undefined, expect.any(Function));
    });

    it('on a thenable whose then accessor throws', () => {
      const hostile = {
        get then(): never {
          throw new Error('hostile then');
        },
      };
      expect(
        verifyLinkAuthSignature(
          args('proof'),
          jest.fn(() => hostile as never),
          sha256,
        ),
      ).toBe(false);
    });

    it.each([
      ['1', 1],
      ['the string "true"', 'true'],
      ['an object', {}],
      ['an array', [true]],
      ['undefined', undefined],
      ['null', null],
      ['false', false],
      ['a Boolean object', Object(true)],
    ])('on a callback returning %s', (_label, returned) => {
      expect(
        verifyLinkAuthSignature(
          args('proof'),
          jest.fn(() => returned as never),
          sha256,
        ),
      ).toBe(false);
    });

    it('on invalid arguments, without ever calling the verifier', () => {
      const cb = jest.fn(() => true);
      const proof = args('proof');
      const bad: unknown[] = [
        null,
        undefined,
        'input',
        { ...proof, stage: 'hello' },
        { ...proof, stage: undefined },
        { ...proof, signer: idA, peer: idA },
        { ...proof, signer: 'node-1' },
        { ...proof, transcript: hash.slice(1) },
        { ...proof, transcript: withLastChar(hash, 'B') },
        { ...proof, signerPublicKey: devA.publicKey.subarray(0, 64) },
        {
          ...proof,
          signerPublicKey: Uint8Array.from([2, ...devA.publicKey.subarray(1)]),
        },
        { ...proof, signerPublicKey: new Uint8Array(66) },
        { ...proof, signerPublicKey: 'key' },
        { ...proof, signature: proof.signature.subarray(0, 63) },
        { ...proof, signature: new Uint8Array(65) },
        { ...proof, signature: new Uint8Array(71) },
        { ...proof, signature: encodeBase64Url(proof.signature) },
        { ...proof, signature: undefined },
      ];
      for (const input of bad) {
        expect(verifyLinkAuthSignature(input as never, cb, sha256)).toBe(false);
      }
      expect(cb).not.toHaveBeenCalled();
    });

    it('when the verifier itself is missing', () => {
      expect(
        verifyLinkAuthSignature(args('proof'), undefined as never, sha256),
      ).toBe(false);
      expect(
        verifyLinkAuthSignature(args('proof'), 'verify' as never, sha256),
      ).toBe(false);
    });

    it('on an input object whose getters throw', () => {
      const hostile = {};
      for (const key of [
        'stage',
        'signer',
        'peer',
        'transcript',
        'signerPublicKey',
        'signature',
      ]) {
        Object.defineProperty(hostile, key, {
          enumerable: true,
          get() {
            throw new Error(`hostile ${key}`);
          },
        });
      }
      expect(() =>
        verifyLinkAuthSignature(hostile as never, nodeVerifySignature, sha256),
      ).not.toThrow();
      expect(
        verifyLinkAuthSignature(hostile as never, nodeVerifySignature, sha256),
      ).toBe(false);
    });
  });

  it('passes the verifier the signing-input bytes and fresh copies of the key and signature', () => {
    const a = args('proof');
    const cb = jest.fn((k: Uint8Array, m: Uint8Array, s: Uint8Array) => {
      const ok = nodeVerifySignature(k, m, s);
      k.fill(0);
      s.fill(0);
      return ok;
    });
    expect(verifyLinkAuthSignature(a, cb, sha256)).toBe(true);
    const [key, message, signature] = cb.mock.calls[0];
    expect(Buffer.from(message).toString('utf8')).toBe(
      linkAuthSigningInput('proof', {
        signer: idA,
        peer: idB,
        transcript: hash,
      }),
    );
    expect(key).not.toBe(a.signerPublicKey);
    expect(signature).not.toBe(a.signature);
    // the caller's buffers were not touched by the callback scribbling on its copies
    expect(Array.from(a.signerPublicKey)).toEqual(Array.from(devA.publicKey));
    expect(a.signature.some(byte => byte !== 0)).toBe(true);
    expect(verifyLinkAuthSignature(a, nodeVerifySignature, sha256)).toBe(true);
  });

  it('never uses signature bytes as an identity: the same statement has two valid signatures', () => {
    const a = args('confirm');
    const twin = maul(a.signature);
    expect(Buffer.from(twin).equals(Buffer.from(a.signature))).toBe(false);
    expect(
      verifyLinkAuthSignature(
        { ...a, signature: twin },
        nodeVerifySignature,
        sha256,
      ),
    ).toBe(true);
    expect(verifyLinkAuthSignature(a, nodeVerifySignature, sha256)).toBe(true);
  });
});

// ---- fixed interoperability vector -----------------------------------------------------------

/**
 * A fixed, complete link_auth exchange between two devices, recorded here from a Node crypto
 * generator. At authoring time (Task 2.2) it was verified by an independent implementation (Python
 * `cryptography` 50.0.1) that rebuilt every hashed and signed string from the raw fields without
 * reading any of the strings recorded below: the two credentials (server signatures, device keys on
 * the curve, node ids), both credential hashes, the binding digest, the transcript text and hash,
 * and all four signing inputs and signatures (each device, PROOF and CONFIRM). It also confirmed
 * that PROOF and CONFIRM signatures do not verify across stages, under the wrong key, with signer
 * and peer swapped, or over a tampered transcript. The party whose node id sorts first is the
 * SECOND party here, so the vector also exercises the node-id ordering. The backend, the Android
 * signer and any other implementation must reproduce these strings byte for byte.
 */
describe('fixed link_auth interoperability vector', () => {
  const VECTOR_RIDE_ID = '54321';
  const VECTOR_SESSION_ID = 'AAECAwQFBgcICQoLDA0ODw';
  const VECTOR_SERVER_PUB =
    'BHdiItO9F5hbug50rszLNJ9C6z44VnJNPONnhPXHYXzxzTYunMAmd-mOfrmVX0CXuz5o9ywOQd9WaGyHn6YErVY';
  const VECTOR_BINDING_MATERIAL_HEX =
    '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
  const VECTOR_BINDING_DIGEST = '69QyRZa15DqWr3JZCtMFyR2dm_IcoNR5H4MtHZrfd1U';
  /** The party whose node id sorts first ("a" in the transcript). */
  const VECTOR_FIRST_NODE_ID = 'aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o';
  const VECTOR_CREDENTIAL_HASHES = [
    'q6CrsLtkkVJUqRkMRaYWWo0CoNniVMx-WxlVYiraJ60',
    'zaAClOs6lDvYpbxW16DFnLTCi6SsF_q6Ej4US1Hyaew',
  ];
  const VECTOR_PARTIES: LinkAuthParty[] = [
    {
      nodeId: 'zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0',
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      credential: {
        v: 1,
        kid: 'srv-vector-1',
        rideId: '54321',
        sessionId: 'AAECAwQFBgcICQoLDA0ODw',
        nodeId: 'zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0',
        pub: 'BM5IkuRXOhzlhGSMAijSdE7v4whHMHXWQvDMAbBpi8rmnGK7yUqwEOWa60c7boAfRVqrteZmTH8afokYAbQ4MgI',
        issuedAt: 1700000000000,
        expiresAt: 1700259200000,
        sig: 'YwO-s2xPeVRew1rsLTSL3wX1qtDnX57v58Oi3unrp8IL2ubyAJDxn8BGQ7Fw9nqbLl57TwwfXfU8iMQVCh7dDg',
      },
    },
    {
      nodeId: 'aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o',
      nonce: 'AQEBAQEBAQEBAQEBAQEBAQ',
      credential: {
        v: 1,
        kid: 'srv-vector-1',
        rideId: '54321',
        sessionId: 'AAECAwQFBgcICQoLDA0ODw',
        nodeId: 'aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o',
        pub: 'BFNLS4_rDi1sR6bJITh_y1UMLYnRFlIiU0Bsy3oqont75-8Xd24to54GJdZ-g5ovDuTnAQarqXriZYeYrg4UF4w',
        issuedAt: 1700000000000,
        expiresAt: 1700259200000,
        sig: '-J_L1sgAZl5ZDzCRs8l4JztWw_Bjq13osbU5kLsBXW6R8bybk-XdrPioiVdCh15UOL2QajXMitqG5LWmysJ9DQ',
      },
    },
  ];
  const VECTOR_TRANSCRIPT_TEXT =
    '{"domain":"rideaze.link-auth.v1.transcript","v":1,"rideId":"54321","sessionId":"AAECAwQFBgcICQoLDA0ODw","binding":{"kind":"nearby-auth-token-v1","digest":"69QyRZa15DqWr3JZCtMFyR2dm_IcoNR5H4MtHZrfd1U"},"a":{"nodeId":"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o","nonce":"AQEBAQEBAQEBAQEBAQEBAQ","credential":"zaAClOs6lDvYpbxW16DFnLTCi6SsF_q6Ej4US1Hyaew"},"b":{"nodeId":"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0","nonce":"AAAAAAAAAAAAAAAAAAAAAA","credential":"q6CrsLtkkVJUqRkMRaYWWo0CoNniVMx-WxlVYiraJ60"}}';
  const VECTOR_TRANSCRIPT_HASH = 'gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU';
  const VECTOR_SIGNATURES = [
    {
      signer: 'zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0',
      peer: 'aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o',
      proofInput:
        '{"domain":"rideaze.link-auth.v1.proof","v":1,"signer":"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0","peer":"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o","transcript":"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"}',
      proofSig:
        'XA9IGuPgBfkvc9BfcSPdpR--VG4dtn68QypLBuCAN8IVnFyeaLQb2mR45lrdCme5CTa_7jRznJfU9pTG5phShg',
      confirmInput:
        '{"domain":"rideaze.link-auth.v1.confirm","v":1,"signer":"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0","peer":"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o","transcript":"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"}',
      confirmSig:
        'mBzO14cLhqAwDlRmpXjhM0F_g5luY3_MCrF4GO4bfM1hgtOrpKi3J09oj7Vcf5IPhDgjCe73orx3dfcisaADeQ',
    },
    {
      signer: 'aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o',
      peer: 'zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0',
      proofInput:
        '{"domain":"rideaze.link-auth.v1.proof","v":1,"signer":"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o","peer":"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0","transcript":"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"}',
      proofSig:
        '5qy3OTChLkhTbS7-XgJwEcVa6WfWL9NQRmG8aRxiPb56lwF9yFr_lukTvjWie6WO0zyjrajdZdXtzIYJ0opm3w',
      confirmInput:
        '{"domain":"rideaze.link-auth.v1.confirm","v":1,"signer":"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o","peer":"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0","transcript":"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"}',
      confirmSig:
        'hKj_EdJymE6mpF_5QEk2mOmnYSdpzKgIpQJjzDUdtYXPLbt8PdaNVnvQBKLR1jzNxERfCENUNKGfgCcOljbOeA',
    },
  ];

  const material = Uint8Array.from(
    Buffer.from(VECTOR_BINDING_MATERIAL_HEX, 'hex'),
  );
  const serverPub = decodeBase64Url(VECTOR_SERVER_PUB) as Uint8Array;
  const [p0, p1] = VECTOR_PARTIES;
  const keyOf = (p: LinkAuthParty) =>
    decodeBase64Url(p.credential.pub) as Uint8Array;
  const VECTOR_BINDING: LocalChannelBinding = {
    kind: 'nearby-auth-token-v1',
    digest: VECTOR_BINDING_DIGEST,
  };
  const transcriptFor = (
    local: LinkAuthParty,
    peer: LinkAuthParty,
    binding: LocalChannelBinding = VECTOR_BINDING,
  ) =>
    linkAuthTranscript(
      {
        rideId: VECTOR_RIDE_ID,
        sessionId: VECTOR_SESSION_ID,
        binding,
        local,
        peer,
      },
      sha256,
    );

  it('both credentials verify under the recorded server key for this ride and session', () => {
    const verifier = createRideCredentialVerifier({
      rideId: VECTOR_RIDE_ID,
      sessionId: VECTOR_SESSION_ID,
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
      verifySignature: nodeVerifySignature,
      sha256,
    });
    for (const party of VECTOR_PARTIES) {
      expect(
        verifier.verify(party.credential, party.credential.issuedAt + 1).ok,
      ).toBe(true);
    }
  });

  it('node ids are the SHA-256 of the recorded device keys', () => {
    for (const party of VECTOR_PARTIES) {
      expect(deriveRideNodeId(keyOf(party), sha256)).toBe(party.nodeId);
      expect(party.credential.nodeId).toBe(party.nodeId);
    }
  });

  it('derives the recorded binding digest from the recorded material', () => {
    expect(material).toHaveLength(32);
    expect(linkAuthBindingDigest(material, sha256)).toBe(VECTOR_BINDING_DIGEST);
  });

  it('derives the recorded credential hashes', () => {
    expect(
      VECTOR_PARTIES.map(p => linkAuthCredentialHash(p.credential, sha256)),
    ).toEqual(VECTOR_CREDENTIAL_HASHES);
  });

  it('produces the recorded transcript byte for byte, from either side', () => {
    for (const [local, peer] of [
      [p0, p1],
      [p1, p0],
    ] as const) {
      const { text, hash } = transcriptFor(local, peer);
      expect(text).toBe(VECTOR_TRANSCRIPT_TEXT);
      expect(hash).toBe(VECTOR_TRANSCRIPT_HASH);
    }
  });

  it('orders the parties by node id: the recorded "a" is the second party, not the first', () => {
    expect(JSON.parse(VECTOR_TRANSCRIPT_TEXT).a.nodeId).toBe(
      VECTOR_FIRST_NODE_ID,
    );
    expect(VECTOR_FIRST_NODE_ID).toBe(p1.nodeId);
    expect(p1.nodeId < p0.nodeId).toBe(true);
  });

  it('produces the recorded PROOF and CONFIRM signing inputs byte for byte', () => {
    for (const s of VECTOR_SIGNATURES) {
      const fields = {
        signer: s.signer,
        peer: s.peer,
        transcript: VECTOR_TRANSCRIPT_HASH,
      };
      expect(linkAuthSigningInput('proof', fields)).toBe(s.proofInput);
      expect(linkAuthSigningInput('confirm', fields)).toBe(s.confirmInput);
    }
  });

  const verifyRecorded = (
    stage: LinkAuthSigningStage,
    index: number,
    over: Partial<Parameters<typeof verifyLinkAuthSignature>[0]> = {},
  ) => {
    const s = VECTOR_SIGNATURES[index];
    return verifyLinkAuthSignature(
      {
        stage,
        signer: s.signer,
        peer: s.peer,
        transcript: VECTOR_TRANSCRIPT_HASH,
        signerPublicKey: keyOf(VECTOR_PARTIES[index]),
        signature: decodeBase64Url(
          stage === 'proof' ? s.proofSig : s.confirmSig,
        ) as Uint8Array,
        ...over,
      },
      nodeVerifySignature,
      sha256,
    );
  };

  it.each([0, 1])('verifies both recorded signatures of device %i', index => {
    expect(verifyRecorded('proof', index)).toBe(true);
    expect(verifyRecorded('confirm', index)).toBe(true);
  });

  it.each([0, 1])(
    'still verifies the malleated (high-S) twins for device %i',
    index => {
      const s = VECTOR_SIGNATURES[index];
      expect(
        verifyRecorded('proof', index, {
          signature: maul(decodeBase64Url(s.proofSig) as Uint8Array),
        }),
      ).toBe(true);
      expect(
        verifyRecorded('confirm', index, {
          signature: maul(decodeBase64Url(s.confirmSig) as Uint8Array),
        }),
      ).toBe(true);
    },
  );

  it.each([0, 1])(
    'rejects a PROOF presented as a CONFIRM and a CONFIRM as a PROOF (device %i)',
    index => {
      const s = VECTOR_SIGNATURES[index];
      expect(
        verifyRecorded('confirm', index, {
          signature: decodeBase64Url(s.proofSig) as Uint8Array,
        }),
      ).toBe(false);
      expect(
        verifyRecorded('proof', index, {
          signature: decodeBase64Url(s.confirmSig) as Uint8Array,
        }),
      ).toBe(false);
    },
  );

  it.each([0, 1])(
    "rejects device %i's signatures under the other device's key",
    index => {
      const other = keyOf(VECTOR_PARTIES[1 - index]);
      expect(verifyRecorded('proof', index, { signerPublicKey: other })).toBe(
        false,
      );
      expect(verifyRecorded('confirm', index, { signerPublicKey: other })).toBe(
        false,
      );
    },
  );

  it.each([0, 1])(
    "rejects device %i's signatures reflected with signer and peer swapped",
    index => {
      const s = VECTOR_SIGNATURES[index];
      expect(
        verifyRecorded('proof', index, { signer: s.peer, peer: s.signer }),
      ).toBe(false);
      expect(
        verifyRecorded('confirm', index, { signer: s.peer, peer: s.signer }),
      ).toBe(false);
    },
  );

  it.each([0, 1])(
    "rejects device %i's signatures over a tampered transcript",
    index => {
      const tampered = `${
        VECTOR_TRANSCRIPT_HASH[0] === 'B' ? 'C' : 'B'
      }${VECTOR_TRANSCRIPT_HASH.slice(1)}`;
      expect(verifyRecorded('proof', index, { transcript: tampered })).toBe(
        false,
      );
      expect(verifyRecorded('confirm', index, { transcript: tampered })).toBe(
        false,
      );
    },
  );

  it('a different binding gives a different transcript, and the recorded signatures no longer verify', () => {
    const unbound = transcriptFor(p0, p1, { kind: 'unavailable' });
    expect(unbound.hash).not.toBe(VECTOR_TRANSCRIPT_HASH);
    expect(JSON.parse(unbound.text).binding).toEqual({
      kind: 'unavailable',
      digest: null,
    });
    expect(verifyRecorded('proof', 0, { transcript: unbound.hash })).toBe(
      false,
    );
    const otherMaterial = linkAuthBindingDigest(
      Uint8Array.from(material).reverse(),
      sha256,
    );
    expect(
      transcriptFor(p0, p1, {
        kind: 'nearby-auth-token-v1',
        digest: otherMaterial,
      }).hash,
    ).not.toBe(VECTOR_TRANSCRIPT_HASH);
  });

  it('builds the recorded messages, which round-trip through parse and JSON', () => {
    const messages: LinkAuthPayload[] = [];
    for (const [index, party] of VECTOR_PARTIES.entries()) {
      const other = VECTOR_PARTIES[1 - index];
      const s = VECTOR_SIGNATURES[index];
      messages.push(
        buildLinkAuthHello({
          credential: party.credential,
          nonce: party.nonce,
          bindingKind: 'nearby-auth-token-v1',
        }),
        buildLinkAuthProof({
          nonce: party.nonce,
          peerNonce: other.nonce,
          transcript: VECTOR_TRANSCRIPT_HASH,
          sig: s.proofSig,
        }),
        buildLinkAuthConfirm({
          nonce: party.nonce,
          peerNonce: other.nonce,
          transcript: VECTOR_TRANSCRIPT_HASH,
          sig: s.confirmSig,
        }),
      );
    }
    expect(messages).toHaveLength(6);
    for (const message of messages) {
      expect(parseLinkAuthPayload(message)).toEqual(message);
      expect(parseLinkAuthPayload(JSON.parse(JSON.stringify(message)))).toEqual(
        message,
      );
      expect(JSON.stringify(message).length).toBeLessThan(800);
    }
  });

  it('the recorded HELLO carries no binding digest, only the kind', () => {
    const hello = buildLinkAuthHello({
      credential: p0.credential,
      nonce: p0.nonce,
      bindingKind: 'nearby-auth-token-v1',
    });
    expect(JSON.stringify(hello)).not.toContain(VECTOR_BINDING_DIGEST);
    expect(hello.binding).toEqual({ kind: 'nearby-auth-token-v1' });
  });

  // After the identity binding, many "wrong key" cases are rejected before any signature is
  // checked. These keep the CRYPTOGRAPHIC layer covered on its own: the signer, the peer and the
  // key are all consistent with each other, and only the signature is wrong.
  it.each([0, 1])(
    "the signature check alone rejects device %i's signatures presented as the other device's (identity consistent)",
    index => {
      const mine = VECTOR_SIGNATURES[index];
      expect(
        verifyRecorded('proof', 1 - index, {
          signature: decodeBase64Url(mine.proofSig) as Uint8Array,
        }),
      ).toBe(false);
      expect(
        verifyRecorded('confirm', 1 - index, {
          signature: decodeBase64Url(mine.confirmSig) as Uint8Array,
        }),
      ).toBe(false);
    },
  );

  it.each([0, 1])(
    "the identity binding rejects device %i's key presented for the other device before any signature check",
    index => {
      const s = VECTOR_SIGNATURES[index];
      const calls: number[] = [];
      const counting = (k: Uint8Array, m: Uint8Array, g: Uint8Array) => {
        calls.push(1);
        return nodeVerifySignature(k, m, g);
      };
      const result = verifyLinkAuthSignature(
        {
          stage: 'proof',
          signer: VECTOR_SIGNATURES[1 - index].signer,
          peer: s.signer,
          transcript: VECTOR_TRANSCRIPT_HASH,
          signerPublicKey: keyOf(VECTOR_PARTIES[index]),
          signature: decodeBase64Url(s.proofSig) as Uint8Array,
        },
        counting,
        sha256,
      );
      expect(result).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );
});

// =================================================================================================
// Task 2.2.1: security corrections following the independent review
// =================================================================================================

describe('F1: the signer public key is bound to the signer node id', () => {
  // devC plays the attacker E, devB the victim B and devA the verifying node.
  const idA = nodeIdOf(devA);
  const idB = nodeIdOf(devB);
  const idE = nodeIdOf(devC);
  const { hash } = transcriptOf();

  const sigBy = (
    stage: LinkAuthSigningStage,
    key: KeyPair,
    signer: string,
    peer: string,
  ) =>
    signText(
      linkAuthSigningInput(stage, { signer, peer, transcript: hash }),
      key.privateKey,
    );

  type Over = Partial<Parameters<typeof verifyLinkAuthSignature>[0]>;
  type Verifier = (k: Uint8Array, m: Uint8Array, g: Uint8Array) => boolean;
  type Hasher = (d: Uint8Array) => Uint8Array;
  /** Both callbacks are explicit (no defaults), so `undefined` really reaches the function. */
  const run = (over: Over, verifier: Verifier, hasher: Hasher) =>
    verifyLinkAuthSignature(
      {
        stage: 'proof',
        signer: idE,
        peer: idA,
        transcript: hash,
        signerPublicKey: devC.publicKey,
        signature: sigBy('proof', devC, idE, idA),
        ...over,
      },
      verifier,
      hasher,
    );
  /** By default: E signs a statement naming E, presented with E's own key. */
  const check = (
    over: Over = {},
    verifier: Verifier = nodeVerifySignature,
    hasher: Hasher = sha256,
  ) => run(over, verifier, hasher);

  it('rejects a VALID signature by attacker key E on a statement that names victim B', () => {
    // The signature is genuine: E really signed this exact statement with E's private key.
    const statementNamingB = sigBy('proof', devC, idB, idA);
    expect(
      nodeVerifySignature(
        devC.publicKey,
        new TextEncoder().encode(
          linkAuthSigningInput('proof', {
            signer: idB,
            peer: idA,
            transcript: hash,
          }),
        ),
        statementNamingB,
      ),
    ).toBe(true);
    const verifier = jest.fn(nodeVerifySignature);
    expect(
      check({ signer: idB, peer: idA, signature: statementNamingB }, verifier),
    ).toBe(false);
    // The identity check fails first: no signature was even evaluated.
    expect(verifier).not.toHaveBeenCalled();
  });

  it('rejects the same attack for CONFIRM and for the malleated twin', () => {
    for (const stage of ['proof', 'confirm'] as const) {
      const forged = sigBy(stage, devC, idB, idA);
      expect(check({ stage, signer: idB, peer: idA, signature: forged })).toBe(
        false,
      );
      expect(
        check({ stage, signer: idB, peer: idA, signature: maul(forged) }),
      ).toBe(false);
    }
  });

  it("accepts the same key when the claimed signer is E's actual node id", () => {
    expect(check()).toBe(true);
    for (const stage of ['proof', 'confirm'] as const) {
      expect(check({ stage, signature: sigBy(stage, devC, idE, idA) })).toBe(
        true,
      );
    }
  });

  it('the one key and signature verify for the signer it belongs to and fail for any other claim', () => {
    const signature = sigBy('proof', devC, idE, idA);
    expect(check({ signature })).toBe(true);
    // Two canonical ids that differ from idE by construction: the last character of a canonical
    // 43-character id takes only 16 values, so a fixed replacement could equal the real one.
    const otherLast = idE.endsWith('A') ? 'E' : 'A';
    const nearMiss = withLastChar(idE, otherLast);
    expect(nearMiss).not.toBe(idE);
    expect(isCanonicalRideNodeId(nearMiss)).toBe(true);
    for (const claimed of [idA, idB, 'A'.repeat(43), nearMiss]) {
      expect(claimed).not.toBe(idE);
      expect(check({ signer: claimed, signature })).toBe(false);
    }
  });

  it('a genuine signature from each side still verifies, including the high-S twin', () => {
    for (const [dev, signer, peer] of [
      [devA, idA, idB],
      [devB, idB, idA],
      [devC, idE, idA],
    ] as const) {
      for (const stage of ['proof', 'confirm'] as const) {
        const signature = sigBy(stage, dev, signer, peer);
        const over = { stage, signer, peer, signerPublicKey: dev.publicKey };
        expect(check({ ...over, signature })).toBe(true);
        expect(check({ ...over, signature: maul(signature) })).toBe(true);
      }
    }
  });

  it('derives the identity exactly once, before the signature check', () => {
    const hasher = jest.fn(sha256);
    const verifier = jest.fn(nodeVerifySignature);
    expect(check({}, verifier, hasher)).toBe(true);
    expect(hasher).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(hasher.mock.invocationCallOrder[0]).toBeLessThan(
      verifier.mock.invocationCallOrder[0],
    );
    expect(Array.from(hasher.mock.calls[0][0])).toEqual(
      Array.from(devC.publicKey),
    );
  });

  it('keeps PROOF and CONFIRM signatures non-interchangeable under the new API', () => {
    const proof = sigBy('proof', devC, idE, idA);
    const confirm = sigBy('confirm', devC, idE, idA);
    expect(check({ stage: 'confirm', signature: proof })).toBe(false);
    expect(check({ stage: 'proof', signature: confirm })).toBe(false);
  });

  describe('malformed public keys fail closed', () => {
    const point = devC.publicKey;
    const bad: [string, unknown][] = [
      ['64 bytes', point.subarray(0, 64)],
      ['66 bytes', new Uint8Array(66).fill(4)],
      ['a compressed prefix', Uint8Array.from([2, ...point.subarray(1)])],
      ['a zero prefix', Uint8Array.from([0, ...point.subarray(1)])],
      ['an empty array', new Uint8Array(0)],
      ['a string', encodeBase64Url(point)],
      ['an ordinary array', Array.from(point)],
      ['null', null],
      ['undefined', undefined],
    ];
    it.each(bad)('%s: false, with neither callback invoked', (_label, key) => {
      const verifier = jest.fn(() => true);
      const hasher = jest.fn(sha256);
      expect(check({ signerPublicKey: key as never }, verifier, hasher)).toBe(
        false,
      );
      expect(verifier).not.toHaveBeenCalled();
      expect(hasher).not.toHaveBeenCalled();
    });

    it('a well-shaped but unrelated point (all zero coordinates) fails the identity check', () => {
      const zero = new Uint8Array(65);
      zero[0] = 4;
      const verifier = jest.fn(() => true);
      expect(check({ signerPublicKey: zero }, verifier)).toBe(false);
      expect(verifier).not.toHaveBeenCalled();
    });
  });

  describe('the hash callback fails closed', () => {
    const rejectsWith = (hasher: unknown) => {
      const verifier = jest.fn(() => true);
      expect(run({}, verifier, hasher as never)).toBe(false);
      expect(verifier).not.toHaveBeenCalled();
    };

    it('when it throws', () => {
      rejectsWith(() => {
        throw new Error('hash crashed');
      });
    });

    it.each([
      ['31 bytes', () => new Uint8Array(31)],
      ['33 bytes', () => new Uint8Array(33)],
      ['a string', () => 'digest'],
      ['undefined', () => undefined],
      ['null', () => null],
      ['an ordinary array', () => Array.from(sha256(devC.publicKey))],
      ['a Uint16Array', () => new Uint16Array(16)],
    ])('when it returns %s', (_label, hasher) => {
      rejectsWith(hasher);
    });

    it('when it is missing or not a function', () => {
      for (const hasher of [undefined, null, 'sha256', {}, 7]) {
        rejectsWith(hasher);
      }
    });

    it('when it returns a Promise, and the Promise is not left unhandled', () => {
      const pending = Promise.reject(new Error('async hash failed'));
      pending.catch(() => undefined); // keeps a regression from crashing the worker
      const thenSpy = jest.spyOn(pending, 'then');
      rejectsWith(() => pending);
      expect(thenSpy).toHaveBeenCalledWith(undefined, expect.any(Function));
      rejectsWith(async () => sha256(devC.publicKey));
    });

    it('when it returns a thenable whose then accessor throws', () => {
      rejectsWith(() => ({
        get then(): never {
          throw new Error('hostile then');
        },
      }));
    });

    it('and cannot corrupt the key that is verified: it receives its own copy', () => {
      const original = Uint8Array.from(devC.publicKey);
      const scribbling = jest.fn((data: Uint8Array) => {
        const digest = sha256(data);
        data.fill(0);
        return digest;
      });
      const verifier = jest.fn(nodeVerifySignature);
      expect(check({ signerPublicKey: original }, verifier, scribbling)).toBe(
        true,
      );
      expect(Array.from(original)).toEqual(Array.from(devC.publicKey));
      expect(Array.from(verifier.mock.calls[0][0])).toEqual(
        Array.from(devC.publicKey),
      );
    });
  });

  describe('the signature callback still fails closed once the identity matches', () => {
    it('when it throws', () => {
      const verifier = jest.fn(() => {
        throw new Error('native verifier crashed');
      });
      expect(check({}, verifier)).toBe(false);
      expect(verifier).toHaveBeenCalledTimes(1);
    });

    it('when it returns a Promise, even one resolving true', () => {
      expect(check({}, jest.fn(async () => true) as never)).toBe(false);
    });

    it.each([1, 'true', {}, [true], undefined, null, false, Object(true)])(
      'when it returns %p',
      returned => {
        expect(
          check(
            {},
            jest.fn(() => returned as never),
          ),
        ).toBe(false);
      },
    );

    it('when it is missing or not a function', () => {
      for (const verifier of [undefined, null, 'verify', {}, 7]) {
        expect(run({}, verifier as never, sha256)).toBe(false);
      }
    });
  });

  it('rejects a mismatched peer or transcript even when the identity matches', () => {
    expect(check({ peer: idB })).toBe(false);
    const other = transcriptOf({ binding: UNBOUND }).hash;
    expect(check({ transcript: other })).toBe(false);
  });
});

describe('F2: the binding-kind list is immutable', () => {
  const kinds = LINK_AUTH_BINDING_KINDS as unknown as string[];
  const hello = () => ({
    v: 1,
    stage: 'hello',
    credential: partyA.credential,
    nonce: NONCE_A,
    binding: { kind: 'evil-kind' },
  });

  afterEach(() => {
    // If a regression let the list be modified, put it back so later tests are not contaminated.
    if (!Object.isFrozen(kinds)) {
      kinds.length = 0;
      kinds.push('nearby-auth-token-v1', 'unavailable');
    }
  });

  it('is frozen, with exactly the supported kinds', () => {
    expect(Object.isFrozen(LINK_AUTH_BINDING_KINDS)).toBe(true);
    expect([...LINK_AUTH_BINDING_KINDS]).toEqual([
      'nearby-auth-token-v1',
      'unavailable',
    ]);
  });

  it('cannot be appended to, overwritten, truncated or reordered', () => {
    // Mutator methods throw on a frozen array in every mode.
    for (const mutate of [
      () => kinds.push('evil-kind'),
      () => kinds.pop(),
      () => kinds.shift(),
      () => kinds.unshift('evil-kind'),
      () => kinds.splice(0, 1),
      () => kinds.reverse(),
      () => kinds.sort(),
      () => kinds.fill('evil-kind'),
    ]) {
      expect(mutate).toThrow(TypeError);
    }
    // Plain assignments throw in strict mode and are silently ignored in sloppy mode. This
    // project's Babel preset compiles modules in sloppy mode (strictMode: false), so the contract
    // is "the array is unchanged", whichever way the engine reports the attempt.
    for (const assign of [
      () => {
        kinds[2] = 'evil-kind';
      },
      () => {
        kinds[0] = 'evil-kind';
      },
      () => {
        kinds.length = 0;
      },
    ]) {
      try {
        assign();
      } catch {
        // acceptable: strict-mode engines report the failed write
      }
    }
    expect([...kinds]).toEqual(['nearby-auth-token-v1', 'unavailable']);
    expect(kinds).toHaveLength(2);
  });

  it('an attempt to add a kind cannot widen what the parser or builder accepts', () => {
    expect(parseLinkAuthPayload(hello())).toBeNull();
    try {
      kinds.push('evil-kind');
    } catch {
      // expected: the list is frozen
    }
    expect(parseLinkAuthPayload(hello())).toBeNull();
    expect(() =>
      buildLinkAuthHello({
        credential: partyA.credential,
        nonce: NONCE_A,
        bindingKind: 'evil-kind' as never,
      }),
    ).toThrow(TypeError);
  });

  it('still accepts both supported kinds', () => {
    for (const kind of ['nearby-auth-token-v1', 'unavailable']) {
      expect(
        parseLinkAuthPayload({ ...hello(), binding: { kind } }),
      ).not.toBeNull();
    }
  });
});

describe('hash callbacks that return a Promise by mistake', () => {
  // The builders throw on an invalid hash (a programmer error), but the stray Promise must still
  // be neutralised so that it cannot surface later as an unhandled rejection.
  function rejectingPromise() {
    const pending = Promise.reject(new Error('async hash failed'));
    pending.catch(() => undefined); // keeps a regression from crashing the worker
    return { pending, thenSpy: jest.spyOn(pending, 'then') };
  }

  it('linkAuthCredentialHash', () => {
    const { pending, thenSpy } = rejectingPromise();
    expect(() =>
      linkAuthCredentialHash(partyA.credential, () => pending as never),
    ).toThrow(TypeError);
    expect(thenSpy).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  it('linkAuthBindingDigest', () => {
    const { pending, thenSpy } = rejectingPromise();
    expect(() =>
      linkAuthBindingDigest(MATERIAL, () => pending as never),
    ).toThrow(TypeError);
    expect(thenSpy).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  it('linkAuthTranscript', () => {
    const { pending, thenSpy } = rejectingPromise();
    expect(() => transcriptWith(() => pending as never)).toThrow(TypeError);
    expect(thenSpy).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  function transcriptWith(hasher: (data: Uint8Array) => Uint8Array) {
    return linkAuthTranscript(
      {
        rideId: RIDE,
        sessionId: SESSION,
        binding: BOUND,
        local: partyA,
        peer: partyB,
      },
      hasher,
    );
  }
});
