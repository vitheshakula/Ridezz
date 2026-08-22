/**
 * @format
 */

// Must be the first import in this file: these polyfill globals (DOMException,
// TextEncoder/TextDecoder) that livekit-client references at
// module-evaluation time (not just inside functions), so they must exist
// before livekit-client is imported by anything — including
// @livekit/react-native below. See src/polyfills/index.ts for details.
import './src/polyfills';
// Must run before any LiveKit/WebRTC objects are created.
import { registerGlobals } from '@livekit/react-native';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

registerGlobals();

AppRegistry.registerComponent(appName, () => App);
