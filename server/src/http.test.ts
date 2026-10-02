import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import express, { type Express } from 'express';
import { createApp } from './app';
import type { Env } from './config/env';
import { asyncHandler, errorHandler } from './http';

const TEST_ENV: Env = {
  port: 5000,
  jwtSecret: 'test-secret'.padEnd(40, 'x'),
  googleClientId: null,
  allowedEmails: null,
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

describe('HTTP fallthrough handling', () => {
  it('returns the same JSON 404 for unknown GET and POST routes', async () => {
    const app = createApp({ prisma: {} as PrismaClient, env: TEST_ENV });

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

describe('central error handler', () => {
  it('preserves generic 500, malformed-JSON 400 and flattened 4xx responses without leaking details', async () => {
    const app = express();
    app.use(express.json());
    app.get(
      '/unexpected',
      asyncHandler(async () => {
        throw new Error('private stack detail');
      }),
    );
    app.get('/client-error', (_req, _res, next) => {
      const error = Object.assign(new Error('private client detail'), { status: 422 });
      next(error);
    });
    app.post('/json', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      await withServer(app, async baseUrl => {
        const unexpected = await fetch(`${baseUrl}/unexpected`);
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
  });
});
