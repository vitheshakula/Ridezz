import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../logger';
import { safeErrorDetails } from '../http';
import { checkDatabase } from '../services/healthService';

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
      await checkDatabase(prisma);
      res.json({ status: 'ok', database: 'ok' });
    } catch (error) {
      logger().error('health_database_unavailable', safeErrorDetails(error));
      res.status(503).json({ status: 'unavailable', database: 'unavailable' });
    }
  });

  return router;
}
