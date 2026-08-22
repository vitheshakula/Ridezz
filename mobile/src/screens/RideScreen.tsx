import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AudioSession,
  LiveKitRoom,
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
} from '@livekit/react-native';
import { ConnectionState, MediaDeviceFailure } from 'livekit-client';
import type { RideSession } from './JoinScreen';
import MuteButton from '../components/MuteButton';
import RiderRow from '../components/RiderRow';
import PresenceToast from '../components/PresenceToast';
import RiderMap from '../components/RiderMap';
import DiagnosticsModal from '../components/DiagnosticsModal';
import { startIntercomService, stopIntercomService } from '../services/intercomService';
import { audioCues } from '../services/audioCues';
import { logDiagnosticEvent } from '../services/diagnosticsLog';
import { useRiderPresenceToasts } from '../hooks/useRiderPresenceToasts';
import { useRiderLocations } from '../hooks/useRiderLocations';
import { useConnectionCues } from '../hooks/useConnectionCues';
import { useKeepAwake } from '../hooks/useKeepAwake';
import { MAX_RIDERS, isRoomOverCapacity, sortByJoinOrder } from '../utils/riderPresence';
import type { PresenceEvent } from '../utils/riderPresence';

interface RideScreenProps {
  session: RideSession;
  onLeave: () => void;
}

type RideTab = 'intercom' | 'map';

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
  // never started after the app has already gone into the background. Untouched by the rider
  // presence/map work below: it doesn't depend on participant count, state, or location.
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
      // Mic publish is held off until the capacity check in RideRoom passes -- see there.
      audio={false}
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
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const remoteParticipants = useRemoteParticipants();
  const [tab, setTab] = useState<RideTab>('intercom');

  const [capacityError, setCapacityError] = useState<string | null>(null);
  const hasCheckedCapacityRef = useRef(false);
  const hasLoggedJoinRef = useRef(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);

  useKeepAwake(keepAwakeEnabled);

  useEffect(() => {
    if (connectionState === ConnectionState.Connected && !hasLoggedJoinRef.current) {
      hasLoggedJoinRef.current = true;
      logDiagnosticEvent('joined_room', `Joined room ${session.roomCode.toUpperCase()}`);
    }
  }, [connectionState, session.roomCode]);

  useConnectionCues(connectionState, transition => {
    logDiagnosticEvent(
      transition === 'lost' ? 'connection_lost' : 'reconnected',
      transition === 'lost' ? 'Connection lost — reconnecting' : 'Connection restored',
    );
  });

  // Ridezz's MVP cap is 10 riders per room. The Development Token Server has no way to set
  // server-side room capacity, so this is a client-side check made the moment we connect: if
  // we'd be the 11th participant, disconnect immediately with a clear reason rather than
  // silently publishing audio into an over-capacity room. This can't close every race (two
  // riders joining in the same instant could both slip through) -- production-grade
  // authoritative enforcement moves to the future Ridezz token backend, which can refuse to
  // mint a token at all once a room is full. Only after this check passes do we publish the
  // microphone, which is why <LiveKitRoom> above is given audio={false}.
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected || hasCheckedCapacityRef.current) {
      return;
    }
    hasCheckedCapacityRef.current = true;

    if (isRoomOverCapacity(room.numParticipants, MAX_RIDERS)) {
      setCapacityError(`This ride is full (${MAX_RIDERS}/${MAX_RIDERS} riders). Try again later.`);
      room.disconnect();
      const timer = setTimeout(onLeave, 2500);
      return () => clearTimeout(timer);
    }

    localParticipant.setMicrophoneEnabled(true).catch(() => {
      // Surfaced via onMediaDeviceFailure already.
    });
  }, [connectionState, room, localParticipant, onLeave]);

  const sortedRemoteParticipants = useMemo(
    () => sortByJoinOrder(remoteParticipants),
    [remoteParticipants],
  );

  const riderIdentities = useMemo(
    () => sortedRemoteParticipants.map(p => ({ identity: p.identity, name: p.name || p.identity })),
    [sortedRemoteParticipants],
  );
  const handlePresenceEvent = useCallback((event: PresenceEvent) => {
    if (event.type === 'left') {
      audioCues.riderLeft();
      logDiagnosticEvent('rider_left', `${event.name} left`);
    } else {
      audioCues.riderJoined();
      logDiagnosticEvent('rider_joined', event.type === 'rejoined' ? `${event.name} rejoined` : `${event.name} joined`);
    }
  }, []);
  const presenceToast = useRiderPresenceToasts(riderIdentities, handlePresenceEvent);

  // Publishes our GPS fixes over LiveKit's data channel and keeps the latest known
  // location per rider (including ourselves). Location is a nice-to-have on top of the
  // core voice room -- a denied permission or GPS failure never affects the intercom.
  const { locations, locationPermissionGranted } = useRiderLocations(
    room,
    localParticipant.identity,
    session.riderName,
  );

  const statusLabel = connectError
    ? 'Error'
    : CONNECTION_STATE_LABELS[connectionState] ?? 'Unknown';

  const handleToggleMute = useCallback(() => {
    localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {
      // setMicrophoneEnabled already surfaces failures via onMediaDeviceFailure.
    });
  }, [localParticipant, isMicrophoneEnabled]);

  const riderCount = remoteParticipants.length + 1;
  const displayedError = capacityError ?? connectError;

  const handleLeavePress = useCallback(() => {
    Alert.alert('Leave ride?', 'You’ll stop sharing audio and location with the group.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave Ride', style: 'destructive', onPress: onLeave },
    ]);
  }, [onLeave]);

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
      ]}
    >
      {presenceToast ? <PresenceToast message={presenceToast} /> : null}

      <Text style={styles.title}>RIDEZZ</Text>
      <Text style={styles.roomLabel}>Room: {session.roomCode.toUpperCase()}</Text>

      <Text style={[styles.status, displayedError && styles.statusError]}>
        {displayedError ? `Error: ${displayedError}` : statusLabel}
      </Text>
      <Text style={styles.riderCount}>
        {riderCount} / {MAX_RIDERS} riders
      </Text>
      {backgroundWarning ? (
        <Text style={styles.backgroundWarning}>{backgroundWarning}</Text>
      ) : null}

      <View style={styles.utilityRow}>
        <View style={styles.keepAwakeRow}>
          <Text style={styles.keepAwakeLabel}>Keep screen awake</Text>
          <Switch value={keepAwakeEnabled} onValueChange={setKeepAwakeEnabled} />
        </View>
        <Pressable
          style={styles.diagnosticsLink}
          onPress={() => setDiagnosticsVisible(true)}
          hitSlop={12}
        >
          <Text style={styles.diagnosticsLinkText}>Diagnostics</Text>
        </Pressable>
      </View>

      <View style={styles.tabs}>
        <Pressable
          style={[styles.tabButton, tab === 'intercom' && styles.tabButtonActive]}
          onPress={() => setTab('intercom')}
        >
          <Text style={[styles.tabButtonText, tab === 'intercom' && styles.tabButtonTextActive]}>
            INTERCOM
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, tab === 'map' && styles.tabButtonActive]}
          onPress={() => setTab('map')}
        >
          <Text style={[styles.tabButtonText, tab === 'map' && styles.tabButtonTextActive]}>
            MAP
          </Text>
        </Pressable>
      </View>

      {tab === 'intercom' ? (
        <ScrollView style={styles.riderList} contentContainerStyle={styles.riderListContent}>
          <RiderRow participant={localParticipant} isLocal />
          {sortedRemoteParticipants.map(p => (
            <RiderRow key={p.identity} participant={p} isLocal={false} />
          ))}
        </ScrollView>
      ) : (
        <View style={styles.mapContainer}>
          {locationPermissionGranted === false ? (
            <Text style={styles.locationWarning}>
              Location sharing is off (permission denied). Your position won't appear on the
              map, but the intercom still works normally.
            </Text>
          ) : null}
          <RiderMap locations={locations} localIdentity={localParticipant.identity} />
        </View>
      )}

      <MuteButton muted={!isMicrophoneEnabled} onPress={handleToggleMute} />

      <Pressable style={styles.leaveButton} onPress={handleLeavePress}>
        <Text style={styles.leaveButtonText}>Leave Ride</Text>
      </Pressable>

      <DiagnosticsModal
        visible={diagnosticsVisible}
        onClose={() => setDiagnosticsVisible(false)}
      />
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
  utilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  keepAwakeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  keepAwakeLabel: {
    color: '#c9d1d9',
    fontSize: 14,
    marginRight: 10,
  },
  diagnosticsLink: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  diagnosticsLinkText: {
    color: '#58a6ff',
    fontSize: 14,
    fontWeight: '600',
  },
  tabs: {
    flexDirection: 'row',
    marginTop: 16,
    backgroundColor: '#161b22',
    borderRadius: 10,
    padding: 4,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: '#21262d',
  },
  tabButtonText: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
  tabButtonTextActive: {
    color: '#ffffff',
  },
  riderList: {
    flex: 1,
    marginTop: 16,
  },
  riderListContent: {
    paddingVertical: 4,
  },
  mapContainer: {
    flex: 1,
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  locationWarning: {
    fontSize: 13,
    color: '#d29922',
    padding: 12,
    backgroundColor: '#161b22',
  },
  leaveButton: {
    marginTop: 16,
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
