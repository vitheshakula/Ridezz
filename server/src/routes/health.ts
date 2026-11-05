import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../logger';
import { safeErrorDetails } from '../http';
import { checkDatabase } from '../services/healthService';

interface HealthRouterDeps {
  prisma: PrismaClient;
  checkCache?: () => Promise<unknown>;
}

export function createHealthRouter({ prisma, checkCache }: HealthRouterDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const cacheStatus = async (): Promise<{ cache?: 'ok' | 'unavailable' }> => {
    if (!checkCache) {
      return {};
    }
    try {
      await checkCache();
      return { cache: 'ok' };
    } catch (error) {
      logger().warn('health_cache_unavailable', safeErrorDetails(error));
      return { cache: 'unavailable' };
    }
  };

  router.get('/ready', async (_req, res) => {
    const cache = await cacheStatus();
    try {
      await checkDatabase(prisma);
      res.json({ status: 'ok', database: 'ok', ...cache });
    } catch (error) {
      logger().error('health_database_unavailable', safeErrorDetails(error));
      res.status(503).json({ status: 'unavailable', database: 'unavailable', ...cache });
    }
  });

  return router;
}
