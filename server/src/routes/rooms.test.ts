import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import express, { type Express, type RequestHandler } from 'express';
import type { Env } from '../config/env';
import { errorHandler, notFoundHandler } from '../http';
import { createRoomsRouter } from './rooms';

const TEST_ENV: Env = {
  appEnv: 'test',
  port: 5000,
  logLevel: 'info',
  shutdownTimeoutMs: 10_000,
  jwtSecret: 'test-secret'.padEnd(40, 'x'),
  googleClientId: null,
  allowedEmails: null,
  corsOrigins: null,
  authRateLimit: { windowMs: 15 * 60 * 1000, max: 100, perAccountMax: 1000 },
  livekit: {
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    url: 'wss://livekit.test',
  },
};

interface Reply {
  status: number;
  body: unknown;
}

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

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body: unknown,
): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function roomApp(findUnique: (args: unknown) => Promise<unknown>): Express {
  const prisma = { room: { findUnique } } as unknown as PrismaClient;
  const requireAuth: RequestHandler = (req, _res, next) => {
    req.user = {
      id: 'rider-1',
      email: 'rider@gmail.com',
      name: 'Rider',
      emailVerified: true,
      roomCode: '54321',
    };
    next();
  };

  const app = express();
  app.use(express.json());
  app.use('/api/rooms', createRoomsRouter({ prisma, env: TEST_ENV, requireAuth }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('room-code validation', () => {
  it('rejects malformed join codes before any room lookup', async () => {
    let lookups = 0;
    const app = roomApp(async () => {
      lookups += 1;
      return null;
    });

    await withServer(app, async baseUrl => {
      for (const roomCode of ['', 'abcde', '1234', '123456', '12 34', '   ']) {
        const reply = await request(baseUrl, 'POST', '/api/rooms/join', { roomCode });
        assert.equal(reply.status, 400, JSON.stringify(roomCode));
        assert.deepEqual(reply.body, { message: 'Invalid room code.', code: 'VALIDATION_FAILED' });
      }
    });

    assert.equal(lookups, 0);
  });

  it('rejects malformed destination path codes before any room lookup', async () => {
    let lookups = 0;
    const app = roomApp(async () => {
      lookups += 1;
      return null;
    });
    const destination = { destinationName: 'Fort', destinationLat: 17.38, destinationLng: 78.4 };

    await withServer(app, async baseUrl => {
      for (const roomCode of ['abcde', '1234', '123456', '12%2034', '%20%20%20']) {
        const reply = await request(
          baseUrl,
          'PATCH',
          `/api/rooms/${roomCode}/destination`,
          destination,
        );
        assert.equal(reply.status, 400, roomCode);
        assert.deepEqual(reply.body, { message: 'Invalid room code.', code: 'VALIDATION_FAILED' });
      }
    });

    assert.equal(lookups, 0);
  });

  it('preserves 404 for a syntactically valid but unknown room', async () => {
    const lookedUpCodes: string[] = [];
    const app = roomApp(async args => {
      lookedUpCodes.push((args as { where: { code: string } }).where.code);
      return null;
    });
    const destination = { destinationName: 'Fort', destinationLat: 17.38, destinationLng: 78.4 };

    await withServer(app, async baseUrl => {
      const join = await request(baseUrl, 'POST', '/api/rooms/join', { roomCode: ' 12345 ' });
      assert.equal(join.status, 404);
      assert.deepEqual(join.body, {
        message: 'Ride room not found. Check the 5-digit code.',
        code: 'ROOM_NOT_FOUND',
      });

      const update = await request(baseUrl, 'PATCH', '/api/rooms/12345/destination', destination);
      assert.equal(update.status, 404);
      assert.deepEqual(update.body, { message: 'Ride room not found.', code: 'ROOM_NOT_FOUND' });
    });

    assert.deepEqual(lookedUpCodes, ['12345', '12345']);
  });

  it("preserves each room operation's existing 500 response", async () => {
    const app = roomApp(async () => {
      throw new Error('private database detail');
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      await withServer(app, async baseUrl => {
        const create = await request(baseUrl, 'POST', '/api/rooms/create', {});
        assert.equal(create.status, 500);
        assert.deepEqual(create.body, {
          message: 'Failed to create room.',
          code: 'INTERNAL_ERROR',
        });

        const join = await request(baseUrl, 'POST', '/api/rooms/join', { roomCode: '12345' });
        assert.equal(join.status, 500);
        assert.deepEqual(join.body, { message: 'Failed to join room.', code: 'INTERNAL_ERROR' });

        const update = await request(baseUrl, 'PATCH', '/api/rooms/12345/destination', {
          destinationLat: 17.38,
          destinationLng: 78.4,
        });
        assert.equal(update.status, 500);
        assert.deepEqual(update.body, {
          message: 'Failed to update destination.',
          code: 'INTERNAL_ERROR',
        });
      });
    } finally {
      console.error = originalConsoleError;
    }
  });
});
