import { OAuth2Client } from 'google-auth-library';
import { isTransientHttpError, withRetry } from '../integrations/retry';

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

export class GoogleUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Google sign-in is temporarily unavailable.', { cause });
    this.name = 'GoogleUnavailableError';
  }
}

export interface GoogleCertsClient {
  getFederatedSignonCertsAsync(): Promise<unknown>;
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{
    getPayload():
      | { sub?: string; email?: string; email_verified?: boolean; name?: string }
      | undefined;
  }>;
}

export interface GoogleVerifierOptions {
  timeoutMs: number;
  retryAttempts: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTIONS: GoogleVerifierOptions = { timeoutMs: 5000, retryAttempts: 3 };
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 2000;

export function createGoogleVerifier(
  clientId: string,
  options: GoogleVerifierOptions = DEFAULT_OPTIONS,
  client: GoogleCertsClient = new OAuth2Client({
    clientId,
    transporterOptions: { timeout: options.timeoutMs },
  }),
): GoogleVerifier {
  return async idToken => {
    try {
      await withRetry(() => client.getFederatedSignonCertsAsync(), {
        attempts: options.retryAttempts,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        maxDelayMs: RETRY_MAX_DELAY_MS,
        shouldRetry: isTransientHttpError,
        sleep: options.sleep,
      });
    } catch (error) {
      throw new GoogleUnavailableError(error);
    }

    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new Error('Google token is missing the account id or email');
    }
    return {
      googleId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
    };
  };
}
