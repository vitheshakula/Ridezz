export interface Env {
  port: number;
  /** Signs and verifies login tokens. Required -- there is deliberately no default. */
  jwtSecret: string;
  /** OAuth "Web application" client id. Null disables Google sign-in. */
  googleClientId: string | null;
  /**
   * Lowercased addresses allowed to register or sign in, or null for "anyone with a Gmail
   * account". This is the only real gate: Google's "test users" list is enforced by Google (and
   * not always, for plain sign-in), and this server never sees it.
   */
  allowedEmails: ReadonlySet<string> | null;
  livekit: { apiKey: string; apiSecret: string; url: string };
}

const MIN_JWT_SECRET_LENGTH = 32;
const DEFAULT_PORT = 5000;

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
    if ((parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') || !parsed.hostname) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL using postgresql:// or postgres://.');
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

/** "a@gmail.com, B@gmail.com" (commas, semicolons, spaces or newlines) -> a set, or null if empty. */
export function parseAllowedEmails(raw: string | undefined): ReadonlySet<string> | null {
  const emails = (raw ?? '')
    .split(/[\s,;]+/)
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
  return emails.length > 0 ? new Set(emails) : null;
}

/**
 * Reads and validates configuration, failing at startup rather than limping along with a
 * guessable default -- a JWT secret that anyone can find in the source lets them mint a valid
 * login for any account.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const jwtSecret = source.JWT_SECRET?.trim();
  if (!jwtSecret) {
    throw new Error(
      'JWT_SECRET is not set. Add it to server/.env, e.g. generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
    );
  }
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET is too short (${jwtSecret.length} chars); use at least ${MIN_JWT_SECRET_LENGTH}.`);
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
    livekit: {
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
      url: livekitUrl,
    },
  };
}
