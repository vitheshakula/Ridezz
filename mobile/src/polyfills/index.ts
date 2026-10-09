/**
 * Startup compatibility polyfills for Hermes/React Native.
 *
 * These must all execute before any LiveKit or livekit-client module is
 * evaluated anywhere in the app (not just before LiveKit APIs are called —
 * see each file for why). Import this module first, before anything else,
 * in index.js. Side-effect imports within one file run in the order
 * written, so this file is the single place that guarantees the order
 * between individual polyfills as more are added.
 */
import './domException';
import './textEncoding';
// Secure crypto.getRandomValues (Hermes has none): a TurboModule backed by SecureRandom on Android
// and SecRandomCopyBytes on iOS. Ride Connectivity Protocol message ids depend on it. It adds only
// getRandomValues; the crypto.randomUUID that LiveKit's registerGlobals installs afterwards is
// Math.random-based and must not be used for protocol ids.
import 'react-native-get-random-values';
