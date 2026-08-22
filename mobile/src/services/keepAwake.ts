import { NativeModules, Platform } from 'react-native';

interface RidezzKeepAwakeNativeModule {
  enable(): Promise<void>;
  disable(): Promise<void>;
}

const nativeModule: RidezzKeepAwakeNativeModule | undefined = NativeModules.RidezzKeepAwake;

export const keepAwake = {
  enable(): void {
    if (Platform.OS !== 'android' || !nativeModule) {
      return;
    }
    nativeModule.enable().catch(() => {
      // Non-essential -- the ride continues either way.
    });
  },
  disable(): void {
    if (Platform.OS !== 'android' || !nativeModule) {
      return;
    }
    nativeModule.disable().catch(() => {
      // Non-essential -- the ride continues either way.
    });
  },
};
