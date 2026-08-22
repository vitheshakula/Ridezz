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
