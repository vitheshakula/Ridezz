function loadWith(config: Record<string, string | undefined>) {
  jest.resetModules();
  jest.doMock('react-native-config', () => ({ __esModule: true, default: config, Config: config }));
  return require('../src/config/appConfig') as typeof import('../src/config/appConfig');
}

describe('appConfig', () => {
  it.each(['dev', 'staging', 'prod'] as const)(
    'reports the %s flavor as its environment',
    flavor => {
      expect(loadWith({ FLAVOR: flavor }).APP_ENV).toBe(flavor);
    },
  );

  it('treats an unknown or missing flavor as dev', () => {
    expect(loadWith({ FLAVOR: 'qa' }).APP_ENV).toBe('dev');
    expect(loadWith({}).APP_ENV).toBe('dev');
  });

  it('exposes the env file values, trimmed', () => {
    const config = loadWith({
      API_URL: ' https://staging.example.com/api ',
      MAPTILER_API_KEY: 'key',
    });
    expect(config.API_URL).toBe('https://staging.example.com/api');
    expect(config.MAPTILER_API_KEY).toBe('key');
  });

  it('turns missing values into empty strings', () => {
    const config = loadWith({});
    expect(config.API_URL).toBe('');
    expect(config.MAPTILER_API_KEY).toBe('');
  });
});
