import dotenv from 'dotenv';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { createGoogleVerifier } from './auth/google';
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

const prisma = new PrismaClient();
const app = createApp({
  prisma,
  env,
  verifyGoogleIdToken: env.googleClientId ? createGoogleVerifier(env.googleClientId) : undefined,
});

const server: Server = app.listen(env.port, '0.0.0.0', () => {
  logger().info('server_started', {
    port: env.port,
    googleSignIn: env.googleClientId ? 'enabled' : 'disabled',
    access: env.allowedEmails ? 'allow_list' : 'open',
    allowedEmailCount: env.allowedEmails?.size ?? null,
  });
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
    const closed = new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    server.closeIdleConnections();
    await closed;
    await prisma.$disconnect();
    logger().info('server_stopped', { reason });
  } catch (error) {
    logger().error('server_shutdown_failed', safeErrorDetails(error));
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('unhandledRejection', reason => {
  logger().error('unhandled_rejection', safeErrorDetails(reason));
});
process.on('uncaughtException', error => {
  logger().fatal('uncaught_exception', safeErrorDetails(error));
  void shutdown('uncaught_exception', 1);
});
