export type CycleOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface CycleSchedulerOptions<T> {
  runCycle: () => Promise<T>;
  intervalMs: number;
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
    } catch {}
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
