import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AudioSession,
  LiveKitRoom,
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
} from '@livekit/react-native';
import { ConnectionState, MediaDeviceFailure } from 'livekit-client';
import type { RideSession } from './JoinScreen';
import MuteButton from '../components/MuteButton';
import { startIntercomService, stopIntercomService } from '../services/intercomService';

interface RideScreenProps {
  session: RideSession;
  onLeave: () => void;
}

const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  [ConnectionState.Connecting]: 'Connecting',
  [ConnectionState.Connected]: 'Connected',
  [ConnectionState.Reconnecting]: 'Reconnecting',
  [ConnectionState.SignalReconnecting]: 'Reconnecting',
  [ConnectionState.Disconnected]: 'Disconnected',
};

const MEDIA_DEVICE_FAILURE_LABELS: Record<MediaDeviceFailure, string> = {
  [MediaDeviceFailure.PermissionDenied]: 'permission denied',
  [MediaDeviceFailure.NotFound]: 'no microphone found',
  [MediaDeviceFailure.DeviceInUse]: 'microphone in use by another app',
  [MediaDeviceFailure.Other]: 'unknown error',
};

export default function RideScreen({ session, onLeave }: RideScreenProps) {
  const [connectError, setConnectError] = useState<string | null>(null);
  const [backgroundWarning, setBackgroundWarning] = useState<string | null>(null);

  // Starts/stops (a) the Android foreground service that keeps this process at foreground
  // priority so a locked screen doesn't freeze/kill the room, and (b) the native audio engine
  // that routes call audio through whatever the phone is currently using (speaker/wired/
  // Bluetooth). Runs while the Activity is still visible, as part of the user's Join Ride tap --
  // never started after the app has already gone into the background.
  //
  // A failed intercom-service start doesn't block the ride -- foreground audio still works,
  // it just won't survive a locked screen -- but it's surfaced rather than swallowed.
  useEffect(() => {
    let cancelled = false;

    startIntercomService().catch((e: Error) => {
      if (!cancelled) {
        setBackgroundWarning(
          `Won't survive a locked screen: ${e.message}`,
        );
      }
    });
    AudioSession.startAudioSession();

    return () => {
      cancelled = true;
      AudioSession.stopAudioSession();
      stopIntercomService().catch(() => {
        // Nothing meaningful to do with a stop failure once we're already leaving.
      });
    };
  }, []);

  return (
    <LiveKitRoom
      serverUrl={session.serverUrl}
      token={session.token}
      audio
      video={false}
      connect
      onError={(e) => setConnectError(e.message)}
      onMediaDeviceFailure={(failure) => {
        if (failure) {
          setConnectError(`Microphone unavailable (${MEDIA_DEVICE_FAILURE_LABELS[failure]}).`);
        }
      }}
    >
      <RideRoom
        session={session}
        connectError={connectError}
        backgroundWarning={backgroundWarning}
        onLeave={onLeave}
      />
    </LiveKitRoom>
  );
}

interface RideRoomProps {
  session: RideSession;
  connectError: string | null;
  backgroundWarning: string | null;
  onLeave: () => void;
}

function RideRoom({ session, connectError, backgroundWarning, onLeave }: RideRoomProps) {
  const insets = useSafeAreaInsets();
  const connectionState = useConnectionState();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const remoteParticipants = useRemoteParticipants();

  const statusLabel = connectError
    ? 'Error'
    : CONNECTION_STATE_LABELS[connectionState] ?? 'Unknown';

  const handleToggleMute = useCallback(() => {
    localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {
      // setMicrophoneEnabled already surfaces failures via onMediaDeviceFailure.
    });
  }, [localParticipant, isMicrophoneEnabled]);

  const riderCount = remoteParticipants.length + 1;

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
      ]}
    >
      <Text style={styles.title}>RIDEZZ</Text>
      <Text style={styles.roomLabel}>Room: {session.roomCode.toUpperCase()}</Text>

      <Text style={[styles.status, connectError && styles.statusError]}>
        {connectError ? `Error: ${connectError}` : statusLabel}
      </Text>
      <Text style={styles.riderCount}>
        {riderCount} {riderCount === 1 ? 'rider' : 'riders'}
      </Text>
      {backgroundWarning ? (
        <Text style={styles.backgroundWarning}>{backgroundWarning}</Text>
      ) : null}

      <View style={styles.riderList}>
        <Text style={styles.riderName}>{session.riderName} (you)</Text>
        {remoteParticipants.map(p => (
          <Text key={p.sid} style={styles.riderName}>
            {p.name || p.identity}
          </Text>
        ))}
      </View>

      <MuteButton muted={!isMicrophoneEnabled} onPress={handleToggleMute} />

      <Pressable style={styles.leaveButton} onPress={onLeave}>
        <Text style={styles.leaveButtonText}>Leave Ride</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
    letterSpacing: 2,
  },
  roomLabel: {
    fontSize: 16,
    color: '#9ca3af',
    textAlign: 'center',
    marginTop: 4,
  },
  status: {
    fontSize: 16,
    color: '#3fb950',
    textAlign: 'center',
    marginTop: 16,
    fontWeight: '600',
  },
  statusError: {
    color: '#f85149',
  },
  riderCount: {
    fontSize: 14,
    color: '#9ca3af',
    textAlign: 'center',
    marginTop: 4,
  },
  backgroundWarning: {
    fontSize: 13,
    color: '#d29922',
    textAlign: 'center',
    marginTop: 12,
  },
  riderList: {
    marginTop: 24,
    marginBottom: 24,
    alignItems: 'center',
  },
  riderName: {
    fontSize: 18,
    color: '#ffffff',
    paddingVertical: 4,
  },
  leaveButton: {
    marginTop: 32,
    backgroundColor: '#21262d',
    borderWidth: 1,
    borderColor: '#f85149',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  leaveButtonText: {
    color: '#f85149',
    fontSize: 16,
    fontWeight: '600',
  },
});
