export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  fatal(event: string, fields?: LogFields): void;
}

const SINKS: Record<LogLevel, (line: string) => void> = {
  debug: line => console.debug(line),
  info: line => console.log(line),
  warn: line => console.warn(line),
  error: line => console.error(line),
  fatal: line => console.error(line),
};

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function createLogger(
  minimumLevel: LogLevel = 'info',
  now: () => Date = () => new Date(),
): Logger {
  const threshold = LOG_LEVELS.indexOf(minimumLevel);
  const write =
    (level: LogLevel) =>
    (event: string, fields: LogFields = {}): void => {
      if (LOG_LEVELS.indexOf(level) < threshold) {
        return;
      }
      SINKS[level](JSON.stringify({ timestamp: now().toISOString(), level, event, ...fields }));
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
  };
}

let activeLogger: Logger = createLogger();

export function logger(): Logger {
  return activeLogger;
}

export function setLogger(next: Logger): void {
  activeLogger = next;
}
