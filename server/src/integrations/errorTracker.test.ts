import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorHandler, logRequestError, requestIdMiddleware } from '../http';
import {
  errorTracker,
  noopErrorTracker,
  scrubEvent,
  setErrorTracker,
  type ErrorContext,
} from './errorTracker';

function recordingTracker() {
  const captured: { error: unknown; context?: ErrorContext }[] = [];
  return {
    captured,
    tracker: {
      capture: (error: unknown, context?: ErrorContext) => captured.push({ error, context }),
      flush: async () => undefined,
    },
  };
}

describe('error tracking', () => {
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  afterEach(() => {
    setErrorTracker(noopErrorTracker);
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  it('is a no-op until a tracker is configured', () => {
    assert.equal(errorTracker(), noopErrorTracker);
  });

  it('reports unexpected request errors with the request id, never warnings', async () => {
    const { captured, tracker } = recordingTracker();
    setErrorTracker(tracker);
    console.error = () => undefined;
    console.warn = () => undefined;

    const failure = new Error('database exploded');
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/boom', async () => {
      throw failure;
    });
    app.get('/warn', (req, res) => {
      logRequestError(req, 'expected_problem', new Error('fine'), 'warn');
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await fetch(`${base}/boom`, { headers: { 'x-request-id': 'tracked-1' } });
      await fetch(`${base}/warn`);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    assert.equal(captured.length, 1);
    assert.equal(captured[0].error, failure);
    assert.deepEqual(captured[0].context, {
      event: 'http_error',
      requestId: 'tracked-1',
      method: 'GET',
      path: '/boom',
      userId: undefined,
    });
  });

  it('strips request bodies, headers, cookies, query strings and user details before sending', () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: 'https://api.example/api/v1/auth/login',
        data: { password: 'secret' },
        headers: { authorization: 'Bearer token' },
        cookies: { session: 'abc' },
        query_string: 'token=abc',
      },
      user: { id: 'user-1', email: 'rider@gmail.com', ip_address: '203.0.113.1' },
    });
    assert.deepEqual(event, {
      type: undefined,
      request: { url: 'https://api.example/api/v1/auth/login' },
      user: { id: 'user-1' },
    });
  });
});
