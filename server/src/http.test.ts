import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import express, { type Express } from 'express';
import { createApp } from './app';
import type { Env } from './config/env';
import { asyncHandler, errorHandler, requestIdMiddleware } from './http';

const TEST_ENV: Env = {
  port: 5000,
  logLevel: 'info',
  shutdownTimeoutMs: 10_000,
  jwtSecret: 'test-secret'.padEnd(40, 'x'),
  googleClientId: null,
  allowedEmails: null,
  corsOrigins: null,
  authRateLimit: { windowMs: 15 * 60 * 1000, max: 100 },
  livekit: {
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    url: 'wss://livekit.test',
  },
};

async function withServer<T>(app: Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const port = (server.address() as AddressInfo).port;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  }
}

function testApp(overrides: Partial<Env> = {}): Express {
  return createApp({ prisma: {} as PrismaClient, env: { ...TEST_ENV, ...overrides } });
}

describe('HTTP fallthrough handling', () => {
  it('returns the same JSON 404 for unknown GET and POST routes', async () => {
    const app = testApp();

    await withServer(app, async baseUrl => {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(`${baseUrl}/api/not-a-real-route`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'POST' ? '{}' : undefined,
        });
        assert.equal(response.status, 404);
        assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
        assert.deepEqual(await response.json(), { message: 'Not found.' });
      }
    });
  });
});

describe('HTTP security middleware', () => {
  it('sets common Helmet headers and removes the Express signature', async () => {
    await withServer(testApp(), async baseUrl => {
      const response = await fetch(`${baseUrl}/api/not-a-real-route`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.ok(response.headers.get('content-security-policy'));
      assert.equal(response.headers.get('x-powered-by'), null);
    });
  });

  it('allows only configured browser origins while preserving native requests', async () => {
    const corsOrigins = new Set(['https://app.example']);
    await withServer(testApp({ corsOrigins }), async baseUrl => {
      const allowed = await fetch(`${baseUrl}/api/not-a-real-route`, {
        headers: { origin: 'https://app.example' },
      });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example');

      const denied = await fetch(`${baseUrl}/api/not-a-real-route`, {
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(denied.status, 404);
      assert.equal(denied.headers.get('access-control-allow-origin'), null);

      const native = await fetch(`${baseUrl}/api/not-a-real-route`);
      assert.equal(native.status, 404);
    });
  });

  it('preserves permissive development CORS when CORS_ORIGINS is unset', async () => {
    await withServer(testApp({ corsOrigins: null }), async baseUrl => {
      const response = await fetch(`${baseUrl}/api/not-a-real-route`, {
        headers: { origin: 'https://local-prototype.example' },
      });
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
    });
  });

  it('generates, propagates and bounds request IDs', async () => {
    await withServer(testApp(), async baseUrl => {
      const generated = await fetch(`${baseUrl}/api/not-a-real-route`);
      assert.match(generated.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);

      const supplied = await fetch(`${baseUrl}/api/not-a-real-route`, {
        headers: { 'x-request-id': 'client-request_123:abc' },
      });
      assert.equal(supplied.headers.get('x-request-id'), 'client-request_123:abc');

      const oversized = 'x'.repeat(200);
      const replaced = await fetch(`${baseUrl}/api/not-a-real-route`, {
        headers: { 'x-request-id': oversized },
      });
      assert.notEqual(replaced.headers.get('x-request-id'), oversized);
      assert.match(replaced.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    });
  });

  it('rate-limits sensitive auth and room-join routes with a generic JSON response', async () => {
    const authRateLimit = { windowMs: 60_000, max: 2 };
    await withServer(testApp({ authRateLimit }), async baseUrl => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(response.status, 400);
      }
      const limitedAuth = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@gmail.com', password: 'not-logged' }),
      });
      assert.equal(limitedAuth.status, 429);
      assert.match(limitedAuth.headers.get('content-type') ?? '', /^application\/json\b/);
      assert.deepEqual(await limitedAuth.json(), {
        message: 'Too many requests. Please try again later.',
      });

      const anotherClient = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
        body: '{}',
      });
      assert.equal(
        anotherClient.status,
        400,
        'a different forwarded client address has its own bucket',
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal((await fetch(`${baseUrl}/api/rooms/join`, { method: 'POST' })).status, 401);
      }
      const limitedJoin = await fetch(`${baseUrl}/api/rooms/join`, { method: 'POST' });
      assert.equal(limitedJoin.status, 429);
      assert.deepEqual(await limitedJoin.json(), {
        message: 'Too many requests. Please try again later.',
      });
    });
  });

  it('accepts normal JSON and safely rejects bodies over 32kb', async () => {
    await withServer(testApp(), async baseUrl => {
      const normal = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(normal.status, 400);
      assert.deepEqual(await normal.json(), { message: 'Email and password are required.' });

      const oversized = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(40 * 1024) }),
      });
      assert.equal(oversized.status, 413);
      assert.deepEqual(await oversized.json(), { message: 'Invalid request.' });
    });
  });

  it('logs request completion fields without headers, query values or request bodies', async () => {
    const entries: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...values: unknown[]) => entries.push(values.map(String).join(' '));
    try {
      await withServer(testApp(), async baseUrl => {
        const response = await fetch(`${baseUrl}/api/auth/login?token=query-secret`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer authorization-secret',
            'content-type': 'application/json',
            'x-request-id': 'logging-test-id',
          },
          body: JSON.stringify({ password: 'body-secret' }),
        });
        assert.equal(response.status, 400);
        await response.text();
      });
    } finally {
      console.log = originalConsoleLog;
    }

    const requestLog = entries
      .map(entry => JSON.parse(entry))
      .find(entry => entry.event === 'http_request');
    assert.ok(requestLog);
    assert.equal(requestLog.requestId, 'logging-test-id');
    assert.equal(requestLog.method, 'POST');
    assert.equal(requestLog.path, '/api/auth/login');
    assert.equal(requestLog.status, 400);
    assert.equal(typeof requestLog.durationMs, 'number');
    const serialized = entries.join('\n');
    assert.equal(serialized.includes('authorization-secret'), false);
    assert.equal(serialized.includes('query-secret'), false);
    assert.equal(serialized.includes('body-secret'), false);
  });
});

describe('central error handler', () => {
  it('preserves generic 500, malformed-JSON 400 and flattened 4xx responses without leaking details', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.get(
      '/unexpected',
      asyncHandler(async () => {
        throw new Error(
          'private stack detail postgresql://private-user:private-password@db.example/ridezz Bearer secret-token',
        );
      }),
    );
    app.get('/client-error', (_req, _res, next) => {
      const error = Object.assign(new Error('private client detail'), { status: 422 });
      next(error);
    });
    app.post('/json', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const errorEntries: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => errorEntries.push(values.map(String).join(' '));
    try {
      await withServer(app, async baseUrl => {
        const unexpected = await fetch(`${baseUrl}/unexpected`, {
          headers: { 'x-request-id': 'error-test-id' },
        });
        assert.equal(unexpected.status, 500);
        assert.deepEqual(await unexpected.json(), { message: 'Internal server error' });

        const clientError = await fetch(`${baseUrl}/client-error`);
        assert.equal(clientError.status, 422);
        assert.deepEqual(await clientError.json(), { message: 'Invalid request.' });

        const malformed = await fetch(`${baseUrl}/json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        });
        assert.equal(malformed.status, 400);
        assert.deepEqual(await malformed.json(), { message: 'Invalid request.' });
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(errorEntries.length, 1);
    const errorLog = JSON.parse(errorEntries[0]);
    assert.equal(errorLog.event, 'http_error');
    assert.equal(errorLog.requestId, 'error-test-id');
    assert.equal(errorLog.method, 'GET');
    assert.equal(errorLog.path, '/unexpected');
    assert.equal(errorLog.errorName, 'Error');
    assert.match(errorLog.errorMessage, /private stack detail/);
    assert.equal(errorEntries[0].includes('private-user'), false);
    assert.equal(errorEntries[0].includes('private-password'), false);
    assert.equal(errorEntries[0].includes('secret-token'), false);
  });
});

describe('health checks', () => {
  it('reports liveness without touching the database', async () => {
    await withServer(testApp(), async baseUrl => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
    });
  });

  it('reports ready when the database answers and 503 when it does not', async () => {
    const healthy = { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as PrismaClient;
    await withServer(createApp({ prisma: healthy, env: TEST_ENV }), async baseUrl => {
      const response = await fetch(`${baseUrl}/health/ready`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', database: 'ok' });
    });

    const failing = {
      $queryRaw: async () => {
        throw new Error('connect ECONNREFUSED postgresql://user:secret@db.internal/ridezz');
      },
    } as unknown as PrismaClient;
    const errorLines: string[] = [];
    const originalConsoleError = console.error;
    console.error = (line: string) => errorLines.push(line);
    try {
      await withServer(createApp({ prisma: failing, env: TEST_ENV }), async baseUrl => {
        const response = await fetch(`${baseUrl}/health/ready`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          status: 'unavailable',
          database: 'unavailable',
        });
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(errorLines.length, 1);
    assert.equal(JSON.parse(errorLines[0]).event, 'health_database_unavailable');
    assert.equal(errorLines[0].includes('secret'), false);
  });
});
