import axios, { type InternalAxiosRequestConfig } from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { API_URL } from '@env';
import { AuthError } from '../utils/authErrors';
import { normalizeEmail } from '../utils/authValidation';

/** Where the signed-in rider's JWT lives. AuthContext reads and writes the same key. */
export const TOKEN_KEY = '@ridezz_jwt_token';

/** What the rest of the app knows about the signed-in rider. */
export interface RiderUser {
  id: string;
  email: string;
  name: string;
  /** True only once Google has vouched for the address (Google sign-in). */
  emailVerified?: boolean;
}

/** Which button the rider pressed. 'login' only signs in an account that already exists; 'signup'
 * creates one if needed. The server enforces the difference -- this just tells it which was meant. */
export type GoogleMode = 'login' | 'signup';

export interface AuthResult {
  token: string;
  user: RiderUser;
}

/** Adds `Authorization: Bearer <token>` to a request when a rider is signed in. Runs for every
 * call made through `api`, so no screen has to remember to. */
export async function attachToken(config: InternalAxiosRequestConfig): Promise<InternalAxiosRequestConfig> {
  if (!API_URL) {
    // A missing URL would otherwise silently send requests nowhere useful.
    throw new Error('API_URL is not set in mobile/.env');
  }
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}

/** The app's API client. `API_URL` already ends in `/api`. */
export const api = axios.create({ baseURL: API_URL, timeout: 10000 });
api.interceptors.request.use(attachToken);

export async function login(email: string, password: string): Promise<AuthResult> {
  const { data } = await api.post<AuthResult>('/auth/login', {
    email: normalizeEmail(email),
    password,
  });
  return data;
}

export async function register(name: string, email: string, password: string): Promise<AuthResult> {
  const { data } = await api.post<AuthResult>('/auth/register', {
    name: name.trim(),
    email: normalizeEmail(email),
    password,
  });
  return data;
}

let googleConfiguredFor: string | null = null;

/** Asks the server which Google client to request a token for, then configures Google Sign-In.
 * The id comes from the server (not the app's own config) so there is one place to change it. */
async function ensureGoogleConfigured(): Promise<void> {
  if (googleConfiguredFor) {
    return;
  }
  const { data } = await api.get<{ clientId: string }>('/auth/google/config');
  GoogleSignin.configure({ webClientId: data.clientId });
  googleConfiguredFor = data.clientId;
}

/** Google's own errors, reworded for a rider. Anything unrecognised is rethrown untouched. */
function translateGoogleError(err: unknown): never {
  if (isErrorWithCode(err)) {
    if (err.code === statusCodes.IN_PROGRESS) {
      throw new AuthError('Google sign-in is already in progress.');
    }
    if (err.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new AuthError('Google Play Services is missing or out of date on this phone.');
    }
    if (err.code === '10' || /DEVELOPER_ERROR/i.test(err.message ?? '')) {
      throw new AuthError(
        "Google sign-in isn't set up for this build yet. Add this app's package name and SHA-1 as an Android OAuth client in Google Cloud.",
      );
    }
  }
  throw err;
}

/**
 * Signs in with Google and exchanges the resulting ID token for this app's own token. The server
 * verifies the ID token with Google -- nothing the phone says about who it is gets trusted.
 *
 * Resolves null if the rider backed out of the Google account picker.
 */
export async function loginWithGoogle(mode: GoogleMode): Promise<AuthResult | null> {
  let idToken: string | null;
  try {
    await ensureGoogleConfigured();
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    // Forget the previously chosen account so the picker always appears.
    await GoogleSignin.signOut().catch(() => {});
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      return null;
    }
    idToken = response.data.idToken;
  } catch (err) {
    translateGoogleError(err);
  }

  if (!idToken) {
    throw new AuthError('Google did not return a sign-in token. Please try again.');
  }
  const { data } = await api.post<AuthResult>('/auth/google', { idToken, mode });
  return data;
}
