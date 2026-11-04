import axios, { type InternalAxiosRequestConfig } from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { API_URL, APP_ENV } from '../config/appConfig';
import { AuthError } from '../utils/authErrors';
import { normalizeEmail } from '../utils/authValidation';

export const TOKEN_KEY = '@ridezz_jwt_token';

export interface RiderUser {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  roomCode?: string | null;
}

export type GoogleMode = 'login' | 'signup';

export interface AuthResult {
  token: string;
  user: RiderUser;
}

export async function attachToken(
  config: InternalAxiosRequestConfig,
): Promise<InternalAxiosRequestConfig> {
  if (!API_URL) {
    throw new Error(`API_URL is not set in mobile/.env.${APP_ENV}`);
  }
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}

export const api = axios.create({ baseURL: API_URL, timeout: 10000 });
api.interceptors.request.use(attachToken);

export async function login(email: string, password: string): Promise<AuthResult> {
  const { data } = await api.post<AuthResult>('/auth/login', {
    email: normalizeEmail(email),
    password,
  });
  return data;
}

export async function fetchProfile(): Promise<RiderUser> {
  const { data } = await api.get<{ user: RiderUser }>('/user/profile');
  return data.user;
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

async function ensureGoogleConfigured(): Promise<void> {
  if (googleConfiguredFor) {
    return;
  }
  const { data } = await api.get<{ clientId: string }>('/auth/google/config');
  GoogleSignin.configure({ webClientId: data.clientId });
  googleConfiguredFor = data.clientId;
}

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

export async function loginWithGoogle(mode: GoogleMode): Promise<AuthResult | null> {
  let idToken: string | null;
  try {
    await ensureGoogleConfigured();
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
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
