// Manual Jest mock for @react-native-community/geolocation.
//
// The real package touches a native module (and, on import, wires up a
// NativeEventEmitter) that doesn't exist under Jest. Our code only uses the
// handful of exports below (see useRiderLocations.ts).
export default {
  setRNConfiguration: jest.fn(),
  requestAuthorization: jest.fn(),
  getCurrentPosition: jest.fn(),
  watchPosition: jest.fn(() => 1),
  clearWatch: jest.fn(),
  stopObserving: jest.fn(),
};
