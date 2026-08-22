import { NativeModules, Platform } from 'react-native';

interface RidezzIntercomServiceNativeModule {
  startIntercomService(): Promise<void>;
  stopIntercomService(): Promise<void>;
}

const nativeModule: RidezzIntercomServiceNativeModule | undefined =
  NativeModules.RidezzIntercomService;

/**
 * Starts the Android foreground service that keeps the intercom session alive while the app is
 * backgrounded/screen-locked. Must be called while the Activity is visible/foregrounded (e.g.
 * right after joining a room), never for the first time after backgrounding.
 *
 * No-op on iOS (background audio survival there is handled differently and not in scope yet).
 * Rejects on native failure rather than swallowing it -- callers should surface this to the rider.
 */
export async function startIntercomService(): Promise<void> {
  if (Platform.OS !== 'android' || !nativeModule) {
    return;
  }
  await nativeModule.startIntercomService();
}

export async function stopIntercomService(): Promise<void> {
  if (Platform.OS !== 'android' || !nativeModule) {
    return;
  }
  await nativeModule.stopIntercomService();
}
