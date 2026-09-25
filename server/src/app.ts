import cors from 'cors';
import express, { type Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { GoogleVerifier } from './auth/google';
import { configurePassport, createRequireAuth } from './config/passport';
import type { Env } from './config/env';
import { errorHandler } from './http';
import { createAuthRouter } from './routes/auth';
import { createRoomsRouter } from './routes/rooms';

export interface AppDeps {
  prisma: PrismaClient;
  env: Env;
  /** Left out when Google sign-in isn't configured. */
  verifyGoogleIdToken?: GoogleVerifier;
}

/** Builds the Express app from its dependencies (no listening, no globals) so tests can run the
 * real routes against a throwaway database and a fake Google. */
export function createApp({ prisma, env, verifyGoogleIdToken }: AppDeps): Express {
  const app = express();
  const passport = configurePassport(prisma, env.jwtSecret, env.allowedEmails);
  const requireAuth = createRequireAuth(passport);

  app.use(cors());
  app.use(express.json());
  app.use(passport.initialize());

  app.use('/api/auth', createAuthRouter({ prisma, env, requireAuth, verifyGoogleIdToken }));
  app.use('/api/rooms', createRoomsRouter({ prisma, env, requireAuth }));

  app.use(errorHandler);
  return app;
}
