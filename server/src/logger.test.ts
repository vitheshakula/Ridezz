import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createLogger, isLogLevel } from './logger';

const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');

describe('createLogger', () => {
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const lines: { sink: string; entry: Record<string, unknown> }[] = [];

  function capture(): void {
    lines.length = 0;
    for (const sink of ['log', 'warn', 'error', 'debug'] as const) {
      console[sink] = (line: string) => lines.push({ sink, entry: JSON.parse(line) });
    }
  }

  afterEach(() => Object.assign(console, originals));

  it('writes one JSON line with timestamp, level, event and fields', () => {
    capture();
    createLogger('info', () => FIXED_TIME).info('server_started', { port: 5000 });
    assert.deepEqual(lines, [
      {
        sink: 'log',
        entry: {
          timestamp: FIXED_TIME.toISOString(),
          level: 'info',
          event: 'server_started',
          port: 5000,
        },
      },
    ]);
  });

  it('drops entries below the minimum level', () => {
    capture();
    const log = createLogger('warn', () => FIXED_TIME);
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    log.fatal('e');
    assert.deepEqual(
      lines.map(line => [line.sink, line.entry.level]),
      [
        ['warn', 'warn'],
        ['error', 'error'],
        ['error', 'fatal'],
      ],
    );
  });

  it('recognises only the supported levels', () => {
    assert.equal(isLogLevel('debug'), true);
    assert.equal(isLogLevel('critical'), false);
    assert.equal(isLogLevel(''), false);
  });
});
