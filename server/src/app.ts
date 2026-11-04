import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { PrismaClient } from '@prisma/client';
import type { GoogleVerifier } from './auth/google';
import { configurePassport, createRequireAuth } from './config/passport';
import type { Env } from './config/env';
import { errorHandler, notFoundHandler, requestIdMiddleware, requestLogger } from './http';
import { createAuthRouter } from './routes/auth';
import { createRoomsRouter } from './routes/rooms';
import { createUserRouter } from './routes/user';

export interface AppDeps {
  prisma: PrismaClient;
  env: Env;
  verifyGoogleIdToken?: GoogleVerifier;
}

const JSON_BODY_LIMIT = '32kb';

function createSensitiveRateLimiter(env: Env): RequestHandler {
  return rateLimit({
    windowMs: env.authRateLimit.windowMs,
    limit: env.authRateLimit.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ message: 'Too many requests. Please try again later.' });
    },
  });
}

export function createApp({ prisma, env, verifyGoogleIdToken }: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1);
  const passport = configurePassport(prisma, env.jwtSecret, env.allowedEmails);
  const requireAuth = createRequireAuth(passport);
  const authRateLimiter = createSensitiveRateLimiter(env);
  const roomJoinRateLimiter = createSensitiveRateLimiter(env);

  app.use(requestIdMiddleware);
  app.use(requestLogger);
  app.use(helmet());
  app.use(
    env.corsOrigins
      ? cors({
          origin: (origin, callback) => callback(null, !origin || env.corsOrigins!.has(origin)),
        })
      : cors(),
  );
  app.post(
    ['/api/auth/login', '/api/auth/register', '/api/auth/signup', '/api/auth/google'],
    authRateLimiter,
  );
  app.post('/api/rooms/join', roomJoinRateLimiter);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(passport.initialize());

  app.use('/api/auth', createAuthRouter({ prisma, env, requireAuth, verifyGoogleIdToken }));
  app.use('/api/user', createUserRouter({ prisma, requireAuth }));
  app.use('/api/rooms', createRoomsRouter({ prisma, env, requireAuth }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
