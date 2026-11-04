import Config from 'react-native-config';

export type AppEnvironment = 'dev' | 'staging' | 'prod';

const ENVIRONMENTS: readonly AppEnvironment[] = ['dev', 'staging', 'prod'];

export function resolveAppEnvironment(flavor: string | undefined): AppEnvironment {
  return ENVIRONMENTS.find(env => env === flavor) ?? 'dev';
}

function read(name: string): string {
  return Config[name]?.trim() ?? '';
}

export const APP_ENV: AppEnvironment = resolveAppEnvironment(read('FLAVOR'));

export const API_URL = read('API_URL');

export const MAPTILER_API_KEY = read('MAPTILER_API_KEY');
