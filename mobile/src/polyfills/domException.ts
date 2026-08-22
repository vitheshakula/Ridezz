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
 * livekit-client directly). This file is imported first, before anything
 * else, in index.js, so it's guaranteed to run regardless of what any
 * package does internally.
 */

// @ts-expect-error: DOMException isn't declared on RN/Hermes's global type.
if (typeof global.DOMException === 'undefined') {
  class PolyfillDOMException extends Error {
    code: number;

    constructor(message = '', name = 'Error') {
      super(message);
      this.name = name;
      this.code = 0;
      Object.setPrototypeOf(this, PolyfillDOMException.prototype);
    }
  }

  // @ts-expect-error: DOMException isn't declared on RN/Hermes's global type.
  global.DOMException = PolyfillDOMException;
}
