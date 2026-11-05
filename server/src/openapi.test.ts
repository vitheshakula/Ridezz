import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createApp, API_PREFIXES } from './app';
import { openApiDocument } from './openapi';
import { TEST_ENV } from './testing/testEnv';

interface Layer {
  name: string;
  matchers?: ((path: string) => unknown)[];
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

const ROUTER_MOUNTS = ['/auth', '/user', '/rooms'];

function mountedRoutes(): Set<string> {
  const app = createApp({ prisma: {} as PrismaClient, env: TEST_ENV });
  const appStack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  const routes = new Set<string>(['GET /openapi.json']);
  for (const mount of ROUTER_MOUNTS) {
    const router = appStack.find(
      layer =>
        layer.name === 'router' &&
        (layer.matchers ?? []).some(match => match(`${API_PREFIXES[0]}${mount}`)),
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
