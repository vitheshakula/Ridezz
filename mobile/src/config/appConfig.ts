import Config from 'react-native-config';

/**
 * The one place the app reads its environment. Values come from `mobile/.env.<flavor>`, baked into
 * the native build by react-native-config (see android/app/build.gradle), so changing them means
 * rebuilding the app -- restarting Metro is not enough.
 */

export type AppEnvironment = 'dev' | 'staging' | 'prod';

const ENVIRONMENTS: readonly AppEnvironment[] = ['dev', 'staging', 'prod'];

/** The Android product flavor this build was made from. Gradle's BuildConfig.FLAVOR, which
 * react-native-config exposes alongside the env file's keys. Anything unexpected (an iOS build
 * without flavors, or no native config at all) counts as dev, the least trusted environment. */
export function resolveAppEnvironment(flavor: string | undefined): AppEnvironment {
  return ENVIRONMENTS.find(env => env === flavor) ?? 'dev';
}

function read(name: string): string {
  return Config[name]?.trim() ?? '';
}

export const APP_ENV: AppEnvironment = resolveAppEnvironment(read('FLAVOR'));

/** Backend base URL, already ending in `/api`. */
export const API_URL = read('API_URL');

/** MapTiler key for map tiles and destination search. Empty disables both. */
export const MAPTILER_API_KEY = read('MAPTILER_API_KEY');
