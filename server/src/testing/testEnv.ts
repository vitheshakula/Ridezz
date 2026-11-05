import type { Env } from '../config/env';

export const TEST_ENV: Env = {
  appEnv: 'test',
  port: 5000,
  logLevel: 'info',
  shutdownTimeoutMs: 10_000,
  jwtSecret: 'test-secret'.padEnd(40, 'x'),
  googleClientId: null,
  allowedEmails: null,
  corsOrigins: null,
  redisUrl: null,
  sentry: null,
  authRateLimit: { windowMs: 15 * 60 * 1000, max: 100, perAccountMax: 1000, perRiderJoinMax: 1000 },
  sessions: { accessTokenTtlSeconds: 900, refreshTokenTtlSeconds: 30 * 24 * 60 * 60 },
  livekit: { apiKey: 'test-key', apiSecret: 'test-secret', url: 'wss://livekit.test' },
};

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...TEST_ENV, ...overrides };
}
