// Manual Jest mock for react-native-bootsplash.
//
// The real package is a TurboModule that doesn't exist under Jest, so importing it fails outright.
// App.tsx only calls hide(); the rest is stubbed out for completeness.
export default {
  hide: jest.fn(async () => {}),
  isVisible: jest.fn(() => false),
  useHideAnimation: jest.fn(() => ({ container: {}, logo: {}, brand: {} })),
};
