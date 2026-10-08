/**
 * Runs an async cycle repeatedly, never overlapping. Used for heartbeats; reusable for other
 * periodic control-plane traffic.
 *
 * Semantics:
 *   - start(): runs a cycle immediately, unless one is still in flight from before a stop(), in
 *     which case the loop resumes when that cycle settles. A second start() while running is a
 *     no-op, so there is never more than one loop.
 *   - After each cycle settles (fulfilled or rejected), the next is scheduled `intervalMs` later.
 *     The period is therefore cycle duration + intervalMs: a slow cycle delays the next one and
 *     cycles never queue up or overlap.
 *   - stop(): cancels any pending timer. An in-flight cycle is not cancelled; it settles normally
 *     and no further cycle is scheduled. Repeated stop() is safe.
 *   - A rejected cycle or a throwing onCycleSettled never breaks the loop.
 */

export type CycleOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface CycleSchedulerOptions<T> {
  runCycle: () => Promise<T>;
  intervalMs: number;
  /** Observability hook, called once per settled cycle. */
  onCycleSettled?: (outcome: CycleOutcome<T>) => void;
}

export interface CycleScheduler {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export function createCycleScheduler<T>({
  runCycle,
  intervalMs,
  onCycleSettled,
}: CycleSchedulerOptions<T>): CycleScheduler {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Cycle scheduler intervalMs must be a positive integer');
  }

  let running = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const report = (outcome: CycleOutcome<T>) => {
    try {
      onCycleSettled?.(outcome);
    } catch {
      // Observability must not break the loop.
    }
  };

  const settle = (outcome: CycleOutcome<T>) => {
    inFlight = false;
    report(outcome);
    if (running) {
      timer = setTimeout(runNow, intervalMs);
    }
  };

  function runNow(): void {
    timer = null;
    inFlight = true;
    let cycle: Promise<T>;
    try {
      cycle = runCycle();
    } catch (error) {
      cycle = Promise.reject(error);
    }
    Promise.resolve(cycle).then(
      value => settle({ ok: true, value }),
      error => settle({ ok: false, error }),
    );
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      if (!inFlight) {
        runNow();
      }
    },

    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    get running(): boolean {
      return running;
    },
  };
}
