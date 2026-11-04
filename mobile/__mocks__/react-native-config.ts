// The real module reads BuildConfig through a native module that jest can't load. Tests get a
// fixed dev configuration instead; override per test with jest.doMock when needed.
const Config: Record<string, string | undefined> = {
  FLAVOR: 'dev',
  API_URL: 'http://localhost:5000/api',
  MAPTILER_API_KEY: '',
};

export { Config };
export default Config;
