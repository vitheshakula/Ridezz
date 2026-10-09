/**
 * Bounded transport sends for connectivity-layer traffic. A transport promise cannot be cancelled,
 * so the operation is raced against a timeout: when the timeout wins the result is UNKNOWN (the
 * send may still complete), and the late settlement is absorbed so it is neither reported twice
 * nor left as an unhandled rejection.
 */

/** Local operational bound on one transport send (routed sendTo, control-plane broadcast). */
export const OPERATIONAL_SEND_TIMEOUT_MS = 2_000;

export type BoundedSendOutcome =
  | { ok: true }
  | { ok: false; error: unknown }
  | { ok: false; timedOut: true };

export function sendWithTimeout(
  send: () => Promise<void>,
  timeoutMs: number,
): Promise<BoundedSendOutcome> {
  return new Promise<BoundedSendOutcome>(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
    let sending: Promise<void>;
    try {
      sending = send();
    } catch (error) {
      sending = Promise.reject(error);
    }
    Promise.resolve(sending).then(
      () => {
        clearTimeout(timer);
        resolve({ ok: true });
      },
      error => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      },
    );
  });
}

export function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown error';
  }
}
