import { configProblems, loadAppConfig, resolveAppEnvironment } from '../src/config/appConfig';

const PROD = {
  FLAVOR: 'prod',
  API_URL: 'https://api.rideaze.example/api',
  MAPTILER_API_KEY: 'key',
};

describe('resolveAppEnvironment', () => {
  it.each(['dev', 'staging', 'prod'])('recognises the %s flavor', flavor => {
    expect(resolveAppEnvironment(flavor)).toBe(flavor);
  });

  it('treats an unknown or missing flavor as dev', () => {
    expect(resolveAppEnvironment('qa')).toBe('dev');
    expect(resolveAppEnvironment(undefined)).toBe('dev');
  });
});

describe('loadAppConfig', () => {
  it('reads and trims the env file values', () => {
    expect(loadAppConfig({ ...PROD, API_URL: ' https://api.rideaze.example/api ' })).toEqual({
      appEnv: 'prod',
      apiUrl: 'https://api.rideaze.example/api',
      mapTilerApiKey: 'key',
      routingUrl: 'https://router.project-osrm.org/route/v1/driving',
    });
  });

  it('uses a configured routing service', () => {
    expect(loadAppConfig({ ...PROD, ROUTING_URL: 'https://osrm.example/route' }).routingUrl).toBe(
      'https://osrm.example/route',
    );
  });

  it('allows a local http backend or a missing value in dev', () => {
    expect(loadAppConfig({ FLAVOR: 'dev', API_URL: 'http://localhost:5000/api' }).apiUrl).toBe(
      'http://localhost:5000/api',
    );
    expect(loadAppConfig({}).apiUrl).toBe('');
  });

  it.each(['staging', 'prod'])('refuses a missing or insecure backend in %s', flavor => {
    expect(() => loadAppConfig({ ...PROD, FLAVOR: flavor, API_URL: '' })).toThrow(
      'API_URL is not set.',
    );
    expect(() =>
      loadAppConfig({ ...PROD, FLAVOR: flavor, API_URL: 'http://10.0.0.5:5000/api' }),
    ).toThrow(`API_URL must use https:// in the ${flavor} environment.`);
    expect(() =>
      loadAppConfig({ ...PROD, FLAVOR: flavor, ROUTING_URL: 'http://osrm.example' }),
    ).toThrow('ROUTING_URL must use https://');
  });
});

describe('configProblems', () => {
  it('reports nothing for a valid production config', () => {
    expect(configProblems(loadAppConfig(PROD))).toEqual([]);
  });
});
