import { API_URL } from '@env';

/**
 * AuthService talks to axios, AsyncStorage and the native Google Sign-In module, none of which run
 * under jest, so all three are replaced. Modules are re-loaded per test because the service keeps
 * one bit of state (whether Google has been configured yet).
 */
function load() {
  jest.resetModules();

  jest.doMock('axios', () => {
    const instance = { get: jest.fn(), post: jest.fn(), interceptors: { request: { use: jest.fn() } } };
    return { __esModule: true, default: { create: jest.fn(() => instance) }, __instance: instance };
  });
  jest.doMock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
  }));
  jest.doMock('@react-native-google-signin/google-signin', () => ({
    GoogleSignin: {
      configure: jest.fn(),
      hasPlayServices: jest.fn().mockResolvedValue(true),
      signOut: jest.fn().mockResolvedValue(null),
      signIn: jest.fn(),
    },
    isErrorWithCode: (e: any) => typeof e === 'object' && e !== null && 'code' in e,
    isSuccessResponse: (r: any) => r?.type === 'success',
    statusCodes: {
      IN_PROGRESS: 'IN_PROGRESS',
      PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
      SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
    },
  }));

  return {
    service: require('../src/services/AuthService') as typeof import('../src/services/AuthService'),
    api: require('axios').__instance,
    storage: require('@react-native-async-storage/async-storage').default,
    google: require('@react-native-google-signin/google-signin').GoogleSignin,
    errors: require('../src/utils/authErrors') as typeof import('../src/utils/authErrors'),
  };
}

const session = { token: 'app-jwt', user: { id: 'u1', email: 'a@gmail.com', name: 'Alex' } };
const googleSuccess = (idToken: string | null) => ({ type: 'success', data: { idToken } });

// attachToken refuses to run without an API_URL (by design), which the .env supplies locally.
const withApiUrl = API_URL ? it : it.skip;

describe('the API client', () => {
  it('sends its requests through the token interceptor', () => {
    const { service, api } = load();
    expect(api.interceptors.request.use).toHaveBeenCalledWith(service.attachToken);
  });

  withApiUrl('attaches Authorization: Bearer <token> when a rider is signed in', async () => {
    const { service, storage } = load();
    storage.getItem.mockResolvedValue('the-jwt');

    const config = await service.attachToken({ headers: {} } as any);

    expect(storage.getItem).toHaveBeenCalledWith(service.TOKEN_KEY);
    expect(config.headers.Authorization).toBe('Bearer the-jwt');
  });

  withApiUrl('sends no Authorization header when nobody is signed in', async () => {
    const { service, storage } = load();
    storage.getItem.mockResolvedValue(null);

    const config = await service.attachToken({ headers: {} } as any);

    expect(config.headers.Authorization).toBeUndefined();
  });
});

describe('login and register', () => {
  it('login sends a normalized email and returns the server session', async () => {
    const { service, api } = load();
    api.post.mockResolvedValue({ data: session });

    await expect(service.login('  ALEX@Gmail.com ', 'secret123')).resolves.toEqual(session);
    expect(api.post).toHaveBeenCalledWith('/auth/login', { email: 'alex@gmail.com', password: 'secret123' });
  });

  it('register sends a trimmed name and normalized email and returns the server session', async () => {
    const { service, api } = load();
    api.post.mockResolvedValue({ data: session });

    await expect(service.register('  Alex ', ' ALEX@gmail.com', 'secret123')).resolves.toEqual(session);
    expect(api.post).toHaveBeenCalledWith('/auth/register', {
      name: 'Alex',
      email: 'alex@gmail.com',
      password: 'secret123',
    });
  });

  it('lets a server failure through untouched, so the screen can show its message', async () => {
    const { service, api } = load();
    const failure = Object.assign(new Error('x'), { isAxiosError: true, response: { status: 401 } });
    api.post.mockRejectedValue(failure);

    await expect(service.login('a@gmail.com', 'nope')).rejects.toBe(failure);
  });
});

describe('loginWithGoogle', () => {
  function readyForGoogle(ctx: ReturnType<typeof load>, idToken: string | null = 'google-id-token') {
    ctx.api.get.mockResolvedValue({ data: { clientId: 'web-client-id' } });
    ctx.google.signIn.mockResolvedValue(googleSuccess(idToken));
    ctx.api.post.mockResolvedValue({ data: session });
  }

  it('runs the whole exchange in order and returns the app session', async () => {
    const ctx = load();
    readyForGoogle(ctx);

    await expect(ctx.service.loginWithGoogle('login')).resolves.toEqual(session);

    expect(ctx.api.get).toHaveBeenCalledWith('/auth/google/config');
    expect(ctx.google.configure).toHaveBeenCalledWith({ webClientId: 'web-client-id' });
    expect(ctx.google.hasPlayServices).toHaveBeenCalledWith({ showPlayServicesUpdateDialog: true });
    expect(ctx.google.signOut).toHaveBeenCalled();
    // Only the ID token goes to our server -- the server verifies it with Google.
    expect(ctx.api.post).toHaveBeenCalledWith('/auth/google', { idToken: 'google-id-token', mode: 'login' });

    const order = [
      ctx.google.configure.mock.invocationCallOrder[0],
      ctx.google.hasPlayServices.mock.invocationCallOrder[0],
      ctx.google.signOut.mock.invocationCallOrder[0],
      ctx.google.signIn.mock.invocationCallOrder[0],
      ctx.api.post.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('tells the server whether the rider pressed the sign-in or the sign-up button', async () => {
    const ctx = load();
    readyForGoogle(ctx);

    await ctx.service.loginWithGoogle('signup');
    expect(ctx.api.post).toHaveBeenLastCalledWith('/auth/google', { idToken: 'google-id-token', mode: 'signup' });

    await ctx.service.loginWithGoogle('login');
    expect(ctx.api.post).toHaveBeenLastCalledWith('/auth/google', { idToken: 'google-id-token', mode: 'login' });
  });

  it('configures Google once, however many times the rider signs in', async () => {
    const ctx = load();
    readyForGoogle(ctx);

    await ctx.service.loginWithGoogle('login');
    await ctx.service.loginWithGoogle('login');

    expect(ctx.api.get).toHaveBeenCalledTimes(1);
    expect(ctx.google.configure).toHaveBeenCalledTimes(1);
    expect(ctx.google.signIn).toHaveBeenCalledTimes(2);
  });

  it('resolves null and contacts nobody when the rider backs out of the account picker', async () => {
    const ctx = load();
    readyForGoogle(ctx);
    ctx.google.signIn.mockResolvedValue({ type: 'cancelled', data: null });

    await expect(ctx.service.loginWithGoogle('login')).resolves.toBeNull();
    expect(ctx.api.post).not.toHaveBeenCalled();
  });

  it('still signs in if clearing the previous Google account fails', async () => {
    const ctx = load();
    readyForGoogle(ctx);
    ctx.google.signOut.mockRejectedValue(new Error('not signed in'));

    await expect(ctx.service.loginWithGoogle('login')).resolves.toEqual(session);
  });

  it('fails clearly, without calling the server, if Google returns no ID token', async () => {
    const ctx = load();
    readyForGoogle(ctx, null);

    await expect(ctx.service.loginWithGoogle('login')).rejects.toMatchObject({ name: 'AuthError' });
    expect(ctx.api.post).not.toHaveBeenCalled();
  });

  describe('translating Google errors for the rider', () => {
    async function failureMessage(ctx: ReturnType<typeof load>, error: unknown) {
      readyForGoogle(ctx);
      ctx.google.signIn.mockRejectedValue(error);
      const thrown = await ctx.service.loginWithGoogle('login').catch((e: unknown) => e);
      return { thrown, message: ctx.errors.describeAuthError(thrown, 'FALLBACK') };
    }

    it('sign-in already in progress', async () => {
      const { message } = await failureMessage(load(), { code: 'IN_PROGRESS', message: 'x' });
      expect(message).toBe('Google sign-in is already in progress.');
    });

    it('Play Services missing or out of date', async () => {
      const { message } = await failureMessage(load(), { code: 'PLAY_SERVICES_NOT_AVAILABLE', message: 'x' });
      expect(message).toMatch(/Google Play Services/);
    });

    it('a build Google does not recognise (DEVELOPER_ERROR, code 10) points at the OAuth setup', async () => {
      const byCode = await failureMessage(load(), { code: '10', message: 'x' });
      const byText = await failureMessage(load(), { code: 'SOMETHING', message: 'DEVELOPER_ERROR: 10' });
      expect(byCode.message).toMatch(/SHA-1/);
      expect(byText.message).toMatch(/SHA-1/);
    });

    it('anything unrecognised becomes the generic fallback, never raw native text', async () => {
      const { message } = await failureMessage(load(), { code: 'WEIRD_NATIVE_THING', message: 'com.google.android...Exception' });
      expect(message).toBe('FALLBACK');
    });
  });

  it('passes a server-side failure through so its message can be shown', async () => {
    const ctx = load();
    readyForGoogle(ctx);
    const failure = Object.assign(new Error('x'), {
      isAxiosError: true,
      response: { status: 403, data: { message: 'Only Gmail accounts are supported.' } },
    });
    ctx.api.post.mockRejectedValue(failure);

    const thrown = await ctx.service.loginWithGoogle('login').catch((e: unknown) => e);
    expect(thrown).toBe(failure);
    expect(ctx.errors.describeAuthError(thrown, 'FALLBACK')).toBe('Only Gmail accounts are supported.');
  });

  it('reports a server that has Google sign-in switched off', async () => {
    const ctx = load();
    const failure = Object.assign(new Error('x'), {
      isAxiosError: true,
      response: { status: 503, data: { message: 'Google sign-in is not configured on the server.' } },
    });
    ctx.api.get.mockRejectedValue(failure);

    const thrown = await ctx.service.loginWithGoogle('login').catch((e: unknown) => e);
    expect(ctx.errors.describeAuthError(thrown, 'FALLBACK')).toBe('Google sign-in is not configured on the server.');
    expect(ctx.google.signIn).not.toHaveBeenCalled();
  });
});
