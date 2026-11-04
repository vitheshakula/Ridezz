export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const SINKS: Record<LogLevel, (...values: unknown[]) => void> = {
  debug: (...values) => console.debug(...values),
  info: (...values) => console.info(...values),
  warn: (...values) => console.warn(...values),
  error: (...values) => console.error(...values),
};

export const DEFAULT_MIN_LEVEL: LogLevel = __DEV__ ? 'debug' : 'warn';

export function createLogger(
  scope: string,
  minLevel: LogLevel = DEFAULT_MIN_LEVEL,
  now: () => Date = () => new Date(),
): Logger {
  const write =
    (level: LogLevel) =>
    (message: string, ...details: unknown[]): void => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
        return;
      }
      SINKS[level](
        `${now().toISOString()} ${level.toUpperCase()} [${scope}] ${message}`,
        ...details,
      );
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
