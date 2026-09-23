import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type Permission,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AudioSession,
  LiveKitRoom,
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
  AndroidAudioTypePresets,
} from '@livekit/react-native';
import {
  ConnectionState,
  MediaDeviceFailure,
  RoomEvent,
  type DataPacket_Kind,
  type Participant,
} from 'livekit-client';
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
import {
  HAZARD_LABELS,
  HAZARD_TOPIC,
  claimHazardWindow,
  encodeHazardPacket,
  nearbyMesh,
  parseHazardPacket,
  startSpeechHazardDetection,
  type HazardPacket,
  type HazardType,
  type MeshStatus,
} from '../services/SpeechHazardService';

/** How long the room must be unreachable before the HUD switches to "MESH". Debounces brief
 * cellular blips so the pill doesn't flicker. */
const MESH_FALLBACK_DELAY_MS = 3000;
const MESH_RETRY_MS = 10_000;
const HAZARD_BANNER_MS = 6000;
const SEEN_HAZARD_IDS_MAX = 50;

type Transport = 'cloud' | 'mesh' | 'connecting';
type HazardSource = 'cloud' | 'mesh';

/** Runtime permissions Nearby Connections needs (mirrors NearbyMeshModule.requiredPermissions). */
async function ensureMeshPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  const permissions: Permission[] = [];
  if (Platform.Version >= 31) {
    permissions.push(
      'android.permission.BLUETOOTH_SCAN' as Permission,
      'android.permission.BLUETOOTH_ADVERTISE' as Permission,
      'android.permission.BLUETOOTH_CONNECT' as Permission,
    );
  }
  permissions.push(
    (Platform.Version >= 33
      ? 'android.permission.NEARBY_WIFI_DEVICES'
      : 'android.permission.ACCESS_FINE_LOCATION') as Permission,
  );
  try {
    const results = await PermissionsAndroid.requestMultiple(permissions);
    return permissions.every(p => results[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}

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

  useEffect(() => {
    let cancelled = false;

    const setupNativeAudio = async () => {
      // 1. FOREGROUND SERVICE: Keeps Android from putting the app to sleep when riding
      try {
        await startIntercomService();
      } catch (e: any) {
        if (!cancelled) {
          setBackgroundWarning(`Won't survive a locked screen: ${e.message}`);
        }
      }

      // 2. DISCORD-STYLE VOIP AUDIO ROUTING:
      // Configures Android AudioManager into 'communication' mode.
      // - Activates hardware Acoustic Echo Cancellation (AEC) and noise gates.
      // - Routes voice through helmet Bluetooth headsets (SCO) instead of media music stream.
      // - Prevents OS buffer drops and audio clock drift.
      try {
        await AudioSession.configureAudio({
          android: {
            audioTypeOptions: AndroidAudioTypePresets.communication,
          },
        });
        await AudioSession.startAudioSession();
      } catch (err) {
        console.warn('AudioSession initialization error:', err);
      }
    };

    setupNativeAudio();

    return () => {
      cancelled = true;
      AudioSession.stopAudioSession();
      stopIntercomService().catch(() => {});
    };
  }, []);

  return (
    <LiveKitRoom
      serverUrl={session.serverUrl}
      token={session.token}
      audio={true}
      video={false}
      connect={true}
      options={{
        // 3. HARDWARE VOICE CAPTURE PIPELINE:
        // Controls how the phone reads from the microphone before encoding.
        audioCaptureDefaults: {
          autoGainControl: true,  // AGC: Normalizes volume (boosts quiet speech, compresses shouting)
          echoCancellation: true, // Prevents acoustic feedback if someone isn't wearing headphones
          noiseSuppression: true, // Built-in WebRTC noise floor suppressor
          channelCount: 1,        // Mono voice: Cuts CPU & network usage in half compared to stereo
        },
        // 4. OPUS ENCODING & VAD (VOICE ACTIVITY DETECTION):
        publishDefaults: {
          // 24 kbps is the exact bitrate Discord uses for high-fidelity speech clarity
          audioPreset: {
            maxBitrate: 24000,
          },
          // DTX (Discontinuous Transmission): Acts as an automatic audio gate.
          // WebRTC pauses packet transmission when the rider is quiet, eliminating
          // constant background static and preserving mobile cellular data.
          dtx: true,
          // Disables RED encapsulation to prevent buffer queues and fast-forward bursts
          red: false,
        },
        // 5. CELLULAR HANDOFF RETRY POLICY:
        // Always returns a delay (never null), so the SDK never gives up on its own -- signal
        // loss keeps the rider in the room (RideRoom falls back to the offline mesh meanwhile).
        reconnectPolicy: {
          nextRetryDelayInMs: (retryContext) => {
            return Math.min(100 * Math.pow(1.5, retryContext.retryCount), 2000);
          },
        },
      }}
      onConnected={() => setConnectError(null)}
      onError={(e) => setConnectError(e.message)}
      onMediaDeviceFailure={(failure) => {
        if (failure) {
          setConnectError(`Microphone unavailable (${MEDIA_DEVICE_FAILURE_LABELS[failure] || failure}).`);
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

  useConnectionCues(connectionState, (transition) => {
    logDiagnosticEvent(
      transition === 'lost' ? 'connection_lost' : 'reconnected',
      transition === 'lost' ? 'Connection lost — reconnecting' : 'Connection restored',
    );
  });

  // Capacity check
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
  }, [connectionState, room, onLeave]);

  // --- Cloud <-> offline mesh fallback -------------------------------------------------------
  const isOnline = connectionState === ConnectionState.Connected;
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;
  const micWantedRef = useRef(true);

  const [meshMode, setMeshMode] = useState(false);
  const [meshPermission, setMeshPermission] = useState<boolean | null>(null);
  const [meshError, setMeshError] = useState<string | null>(null);
  const [meshStatus, setMeshStatus] = useState<MeshStatus>({ active: false, peers: 0, error: null });
  const [lastHeard, setLastHeard] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [hazardAlert, setHazardAlert] = useState<HazardPacket | null>(null);
  const senderIdRef = useRef(Math.random().toString(36).slice(2, 10));
  const seenHazardIdsRef = useRef<Set<string>>(new Set());
  const recentHazardsRef = useRef<Map<HazardType, number>>(new Map());

  const transport: Transport = isOnline ? 'cloud' : meshMode ? 'mesh' : 'connecting';

  // Enter mesh mode only after a sustained outage; leave it the moment the room is back.
  useEffect(() => {
    if (isOnline) {
      setMeshMode(false);
      return;
    }
    const timer = setTimeout(() => setMeshMode(true), MESH_FALLBACK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isOnline]);

  // A ride never ends on signal loss. If the SDK has given up (state Disconnected) -- retries
  // exhausted or the signal channel closed -- keep re-joining with backoff. Skipped for the
  // deliberate capacity kick; a manual Leave unmounts this screen, which cancels the timer.
  useEffect(() => {
    if (connectionState !== ConnectionState.Disconnected || capacityError) {
      return;
    }
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tryReconnect = async () => {
      try {
        await room.connect(session.serverUrl, session.token);
        if (!cancelled && micWantedRef.current) {
          await room.localParticipant.setMicrophoneEnabled(true);
        }
      } catch {
        if (!cancelled) {
          timer = setTimeout(tryReconnect, Math.min(2000 * Math.pow(1.5, attempt++), 15000));
        }
      }
    };
    // Initial delay also covers the first render, when the room is still Disconnected only
    // because LiveKitRoom hasn't started its own connect yet.
    timer = setTimeout(tryReconnect, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connectionState, capacityError, room, session.serverUrl, session.token]);

  // Ask once, up front, so a mid-ride outage never triggers a permission dialog.
  useEffect(() => {
    ensureMeshPermission().then(setMeshPermission);
  }, []);

  // The mesh runs for the whole ride, not only while offline: an online rider has to hear a hazard
  // from an offline neighbour (over Nearby Connections) to relay it into the room. Costs some
  // battery; Bluetooth must be on and Google Play Services present.
  useEffect(() => {
    if (meshPermission === null) {
      return;
    }
    if (!meshPermission) {
      setMeshError('Bluetooth / nearby-devices permission denied');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const startMesh = () => {
      nearbyMesh
        .start(session.roomCode, session.riderName)
        .then(() => {
          if (!cancelled) {
            setMeshError(null);
          }
        })
        .catch((e: { code?: string; message?: string }) => {
          if (cancelled) {
            return;
          }
          setMeshError(e?.message ?? 'unavailable');
          // e.g. Wi-Fi switched on later. Unsupported hardware won't ever recover.
          if (e?.code !== 'mesh_unsupported') {
            timer = setTimeout(startMesh, MESH_RETRY_MS);
          }
        });
    };
    startMesh();
    const unsubscribeStatus = nearbyMesh.onStatus(setMeshStatus);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribeStatus();
      nearbyMesh.stop().catch(() => {});
    };
  }, [meshPermission, session.roomCode, session.riderName]);

  const publishToCloud = useCallback(
    (packet: HazardPacket) =>
      room.localParticipant.publishData(encodeHazardPacket(packet), {
        reliable: true,
        topic: HAZARD_TOPIC,
      }),
    [room],
  );

  /** True the first time an id is seen. The same packet can arrive repeatedly (mesh
   * re-discovery), over both transports, or bounce back after being relayed. */
  const rememberHazardId = useCallback((id: string): boolean => {
    const seen = seenHazardIdsRef.current;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    if (seen.size > SEEN_HAZARD_IDS_MAX) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
    return true;
  }, []);

  const handleIncomingHazard = useCallback(
    (packet: HazardPacket, source: HazardSource) => {
      if (packet.senderId === senderIdRef.current || !rememberHazardId(packet.id)) {
        return;
      }
      // The same real hazard reported again by another rider within a few seconds (they heard
      // each other, or it came in over both transports) is shown and relayed only once.
      if (!claimHazardWindow(recentHazardsRef.current, packet.hazard)) {
        return;
      }
      setHazardAlert(packet);

      // Relay so a rider on any side reaches the whole ride: mesh -> room (any online neighbour
      // pushes an offline rider's hazard into the room), and every hazard onward over the mesh, so
      // riders spread out along the road pass it bike to bike beyond one radio hop. Duplicates are
      // dropped by rememberHazardId, so this can't loop.
      if (source === 'mesh' && isOnlineRef.current) {
        publishToCloud(packet).catch(() => {});
      }
      nearbyMesh.broadcast(packet).catch(() => {});
    },
    [publishToCloud, rememberHazardId],
  );

  useEffect(() => {
    function handleData(
      payload: Uint8Array,
      _participant?: Participant,
      _kind?: DataPacket_Kind,
      topic?: string,
    ) {
      if (topic !== HAZARD_TOPIC) {
        return;
      }
      const packet = parseHazardPacket(payload);
      if (packet) {
        handleIncomingHazard(packet, 'cloud');
      }
    }
    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room, handleIncomingHazard]);

  useEffect(
    () => nearbyMesh.onHazardReceived(packet => handleIncomingHazard(packet, 'mesh')),
    [handleIncomingHazard],
  );

  // Send on every channel that is up: the cloud reaches online riders anywhere, the mesh reaches
  // offline riders nearby.
  const broadcastHazard = (packet: HazardPacket) => {
    rememberHazardId(packet.id);
    // Someone (maybe this phone's mic hearing another rider) already reported this a moment ago.
    if (!claimHazardWindow(recentHazardsRef.current, packet.hazard)) {
      return;
    }
    const outcomes: string[] = [];
    const attempt = (channel: string, send: Promise<unknown>) =>
      send.then(
        () => {
          outcomes.push(`${channel} ok`);
        },
        (e: { message?: string }) => {
          outcomes.push(`${channel} FAILED (${e?.message ?? 'error'})`);
        },
      );

    const sends = [attempt('mesh', nearbyMesh.broadcast(packet))];
    if (isOnlineRef.current) {
      sends.push(attempt('cloud', publishToCloud(packet)));
    }
    Promise.all(sends).then(() => setLastSent(`${HAZARD_LABELS[packet.hazard]} → ${outcomes.join(', ')}`));
  };
  const broadcastHazardRef = useRef(broadcastHazard);
  broadcastHazardRef.current = broadcastHazard;

  // Always-on offline speech -> hazard detection; independent of connectivity and of the mic mute.
  useEffect(
    () =>
      startSpeechHazardDetection({
        senderId: senderIdRef.current,
        senderName: session.riderName,
        onHazard: packet => broadcastHazardRef.current(packet),
        onHeard: setLastHeard,
        onError: setVoiceError,
      }),
    [session.riderName],
  );

  const dismissHazard = useCallback(() => setHazardAlert(null), []);

  const sortedRemoteParticipants = useMemo(
    () => sortByJoinOrder(remoteParticipants),
    [remoteParticipants],
  );

  const riderIdentities = useMemo(
    () => sortedRemoteParticipants.map((p) => ({ identity: p.identity, name: p.name || p.identity })),
    [sortedRemoteParticipants],
  );

  const handlePresenceEvent = useCallback((event: PresenceEvent) => {
    if (event.type === 'left') {
      audioCues.riderLeft();
      logDiagnosticEvent('rider_left', `${event.name} left`);
    } else {
      audioCues.riderJoined();
      logDiagnosticEvent(
        'rider_joined',
        event.type === 'rejoined' ? `${event.name} rejoined` : `${event.name} joined`,
      );
    }
  }, []);

  const presenceToast = useRiderPresenceToasts(riderIdentities, handlePresenceEvent);

  const { locations, locationPermissionGranted } = useRiderLocations(
    room,
    localParticipant.identity,
    session.riderName,
  );

  // Mute / Unmute Toggle
  const handleToggleMute = useCallback(async () => {
    if (room.state !== ConnectionState.Connected) {
      Alert.alert('Please wait', 'Connecting to audio stream...');
      return;
    }

    try {
      const nextEnabled = !isMicrophoneEnabled;
      await localParticipant.setMicrophoneEnabled(nextEnabled);
      micWantedRef.current = nextEnabled;
    } catch (err: any) {
      console.warn('Mute toggle error:', err);
      Alert.alert('Microphone Notice', err.message || 'Unable to toggle mute.');
    }
  }, [room.state, localParticipant, isMicrophoneEnabled]);

  const riderCount = remoteParticipants.length + 1;
  const displayedError = capacityError ?? connectError;
  const statusLabel = connectError ? 'Error' : CONNECTION_STATE_LABELS[connectionState] ?? 'Unknown';

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
      {/* Visual presence notifications */}
      {presenceToast ? <PresenceToast message={presenceToast} /> : null}
      {hazardAlert ? (
        <HazardAlertBanner packet={hazardAlert} top={insets.top + 8} onDismiss={dismissHazard} />
      ) : null}

      <Text style={styles.title}>RIDEZZ</Text>
      <Text style={styles.roomLabel}>Room: {session.roomCode.toUpperCase()}</Text>

      <Text style={[styles.status, displayedError && styles.statusError]}>
        {displayedError ? `Error: ${displayedError}` : statusLabel}
      </Text>
      <View style={styles.hudRow}>
        <View style={[styles.hudPill, transport === 'mesh' ? styles.hudPillMesh : styles.hudPillCloud]}>
          <Text style={[styles.hudText, transport === 'mesh' && styles.hudTextMesh]}>
            {transport === 'cloud' ? 'CLOUD' : transport === 'mesh' ? 'MESH · VOICE OFFLINE' : 'CONNECTING'}
          </Text>
        </View>
      </View>
      <Text style={styles.hudDetail}>
        {meshStatus.active
          ? `Mesh: ${meshStatus.peers} rider${meshStatus.peers === 1 ? '' : 's'} nearby`
          : 'Mesh: not running'}
      </Text>
      {lastHeard ? <Text style={styles.hudDetail}>Heard: “{lastHeard}”</Text> : null}
      {lastSent ? <Text style={styles.hudDetail}>Sent: {lastSent}</Text> : null}
      <Text style={styles.riderCount}>
        {riderCount} / {MAX_RIDERS} riders
      </Text>
      {backgroundWarning ? <Text style={styles.backgroundWarning}>{backgroundWarning}</Text> : null}
      {meshError || meshStatus.error ? (
        <Text style={styles.backgroundWarning}>Mesh problem: {meshError ?? meshStatus.error}</Text>
      ) : null}
      {voiceError ? (
        <Text style={styles.backgroundWarning}>Hazard voice detection off: {voiceError}</Text>
      ) : null}

      <View style={styles.utilityRow}>
        <View style={styles.keepAwakeRow}>
          <Text style={styles.keepAwakeLabel}>Keep screen awake</Text>
          <Switch value={keepAwakeEnabled} onValueChange={setKeepAwakeEnabled} />
        </View>
        <Pressable style={styles.diagnosticsLink} onPress={() => setDiagnosticsVisible(true)} hitSlop={12}>
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
          {sortedRemoteParticipants.map((p) => (
            <RiderRow key={p.identity} participant={p} isLocal={false} />
          ))}
        </ScrollView>
      ) : (
        <View style={styles.mapContainer}>
          {locationPermissionGranted === false ? (
            <Text style={styles.locationWarning}>
              Location sharing is off (permission denied). Your position won't appear on the map, but the intercom still works normally.
            </Text>
          ) : null}
          <RiderMap locations={locations} localIdentity={localParticipant.identity} />
        </View>
      )}

      {/* Mic toggle */}
      <MuteButton muted={!isMicrophoneEnabled} onPress={handleToggleMute} />

      {/* Leave button */}
      <Pressable style={styles.leaveButton} onPress={onLeave}>
        <Text style={styles.leaveButtonText}>Leave Ride</Text>
      </Pressable>

      <DiagnosticsModal visible={diagnosticsVisible} onClose={() => setDiagnosticsVisible(false)} />
    </View>
  );
}

function HazardAlertBanner({
  packet,
  top,
  onDismiss,
}: {
  packet: HazardPacket;
  top: number;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, HAZARD_BANNER_MS);
    return () => clearTimeout(timer);
  }, [packet.id, onDismiss]);

  return (
    <Pressable
      style={[styles.hazardBanner, { top }]}
      onPress={onDismiss}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text style={styles.hazardTitle}>HAZARD: {HAZARD_LABELS[packet.hazard].toUpperCase()}</Text>
      <Text style={styles.hazardSubtitle}>Reported by {packet.senderName}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212', paddingHorizontal: 24 },
  hudRow: { alignItems: 'center', marginTop: 8 },
  hudPill: { paddingVertical: 4, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1 },
  hudPillCloud: { borderColor: '#166534', backgroundColor: 'rgba(34, 197, 94, 0.12)' },
  hudPillMesh: { borderColor: '#92400e', backgroundColor: 'rgba(245, 158, 11, 0.15)' },
  hudText: { color: '#22c55e', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  hudTextMesh: { color: '#f59e0b' },
  hudDetail: { fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 4 },
  hazardBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 10,
    elevation: 10,
    backgroundColor: '#b91c1c',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  hazardTitle: { color: '#ffffff', fontSize: 18, fontWeight: '800', letterSpacing: 1 },
  hazardSubtitle: { color: '#fecaca', fontSize: 13, marginTop: 2 },
  title: { fontSize: 24, fontWeight: '700', color: '#22c55e', textAlign: 'center', letterSpacing: 2 },
  roomLabel: { fontSize: 16, color: '#9ca3af', textAlign: 'center', marginTop: 4 },
  status: { fontSize: 16, color: '#22c55e', textAlign: 'center', marginTop: 16, fontWeight: '600' },
  statusError: { color: '#f85149' },
  riderCount: { fontSize: 14, color: '#9ca3af', textAlign: 'center', marginTop: 4 },
  backgroundWarning: { fontSize: 13, color: '#d29922', textAlign: 'center', marginTop: 12 },
  utilityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  keepAwakeRow: { flexDirection: 'row', alignItems: 'center' },
  keepAwakeLabel: { color: '#c9d1d9', fontSize: 14, marginRight: 10 },
  diagnosticsLink: { paddingVertical: 6, paddingHorizontal: 4 },
  diagnosticsLinkText: { color: '#22c55e', fontSize: 14, fontWeight: '600' },
  tabs: { flexDirection: 'row', marginTop: 16, backgroundColor: '#1e1e1e', borderRadius: 10, padding: 4 },
  tabButton: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  tabButtonActive: { backgroundColor: '#2e2e2e' },
  tabButtonText: { color: '#9ca3af', fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  tabButtonTextActive: { color: '#22c55e' },
  riderList: { flex: 1, marginTop: 16 },
  riderListContent: { paddingVertical: 4 },
  mapContainer: { flex: 1, marginTop: 16, borderRadius: 12, overflow: 'hidden' },
  locationWarning: { fontSize: 13, color: '#d29922', padding: 12, backgroundColor: '#1e1e1e' },
  leaveButton: {
    marginTop: 16,
    backgroundColor: '#1e1e1e',
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  leaveButtonText: { color: '#f87171', fontSize: 16, fontWeight: '600' },
});