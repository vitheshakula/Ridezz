// @ts-expect-error: `global` isn't declared in this project's TS lib config.
const globalObject: any = global;

if (typeof globalObject.DOMException === 'undefined') {
  class PolyfillDOMException extends Error {
    code: number;

    constructor(message = '', name = 'Error') {
      super(message);
      this.name = name;
      this.code = 0;
      Object.setPrototypeOf(this, PolyfillDOMException.prototype);
    }
  }

  globalObject.DOMException = PolyfillDOMException;
}
