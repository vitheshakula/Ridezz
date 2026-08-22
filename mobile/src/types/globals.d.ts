/**
 * Minimal ambient declarations for the WHATWG globals we actually use and
 * guarantee via src/polyfills/textEncoding.ts. Deliberately narrow (not the full
 * "dom" lib) to avoid pulling in unrelated DOM types that could conflict with
 * React Native's own global types.
 */
declare class TextEncoder {
  readonly encoding: string;
  // Always ArrayBuffer-backed (never SharedArrayBuffer), matching the real WHATWG spec --
  // spelled out because some libraries (e.g. livekit-client's publishData) distinguish
  // Uint8Array<ArrayBuffer> from the wider Uint8Array<ArrayBufferLike>.
  encode(input?: string): Uint8Array<ArrayBuffer>;
}

declare class TextDecoder {
  readonly encoding: string;
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}
