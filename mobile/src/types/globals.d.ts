declare class TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array<ArrayBuffer>;
}

declare class TextDecoder {
  readonly encoding: string;
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}
