import { AuthError, describeAuthError, errorCode, isUnauthorized } from '../src/utils/authErrors';

const FALLBACK = 'Sign in failed. Please try again.';

/** Shaped like the errors axios throws, without importing axios. */
function axiosError(response?: { status?: number; data?: unknown }, code?: string) {
  return Object.assign(new Error('Request failed'), { isAxiosError: true, response, code });
}

describe('describeAuthError', () => {
  it('shows the message the server chose to send', () => {
    expect(describeAuthError(axiosError({ status: 401, data: { message: 'Invalid credentials.' } }), FALLBACK)).toBe(
      'Invalid credentials.',
    );
    expect(describeAuthError(axiosError({ status: 409, data: { message: 'An account with this email already exists.' } }), FALLBACK)).toBe(
      'An account with this email already exists.',
    );
  });

  it('shows a message the app wrote (AuthError)', () => {
    expect(describeAuthError(new AuthError('Google Play Services is missing.'), FALLBACK)).toBe(
      'Google Play Services is missing.',
    );
  });

  it('explains a request that never reached the server', () => {
    expect(describeAuthError(axiosError(undefined), FALLBACK)).toBe("Can't reach the server. Check your connection.");
  });

  it('explains a timeout differently from an unreachable server', () => {
    expect(describeAuthError(axiosError(undefined, 'ECONNABORTED'), FALLBACK)).toBe(
      'The server took too long to respond. Try again.',
    );
  });

  it('gives a plain message for a server error with no usable body', () => {
    expect(describeAuthError(axiosError({ status: 500, data: '<html>boom</html>' }), FALLBACK)).toBe(
      'The server had a problem. Try again in a moment.',
    );
  });

  it('never shows raw internals -- unknown errors become the fallback', () => {
    expect(describeAuthError(new Error('TypeError: undefined is not an object (evaluating x.y)'), FALLBACK)).toBe(FALLBACK);
    expect(describeAuthError('some string', FALLBACK)).toBe(FALLBACK);
    expect(describeAuthError(null, FALLBACK)).toBe(FALLBACK);
    expect(describeAuthError(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('ignores a non-string message in the response body', () => {
    expect(describeAuthError(axiosError({ status: 400, data: { message: { nested: true } } }), FALLBACK)).toBe(FALLBACK);
  });
});

describe('isUnauthorized', () => {
  it('is true only for a 401 from the server', () => {
    expect(isUnauthorized(axiosError({ status: 401 }))).toBe(true);
    expect(isUnauthorized(axiosError({ status: 403 }))).toBe(false);
    expect(isUnauthorized(axiosError({ status: 500 }))).toBe(false);
    expect(isUnauthorized(axiosError(undefined))).toBe(false);
    expect(isUnauthorized(new Error('401'))).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });
});

describe('errorCode', () => {
  it('reads the machine-readable code the server sent', () => {
    expect(errorCode(axiosError({ status: 404, data: { message: 'x', code: 'ACCOUNT_NOT_FOUND' } }))).toBe('ACCOUNT_NOT_FOUND');
  });

  it('is null when there is no code, or it is not a string', () => {
    expect(errorCode(axiosError({ status: 404, data: { message: 'x' } }))).toBeNull();
    expect(errorCode(axiosError({ status: 404, data: { code: 42 } }))).toBeNull();
    expect(errorCode(axiosError(undefined))).toBeNull();
    expect(errorCode(new Error('boom'))).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});
