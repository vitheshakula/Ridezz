export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export function describeAuthError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.name === 'AuthError') {
    return err.message;
  }

  const axiosLike = err as
    | {
        isAxiosError?: boolean;
        code?: string;
        response?: { status?: number; data?: { message?: unknown } };
      }
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

export function errorCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  return typeof code === 'string' ? code : null;
}

export function isUnauthorized(err: unknown): boolean {
  const axiosLike = err as
    | { isAxiosError?: boolean; response?: { status?: number } }
    | null
    | undefined;
  return axiosLike?.isAxiosError === true && axiosLike.response?.status === 401;
}
