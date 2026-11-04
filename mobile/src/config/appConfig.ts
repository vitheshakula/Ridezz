import Config from 'react-native-config';

export type AppEnvironment = 'dev' | 'staging' | 'prod';

const ENVIRONMENTS: readonly AppEnvironment[] = ['dev', 'staging', 'prod'];

const DEFAULT_ROUTING_URL = 'https://router.project-osrm.org/route/v1/driving';

export interface AppConfig {
  appEnv: AppEnvironment;
  apiUrl: string;
  mapTilerApiKey: string;
  routingUrl: string;
}

export function resolveAppEnvironment(flavor: string | undefined): AppEnvironment {
  return ENVIRONMENTS.find(env => env === flavor) ?? 'dev';
}

function isHttpsUrl(value: string): boolean {
  return /^https:\/\/[^\s/]+/i.test(value);
}

export function configProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (!config.apiUrl) {
    problems.push('API_URL is not set.');
  } else if (config.appEnv !== 'dev' && !isHttpsUrl(config.apiUrl)) {
    problems.push(`API_URL must use https:// in the ${config.appEnv} environment.`);
  }
  if (config.appEnv !== 'dev' && !isHttpsUrl(config.routingUrl)) {
    problems.push(`ROUTING_URL must use https:// in the ${config.appEnv} environment.`);
  }
  return problems;
}

export function loadAppConfig(source: Record<string, string | undefined>): AppConfig {
  const read = (name: string): string => source[name]?.trim() ?? '';
  const config: AppConfig = {
    appEnv: resolveAppEnvironment(read('FLAVOR')),
    apiUrl: read('API_URL'),
    mapTilerApiKey: read('MAPTILER_API_KEY'),
    routingUrl: read('ROUTING_URL') || DEFAULT_ROUTING_URL,
  };
  const problems = configProblems(config);
  if (config.appEnv !== 'dev' && problems.length > 0) {
    throw new Error(`Invalid ${config.appEnv} configuration: ${problems.join(' ')}`);
  }
  return config;
}

const appConfig = loadAppConfig(Config);

export const APP_ENV = appConfig.appEnv;

export const API_URL = appConfig.apiUrl;

export const MAPTILER_API_KEY = appConfig.mapTilerApiKey;

export const ROUTING_URL = appConfig.routingUrl;
