// Manual Jest mock for @react-native-async-storage/async-storage.
//
// The real package ships untranspiled ES modules and needs a native module, so importing it under
// Jest fails outright. This keeps values in memory, which is all AuthContext / AuthService need.
const store = new Map<string, string>();

export default {
  getItem: jest.fn(async (key: string) => store.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    store.delete(key);
  }),
  clear: jest.fn(async () => {
    store.clear();
  }),
};
