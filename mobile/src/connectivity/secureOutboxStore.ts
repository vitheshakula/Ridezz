import { NativeModules, Platform } from 'react-native';
import type { PersistentOutboxStore } from './persistentOutbox';

interface SecureOutboxNativeModule {
  load(): Promise<string | null>;
  save(serialized: string): Promise<void>;
  remove(): Promise<void>;
}

function nativeModule(): SecureOutboxNativeModule {
  const module = NativeModules.RideazeSecureOutbox as Partial<SecureOutboxNativeModule> | undefined;
  if (
    Platform.OS !== 'android' ||
    !module ||
    typeof module.load !== 'function' ||
    typeof module.save !== 'function'
  ) {
    throw new Error('Encrypted Android outbox storage is unavailable');
  }
  return module as SecureOutboxNativeModule;
}

/** Android Keystore-backed store. Serialized records never enter AsyncStorage in plaintext. */
export function createSecureOutboxStore(): PersistentOutboxStore {
  return {
    load: () => nativeModule().load(),
    save: serialized => nativeModule().save(serialized),
  };
}
