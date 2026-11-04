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
