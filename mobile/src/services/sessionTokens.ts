import AsyncStorage from '@react-native-async-storage/async-storage';

export const TOKEN_KEY = '@ridezz_jwt_token';

export const REFRESH_TOKEN_KEY = '@ridezz_refresh_token';

export interface StoredTokens {
  token: string;
  refreshToken?: string | null;
}

export type SessionEvent = { type: 'refreshed'; token: string } | { type: 'expired' };

type Listener = (event: SessionEvent) => void;

const listeners = new Set<Listener>();

export function onSessionEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSessionEvent(event: SessionEvent): void {
  listeners.forEach(listener => listener(event));
}

export function readAccessToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export function readRefreshToken(): Promise<string | null> {
  return AsyncStorage.getItem(REFRESH_TOKEN_KEY);
}

export async function saveTokens({ token, refreshToken }: StoredTokens): Promise<void> {
  await AsyncStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) {
    await AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  } else if (refreshToken === null) {
    await AsyncStorage.removeItem(REFRESH_TOKEN_KEY);
  }
}

export async function clearTokens(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
  await AsyncStorage.removeItem(REFRESH_TOKEN_KEY);
}

export type RefreshOutcome =
  | { kind: 'refreshed'; token: string }
  | { kind: 'expired' }
  | { kind: 'unavailable' };

export function createSingleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = run().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}
