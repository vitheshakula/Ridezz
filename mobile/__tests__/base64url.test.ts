/// <reference types="node" />
import { randomBytes } from 'crypto';
import {
  decodeBase64Url,
  encodeBase64Url,
  isUint8Array,
} from '../src/connectivity/protocol/base64url';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) =>
  Uint8Array.from(Array.from(text, c => c.charCodeAt(0)));

describe('encodeBase64Url', () => {
  it.each([
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ])('matches the RFC 4648 vector for %j (unpadded)', (input, expected) => {
    expect(encodeBase64Url(ascii(input))).toBe(expected);
  });

  it('uses the URL-safe alphabet', () => {
    expect(encodeBase64Url(bytes(0xfb, 0xff))).toBe('-_8');
    expect(encodeBase64Url(bytes(0xff, 0xff, 0xff))).toBe('____');
    expect(encodeBase64Url(bytes(0xfb, 0xef, 0xbe))).toBe('----');
  });

  it('never emits padding or standard-alphabet characters', () => {
    for (let length = 0; length < 70; length++) {
      expect(encodeBase64Url(new Uint8Array(length).fill(0xfe))).toMatch(
        /^[A-Za-z0-9_-]*$/,
      );
    }
  });

  it('encodes only the viewed bytes of a subarray', () => {
    const backing = bytes(9, 9, 0x66, 0x6f, 9);
    expect(encodeBase64Url(backing.subarray(2, 4))).toBe('Zm8');
  });

  it('throws TypeError for anything that is not a Uint8Array', () => {
    for (const bad of [
      'text',
      [1, 2],
      null,
      undefined,
      new ArrayBuffer(2),
      new Uint16Array(2),
    ]) {
      expect(() => encodeBase64Url(bad as unknown as Uint8Array)).toThrow(
        TypeError,
      );
    }
  });
});

describe('decodeBase64Url', () => {
  it('decodes the RFC 4648 vectors', () => {
    expect(decodeBase64Url('')).toEqual(new Uint8Array(0));
    expect(decodeBase64Url('Zg')).toEqual(ascii('f'));
    expect(decodeBase64Url('Zm8')).toEqual(ascii('fo'));
    expect(decodeBase64Url('Zm9vYmFy')).toEqual(ascii('foobar'));
    expect(decodeBase64Url('-_8')).toEqual(bytes(0xfb, 0xff));
  });

  it('round-trips every length from 0 to 130 with random bytes', () => {
    for (let length = 0; length <= 130; length++) {
      const input = new Uint8Array(randomBytes(length));
      const encoded = encodeBase64Url(input);
      expect(encoded).toBe(Buffer.from(input).toString('base64url'));
      expect(decodeBase64Url(encoded)).toEqual(input);
    }
  });

  it('round-trips every single byte value and the 65-byte and 64-byte key shapes', () => {
    for (let value = 0; value < 256; value++) {
      expect(decodeBase64Url(encodeBase64Url(bytes(value)))).toEqual(
        bytes(value),
      );
    }
    for (const length of [64, 65]) {
      const input = new Uint8Array(randomBytes(length));
      expect(decodeBase64Url(encodeBase64Url(input))).toEqual(input);
    }
  });

  it.each([
    ['standard-alphabet plus', 'ab+d'],
    ['standard-alphabet slash', 'ab/d'],
    ['padding', 'Zg=='],
    ['single trailing padding', 'Zm8='],
    ['leading space', ' Zm9v'],
    ['trailing newline', 'Zm9v\n'],
    ['embedded space', 'Zm 9v'],
    ['non-ASCII letter', 'Zm9é'],
    ['null character', 'Zm9\u0000'],
    ['length 4n+1 (1)', 'A'],
    ['length 4n+1 (5)', 'AAAAA'],
    ['length 4n+1 (9)', 'AAAAAAAAA'],
  ])('rejects %s', (_label, text) => {
    expect(decodeBase64Url(text)).toBeNull();
  });

  it('rejects non-zero unused trailing bits (non-canonical forms)', () => {
    // 'Zg' is the canonical form of "f"; 'Zh' would decode to the same byte.
    expect(decodeBase64Url('Zh')).toBeNull();
    expect(decodeBase64Url('Zm9')).toBeNull(); // canonical form of "fo" is 'Zm8'
    expect(decodeBase64Url('Zm8')).not.toBeNull();
  });

  it('accepts exactly 256 of the 4096 two-character strings, one for each byte value', () => {
    // Two characters carry one byte; the final character's low 4 bits are unused and must be 0.
    const decodedBytes = new Set<number>();
    let accepted = 0;
    for (const a of ALPHABET) {
      for (const b of ALPHABET) {
        const text = a + b;
        const decoded = decodeBase64Url(text);
        if (decoded === null) {
          continue;
        }
        accepted++;
        expect(decoded).toHaveLength(1);
        expect(encodeBase64Url(decoded)).toBe(text);
        decodedBytes.add(decoded[0]);
      }
    }
    expect(accepted).toBe(256);
    expect(decodedBytes.size).toBe(256);
  });

  it('accepts exactly 65536 of the 262144 three-character strings, one for each byte pair', () => {
    // Three characters carry two bytes; the final character's low 2 bits are unused and must be 0.
    const decodedPairs = new Set<number>();
    let accepted = 0;
    for (const a of ALPHABET) {
      for (const b of ALPHABET) {
        for (const c of ALPHABET) {
          const text = a + b + c;
          const decoded = decodeBase64Url(text);
          if (decoded === null) {
            continue;
          }
          accepted++;
          expect(decoded).toHaveLength(2);
          expect(encodeBase64Url(decoded)).toBe(text);
          decodedPairs.add(decoded[0] * 256 + decoded[1]);
        }
      }
    }
    expect(accepted).toBe(65536);
    expect(decodedPairs.size).toBe(65536);
  });

  it('accepts every four-character string that starts with A, and each re-encodes to itself', () => {
    let accepted = 0;
    for (const b of ALPHABET) {
      for (const c of ALPHABET) {
        for (const d of ALPHABET) {
          const text = `A${b}${c}${d}`;
          const decoded = decodeBase64Url(text);
          expect(decoded).not.toBeNull();
          expect(decoded).toHaveLength(3);
          expect(encodeBase64Url(decoded as Uint8Array)).toBe(text);
          accepted++;
        }
      }
    }
    expect(accepted).toBe(262144);
  });

  it('rejects every one-character string', () => {
    for (const a of ALPHABET) {
      expect(decodeBase64Url(a)).toBeNull();
    }
  });

  it('keeps the canonical rule at the trailing group of longer strings', () => {
    // 87 characters (a P-256 point) and 86 (a P1363 signature) end in a 3- and 2-character group.
    for (const [length, charCount] of [
      [65, 87],
      [64, 86],
      [32, 43],
    ] as const) {
      const sample = new Uint8Array(randomBytes(length));
      const text = encodeBase64Url(sample);
      expect(text).toHaveLength(charCount);
      const last = ALPHABET.indexOf(text[text.length - 1]);
      // The final character holds 2 unused bits after a 3-character group, 4 after a 2-character one.
      const unusedValues = length % 3 === 2 ? 4 : 16;
      // Flip the lowest bit: still in the alphabet, but now one of the unused bits is set.
      const twisted = ALPHABET[last % 2 === 0 ? last + 1 : last - 1];
      expect(last % unusedValues).toBe(0);
      expect(decodeBase64Url(text.slice(0, -1) + twisted)).toBeNull();
    }
  });

  it('returns null, without throwing, for non-string input', () => {
    for (const bad of [undefined, null, 5, {}, [], bytes(1, 2)]) {
      expect(decodeBase64Url(bad as unknown as string)).toBeNull();
    }
  });

  it('returns a fresh array on every call', () => {
    const a = decodeBase64Url('Zm9v') as Uint8Array;
    const b = decodeBase64Url('Zm9v') as Uint8Array;
    a[0] = 0;
    expect(b[0]).toBe(0x66);
  });
});

describe('decodeBase64Url with a polluted Object.prototype', () => {
  // Only keys that do not exist on Object.prototype natively, so cleanup can never delete a builtin.
  const POLLUTED = ['=', '+', '/', ' ', '\n', '!', 'é'];

  afterEach(() => {
    for (const key of POLLUTED) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  it('is unaffected by inherited properties named after non-alphabet characters', () => {
    const before = [
      'Zg==',
      'ab+d',
      'ab/d',
      'Zm 9v',
      'Zm9v\n',
      'Zm9!',
      'Zm9é',
    ].map(decodeBase64Url);
    expect(before.every(result => result === null)).toBe(true);

    for (const key of POLLUTED) {
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, key)).toBe(
        false,
      );
      (Object.prototype as Record<string, unknown>)[key] = 0;
    }
    const after = [
      'Zg==',
      'ab+d',
      'ab/d',
      'Zm 9v',
      'Zm9v\n',
      'Zm9!',
      'Zm9é',
    ].map(decodeBase64Url);
    expect(after.every(result => result === null)).toBe(true);
  });

  it('still decodes canonical input identically', () => {
    (Object.prototype as Record<string, unknown>)['='] = 0;
    (Object.prototype as Record<string, unknown>)['+'] = 1;
    expect(decodeBase64Url('Zm9vYmFy')).toEqual(ascii('foobar'));
    expect(decodeBase64Url('-_8')).toEqual(bytes(0xfb, 0xff));
    expect(encodeBase64Url(ascii('foobar'))).toBe('Zm9vYmFy');
  });

  it('rejects characters outside ASCII, including code units that wrap into the alphabet', () => {
    // 'Ā' is U+0100; a lookup that masked to 8 bits would read it as 'A'.
    expect(decodeBase64Url('Zm9\u0141')).toBeNull();
    expect(decodeBase64Url('\u0100\u0100\u0100\u0100')).toBeNull();
    expect(decodeBase64Url('Zm9\uD83D\uDE00')).toBeNull();
  });
});

describe('isUint8Array', () => {
  it('recognises Uint8Array and Buffer, and nothing else', () => {
    expect(isUint8Array(new Uint8Array(1))).toBe(true);
    expect(isUint8Array(Buffer.from([1]))).toBe(true);
    for (const other of [
      [1],
      'a',
      null,
      undefined,
      new Uint16Array(1),
      new DataView(new ArrayBuffer(1)),
    ]) {
      expect(isUint8Array(other)).toBe(false);
    }
  });
});
