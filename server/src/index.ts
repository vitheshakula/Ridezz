import dotenv from 'dotenv';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { createGoogleVerifier } from './auth/google';
import { createSentryTracker, errorTracker, setErrorTracker } from './integrations/errorTracker';
import { connectRedis, type RedisConnection } from './integrations/rateLimitStore';
import { loadEnv } from './config/env';
import { safeErrorDetails } from './http';
import { createLogger, logger, setLogger } from './logger';

dotenv.config();

function startupFailure(error: unknown): never {
  logger().fatal('server_config_invalid', safeErrorDetails(error));
  process.exit(1);
}

let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (error) {
  startupFailure(error);
}
setLogger(createLogger(env.logLevel));
if (env.sentry) {
  setErrorTracker(
    createSentryTracker({
      dsn: env.sentry.dsn,
      release: env.sentry.release,
      environment: env.appEnv,
    }),
  );
}

const ERROR_FLUSH_TIMEOUT_MS = 2000;

const prisma = new PrismaClient();
let redis: RedisConnection | null = null;
let server: Server | undefined;

async function start(): Promise<void> {
  if (env.redisUrl) {
    redis = await connectRedis(env.redisUrl);
  }
  const app = createApp({
    prisma,
    env,
    verifyGoogleIdToken: env.googleClientId ? createGoogleVerifier(env.googleClientId) : undefined,
    rateLimitStores: redis?.storeFactory,
    checkCache: redis ? () => redis!.ping() : undefined,
  });
  const listening = app.listen(env.port, '0.0.0.0', () => {
    logger().info('server_started', {
      port: env.port,
      rateLimitStore: redis ? 'redis' : 'memory',
      googleSignIn: env.googleClientId ? 'enabled' : 'disabled',
      access: env.allowedEmails ? 'allow_list' : 'open',
      allowedEmailCount: env.allowedEmails?.size ?? null,
    });
  });
  server = listening;
}

start().catch(async error => {
  logger().fatal('server_start_failed', safeErrorDetails(error));
  errorTracker().capture(error, { event: 'server_start_failed' });
  await errorTracker().flush(ERROR_FLUSH_TIMEOUT_MS);
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger().info('server_stopping', { reason });

  const forceExit = setTimeout(() => {
    logger().error('server_shutdown_timeout', { timeoutMs: env.shutdownTimeoutMs });
    process.exit(1);
  }, env.shutdownTimeoutMs);
  forceExit.unref();

  try {
    const running = server;
    const closed = new Promise<void>((resolve, reject) =>
      running ? running.close(error => (error ? reject(error) : resolve())) : resolve(),
    );
    running?.closeIdleConnections();
    await closed;
    await prisma.$disconnect();
    await redis?.close();
    logger().info('server_stopped', { reason });
  } catch (error) {
    logger().error('server_shutdown_failed', safeErrorDetails(error));
    errorTracker().capture(error, { event: 'server_shutdown_failed' });
    exitCode = 1;
  }
  await errorTracker().flush(ERROR_FLUSH_TIMEOUT_MS);
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('unhandledRejection', reason => {
  logger().error('unhandled_rejection', safeErrorDetails(reason));
  errorTracker().capture(reason, { event: 'unhandled_rejection' });
});
process.on('uncaughtException', error => {
  logger().fatal('uncaught_exception', safeErrorDetails(error));
  errorTracker().capture(error, { event: 'uncaught_exception' });
  void shutdown('uncaught_exception', 1);
});
