import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createApp, API_PREFIXES } from './app';
import type { Env } from './config/env';
import { openApiDocument } from './openapi';

const ENV: Env = {
  appEnv: 'test',
  port: 0,
  logLevel: 'error',
  shutdownTimeoutMs: 1000,
  jwtSecret: 'x'.repeat(40),
  googleClientId: null,
  allowedEmails: null,
  corsOrigins: null,
  authRateLimit: { windowMs: 60_000, max: 100, perAccountMax: 10 },
  livekit: { apiKey: 'key', apiSecret: 'secret', url: 'wss://livekit.test' },
};

interface Layer {
  name: string;
  regexp?: RegExp;
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

const ROUTER_MOUNTS = ['/auth', '/user', '/rooms'];

function mountedRoutes(): Set<string> {
  const app = createApp({ prisma: {} as PrismaClient, env: ENV });
  const appStack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
  const routes = new Set<string>(['GET /openapi.json']);
  for (const mount of ROUTER_MOUNTS) {
    const router = appStack.find(
      layer => layer.name === 'router' && layer.regexp?.test(`${API_PREFIXES[0]}${mount}`),
    );
    assert.ok(router?.handle.stack, `no router mounted at ${mount}`);
    for (const { route } of router.handle.stack) {
      if (!route) {
        continue;
      }
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const path of paths) {
        for (const method of Object.keys(route.methods)) {
          routes.add(`${method.toUpperCase()} ${mount}${path.replace(/:(\w+)/g, '{$1}')}`);
        }
      }
    }
  }
  return routes;
}

function documentedRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const [path, operations] of Object.entries(openApiDocument.paths)) {
    for (const method of Object.keys(operations)) {
      routes.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

describe('OpenAPI document', () => {
  it('documents exactly the routes the app serves', () => {
    assert.deepEqual([...documentedRoutes()].sort(), [...mountedRoutes()].sort());
  });

  it('only references schemas it defines', () => {
    const defined = new Set(Object.keys(openApiDocument.components.schemas));
    const references = JSON.stringify(openApiDocument).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const reference of references) {
      assert.ok(defined.has(reference.split('/').pop()!), `${reference} is not defined`);
    }
  });

  it('lists every error code the server can return', async () => {
    const { ErrorCode } = await import('./errors');
    assert.deepEqual(
      [...openApiDocument.components.schemas.Error.properties.code.enum].sort(),
      Object.values(ErrorCode).sort(),
    );
  });
});
