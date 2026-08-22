// Manual Jest mock for @livekit/react-native.
//
// The real package pulls in native modules (WebRTCModule, LiveKitReactNative, etc.)
// that don't exist under Jest, so component tests would crash on import. Our code only
// uses a small slice of this SDK's surface (see RideScreen.tsx / index.js), so this mock
// stubs exactly that slice rather than the whole native bridge.
import type { PropsWithChildren } from 'react';

export const AudioSession = {
  startAudioSession: jest.fn(async () => {}),
  stopAudioSession: jest.fn(async () => {}),
};

export function registerGlobals() {}

export function LiveKitRoom({ children }: PropsWithChildren<Record<string, unknown>>) {
  return children;
}

export function useConnectionState() {
  return 'disconnected';
}

export function useLocalParticipant() {
  return {
    localParticipant: { setMicrophoneEnabled: jest.fn(async () => {}) },
    isMicrophoneEnabled: true,
  };
}

export function useRemoteParticipants() {
  return [];
}

export function useRoomContext() {
  return { numParticipants: 1, disconnect: jest.fn(async () => {}) };
}

export function useIsSpeaking() {
  return false;
}

export function useIsMuted() {
  return false;
}
