export interface Env {
  port: number;
  jwtSecret: string;
  googleClientId: string | null;
  allowedEmails: ReadonlySet<string> | null;
  corsOrigins: ReadonlySet<string> | null;
  authRateLimit: { windowMs: number; max: number };
  livekit: { apiKey: string; apiSecret: string; url: string };
}

const MIN_JWT_SECRET_LENGTH = 32;
const DEFAULT_PORT = 5000;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 100;

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
    port: parsePort(source.PORT),
    jwtSecret,
    googleClientId: source.GOOGLE_CLIENT_ID?.trim() || null,
    allowedEmails: parseAllowedEmails(source.ALLOWED_EMAILS),
    corsOrigins: parseCorsOrigins(source.CORS_ORIGINS),
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
    },
    livekit: {
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
      url: livekitUrl,
    },
  };
}
