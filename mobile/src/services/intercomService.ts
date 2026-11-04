import { NativeModules, Platform } from 'react-native';

interface RidezzIntercomServiceNativeModule {
  startIntercomService(): Promise<void>;
  stopIntercomService(): Promise<void>;
}

const nativeModule: RidezzIntercomServiceNativeModule | undefined =
  NativeModules.RidezzIntercomService;

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
