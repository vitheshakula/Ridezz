/** An error whose message is already written for the rider and safe to show as-is. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Turns whatever a sign-in attempt threw into a sentence for the rider.
 *
 * Only messages we wrote (AuthError) or the server deliberately sent are shown. Anything else --
 * a raw exception, a native error string -- falls back to `fallback`, so the screen never
 * displays internals like "Network Error" or a stack fragment.
 *
 * Detects axios errors by their marker rather than importing axios, so this stays a plain,
 * dependency-free function.
 */
export function describeAuthError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.name === 'AuthError') {
    return err.message;
  }

  const axiosLike = err as
    | { isAxiosError?: boolean; code?: string; response?: { status?: number; data?: { message?: unknown } } }
    | null
    | undefined;
  if (axiosLike?.isAxiosError) {
    const serverMessage = axiosLike.response?.data?.message;
    if (typeof serverMessage === 'string' && serverMessage) {
      return serverMessage;
    }
    if (!axiosLike.response) {
      return axiosLike.code === 'ECONNABORTED'
        ? 'The server took too long to respond. Try again.'
        : "Can't reach the server. Check your connection.";
    }
    if ((axiosLike.response.status ?? 0) >= 500) {
      return 'The server had a problem. Try again in a moment.';
    }
  }
  return fallback;
}

/** The machine-readable `code` the server attached to an error response, if any (e.g.
 * ACCOUNT_NOT_FOUND), so a screen can offer a specific next step instead of only showing text. */
export function errorCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data?.code;
  return typeof code === 'string' ? code : null;
}

/** True when a request failed because the stored token is missing, expired or no longer valid. */
export function isUnauthorized(err: unknown): boolean {
  const axiosLike = err as { isAxiosError?: boolean; response?: { status?: number } } | null | undefined;
  return axiosLike?.isAxiosError === true && axiosLike.response?.status === 401;
}
