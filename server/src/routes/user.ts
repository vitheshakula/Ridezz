import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prepareCurrentUser } from '../services/authService';

interface UserRouterDeps {
  prisma: PrismaClient;
  requireAuth: RequestHandler;
}

export function createUserRouter({ prisma, requireAuth }: UserRouterDeps): Router {
  const router = Router();

  router.use(requireAuth);

  router.get('/profile', async (req, res) => {
    return res.json({ user: await prepareCurrentUser(prisma, req.user!) });
  });

  return router;
}
