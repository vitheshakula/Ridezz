import cors, { type CorsOptions } from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { PrismaClient } from '@prisma/client';
import type { GoogleVerifier } from './auth/google';
import { configurePassport, createRequireAuth } from './config/passport';
import type { Env } from './config/env';
import { ErrorCode, sendError } from './errors';
import { errorHandler, notFoundHandler, requestIdMiddleware, requestLogger } from './http';
import { openApiDocument } from './openapi';
import { createAuthRouter } from './routes/auth';
import { createHealthRouter } from './routes/health';
import { createRoomsRouter } from './routes/rooms';
import { createUserRouter } from './routes/user';

export interface AppDeps {
  prisma: PrismaClient;
  env: Env;
  verifyGoogleIdToken?: GoogleVerifier;
}

export const API_PREFIXES = ['/api/v1', '/api'] as const;

const JSON_BODY_LIMIT = '32kb';

const AUTH_POST_PATHS = ['/auth/login', '/auth/register', '/auth/signup', '/auth/google'];

const ROOM_JOIN_POST_PATHS = ['/rooms/join'];

const withApiPrefixes = (paths: string[]) =>
  API_PREFIXES.flatMap(prefix => paths.map(path => prefix + path));

function createSensitiveRateLimiter(env: Env): RequestHandler {
  return rateLimit({
    windowMs: env.authRateLimit.windowMs,
    limit: env.authRateLimit.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(res, 429, ErrorCode.RateLimited, 'Too many requests. Please try again later.'),
  });
}

export function corsOptions(env: Env): CorsOptions {
  if (env.corsOrigins) {
    const allowed = env.corsOrigins;
    return { origin: (origin, callback) => callback(null, !origin || allowed.has(origin)) };
  }
  return { origin: env.appEnv === 'development' || env.appEnv === 'test' ? '*' : false };
}

export function createApp({ prisma, env, verifyGoogleIdToken }: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1);
  const passport = configurePassport(prisma, env.jwtSecret, env.allowedEmails);
  const requireAuth = createRequireAuth(passport);

  app.use(requestIdMiddleware);
  app.use(requestLogger);
  app.use(helmet());
  app.use('/health', createHealthRouter({ prisma }));
  app.use(cors(corsOptions(env)));
  app.post(withApiPrefixes(AUTH_POST_PATHS), createSensitiveRateLimiter(env));
  app.post(withApiPrefixes(ROOM_JOIN_POST_PATHS), createSensitiveRateLimiter(env));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(passport.initialize());

  const authRouter = createAuthRouter({ prisma, env, requireAuth, verifyGoogleIdToken });
  const userRouter = createUserRouter({ prisma, requireAuth });
  const roomsRouter = createRoomsRouter({ prisma, env, requireAuth });
  for (const prefix of API_PREFIXES) {
    app.get(`${prefix}/openapi.json`, (_req, res) => res.json(openApiDocument));
    app.use(`${prefix}/auth`, authRouter);
    app.use(`${prefix}/user`, userRouter);
    app.use(`${prefix}/rooms`, roomsRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
