import * as fs from 'fs';
import * as path from 'path';
import { NativeModules, Platform } from 'react-native';
import {
  LinkSignerError,
  NATIVE_LINK_SIGNER_ERROR_CODES,
  createAndroidLinkSigner,
  createDefaultLinkSigner,
  type RideazeLinkSignerNative,
} from '../src/connectivity/linkSigner';
import {
  p256RuntimeCrypto,
  verifyP256Signature,
} from '../src/connectivity/p256Crypto';
import {
  decodeBase64Url,
  encodeBase64Url,
} from '../src/connectivity/protocol/base64url';
import { deriveRideNodeId } from '../src/connectivity/protocol/rideCredential';

// Fixed values from the Task 2.2 interoperability vector (real P-256 points and signatures).
const SESSION = 'AAECAwQFBgcICQoLDA0ODw';
const OTHER_SESSION = '__79_Pv6-fj39vX08_Lx8A';
const PUB_A =
  'BM5IkuRXOhzlhGSMAijSdE7v4whHMHXWQvDMAbBpi8rmnGK7yUqwEOWa60c7boAfRVqrteZmTH8afokYAbQ4MgI';
const NODE_A = 'zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0';
const PUB_B =
  'BFNLS4_rDi1sR6bJITh_y1UMLYnRFlIiU0Bsy3oqont75-8Xd24to54GJdZ-g5ovDuTnAQarqXriZYeYrg4UF4w';
const NODE_B = 'aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o';
const LOW_S_SIGNATURE =
  'XA9IGuPgBfkvc9BfcSPdpR--VG4dtn68QypLBuCAN8IVnFyeaLQb2mR45lrdCme5CTa_7jRznJfU9pTG5phShg'; // proof, node A
const HIGH_S_SIGNATURE =
  'hKj_EdJymE6mpF_5QEk2mOmnYSdpzKgIpQJjzDUdtYXPLbt8PdaNVnvQBKLR1jzNxERfCENUNKGfgCcOljbOeA'; // confirm, node B

const ORDER = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
const sBigInt = (signature: string): bigint =>
  BigInt(
    '0x' + Buffer.from(signature, 'base64url').subarray(32).toString('hex'),
  );

const STATEMENT = `{"domain":"rideaze.link-auth.v1.proof","v":1,"signer":"${NODE_A}","peer":"${NODE_B}","transcript":"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"}`;

type Mock = jest.Mock<Promise<unknown>, unknown[]>;
interface FakeNative extends RideazeLinkSignerNative {
  ensureIdentity: Mock;
  getIdentity: Mock;
  signLinkAuthStatement: Mock;
  listIdentities: Mock;
  releaseIdentity: Mock;
}

function fakeNative(): FakeNative {
  return {
    ensureIdentity: jest.fn(async () => identityResponse()),
    getIdentity: jest.fn(async () => identityResponse()),
    signLinkAuthStatement: jest.fn(async () => LOW_S_SIGNATURE),
    listIdentities: jest.fn(async () => []),
    releaseIdentity: jest.fn(async () => null),
  };
}

function identityResponse(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId: SESSION,
    nodeId: NODE_A,
    publicKey: PUB_A,
    createdAt: 1_700_000_000_000,
    securityLevel: 'tee',
    created: false,
    ...over,
  };
}

function listingRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId: SESSION,
    status: 'ok',
    nodeId: NODE_A,
    createdAt: 1_700_000_000_000,
    securityLevel: 'tee',
    ...over,
  };
}

const signerFor = (
  native: FakeNative | null | undefined,
  platform = 'android',
) => createAndroidLinkSigner(native, p256RuntimeCrypto, platform);

async function rejection(promise: Promise<unknown>): Promise<LinkSignerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LinkSignerError);
    return error as LinkSignerError;
  }
  throw new Error('expected a rejection');
}

const nativeError = (code: string, message = 'native detail with secrets') =>
  Object.assign(new Error(message), { code });

/** The real vector keys must satisfy the facts the adapter re-derives, or the tests prove nothing. */
describe('test fixtures', () => {
  it('are real points whose node ids derive from SHA-256 of the key', () => {
    for (const [pub, node] of [
      [PUB_A, NODE_A],
      [PUB_B, NODE_B],
    ]) {
      expect(
        deriveRideNodeId(
          decodeBase64Url(pub) as Uint8Array,
          p256RuntimeCrypto.sha256,
        ),
      ).toBe(node);
    }
    expect(sBigInt(LOW_S_SIGNATURE) > ORDER / 2n).toBe(false);
    expect(sBigInt(HIGH_S_SIGNATURE) > ORDER / 2n).toBe(true);
  });
});

describe('identities', () => {
  it('decodes a valid identity and checks the node id against the key', async () => {
    const native = fakeNative();
    const identity = await signerFor(native).ensureIdentity(SESSION);
    expect(identity.sessionId).toBe(SESSION);
    expect(identity.nodeId).toBe(NODE_A);
    expect(identity.createdAtMs).toBe(1_700_000_000_000);
    expect(identity.securityLevel).toBe('tee');
    expect(identity.created).toBe(false);
    expect(Buffer.from(identity.publicKey()).toString('base64url')).toBe(PUB_A);
    expect(identity.publicKey()).toHaveLength(65);
    expect(identity.publicKey()[0]).toBe(0x04);
    expect(native.ensureIdentity).toHaveBeenCalledTimes(1);
    expect(native.ensureIdentity).toHaveBeenCalledWith(SESSION);
  });

  it('accepts the second recorded key too (the control for the alphabet test below)', async () => {
    const native = fakeNative();
    native.ensureIdentity.mockResolvedValue(
      identityResponse({ publicKey: PUB_B, nodeId: NODE_B }),
    );
    expect((await signerFor(native).ensureIdentity(SESSION)).nodeId).toBe(
      NODE_B,
    );
  });

  it('returns a fresh copy of the public key every time', async () => {
    const identity = await signerFor(fakeNative()).ensureIdentity(SESSION);
    const first = identity.publicKey();
    first.fill(0);
    const second = identity.publicKey();
    expect(second).not.toBe(first);
    expect(Buffer.from(second).toString('base64url')).toBe(PUB_A);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('the public key does not alias the native response', async () => {
    const native = fakeNative();
    const response = identityResponse();
    native.ensureIdentity.mockResolvedValue(response);
    const identity = await signerFor(native).ensureIdentity(SESSION);
    response.publicKey = 'changed';
    expect(Buffer.from(identity.publicKey()).toString('base64url')).toBe(PUB_A);
  });

  it('getIdentity returns an identity or null and never generates', async () => {
    const native = fakeNative();
    expect((await signerFor(native).getIdentity(SESSION))?.nodeId).toBe(NODE_A);
    native.getIdentity.mockResolvedValue(null);
    expect(await signerFor(native).getIdentity(SESSION)).toBeNull();
    expect(native.ensureIdentity).not.toHaveBeenCalled();
  });

  it('reports created = true when the native call created the key', async () => {
    const native = fakeNative();
    native.ensureIdentity.mockResolvedValue(
      identityResponse({ created: true }),
    );
    expect((await signerFor(native).ensureIdentity(SESSION)).created).toBe(
      true,
    );
  });

  it('accepts every supported security level', async () => {
    for (const level of ['strongbox', 'tee', 'software', 'unknown']) {
      const native = fakeNative();
      native.getIdentity.mockResolvedValue(
        identityResponse({ securityLevel: level }),
      );
      expect(
        (await signerFor(native).getIdentity(SESSION))?.securityLevel,
      ).toBe(level);
    }
  });

  const badIdentities: [string, Record<string, unknown>][] = [
    ['a different session', identityResponse({ sessionId: OTHER_SESSION })],
    [
      'a non-canonical session',
      identityResponse({ sessionId: SESSION.slice(0, -1) + 'B' }),
    ],
    ['a node id of another key', identityResponse({ nodeId: NODE_B })],
    [
      'a non-canonical node id',
      identityResponse({ nodeId: NODE_A.slice(0, -1) + 'p' }),
    ],
    ['a short node id', identityResponse({ nodeId: NODE_A.slice(0, -1) })],
    ['no public key', identityResponse({ publicKey: undefined })],
    ['a numeric public key', identityResponse({ publicKey: 65 })],
    ['a padded public key', identityResponse({ publicKey: PUB_A + '=' })],
    [
      'a standard base64 public key',
      identityResponse({
        publicKey: PUB_B.replace('-', '+').replace('_', '/'),
        nodeId: NODE_B,
      }),
    ],
    [
      'a non-canonical (trailing bits) public key',
      identityResponse({ publicKey: PUB_A.slice(0, -1) + 'J' }),
    ],
    [
      'a 64-byte public key',
      identityResponse({
        publicKey: encodeBase64Url(decodeBase64Url(PUB_A)!.subarray(1)),
      }),
    ],
    [
      'a 33-byte compressed key',
      identityResponse({
        publicKey: encodeBase64Url(
          Uint8Array.from([2, ...decodeBase64Url(PUB_A)!.subarray(1, 33)]),
        ),
      }),
    ],
    [
      'a wrong prefix',
      identityResponse({
        publicKey: encodeBase64Url(
          Uint8Array.from([6, ...decodeBase64Url(PUB_A)!.subarray(1)]),
        ),
      }),
    ],
    [
      'a 66-byte public key',
      identityResponse({
        publicKey: encodeBase64Url(
          Uint8Array.from([...decodeBase64Url(PUB_A)!, 0]),
        ),
      }),
    ],
    ['a missing created time', identityResponse({ createdAt: undefined })],
    ['a fractional created time', identityResponse({ createdAt: 1.5 })],
    ['a negative created time', identityResponse({ createdAt: -1 })],
    ['a string created time', identityResponse({ createdAt: '1700000000000' })],
    ['an unsafe created time', identityResponse({ createdAt: 2 ** 53 })],
    ['a missing created flag', identityResponse({ created: undefined })],
    ['a non-boolean created flag', identityResponse({ created: 'yes' })],
    [
      'an unknown security level',
      identityResponse({ securityLevel: 'hardware' }),
    ],
    [
      'a missing security level',
      identityResponse({ securityLevel: undefined }),
    ],
    ['an unexpected extra field', identityResponse({ privateKey: 'AAAA' })],
    ['an array', [] as unknown as Record<string, unknown>],
    ['a string', 'identity' as unknown as Record<string, unknown>],
    ['undefined', undefined as unknown as Record<string, unknown>],
  ];

  it.each(badIdentities)(
    'rejects %s as invalid_native_response',
    async (_label, response) => {
      const native = fakeNative();
      native.ensureIdentity.mockResolvedValue(response);
      native.getIdentity.mockResolvedValue(
        response === undefined ? undefined : response,
      );
      expect(
        (await rejection(signerFor(native).ensureIdentity(SESSION))).code,
      ).toBe('invalid_native_response');
      expect(
        (await rejection(signerFor(native).getIdentity(SESSION))).code,
      ).toBe('invalid_native_response');
    },
  );

  it('rejects a public key that is not on the P-256 curve even when its node id is consistent', async () => {
    const point = Uint8Array.from(decodeBase64Url(PUB_A)!);
    point[40] = (point[40] + 1) % 256; // off the curve
    const nodeId = deriveRideNodeId(point, p256RuntimeCrypto.sha256);
    const native = fakeNative();
    native.ensureIdentity.mockResolvedValue(
      identityResponse({ publicKey: encodeBase64Url(point), nodeId }),
    );
    expect(
      (await rejection(signerFor(native).ensureIdentity(SESSION))).code,
    ).toBe('invalid_native_response');
  });

  it('rejects an all-zero point with a consistent node id', async () => {
    const point = Uint8Array.from([4, ...new Uint8Array(64)]);
    const native = fakeNative();
    native.ensureIdentity.mockResolvedValue(
      identityResponse({
        publicKey: encodeBase64Url(point),
        nodeId: deriveRideNodeId(point, p256RuntimeCrypto.sha256),
      }),
    );
    expect(
      (await rejection(signerFor(native).ensureIdentity(SESSION))).code,
    ).toBe('invalid_native_response');
  });

  it('rejects an invalid session id before calling native code', async () => {
    const native = fakeNative();
    const signer = signerFor(native);
    for (const bad of [
      '',
      'x',
      SESSION + 'A',
      SESSION.slice(0, -1) + 'B',
      '54321',
      'rideaze.linkauth.v1.' + SESSION,
      null,
      undefined,
      5,
    ]) {
      expect((await rejection(signer.ensureIdentity(bad as never))).code).toBe(
        'invalid_argument',
      );
      expect((await rejection(signer.getIdentity(bad as never))).code).toBe(
        'invalid_argument',
      );
      expect(
        (
          await rejection(
            signer.signLinkAuthStatement(bad as never, 'proof', STATEMENT),
          )
        ).code,
      ).toBe('invalid_argument');
      expect(
        (await rejection(signer.releaseIdentity(bad as never, NODE_A))).code,
      ).toBe('invalid_argument');
    }
    expect(native.ensureIdentity).not.toHaveBeenCalled();
    expect(native.getIdentity).not.toHaveBeenCalled();
    expect(native.signLinkAuthStatement).not.toHaveBeenCalled();
    expect(native.releaseIdentity).not.toHaveBeenCalled();
  });
});

describe('signatures', () => {
  it('returns the 64-byte P1363 signature unchanged', async () => {
    const native = fakeNative();
    const signature = await signerFor(native).signLinkAuthStatement(
      SESSION,
      'proof',
      STATEMENT,
    );
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature).toHaveLength(64);
    expect(Buffer.from(signature).toString('base64url')).toBe(LOW_S_SIGNATURE);
    expect(native.signLinkAuthStatement).toHaveBeenCalledTimes(1);
    expect(native.signLinkAuthStatement).toHaveBeenCalledWith(
      SESSION,
      'proof',
      STATEMENT,
    );
  });

  it('accepts low-S and high-S signatures and never normalises either', async () => {
    for (const sig of [LOW_S_SIGNATURE, HIGH_S_SIGNATURE]) {
      const native = fakeNative();
      native.signLinkAuthStatement.mockResolvedValue(sig);
      const out = await signerFor(native).signLinkAuthStatement(
        SESSION,
        'confirm',
        STATEMENT,
      );
      expect(Buffer.from(out).toString('base64url')).toBe(sig);
    }
  });

  it('the recorded signatures really verify under the real P-256 adapter (high-S included)', () => {
    const proof = `{"domain":"rideaze.link-auth.v1.proof","v":1,"signer":"${NODE_A}","peer":"${NODE_B}","transcript":"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"}`;
    const confirm = `{"domain":"rideaze.link-auth.v1.confirm","v":1,"signer":"${NODE_B}","peer":"${NODE_A}","transcript":"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"}`;
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(
      verifyP256Signature(
        decodeBase64Url(PUB_A)!,
        enc(proof),
        decodeBase64Url(LOW_S_SIGNATURE)!,
      ),
    ).toBe(true);
    expect(
      verifyP256Signature(
        decodeBase64Url(PUB_B)!,
        enc(confirm),
        decodeBase64Url(HIGH_S_SIGNATURE)!,
      ),
    ).toBe(true);
  });

  it('returns a fresh byte array on every call', async () => {
    const signer = signerFor(fakeNative());
    const a = await signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT);
    a.fill(0);
    const b = await signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT);
    expect(Buffer.from(b).toString('base64url')).toBe(LOW_S_SIGNATURE);
    expect(b).not.toBe(a);
  });

  const derVectors: { label: string; der: string }[] = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        '../android/app/src/test/resources/linkauth/ecdsa-der-p1363-vectors.json',
      ),
      'utf8',
    ),
  ).valid;

  it('rejects every recorded DER signature (the Kotlin DER vectors) as invalid_native_response', async () => {
    expect(derVectors.length).toBeGreaterThanOrEqual(20);
    for (const { der } of derVectors) {
      const native = fakeNative();
      native.signLinkAuthStatement.mockResolvedValue(
        Buffer.from(der, 'hex').toString('base64url'),
      );
      expect(
        (
          await rejection(
            signerFor(native).signLinkAuthStatement(
              SESSION,
              'proof',
              STATEMENT,
            ),
          )
        ).code,
      ).toBe('invalid_native_response');
    }
  });

  it('accepts the P1363 form of those same vectors', async () => {
    const vectors: { p1363: string }[] = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          '../android/app/src/test/resources/linkauth/ecdsa-der-p1363-vectors.json',
        ),
        'utf8',
      ),
    ).valid;
    for (const { p1363 } of vectors) {
      const native = fakeNative();
      native.signLinkAuthStatement.mockResolvedValue(
        Buffer.from(p1363, 'hex').toString('base64url'),
      );
      const out = await signerFor(native).signLinkAuthStatement(
        SESSION,
        'proof',
        STATEMENT,
      );
      expect(Buffer.from(out).toString('hex')).toBe(p1363);
    }
  });

  const raw = Buffer.from(LOW_S_SIGNATURE, 'base64url');
  const badSignatures: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 64],
    ['an object', { sig: LOW_S_SIGNATURE }],
    ['a byte array', Array.from(raw)],
    ['an empty string', ''],
    ['63 bytes', raw.subarray(0, 63).toString('base64url')],
    ['65 bytes', Buffer.concat([raw, Buffer.from([0])]).toString('base64url')],
    ['128 bytes', Buffer.concat([raw, raw]).toString('base64url')],
    ['a padded signature', LOW_S_SIGNATURE + '=='],
    ['standard base64', raw.toString('base64')],
    ['a non-canonical last character', LOW_S_SIGNATURE.slice(0, -1) + 'h'],
    ['whitespace', ` ${LOW_S_SIGNATURE}`],
    ['a trailing newline', `${LOW_S_SIGNATURE}\n`],
    ['hex', raw.toString('hex')],
  ];

  it.each(badSignatures)(
    'rejects %s as invalid_native_response',
    async (_label, response) => {
      const native = fakeNative();
      native.signLinkAuthStatement.mockResolvedValue(response);
      expect(
        (
          await rejection(
            signerFor(native).signLinkAuthStatement(
              SESSION,
              'proof',
              STATEMENT,
            ),
          )
        ).code,
      ).toBe('invalid_native_response');
    },
  );

  it('only accepts proof and confirm and sensible statements, before calling native code', async () => {
    const native = fakeNative();
    const signer = signerFor(native);
    for (const stage of [
      '',
      'hello',
      'PROOF',
      'sign',
      'proof ',
      null,
      undefined,
      1,
    ]) {
      expect(
        (
          await rejection(
            signer.signLinkAuthStatement(SESSION, stage as never, STATEMENT),
          )
        ).code,
      ).toBe('invalid_argument');
    }
    for (const statement of ['', 'x'.repeat(513), null, undefined, 5, {}]) {
      expect(
        (
          await rejection(
            signer.signLinkAuthStatement(SESSION, 'proof', statement as never),
          )
        ).code,
      ).toBe('invalid_argument');
    }
    expect(native.signLinkAuthStatement).not.toHaveBeenCalled();
    await signer.signLinkAuthStatement(SESSION, 'confirm', STATEMENT); // the native side validates the content
    expect(native.signLinkAuthStatement).toHaveBeenCalledTimes(1);
  });
});

describe('inventory and release', () => {
  it('validates and returns the listing', async () => {
    const native = fakeNative();
    native.listIdentities.mockResolvedValue([
      listingRow(),
      listingRow({
        sessionId: OTHER_SESSION,
        status: 'identity_lost',
        nodeId: NODE_B,
        createdAt: null,
        securityLevel: null,
      }),
      listingRow({
        sessionId: 'A'.repeat(21) + 'g',
        status: 'key_without_metadata',
        nodeId: null,
        createdAt: null,
      }),
    ]);
    const list = await signerFor(native).listIdentities();
    expect(list.map(row => row.status)).toEqual([
      'ok',
      'identity_lost',
      'key_without_metadata',
    ]);
    expect(list[1].nodeId).toBe(NODE_B);
    expect(list[1].createdAtMs).toBeNull();
    expect(list[2].nodeId).toBeNull();
    expect(Object.isFrozen(list)).toBe(true);
  });

  const badListings: [string, unknown][] = [
    ['not an array', {}],
    ['null', null],
    ['an unknown status', [listingRow({ status: 'fine' })]],
    ['a bad session', [listingRow({ sessionId: 'nope' })]],
    ['a duplicate session', [listingRow(), listingRow()]],
    ['a bad node id', [listingRow({ nodeId: 'x' })]],
    ['a bad time', [listingRow({ createdAt: 'now' })]],
    ['a bad level', [listingRow({ securityLevel: 'vault' })]],
    ['an extra field', [{ ...listingRow(), alias: 'rideaze.linkauth.v1.x' }]],
    ['a missing field', [{ sessionId: SESSION, status: 'ok' }]],
    ['too many rows', Array.from({ length: 1001 }, () => listingRow())],
  ];

  it.each(badListings)(
    'rejects a listing with %s',
    async (_label, response) => {
      const native = fakeNative();
      native.listIdentities.mockResolvedValue(response);
      expect((await rejection(signerFor(native).listIdentities())).code).toBe(
        'invalid_native_response',
      );
    },
  );

  it('releases only on an explicit call with a canonical node id', async () => {
    const native = fakeNative();
    const signer = signerFor(native);
    await signer.ensureIdentity(SESSION);
    await signer.listIdentities();
    await signer.getIdentity(SESSION);
    expect(native.releaseIdentity).not.toHaveBeenCalled(); // nothing releases automatically
    await signer.releaseIdentity(SESSION, NODE_A);
    expect(native.releaseIdentity).toHaveBeenCalledTimes(1);
    expect(native.releaseIdentity).toHaveBeenCalledWith(SESSION, NODE_A);
    for (const bad of [
      '',
      NODE_A.slice(0, -1),
      NODE_A + 'A',
      NODE_A.slice(0, -1) + 'p',
      null,
      undefined,
    ]) {
      expect(
        (await rejection(signer.releaseIdentity(SESSION, bad as never))).code,
      ).toBe('invalid_argument');
    }
    expect(native.releaseIdentity).toHaveBeenCalledTimes(1);
  });

  it('treats an unexpected release result as invalid', async () => {
    const native = fakeNative();
    native.releaseIdentity.mockResolvedValue({ released: true });
    expect(
      (await rejection(signerFor(native).releaseIdentity(SESSION, NODE_A)))
        .code,
    ).toBe('invalid_native_response');
  });
});

describe('platform and native module', () => {
  it('rejects every operation when the module is missing', async () => {
    for (const missing of [null, undefined, {}]) {
      const signer = createAndroidLinkSigner(
        missing as never,
        p256RuntimeCrypto,
        'android',
      );
      for (const run of [
        () => signer.ensureIdentity(SESSION),
        () => signer.getIdentity(SESSION),
        () => signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT),
        () => signer.listIdentities(),
        () => signer.releaseIdentity(SESSION, NODE_A),
      ]) {
        expect((await rejection(run())).code).toBe('native_unavailable');
      }
    }
  });

  it('rejects a module with a missing method', async () => {
    const native = fakeNative();
    delete (native as Partial<FakeNative>).releaseIdentity;
    expect(
      (await rejection(signerFor(native as never).ensureIdentity(SESSION)))
        .code,
    ).toBe('native_unavailable');
  });

  it('rejects every operation on unsupported platforms without touching the module', async () => {
    for (const platform of ['ios', 'web', 'windows', 'macos', '']) {
      const native = fakeNative();
      const signer = signerFor(native, platform);
      expect((await rejection(signer.ensureIdentity(SESSION))).code).toBe(
        'native_unavailable',
      );
      expect(
        (
          await rejection(
            signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT),
          )
        ).code,
      ).toBe('native_unavailable');
      expect(native.ensureIdentity).not.toHaveBeenCalled();
      expect(native.signLinkAuthStatement).not.toHaveBeenCalled();
    }
  });

  it('creating a signer never touches the native module', () => {
    const native = fakeNative();
    signerFor(native);
    createAndroidLinkSigner(null, p256RuntimeCrypto, 'ios');
    for (const fn of Object.values(native)) expect(fn).not.toHaveBeenCalled();
  });

  it('the default signer is unavailable off Android, and works through NativeModules on Android', async () => {
    expect(Platform.OS).not.toBe('android');
    expect(
      (await rejection(createDefaultLinkSigner().ensureIdentity(SESSION))).code,
    ).toBe('native_unavailable');

    const native = fakeNative();
    (NativeModules as Record<string, unknown>).RideazeLinkSigner = native;
    const restore = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      const identity = await createDefaultLinkSigner().ensureIdentity(SESSION);
      expect(identity.nodeId).toBe(NODE_A);
      expect(native.ensureIdentity).toHaveBeenCalledTimes(1);
      delete (NativeModules as Record<string, unknown>).RideazeLinkSigner;
      expect(
        (await rejection(createDefaultLinkSigner().getIdentity(SESSION))).code,
      ).toBe('native_unavailable');
    } finally {
      restore.restore();
      delete (NativeModules as Record<string, unknown>).RideazeLinkSigner;
    }
  });

  it('exposes only the five operations: no raw signing, no key access, no replacement', () => {
    const signer = signerFor(fakeNative());
    expect(Object.keys(signer).sort()).toEqual([
      'ensureIdentity',
      'getIdentity',
      'listIdentities',
      'releaseIdentity',
      'signLinkAuthStatement',
    ]);
    expect(Object.isFrozen(signer)).toBe(true);
  });
});

describe('native errors', () => {
  it.each(NATIVE_LINK_SIGNER_ERROR_CODES)(
    'keeps the native code %s',
    async code => {
      const native = fakeNative();
      for (const fn of [
        native.ensureIdentity,
        native.getIdentity,
        native.signLinkAuthStatement,
        native.listIdentities,
        native.releaseIdentity,
      ]) {
        fn.mockRejectedValue(nativeError(code));
      }
      const signer = signerFor(native);
      const errors = await Promise.all([
        rejection(signer.ensureIdentity(SESSION)),
        rejection(signer.getIdentity(SESSION)),
        rejection(signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT)),
        rejection(signer.listIdentities()),
        rejection(signer.releaseIdentity(SESSION, NODE_A)),
      ]);
      for (const error of errors) {
        expect(error.code).toBe(code);
        expect(error.message).toBe(code); // never the native message
        expect(JSON.stringify(error)).not.toContain('secrets');
      }
    },
  );

  it('distinguishes permanent identity loss and queue pressure from other failures', async () => {
    const native = fakeNative();
    native.signLinkAuthStatement.mockRejectedValueOnce(
      nativeError('identity_lost'),
    );
    native.signLinkAuthStatement.mockRejectedValueOnce(nativeError('busy'));
    native.signLinkAuthStatement.mockRejectedValueOnce(
      nativeError('signing_failed'),
    );
    const signer = signerFor(native);
    expect(
      (
        await rejection(
          signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT),
        )
      ).code,
    ).toBe('identity_lost');
    expect(
      (
        await rejection(
          signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT),
        )
      ).code,
    ).toBe('busy');
    expect(
      (
        await rejection(
          signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT),
        )
      ).code,
    ).toBe('signing_failed');
  });

  it('maps unknown failures to native_error without leaking details', async () => {
    const failures: unknown[] = [
      new Error(`boom for session ${SESSION} node ${NODE_A}`),
      nativeError('some_new_code', `alias rideaze.linkauth.v1.${SESSION}`),
      'a string',
      null,
      undefined,
      42,
      { code: 5 },
      Object.defineProperty({}, 'code', {
        get() {
          throw new Error('hostile getter');
        },
      }),
    ];
    for (const failure of failures) {
      const native = fakeNative();
      native.ensureIdentity.mockRejectedValue(failure);
      const error = await rejection(signerFor(native).ensureIdentity(SESSION));
      expect(error.code).toBe('native_error');
      expect(error.message).toBe('native_error');
      expect(error.message).not.toContain(SESSION);
      expect(error.message).not.toContain(NODE_A);
    }
  });

  it('maps a synchronous throw from the native method the same way', async () => {
    const native = fakeNative();
    native.listIdentities.mockImplementation(() => {
      throw nativeError('keystore_unavailable');
    });
    expect((await rejection(signerFor(native).listIdentities())).code).toBe(
      'keystore_unavailable',
    );
  });

  it('never retries, generates or releases after a failure', async () => {
    const native = fakeNative();
    native.signLinkAuthStatement.mockRejectedValue(
      nativeError('identity_lost'),
    );
    native.getIdentity.mockRejectedValue(nativeError('identity_lost'));
    const signer = signerFor(native);
    await rejection(signer.signLinkAuthStatement(SESSION, 'proof', STATEMENT));
    await rejection(signer.getIdentity(SESSION));
    expect(native.signLinkAuthStatement).toHaveBeenCalledTimes(1);
    expect(native.getIdentity).toHaveBeenCalledTimes(1);
    expect(native.ensureIdentity).not.toHaveBeenCalled();
    expect(native.releaseIdentity).not.toHaveBeenCalled();
  });

  it('a hanging native call is passed through unchanged (no adapter-level timeout or retry)', async () => {
    const native = fakeNative();
    native.signLinkAuthStatement.mockReturnValue(new Promise(() => undefined));
    const pending = signerFor(native).signLinkAuthStatement(
      SESSION,
      'proof',
      STATEMENT,
    );
    const winner = await Promise.race([
      pending.then(() => 'settled'),
      Promise.resolve('pending'),
    ]);
    expect(winner).toBe('pending');
    expect(native.signLinkAuthStatement).toHaveBeenCalledTimes(1);
  });
});
