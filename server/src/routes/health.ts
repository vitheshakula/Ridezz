import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../logger';
import { safeErrorDetails } from '../http';

interface HealthRouterDeps {
  prisma: PrismaClient;
}

export function createHealthRouter({ prisma }: HealthRouterDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'ok' });
    } catch (error) {
      logger().error('health_database_unavailable', safeErrorDetails(error));
      res.status(503).json({ status: 'unavailable', database: 'unavailable' });
    }
  });

  return router;
}
