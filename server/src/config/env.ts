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

  return {
    port: Number(source.PORT) || 5000,
    jwtSecret,
    googleClientId: source.GOOGLE_CLIENT_ID?.trim() || null,
    allowedEmails: parseAllowedEmails(source.ALLOWED_EMAILS),
    livekit: {
      apiKey: source.LIVEKIT_API_KEY || 'devkey',
      apiSecret: source.LIVEKIT_API_SECRET || 'secret',
      url: source.LIVEKIT_URL || 'ws://127.0.0.1:7880',
    },
  };
}
