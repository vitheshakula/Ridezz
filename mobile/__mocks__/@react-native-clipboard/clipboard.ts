// Manual Jest mock for @react-native-clipboard/clipboard.
//
// The real package is a native module that doesn't exist under Jest. Tests read
// `Clipboard.setString.mock.calls` to check what a screen copied.
export default {
  setString: jest.fn(),
  getString: jest.fn(async () => ''),
  hasString: jest.fn(async () => false),
};
