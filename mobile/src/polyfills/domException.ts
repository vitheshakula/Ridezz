/**
 * Hermes has no global `DOMException`. livekit-client references it at
 * module-evaluation time, not just inside functions — e.g.
 * `class DeferrableMapAbortError extends DOMException` in
 * livekit-client/src/utils/deferrable-map.ts, reached as soon as
 * RemoteParticipant (a core class) is loaded. That means `DOMException` must
 * exist globally before livekit-client is imported anywhere, by anything.
 *
 * @livekit/react-native ships its own version of this polyfill, but relying
 * on its internal import ordering is fragile (our own code also imports
 * livekit-client directly). This is imported first via
 * src/polyfills/index.ts, which index.js imports before anything else, so
 * it's guaranteed to run regardless of what any package does internally.
 */

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
