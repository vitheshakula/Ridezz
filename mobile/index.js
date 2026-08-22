/**
 * @format
 */

// Must be the first import in this file: Hermes has no global DOMException,
// and livekit-client references it at module-evaluation time (not just
// inside functions), so it must exist before livekit-client is imported by
// anything — including @livekit/react-native below. See
// src/polyfills/domException.ts for details.
import './src/polyfills/domException';
// Must run before any LiveKit/WebRTC objects are created.
import { registerGlobals } from '@livekit/react-native';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

registerGlobals();

AppRegistry.registerComponent(appName, () => App);
