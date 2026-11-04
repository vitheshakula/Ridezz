import { NativeModules, Platform } from 'react-native';

type CueName = 'cue_join' | 'cue_leave' | 'cue_disconnect' | 'cue_reconnect';

interface RidezzAudioCuesNativeModule {
  playCue(cueName: CueName): Promise<void>;
}

const nativeModule: RidezzAudioCuesNativeModule | undefined = NativeModules.RidezzAudioCues;

function playCue(cueName: CueName): void {
  if (Platform.OS !== 'android' || !nativeModule) {
    return;
  }
  nativeModule.playCue(cueName).catch(() => {});
}

export const audioCues = {
  riderJoined: () => playCue('cue_join'),
  riderLeft: () => playCue('cue_leave'),
  connectionLost: () => playCue('cue_disconnect'),
  connectionRestored: () => playCue('cue_reconnect'),
};
