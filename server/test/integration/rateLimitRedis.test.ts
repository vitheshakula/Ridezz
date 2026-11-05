import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { connectRedis, type RedisConnection } from '../../src/integrations/rateLimitStore';
import { createLogger, setLogger } from '../../src/logger';
import { testEnv } from '../../src/testing/testEnv';

const redisUrl = process.env.TEST_REDIS_URL?.trim();

setLogger(createLogger('error'));

describe(
  'rate limits shared through Redis',
  { skip: redisUrl ? false : 'TEST_REDIS_URL is not set' },
  () => {
    let redis: RedisConnection;
    const servers: Server[] = [];

    async function startInstance(connection: RedisConnection = redis): Promise<string> {
      const env = testEnv({
        authRateLimit: { windowMs: 60_000, max: 3, perAccountMax: 1000, perRiderJoinMax: 1000 },
      });
      const app = createApp({
        prisma: { $queryRaw: async () => [{ ok: 1 }] } as unknown as PrismaClient,
        env,
        rateLimitStores: connection.storeFactory,
        checkCache: () => connection.ping(),
      });
      const server = await new Promise<Server>(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      servers.push(server);
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    before(async () => {
      redis = await connectRedis(redisUrl!);
    });

    after(async () => {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
      await redis.close();
    });

    it('counts requests across instances, so a second instance does not reset the limit', async () => {
      const [first, second] = [await startInstance(), await startInstance()];
      const clientIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      const attempt = (base: string) =>
        fetch(`${base}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp },
          body: '{}',
        });

      assert.equal((await attempt(first)).status, 400);
      assert.equal((await attempt(second)).status, 400);
      assert.equal((await attempt(first)).status, 400);
      const limited = await attempt(second);
      assert.equal(limited.status, 429);
      assert.equal(((await limited.json()) as { code: string }).code, 'RATE_LIMITED');
    });

    it('reports the cache in the readiness check', async () => {
      const base = await startInstance();
      const response = await fetch(`${base}/health/ready`);
      const body = (await response.json()) as { cache?: string };
      assert.equal(body.cache, 'ok');
    });

    it('lets requests through and reports the cache as unavailable when Redis goes away', async () => {
      const lost = await connectRedis(redisUrl!);
      const base = await startInstance(lost);
      await lost.close();

      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(login.status, 400);

      const ready = await fetch(`${base}/health/ready`);
      assert.equal(ready.status, 200);
      assert.equal(((await ready.json()) as { cache?: string }).cache, 'unavailable');
    });
  },
);
