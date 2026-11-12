/// <reference types="node" />
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'crypto';
import {
  P256_PUBLIC_KEY_BYTES,
  P256_SIGNATURE_BYTES,
  SHA256_DIGEST_BYTES,
  p256RuntimeCrypto,
  sha256,
  verifyP256Signature,
} from '../src/connectivity/p256Crypto';
import { createLinkAuthenticator } from '../src/connectivity/linkAuthenticator';
import type { LinkAuthEffect } from '../src/connectivity/linkAuthenticator';
import {
  decodeBase64Url,
  encodeBase64Url,
} from '../src/connectivity/protocol/base64url';
import {
  buildLinkAuthHello,
  linkAuthBindingDigest,
  linkAuthCredentialHash,
  linkAuthTranscript,
  verifyLinkAuthSignature,
  type LinkAuthParty,
  type LocalChannelBinding,
} from '../src/connectivity/protocol/linkAuth';
import {
  createRideCredentialVerifier,
  deriveRideNodeId,
  rideCredentialSigningInput,
} from '../src/connectivity/protocol/rideCredential';

// ---- Node reference helpers (tests only; the adapter never uses Node APIs) --------------------

interface NodeKey {
  readonly privateKey: KeyObject;
  readonly publicKey: Uint8Array;
}

function newKey(): NodeKey {
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

const nodeSha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

/** P1363 signature over the SHA-256 of `message` (Node hashes once). */
const nodeSignRaw = (message: Uint8Array, key: NodeKey): Uint8Array =>
  new Uint8Array(
    nodeSign('sha256', message, {
      key: key.privateKey,
      dsaEncoding: 'ieee-p1363',
    }),
  );

const nodeSignDer = (message: Uint8Array, key: NodeKey): Uint8Array =>
  new Uint8Array(nodeSign('sha256', message, { key: key.privateKey }));

const ORDER = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
const toBig = (bytes: Uint8Array): bigint =>
  BigInt('0x' + Buffer.from(bytes).toString('hex'));
const toBytes32 = (value: bigint): Uint8Array =>
  new Uint8Array(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'));

/** The same signature with S replaced by n - S (the other, equally valid, S). */
function flipS(signature: Uint8Array): Uint8Array {
  const out = Uint8Array.from(signature);
  out.set(toBytes32(ORDER - toBig(signature.subarray(32))), 32);
  return out;
}
const isHighS = (signature: Uint8Array): boolean =>
  toBig(signature.subarray(32)) > ORDER / 2n;

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

// ---- the fixed Task 2.2 interoperability vector (recorded by Node, checked by Python) ---------

const VECTOR_RIDE_ID = '54321';
const VECTOR_SESSION_ID = 'AAECAwQFBgcICQoLDA0ODw';
const VECTOR_SERVER_PUB =
  'BHdiItO9F5hbug50rszLNJ9C6z44VnJNPONnhPXHYXzxzTYunMAmd-mOfrmVX0CXuz5o9ywOQd9WaGyHn6YErVY';
const VECTOR_BINDING_MATERIAL_HEX =
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const VECTOR_BINDING_DIGEST = '69QyRZa15DqWr3JZCtMFyR2dm_IcoNR5H4MtHZrfd1U';
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

const serverPublicKey = decodeBase64Url(VECTOR_SERVER_PUB) as Uint8Array;
const keyOf = (party: LinkAuthParty): Uint8Array =>
  decodeBase64Url(party.credential.pub) as Uint8Array;
const VECTOR_BINDING: LocalChannelBinding = {
  kind: 'nearby-auth-token-v1',
  digest: VECTOR_BINDING_DIGEST,
};

const verifyAll = verifyP256Signature;

// =================================================================================================
// SHA-256
// =================================================================================================

describe('sha256', () => {
  it('matches the FIPS 180-4 known answers', () => {
    expect(Buffer.from(sha256(text(''))).toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(Buffer.from(sha256(text('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      Buffer.from(
        sha256(
          text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        ),
      ).toString('hex'),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with Node for every length from 0 to 300 (padding boundaries included)', () => {
    for (let length = 0; length <= 300; length++) {
      const data = Uint8Array.from(
        { length },
        (_, i) => (i * 31 + length) % 256,
      );
      expect(
        Buffer.from(sha256(data)).equals(Buffer.from(nodeSha256(data))),
      ).toBe(true);
    }
  });

  it('returns a fresh plain 32-byte Uint8Array, deterministically', () => {
    const data = text('rideaze');
    const a = sha256(data);
    const b = sha256(data);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(Object.getPrototypeOf(a)).toBe(Uint8Array.prototype);
    expect(a).toHaveLength(SHA256_DIGEST_BYTES);
    expect(a).not.toBe(b);
    expect(Array.from(a)).toEqual(Array.from(b));
    a[0] = (a[0] + 1) % 256;
    expect(Array.from(sha256(data))).toEqual(Array.from(b)); // mutating a result changes nothing
  });

  it('does not modify its input and accepts Buffers and views', () => {
    const backing = Uint8Array.from({ length: 64 }, (_, i) => i);
    const before = Array.from(backing);
    const view = backing.subarray(8, 40);
    expect(
      Buffer.from(sha256(view)).equals(
        Buffer.from(nodeSha256(Uint8Array.from(view))),
      ),
    ).toBe(true);
    expect(Array.from(backing)).toEqual(before);
    expect(Buffer.from(sha256(Buffer.from('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it.each([
    ['a string', 'abc'],
    ['an array', [1, 2, 3]],
    ['null', null],
    ['undefined', undefined],
    ['an ArrayBuffer', new ArrayBuffer(4)],
    ['a number', 5],
    ['a Uint16Array', new Uint16Array(2)],
  ])('throws a TypeError for %s', (_label, value) => {
    expect(() => sha256(value as never)).toThrow(TypeError);
  });

  it('is synchronous', () => {
    const result: unknown = sha256(text('x'));
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).toBe('undefined');
  });
});

// =================================================================================================
// The Task 2.2 interoperability vector, through the real adapter
// =================================================================================================

describe('interoperability vector (Node + Python, Task 2.2)', () => {
  it('reproduces the binding digest, credential hashes and transcript with the adapter hash', () => {
    const material = Uint8Array.from(
      Buffer.from(VECTOR_BINDING_MATERIAL_HEX, 'hex'),
    );
    expect(linkAuthBindingDigest(material, sha256)).toBe(VECTOR_BINDING_DIGEST);
    expect(
      VECTOR_PARTIES.map(p => linkAuthCredentialHash(p.credential, sha256)),
    ).toEqual(VECTOR_CREDENTIAL_HASHES);
    const { text: transcriptText, hash } = linkAuthTranscript(
      {
        rideId: VECTOR_RIDE_ID,
        sessionId: VECTOR_SESSION_ID,
        binding: VECTOR_BINDING,
        local: VECTOR_PARTIES[0],
        peer: VECTOR_PARTIES[1],
      },
      sha256,
    );
    expect(transcriptText).toBe(VECTOR_TRANSCRIPT_TEXT);
    expect(hash).toBe(VECTOR_TRANSCRIPT_HASH);
  });

  it('derives the recorded node ids from the recorded keys', () => {
    for (const party of VECTOR_PARTIES) {
      expect(deriveRideNodeId(keyOf(party), sha256)).toBe(party.nodeId);
    }
  });

  it('verifies both server-signed credentials', () => {
    for (const party of VECTOR_PARTIES) {
      const { sig, ...body } = party.credential;
      const signature = decodeBase64Url(sig) as Uint8Array;
      expect(signature).toHaveLength(P256_SIGNATURE_BYTES);
      expect(
        verifyAll(
          serverPublicKey,
          text(rideCredentialSigningInput(body)),
          signature,
        ),
      ).toBe(true);
    }
  });

  it('verifies all four recorded PROOF and CONFIRM signatures', () => {
    VECTOR_SIGNATURES.forEach((entry, index) => {
      const key = keyOf(VECTOR_PARTIES[index]);
      expect(
        verifyAll(
          key,
          text(entry.proofInput),
          decodeBase64Url(entry.proofSig) as Uint8Array,
        ),
      ).toBe(true);
      expect(
        verifyAll(
          key,
          text(entry.confirmInput),
          decodeBase64Url(entry.confirmSig) as Uint8Array,
        ),
      ).toBe(true);
    });
  });

  it('rejects them across stages, under the other key and for the other direction', () => {
    const [first, second] = VECTOR_SIGNATURES;
    const proofSig = decodeBase64Url(first.proofSig) as Uint8Array;
    const key0 = keyOf(VECTOR_PARTIES[0]);
    const key1 = keyOf(VECTOR_PARTIES[1]);
    expect(verifyAll(key0, text(first.confirmInput), proofSig)).toBe(false); // wrong stage
    expect(verifyAll(key1, text(first.proofInput), proofSig)).toBe(false); // wrong key
    expect(verifyAll(key0, text(second.proofInput), proofSig)).toBe(false); // other direction
  });

  it('works through verifyLinkAuthSignature with the injected adapter pair', () => {
    VECTOR_SIGNATURES.forEach((entry, index) => {
      const input = {
        signer: entry.signer,
        peer: entry.peer,
        transcript: VECTOR_TRANSCRIPT_HASH,
        signerPublicKey: keyOf(VECTOR_PARTIES[index]),
      };
      expect(
        verifyLinkAuthSignature(
          {
            stage: 'proof',
            ...input,
            signature: decodeBase64Url(entry.proofSig) as Uint8Array,
          },
          p256RuntimeCrypto.verifySignature,
          p256RuntimeCrypto.sha256,
        ),
      ).toBe(true);
      expect(
        verifyLinkAuthSignature(
          {
            stage: 'confirm',
            ...input,
            signature: decodeBase64Url(entry.proofSig) as Uint8Array,
          },
          p256RuntimeCrypto.verifySignature,
          p256RuntimeCrypto.sha256,
        ),
      ).toBe(false);
    });
  });

  it('lets the credential verifier accept the recorded credentials and reject a tampered one', () => {
    const verifier = createRideCredentialVerifier({
      rideId: VECTOR_RIDE_ID,
      sessionId: VECTOR_SESSION_ID,
      keys: new Map([
        [
          'srv-vector-1',
          {
            publicKey: serverPublicKey,
            notBefore: 1_600_000_000_000,
            notAfter: 1_800_000_000_000,
          },
        ],
      ]),
      verifySignature: p256RuntimeCrypto.verifySignature,
      sha256: p256RuntimeCrypto.sha256,
    });
    for (const party of VECTOR_PARTIES) {
      expect(verifier.verify(party.credential, 1_700_000_100_000).ok).toBe(
        true,
      );
      expect(
        verifier.verify(
          { ...party.credential, expiresAt: party.credential.expiresAt + 1 },
          1_700_000_100_000,
        ).ok,
      ).toBe(false);
    }
  });
});

// =================================================================================================
// ECDSA P-256 verification
// =================================================================================================

describe('verifyP256Signature', () => {
  const key = newKey();
  const other = newKey();
  const message = text('{"domain":"rideaze.link-auth.v1.proof","v":1}');
  const signature = nodeSignRaw(message, key);

  it('accepts a Node-produced P1363 signature', () => {
    expect(verifyAll(key.publicKey, message, signature)).toBe(true);
  });

  it('accepts valid low-S and high-S forms of the same signature (Keystore does not normalise)', () => {
    let low: Uint8Array | null = null;
    let high: Uint8Array | null = null;
    for (let i = 0; i < 20 && (low === null || high === null); i++) {
      const msg = text(`message ${i}`);
      const sig = nodeSignRaw(msg, key);
      const flipped = flipS(sig);
      const [lo, hi] = isHighS(sig) ? [flipped, sig] : [sig, flipped];
      expect(isHighS(lo)).toBe(false);
      expect(isHighS(hi)).toBe(true);
      expect(verifyAll(key.publicKey, msg, lo)).toBe(true);
      expect(verifyAll(key.publicKey, msg, hi)).toBe(true);
      // Node, the reference, agrees about both forms
      for (const s of [lo, hi]) {
        expect(
          nodeVerify(
            'sha256',
            msg,
            {
              key: createPublicKey({
                key: {
                  kty: 'EC',
                  crv: 'P-256',
                  x: Buffer.from(key.publicKey.subarray(1, 33)).toString(
                    'base64url',
                  ),
                  y: Buffer.from(key.publicKey.subarray(33)).toString(
                    'base64url',
                  ),
                },
                format: 'jwk',
              }),
              dsaEncoding: 'ieee-p1363',
            },
            s,
          ),
        ).toBe(true);
      }
      low = lo;
      high = hi;
    }
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
  });

  it('rejects the wrong public key', () => {
    expect(verifyAll(other.publicKey, message, signature)).toBe(false);
  });

  it('rejects a tampered message, and a message with a byte added or removed', () => {
    const tampered = Uint8Array.from(message);
    tampered[3] = (tampered[3] + 1) % 256;
    expect(verifyAll(key.publicKey, tampered, signature)).toBe(false);
    expect(
      verifyAll(
        key.publicKey,
        message.subarray(0, message.length - 1),
        signature,
      ),
    ).toBe(false);
    expect(
      verifyAll(key.publicKey, Uint8Array.from([...message, 0]), signature),
    ).toBe(false);
    expect(verifyAll(key.publicKey, new Uint8Array(0), signature)).toBe(false);
  });

  it('rejects a signature with any single flipped bit (checked on every byte)', () => {
    for (let i = 0; i < signature.length; i++) {
      const bad = Uint8Array.from(signature);
      bad[i] = (bad[i] + 1) % 256;
      expect(verifyAll(key.publicKey, message, bad)).toBe(false);
    }
  });

  describe('invalid public keys', () => {
    const offCurve = new Uint8Array(65).fill(7);
    offCurve[0] = 0x04;
    const cases: [string, Uint8Array][] = [
      ['an off-curve point', offCurve],
      [
        'the all-zero point with the prefix',
        Uint8Array.from([0x04, ...new Uint8Array(64)]),
      ],
      [
        'the all-zero 65 bytes (point at infinity encoding)',
        new Uint8Array(65),
      ],
      [
        'coordinates beyond the field prime',
        Uint8Array.from([0x04, ...new Uint8Array(64).fill(0xff)]),
      ],
      [
        'a compressed point (33 bytes)',
        Uint8Array.from([0x02, ...key.publicKey.subarray(1, 33)]),
      ],
      ['a 64-byte key without the prefix', key.publicKey.subarray(1)],
      [
        'a hybrid prefix 0x06',
        Uint8Array.from([0x06, ...key.publicKey.subarray(1)]),
      ],
      [
        'prefix 0x02 on 65 bytes',
        Uint8Array.from([0x02, ...key.publicKey.subarray(1)]),
      ],
      ['a 66-byte key', Uint8Array.from([...key.publicKey, 0])],
      ['an empty key', new Uint8Array(0)],
      [
        'the real key with one flipped coordinate bit',
        Uint8Array.from(key.publicKey, (b, i) =>
          i === 40 ? (b + 1) % 256 : b,
        ),
      ],
    ];
    it.each(cases)('rejects %s', (_label, bad) => {
      expect(verifyAll(bad, message, signature)).toBe(false);
    });
  });

  describe('invalid signatures', () => {
    const r = signature.subarray(0, 32);
    const s = signature.subarray(32);
    const n = toBytes32(ORDER);
    const join = (a: Uint8Array, b: Uint8Array) =>
      Uint8Array.from([...a, ...b]);
    const cases: [string, Uint8Array][] = [
      ['an empty signature', new Uint8Array(0)],
      ['63 bytes', signature.subarray(0, 63)],
      ['65 bytes', Uint8Array.from([...signature, 0])],
      ['32 bytes (r only)', Uint8Array.from(r)],
      ['128 bytes', Uint8Array.from([...signature, ...signature])],
      ['64 zero bytes', new Uint8Array(64)],
      ['r = 0', join(new Uint8Array(32), s)],
      ['s = 0', join(r, new Uint8Array(32))],
      ['r = n', join(n, s)],
      ['s = n', join(r, n)],
      ['r and s all 0xff', new Uint8Array(64).fill(0xff)],
      ['a DER signature', nodeSignDer(message, key)],
      [
        'a DER signature zero-padded to 64 bytes',
        (() => {
          const der = nodeSignDer(message, key);
          const out = new Uint8Array(64);
          out.set(der.subarray(0, 64));
          return out;
        })(),
      ],
      ['r and s swapped', join(s, r)],
    ];
    it.each(cases)('rejects %s', (_label, bad) => {
      expect(verifyAll(key.publicKey, message, bad)).toBe(false);
    });

    it('never accepts DER while compact is required, even for a valid DER signature', () => {
      for (let i = 0; i < 10; i++) {
        const msg = text(`der ${i}`);
        expect(verifyAll(key.publicKey, msg, nodeSignDer(msg, key))).toBe(
          false,
        );
      }
    });
  });

  describe('no accidental double hashing', () => {
    it('hashes the raw message exactly once', () => {
      // Node signs sha256(message): verifying the raw message passes, the digest as the message fails
      expect(verifyAll(key.publicKey, message, signature)).toBe(true);
      expect(verifyAll(key.publicKey, sha256(message), signature)).toBe(false);
    });

    it('a signature over the digest bytes is a signature over different data', () => {
      const digest = sha256(message);
      const overDigest = nodeSignRaw(digest, key); // = ECDSA over sha256(digest)
      expect(verifyAll(key.publicKey, digest, overDigest)).toBe(true);
      expect(verifyAll(key.publicKey, message, overDigest)).toBe(false);
    });
  });

  describe('input handling', () => {
    it.each([
      ['strings', 'a', 'b', 'c'],
      ['arrays', [4], [1], [2]],
      ['nulls', null, null, null],
      ['undefined', undefined, undefined, undefined],
      [
        'ArrayBuffers',
        new ArrayBuffer(65),
        new ArrayBuffer(3),
        new ArrayBuffer(64),
      ],
    ])('returns false for %s', (_label, k, m, s) => {
      expect(verifyAll(k as never, m as never, s as never)).toBe(false);
    });

    it('returns false (not an exception) for each non-bytes argument position', () => {
      expect(verifyAll('x' as never, message, signature)).toBe(false);
      expect(verifyAll(key.publicKey, 'x' as never, signature)).toBe(false);
      expect(verifyAll(key.publicKey, message, 'x' as never)).toBe(false);
      expect(
        verifyAll(key.publicKey, message, Array.from(signature) as never),
      ).toBe(false);
    });

    it('accepts Buffers and views into larger buffers, and does not modify any input', () => {
      const backing = new Uint8Array(400);
      backing.set(key.publicKey, 3);
      backing.set(signature, 100);
      backing.set(message, 200);
      const before = Uint8Array.from(backing);
      expect(
        verifyAll(
          backing.subarray(3, 68),
          backing.subarray(200, 200 + message.length),
          backing.subarray(100, 164),
        ),
      ).toBe(true);
      expect(Array.from(backing)).toEqual(Array.from(before));
      expect(
        verifyAll(
          Buffer.from(key.publicKey),
          Buffer.from(message),
          Buffer.from(signature),
        ),
      ).toBe(true);
    });

    it('is a plain synchronous boolean, never a Promise', () => {
      for (const sig of [signature, new Uint8Array(64), new Uint8Array(0)]) {
        const result: unknown = verifyAll(key.publicKey, message, sig);
        expect(typeof result).toBe('boolean');
        expect(result).not.toBeInstanceOf(Promise);
      }
    });

    it('never throws, whatever it is given', () => {
      const hostile = [
        undefined,
        null,
        NaN,
        {},
        [],
        'x',
        () => 1,
        Symbol('s'),
        new Proxy(
          {},
          {
            get: () => {
              throw new Error('hostile');
            },
          },
        ),
        Object.create(null),
      ];
      for (const a of hostile) {
        for (const b of hostile) {
          expect(() =>
            verifyAll(a as never, b as never, a as never),
          ).not.toThrow();
          expect(verifyAll(a as never, b as never, a as never)).toBe(false);
        }
      }
    });

    it('is deterministic and stateless across many calls', () => {
      const results = new Set<boolean>();
      for (let i = 0; i < 20; i++) {
        results.add(verifyAll(key.publicKey, message, signature));
      }
      expect([...results]).toEqual([true]);
      expect(verifyAll(key.publicKey, message, new Uint8Array(64))).toBe(false);
      expect(verifyAll(key.publicKey, message, signature)).toBe(true);
    });
  });

  it('exports the byte sizes the protocol modules expect', () => {
    expect(P256_PUBLIC_KEY_BYTES).toBe(65);
    expect(P256_SIGNATURE_BYTES).toBe(64);
    expect(SHA256_DIGEST_BYTES).toBe(32);
    expect(Object.isFrozen(p256RuntimeCrypto)).toBe(true);
    expect(p256RuntimeCrypto.sha256).toBe(sha256);
    expect(p256RuntimeCrypto.verifySignature).toBe(verifyP256Signature);
  });
});

// =================================================================================================
// The adapter inside the real authenticator (signing is done by Node here, as the Keystore will)
// =================================================================================================

describe('integration with the link authenticator', () => {
  const RIDE = '54321';
  const SESSION = 'AAECAwQFBgcICQoLDA0ODw';
  const T0 = 1_700_000_000_000;
  const server = newKey();
  const bindingDigest = linkAuthBindingDigest(
    Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    sha256,
  );
  const binding: LocalChannelBinding = {
    kind: 'nearby-auth-token-v1',
    digest: bindingDigest,
  };

  function makeNode(device: NodeKey, seed: number) {
    const body = {
      v: 1 as const,
      kid: 'srv-1',
      rideId: RIDE,
      sessionId: SESSION,
      nodeId: deriveRideNodeId(device.publicKey, sha256),
      pub: encodeBase64Url(device.publicKey),
      issuedAt: T0,
      expiresAt: T0 + 3_600_000,
    };
    const credential = {
      ...body,
      sig: encodeBase64Url(
        nodeSignRaw(text(rideCredentialSigningInput(body)), server),
      ),
    };
    let counter = 0;
    const auth = createLinkAuthenticator({
      rideId: RIDE,
      sessionId: SESSION,
      local: { credential, publicKey: device.publicKey },
      credentialVerifier: createRideCredentialVerifier({
        rideId: RIDE,
        sessionId: SESSION,
        keys: new Map([
          [
            'srv-1',
            {
              publicKey: server.publicKey,
              notBefore: T0 - 1000,
              notAfter: T0 + 10 ** 10,
            },
          ],
        ]),
        verifySignature: p256RuntimeCrypto.verifySignature,
        sha256: p256RuntimeCrypto.sha256,
      }),
      verifySignature: p256RuntimeCrypto.verifySignature,
      sha256: p256RuntimeCrypto.sha256,
      randomBytes: length =>
        nodeSha256(Buffer.from(`${seed}:${counter++}`)).subarray(0, length),
      policy: { channelBinding: 'required' },
    });
    return {
      auth,
      credential,
      device,
      state: auth.initialState(`conn-${seed}`),
      connectionId: `conn-${seed}`,
    };
  }

  it('reaches mutual with verification done only by the adapter, and refuses a forged peer', () => {
    const a = makeNode(newKey(), 1);
    const b = makeNode(newKey(), 2);
    const clocks = { monoNow: 1000, wallNow: T0 + 1000 };
    const wire: Array<{ from: typeof a; payload: unknown }> = [];
    const authenticated: string[] = [];
    const feed = (node: typeof a, event: Record<string, unknown>): void => {
      const result = node.auth.reduce(node.state, {
        connectionId: node.connectionId,
        ...clocks,
        ...event,
      } as never);
      node.state = result.state;
      for (const effect of result.effects as readonly LinkAuthEffect[]) {
        if (effect.kind === 'send')
          wire.push({ from: node, payload: effect.payload });
        if (effect.kind === 'authenticated')
          authenticated.push(
            `${node.connectionId}->${effect.nodeId}:${effect.bound}`,
          );
        if (effect.kind === 'sign') {
          feed(node, {
            kind: 'signature_ready',
            requestId: effect.requestId,
            signature: nodeSignRaw(text(effect.input), node.device),
          });
        }
      }
    };
    feed(a, { kind: 'start', binding });
    feed(b, { kind: 'start', binding });
    while (wire.length > 0) {
      const { from, payload } = wire.shift() as (typeof wire)[number];
      const to = from === a ? b : a;
      feed(to, {
        kind: 'received',
        envelope: {
          originId: from.credential.nodeId,
          hopCount: 0,
          rideId: RIDE,
        },
        payload: JSON.parse(JSON.stringify(payload)),
      });
    }
    expect(a.state.authenticated?.nodeId).toBe(b.credential.nodeId);
    expect(b.state.authenticated?.nodeId).toBe(a.credential.nodeId);
    expect(authenticated).toHaveLength(2);

    // a peer holding a credential for somebody else's key cannot get through
    const mallory = newKey();
    const forged = { ...b.credential, pub: encodeBase64Url(mallory.publicKey) };
    const victim = makeNode(newKey(), 3);
    feed(victim, { kind: 'start', binding });
    feed(victim, {
      kind: 'received',
      envelope: { originId: forged.nodeId, hopCount: 0, rideId: RIDE },
      payload: buildLinkAuthHello({
        credential: forged,
        nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
        bindingKind: 'nearby-auth-token-v1',
      }),
    });
    expect(victim.state.phase).toBe('failed');
    expect(victim.state.authenticated).toBeNull();
  });
});
