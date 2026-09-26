import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ensureRoomCode } from '../auth/roomCode';
import { asyncHandler } from '../http';

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
      const me = req.user!;
      const roomCode = me.roomCode ?? (await ensureRoomCode(prisma, me.id));
      return res.json({ user: { ...me, roomCode } });
    }),
  );

  return router;
}
