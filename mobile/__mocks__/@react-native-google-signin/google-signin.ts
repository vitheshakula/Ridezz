// Manual Jest mock for @react-native-google-signin/google-signin.
//
// The real package talks to the Google Sign-In SDK through a native module that doesn't exist under
// Jest. Only the pieces AuthService uses are provided; tests that care about the sign-in flow
// (authService.test.ts) install their own, more specific mock.
export const GoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(async () => true),
  signIn: jest.fn(async () => ({ type: 'cancelled', data: null })),
  signOut: jest.fn(async () => null),
};

export const statusCodes = {
  SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
  IN_PROGRESS: 'IN_PROGRESS',
  PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
  SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
};

export const isErrorWithCode = (error: unknown): error is { code: string; message?: string } =>
  typeof error === 'object' && error !== null && 'code' in error;

export const isSuccessResponse = (response: { type?: string } | null | undefined): boolean =>
  response?.type === 'success';
