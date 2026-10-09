import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { asyncHandler } from '../http';
import { prepareCurrentUser } from '../services/authService';

interface UserRouterDeps {
  prisma: PrismaClient;
  requireAuth: RequestHandler;
}

export function createUserRouter({ prisma, requireAuth }: UserRouterDeps): Router {
  const router = Router();

  router.use(requireAuth);

  // The signed-in rider's profile, including their permanent room code. A rider from before room
  // codes existed is given one here the first time they ask, so the answer always has a code.
  router.get(
    '/profile',
    asyncHandler(async (req, res) => {
      return res.json({ user: await prepareCurrentUser(prisma, req.user!) });
    }),
  );

  return router;
}
