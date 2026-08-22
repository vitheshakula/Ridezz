/**
 * Hermes on this stack provides `TextEncoder` natively but not `TextDecoder`
 * (confirmed on-device: `typeof TextEncoder === 'function'`, `typeof
 * TextDecoder === 'undefined'`) — React Native's own core polyfills don't
 * provide either (checked node_modules/react-native/Libraries/Core).
 * livekit-client references `TextDecoder` while decoding incoming protocol
 * messages, reached during livekit-client's module evaluation via the same
 * dependency chain as `DOMException` (see ./domException.ts) — so this must
 * be in place before livekit-client is imported by anything, not just
 * before it's used.
 *
 * This is a hand-written UTF-8-only implementation, which is normally worth
 * avoiding in favor of a vetted package. We tried the obvious one first —
 * `@livekit/react-native` already vendors `FastestSmallestTextEncoderDecoder`
 * (CC0-1.0) as `./polyfills/EncoderDecoderTogether.min.js`, and we depended
 * on the same npm package directly. It didn't work: diffing Metro's compiled
 * bundle output against the original source showed that the line capturing
 * the existing `TextDecoder` value (`F = q.TextDecoder`) is silently dropped
 * during Metro's transform of that pre-minified file, so the polyfill's
 * `F || (q.TextDecoder = x)` assignment never runs — proven on-device via
 * `Object.getOwnPropertyDescriptor`, which showed no property was ever
 * created. That's a bug in how this project's Metro/Babel pipeline handles
 * that specific vendored file, not an import-ordering problem, and it would
 * affect @livekit/react-native's own copy of the file identically regardless
 * of import order. A direct, explicit assignment (the same pattern already
 * proven working for DOMException) sidesteps it entirely.
 *
 * Supports the `{ stream: true }` decode option, since livekit-client's data
 * stream reassembly (IncomingDataStreamManager.ts, StreamReader.ts) decodes
 * incrementally across chunk boundaries and needs multi-byte sequences split
 * across chunks to carry over correctly.
 */
/* eslint-disable no-bitwise -- bit ops are the actual UTF-8 codec, not incidental */

class RidezzTextEncoder {
  readonly encoding = 'utf-8';

  encode(input: string = ''): Uint8Array {
    const str = String(input);
    const bytes: number[] = [];

    for (let i = 0; i < str.length; i++) {
      let codePoint = str.codePointAt(i)!;
      if (codePoint > 0xffff) {
        // codePointAt already consumed the low surrogate; skip it.
        i++;
      }

      if (codePoint <= 0x7f) {
        bytes.push(codePoint);
      } else if (codePoint <= 0x7ff) {
        bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      } else if (codePoint <= 0xffff) {
        bytes.push(
          0xe0 | (codePoint >> 12),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      }
    }

    return new Uint8Array(bytes);
  }
}

interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

interface TextDecodeOptions {
  stream?: boolean;
}

class RidezzTextDecoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  private pendingBytes: number[] = [];

  constructor(label: string = 'utf-8', options: TextDecoderOptions = {}) {
    const normalized = label.toLowerCase();
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(normalized)) {
      throw new RangeError(
        `Ridezz's TextDecoder polyfill only supports utf-8, got "${label}"`,
      );
    }
    this.fatal = options.fatal ?? false;
    this.ignoreBOM = options.ignoreBOM ?? false;
  }

  decode(
    input?: ArrayBuffer | ArrayBufferView,
    options: TextDecodeOptions = {},
  ): string {
    let bytes: number[];
    if (input === undefined) {
      bytes = this.pendingBytes;
      this.pendingBytes = [];
    } else {
      const view =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      bytes = this.pendingBytes.length
        ? this.pendingBytes.concat(Array.from(view))
        : Array.from(view);
      this.pendingBytes = [];
    }

    let result = '';
    let i = 0;

    while (i < bytes.length) {
      const byte1 = bytes[i];
      let codePoint: number;
      let length: number;

      if (byte1 <= 0x7f) {
        codePoint = byte1;
        length = 1;
      } else if ((byte1 & 0xe0) === 0xc0) {
        codePoint = byte1 & 0x1f;
        length = 2;
      } else if ((byte1 & 0xf0) === 0xe0) {
        codePoint = byte1 & 0x0f;
        length = 3;
      } else if ((byte1 & 0xf8) === 0xf0) {
        codePoint = byte1 & 0x07;
        length = 4;
      } else {
        if (this.fatal) {
          throw new TypeError('Invalid UTF-8: bad leading byte');
        }
        result += '�';
        i += 1;
        continue;
      }

      if (i + length > bytes.length) {
        // Sequence is cut off by the end of this chunk.
        if (options.stream) {
          this.pendingBytes = bytes.slice(i);
          return result;
        }
        if (this.fatal) {
          throw new TypeError('Invalid UTF-8: truncated sequence');
        }
        result += '�';
        break;
      }

      let valid = true;
      for (let j = 1; j < length; j++) {
        const cont = bytes[i + j];
        if ((cont & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        codePoint = (codePoint << 6) | (cont & 0x3f);
      }

      if (!valid) {
        if (this.fatal) {
          throw new TypeError('Invalid UTF-8: bad continuation byte');
        }
        result += '�';
        i += 1;
        continue;
      }

      if (codePoint > 0xffff) {
        codePoint -= 0x10000;
        result += String.fromCharCode(
          0xd800 + (codePoint >> 10),
          0xdc00 + (codePoint & 0x3ff),
        );
      } else {
        result += String.fromCharCode(codePoint);
      }

      i += length;
    }

    return result;
  }
}

// @ts-expect-error: `global` isn't declared in this project's TS lib config.
const globalObject: any = global;

if (typeof globalObject.TextEncoder === 'undefined') {
  globalObject.TextEncoder = RidezzTextEncoder;
}

if (typeof globalObject.TextDecoder === 'undefined') {
  globalObject.TextDecoder = RidezzTextDecoder;
}
