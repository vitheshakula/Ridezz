import cors, { type CorsOptions } from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { PrismaClient } from '@prisma/client';
import type { GoogleVerifier } from './auth/google';
import { normalizeEmail } from './auth/validation';
import { configurePassport, createRequireAuth } from './config/passport';
import type { Env } from './config/env';
import { errorHandler, notFoundHandler, requestIdMiddleware, requestLogger } from './http';
import { memoryRateLimitStores, type RateLimitStoreFactory } from './integrations/rateLimitStore';
import { openApiDocument } from './openapi';
import { createRateLimiter } from './rateLimit';
import { createAuthRouter } from './routes/auth';
import { createHealthRouter } from './routes/health';
import { createRoomsRouter } from './routes/rooms';
import { createUserRouter } from './routes/user';

export interface AppDeps {
  prisma: PrismaClient;
  env: Env;
  verifyGoogleIdToken?: GoogleVerifier;
  rateLimitStores?: RateLimitStoreFactory;
  checkCache?: () => Promise<unknown>;
}

export const API_PREFIXES = ['/api/v1', '/api'] as const;

const JSON_BODY_LIMIT = '32kb';

const AUTH_POST_PATHS = [
  '/auth/login',
  '/auth/register',
  '/auth/signup',
  '/auth/google',
  '/auth/refresh',
];

export const LEGACY_ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const ROOM_JOIN_POST_PATHS = ['/rooms/join'];

const withApiPrefixes = (paths: string[]) =>
  API_PREFIXES.flatMap(prefix => paths.map(path => prefix + path));

function createSensitiveRateLimiter(
  env: Env,
  stores: RateLimitStoreFactory,
  name: string,
): RequestHandler {
  return createRateLimiter({
    windowMs: env.authRateLimit.windowMs,
    limit: env.authRateLimit.max,
    store: stores(name),
    message: 'Too many requests. Please try again later.',
  });
}

function createAccountLoginLimiter(env: Env, stores: RateLimitStoreFactory): RequestHandler {
  return createRateLimiter({
    windowMs: env.authRateLimit.windowMs,
    limit: env.authRateLimit.perAccountMax,
    store: stores('login-account'),
    skip: req => typeof req.body?.email !== 'string',
    keyGenerator: req => normalizeEmail(req.body.email),
    message: 'Too many sign-in attempts for this account. Please try again later.',
  });
}

function createRiderJoinLimiter(env: Env, stores: RateLimitStoreFactory): RequestHandler {
  return createRateLimiter({
    windowMs: env.authRateLimit.windowMs,
    limit: env.authRateLimit.perRiderJoinMax,
    store: stores('join-rider'),
    keyGenerator: req => req.user!.id,
    message: 'Too many attempts to join rides. Please try again later.',
  });
}

export function corsOptions(env: Env): CorsOptions {
  if (env.corsOrigins) {
    const allowed = env.corsOrigins;
    return { origin: (origin, callback) => callback(null, !origin || allowed.has(origin)) };
  }
  return { origin: env.appEnv === 'development' || env.appEnv === 'test' ? '*' : false };
}

export function createApp({
  prisma,
  env,
  verifyGoogleIdToken,
  rateLimitStores = memoryRateLimitStores,
  checkCache,
}: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1);
  const passport = configurePassport(prisma, env.jwtSecret, env.allowedEmails);
  const requireAuth = createRequireAuth(passport);

  app.use(requestIdMiddleware);
  app.use(requestLogger);
  app.use(helmet());
  app.use('/health', createHealthRouter({ prisma, checkCache }));
  app.use(cors(corsOptions(env)));
  app.post(
    withApiPrefixes(AUTH_POST_PATHS),
    createSensitiveRateLimiter(env, rateLimitStores, 'auth-ip'),
  );
  app.post(
    withApiPrefixes(ROOM_JOIN_POST_PATHS),
    createSensitiveRateLimiter(env, rateLimitStores, 'join-ip'),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(passport.initialize());

  const userRouter = createUserRouter({ prisma, requireAuth });
  const loginLimiter = createAccountLoginLimiter(env, rateLimitStores);
  const roomsRouter = createRoomsRouter({
    prisma,
    env,
    requireAuth,
    joinLimiter: createRiderJoinLimiter(env, rateLimitStores),
  });
  for (const prefix of API_PREFIXES) {
    app.get(`${prefix}/openapi.json`, (_req, res) => res.json(openApiDocument));
    app.use(
      `${prefix}/auth`,
      createAuthRouter({
        prisma,
        env,
        requireAuth,
        verifyGoogleIdToken,
        loginLimiter,
        accessTokenTtlSeconds:
          prefix === '/api' ? LEGACY_ACCESS_TOKEN_TTL_SECONDS : env.sessions.accessTokenTtlSeconds,
      }),
    );
    app.use(`${prefix}/user`, userRouter);
    app.use(`${prefix}/rooms`, roomsRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
