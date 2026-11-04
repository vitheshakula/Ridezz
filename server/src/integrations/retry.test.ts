import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backoffDelayMs, isTransientHttpError, withRetry } from './retry';

const noSleep = async () => undefined;

describe('backoffDelayMs', () => {
  it('grows exponentially, is capped, and applies full jitter', () => {
    assert.equal(
      backoffDelayMs(0, 100, 1000, () => 0.999),
      99,
    );
    assert.equal(
      backoffDelayMs(2, 100, 1000, () => 0.5),
      200,
    );
    assert.equal(
      backoffDelayMs(10, 100, 1000, () => 0.5),
      500,
    );
    assert.equal(
      backoffDelayMs(3, 100, 1000, () => 0),
      0,
    );
  });
});

describe('withRetry', () => {
  const options = { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep };

  it('returns the first successful result', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new Error('transient');
        }
        return 'ok';
      },
      { ...options, shouldRetry: () => true },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('stops after the configured number of attempts and rethrows the last error', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error(`failure ${calls}`);
        },
        { ...options, shouldRetry: () => true },
      ),
      /failure 3/,
    );
    assert.equal(calls, 3);
  });

  it('does not retry permanent errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('permanent');
        },
        { ...options, shouldRetry: () => false },
      ),
      /permanent/,
    );
    assert.equal(calls, 1);
  });

  it('waits the backoff delay between attempts', async () => {
    const delays: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw new Error('down');
        },
        {
          ...options,
          shouldRetry: () => true,
          random: () => 0.5,
          sleep: async ms => {
            delays.push(ms);
          },
        },
      ),
    );
    assert.deepEqual(delays, [5, 10]);
  });
});

describe('isTransientHttpError', () => {
  it('treats network failures, 429 and 5xx as transient', () => {
    assert.equal(isTransientHttpError({ code: 'ETIMEDOUT' }), true);
    assert.equal(isTransientHttpError({ code: 'ECONNRESET' }), true);
    assert.equal(isTransientHttpError({ response: { status: 503 } }), true);
    assert.equal(isTransientHttpError({ response: { status: 429 } }), true);
  });

  it('treats client errors and unknown values as permanent', () => {
    assert.equal(isTransientHttpError({ response: { status: 400 } }), false);
    assert.equal(isTransientHttpError(new Error('Invalid token signature')), false);
    assert.equal(isTransientHttpError(null), false);
    assert.equal(isTransientHttpError('timeout'), false);
  });
});
