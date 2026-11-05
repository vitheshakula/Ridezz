import { isLogLevel, type LogLevel } from '../logger';

export type AppEnv = 'development' | 'test' | 'staging' | 'production';

export interface Env {
  appEnv: AppEnv;
  port: number;
  logLevel: LogLevel;
  shutdownTimeoutMs: number;
  jwtSecret: string;
  googleClientId: string | null;
  allowedEmails: ReadonlySet<string> | null;
  corsOrigins: ReadonlySet<string> | null;
  redisUrl: string | null;
  sentry: { dsn: string; release: string | null } | null;
  authRateLimit: { windowMs: number; max: number; perAccountMax: number; perRiderJoinMax: number };
  sessions: { accessTokenTtlSeconds: number; refreshTokenTtlSeconds: number };
  livekit: { apiKey: string; apiSecret: string; url: string };
}

const MIN_JWT_SECRET_LENGTH = 32;
const DEFAULT_PORT = 5000;
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 100;
const DEFAULT_AUTH_ACCOUNT_RATE_LIMIT_MAX = 10;
const DEFAULT_ROOM_JOIN_RIDER_RATE_LIMIT_MAX = 30;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30;
const SECONDS_PER_DAY = 24 * 60 * 60;
const APP_ENVS: readonly AppEnv[] = ['development', 'test', 'staging', 'production'];

function requireNonBlank(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

function validateDatabaseUrl(source: NodeJS.ProcessEnv): void {
  const databaseUrl = requireNonBlank(source, 'DATABASE_URL');

  try {
    if (!databaseUrl.startsWith('postgresql://') && !databaseUrl.startsWith('postgres://')) {
      throw new Error('unsupported protocol');
    }
    const parsed = new URL(databaseUrl);
    if (
      (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') ||
      !parsed.hostname
    ) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(
      'DATABASE_URL must be a valid PostgreSQL URL using postgresql:// or postgres://.',
    );
  }
}

function parsePort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function validateLiveKitUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('LIVEKIT_URL must be a valid WebSocket URL using ws:// or wss://.');
  }
  return raw;
}

function parseAppEnv(raw: string | undefined): AppEnv {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return 'development';
  }
  const appEnv = APP_ENVS.find(candidate => candidate === value);
  if (!appEnv) {
    throw new Error('APP_ENV must be one of development, test, staging or production.');
  }
  return appEnv;
}

function parseRedisUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== 'redis:' && url.protocol !== 'rediss:') || !url.hostname) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('REDIS_URL must be a redis:// or rediss:// URL.');
  }
  return value;
}

function parseSentry(source: NodeJS.ProcessEnv): Env['sentry'] {
  const dsn = source.SENTRY_DSN?.trim();
  if (!dsn) {
    return null;
  }
  try {
    const url = new URL(dsn);
    if (url.protocol !== 'https:' || !url.username) {
      throw new Error('unsupported dsn');
    }
  } catch {
    throw new Error('SENTRY_DSN must be the https:// DSN shown in the Sentry project settings.');
  }
  const release = source.SENTRY_RELEASE?.trim() || source.RENDER_GIT_COMMIT?.trim() || null;
  return { dsn, release };
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return DEFAULT_LOG_LEVEL;
  }
  if (!isLogLevel(value)) {
    throw new Error('LOG_LEVEL must be one of debug, info, warn, error or fatal.');
  }
  return value;
}

export function parseAllowedEmails(raw: string | undefined): ReadonlySet<string> | null {
  const emails = (raw ?? '')
    .split(/[\s,;]+/)
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
  return emails.length > 0 ? new Set(emails) : null;
}

export function parseCorsOrigins(raw: string | undefined): ReadonlySet<string> | null {
  const origins = (raw ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? new Set(origins) : null;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const jwtSecret = source.JWT_SECRET?.trim();
  if (!jwtSecret) {
    throw new Error(
      'JWT_SECRET is not set. Add it to server/.env, e.g. generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
    );
  }
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is too short (${jwtSecret.length} chars); use at least ${MIN_JWT_SECRET_LENGTH}.`,
    );
  }

  validateDatabaseUrl(source);

  const livekitApiKey = requireNonBlank(source, 'LIVEKIT_API_KEY');
  const livekitApiSecret = requireNonBlank(source, 'LIVEKIT_API_SECRET');
  const livekitUrl = validateLiveKitUrl(requireNonBlank(source, 'LIVEKIT_URL'));

  return {
    appEnv: parseAppEnv(source.APP_ENV),
    port: parsePort(source.PORT),
    logLevel: parseLogLevel(source.LOG_LEVEL),
    shutdownTimeoutMs: parsePositiveInteger(
      source.SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'SHUTDOWN_TIMEOUT_MS',
    ),
    jwtSecret,
    googleClientId: source.GOOGLE_CLIENT_ID?.trim() || null,
    allowedEmails: parseAllowedEmails(source.ALLOWED_EMAILS),
    corsOrigins: parseCorsOrigins(source.CORS_ORIGINS),
    redisUrl: parseRedisUrl(source.REDIS_URL),
    sentry: parseSentry(source),
    authRateLimit: {
      windowMs: parsePositiveInteger(
        source.AUTH_RATE_LIMIT_WINDOW_MS,
        DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
        'AUTH_RATE_LIMIT_WINDOW_MS',
      ),
      max: parsePositiveInteger(
        source.AUTH_RATE_LIMIT_MAX,
        DEFAULT_AUTH_RATE_LIMIT_MAX,
        'AUTH_RATE_LIMIT_MAX',
      ),
      perAccountMax: parsePositiveInteger(
        source.AUTH_ACCOUNT_RATE_LIMIT_MAX,
        DEFAULT_AUTH_ACCOUNT_RATE_LIMIT_MAX,
        'AUTH_ACCOUNT_RATE_LIMIT_MAX',
      ),
      perRiderJoinMax: parsePositiveInteger(
        source.ROOM_JOIN_RIDER_RATE_LIMIT_MAX,
        DEFAULT_ROOM_JOIN_RIDER_RATE_LIMIT_MAX,
        'ROOM_JOIN_RIDER_RATE_LIMIT_MAX',
      ),
    },
    sessions: {
      accessTokenTtlSeconds: parsePositiveInteger(
        source.ACCESS_TOKEN_TTL_SECONDS,
        DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        'ACCESS_TOKEN_TTL_SECONDS',
      ),
      refreshTokenTtlSeconds:
        parsePositiveInteger(
          source.REFRESH_TOKEN_TTL_DAYS,
          DEFAULT_REFRESH_TOKEN_TTL_DAYS,
          'REFRESH_TOKEN_TTL_DAYS',
        ) * SECONDS_PER_DAY,
    },
    livekit: {
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
      url: livekitUrl,
    },
  };
}
