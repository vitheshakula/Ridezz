import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
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
  type Room,
} from 'livekit-client';
import type { RideSession } from './JoinScreen';
import MuteButton from '../components/MuteButton';
import RiderRow from '../components/RiderRow';
import PresenceToast from '../components/PresenceToast';
import RiderMap from '../components/RiderMap';
import DiagnosticsModal from '../components/DiagnosticsModal';
import HazardAlertBanner, { type HazardBannerKind } from '../components/HazardAlertBanner';
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
  createEchoGuard,
  encodeHazardPacket,
  isWithinHazardWindow,
  parseHazardPacket,
  rememberHazardOnce,
  speakHazardAudio,
  startSpeechHazardDetection,
  type HazardPacket,
  type HazardType,
} from '../services/SpeechHazardService';
import { nearbyMeshService, type MeshStatus } from '../services/NearbyMeshService';
import { color, radius, spacing, type } from '../theme';
import { useAuth } from '../context/AuthContext';
import { geocodeDestination, updateRoomDestination } from '../services/destinationService';
import {
  DESTINATION_TOPIC,
  decodeDestinationUpdate,
  encodeDestinationUpdate,
  participantMetadataIsHost,
} from '../services/destinationUpdates';
import type { RideDestination } from '../components/RiderMap';

/** How long the room must be unreachable before the HUD switches to "MESH". Debounces brief
 * cellular blips so the pill doesn't flicker. */
const MESH_FALLBACK_DELAY_MS = 3000;
const MESH_RETRY_MS = 10_000;
/** How far the other riders' voices are turned down while a hazard is being read aloud. Not
 * fully silent -- a rider mid-sentence stays faintly audible under the announcement rather than
 * abruptly vanishing and reappearing. */
const HAZARD_DUCK_VOLUME = 0.2;
const CALL_VOLUME = 1.0;

type Transport = 'cloud' | 'mesh' | 'connecting';
type HazardSource = 'cloud' | 'mesh';

/** Turns every other rider's mic volume down (or back up) in this room. Used to duck the live
 * call for the exact duration of a spoken hazard announcement -- see speakHazardAudio's promise,
 * which resolves only once the announcement actually finishes, so the `finally` below fires at
 * the right time and can't leave the call stuck quiet if the app is fine but the announcement
 * itself fails for some reason. */
function duckRemoteAudio(room: Room, duck: boolean): void {
  const volume = duck ? HAZARD_DUCK_VOLUME : CALL_VOLUME;
  room.remoteParticipants.forEach(participant => participant.setVolume(volume));
}

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
  const { token: authToken } = useAuth();
  const [tab, setTab] = useState<RideTab>('intercom');
  const [currentDestination, setCurrentDestination] = useState<RideDestination | null>(
    session.destination ?? null,
  );
  const [destinationEditorVisible, setDestinationEditorVisible] = useState(false);
  const [destinationQuery, setDestinationQuery] = useState(session.destination?.name ?? '');
  const [destinationUpdating, setDestinationUpdating] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);

  const [capacityError, setCapacityError] = useState<string | null>(null);
  const hasCheckedCapacityRef = useRef(false);
  const hasLoggedJoinRef = useRef(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);

  useKeepAwake(keepAwakeEnabled);

  useEffect(() => {
    setCurrentDestination(session.destination ?? null);
  }, [session.destination]);

  useEffect(() => {
    function handleDestinationData(
      payload: Uint8Array,
      participant?: Participant,
      _kind?: DataPacket_Kind,
      topic?: string,
    ) {
      if (
        topic !== DESTINATION_TOPIC ||
        !participant ||
        !participantMetadataIsHost(participant.metadata)
      ) {
        return;
      }
      const nextDestination = decodeDestinationUpdate(payload);
      if (nextDestination) {
        setCurrentDestination(nextDestination);
      }
    }

    room.on(RoomEvent.DataReceived, handleDestinationData);
    return () => {
      room.off(RoomEvent.DataReceived, handleDestinationData);
    };
  }, [room]);

  const handleChangeDestination = useCallback(async () => {
    const query = destinationQuery.trim();
    if (!query) {
      setDestinationError('Enter a destination.');
      return;
    }
    if (!authToken) {
      setDestinationError('Your login session has expired.');
      return;
    }

    setDestinationUpdating(true);
    setDestinationError(null);
    try {
      const geocoded = await geocodeDestination(query);
      if (!geocoded) {
        setDestinationError('Destination not found. Try a more specific place name.');
        return;
      }
      const confirmed = await updateRoomDestination(session.roomCode, geocoded, authToken);
      setCurrentDestination(confirmed);
      await room.localParticipant.publishData(encodeDestinationUpdate(confirmed), {
        reliable: true,
        topic: DESTINATION_TOPIC,
      });
      setDestinationQuery(confirmed.name ?? query);
      setDestinationEditorVisible(false);
    } catch (error: any) {
      setDestinationError(
        error?.response?.data?.message || error?.message || 'Could not update the destination.',
      );
    } finally {
      setDestinationUpdating(false);
    }
  }, [authToken, destinationQuery, room, session.roomCode]);

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
  const [offlinePeerCount, setOfflinePeerCount] = useState(0);
  const [bannerAlert, setBannerAlert] = useState<{ packet: HazardPacket; kind: HazardBannerKind } | null>(
    null,
  );
  const senderIdRef = useRef(Math.random().toString(36).slice(2, 10));
  // Packet-id memory for the general dedup/relay gate below (rememberHazardOnce prunes this by
  // age, not count -- see that function for why a fixed-size cache caused hazards to loop).
  const seenHazardIdsRef = useRef<Map<string, number>>(new Map());
  // A second, independent id memory dedicated to the TTS call site: guarantees a given packet is
  // read aloud at most once, regardless of anything the banner/relay logic above does or changes
  // to in the future.
  const spokenHazardIdsRef = useRef<Map<string, number>>(new Map());
  // Two dedup windows with a deliberate ONE-WAY relationship:
  //  - a hazard this rider just SENT never suppresses an incoming report of the same type -- a
  //    false local trigger (e.g. overhearing another phone) must not hide a real alert; but
  //  - a hazard this rider just RECEIVED does suppress a local re-send of the same type -- they
  //    already know about it, and a re-send is what turns a readout heard by our own mic into an
  //    echo that bounces back to the original rider.
  const recentSentHazardsRef = useRef<Map<HazardType, number>>(new Map());
  const recentReceivedHazardsRef = useRef<Map<HazardType, number>>(new Map());
  // True while this phone's own speaker is reading an alert (plus a short tail), so the always-on
  // recognizer ignores it instead of hearing "...reported low fuel" as this rider saying it.
  const echoGuardRef = useRef(createEchoGuard());

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

  // Tracks connected mesh peers independently of meshStatus, for the "Riders Connected Offline"
  // sub-label -- always subscribed (a no-op while the mesh session isn't running).
  useEffect(() => nearbyMeshService.onPeerCountChanged(setOfflinePeerCount), []);

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
      nearbyMeshService
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
    const unsubscribeStatus = nearbyMeshService.onStatus(setMeshStatus);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribeStatus();
      nearbyMeshService.stop().catch(() => {});
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
   * re-discovery/relay), over both transports, or bounce back after being relayed. */
  const rememberHazardId = useCallback((id: string): boolean => {
    return rememberHazardOnce(seenHazardIdsRef.current, id);
  }, []);

  const handleIncomingHazard = useCallback(
    (packet: HazardPacket, source: HazardSource) => {
      // This rider's own hazard, bounced back by a relay: it already got its silent "sent"
      // confirmation in broadcastHazard below, and must never be re-shown as a red "received"
      // alert or read back to the rider who just said it.
      const isLocalSender = packet.senderId === senderIdRef.current;
      if (isLocalSender || !rememberHazardId(packet.id)) {
        return;
      }
      // The same real hazard reported again by another rider within a few seconds (they heard
      // each other, or it came in over both transports) is shown and relayed only once.
      if (!claimHazardWindow(recentReceivedHazardsRef.current, packet.hazard)) {
        return;
      }
      setBannerAlert({ packet, kind: 'received' });
      // Single-play TTS guard: a dedicated, independent check that this exact packet is read
      // aloud at most once -- never for this rider's own hazard (see broadcastHazard, which
      // shows the green confirmation silently), and never a second time even if this function
      // somehow ran again for the same packet. Duck other riders' voices for exactly the duration
      // of the readout, then restore them; never left ducked even if speech fails, since the
      // promise always settles. The echo guard covers the same span (plus a tail) so the
      // recognizer never mistakes this readout for the rider speaking.
      if (rememberHazardOnce(spokenHazardIdsRef.current, packet.id)) {
        echoGuardRef.current.begin();
        duckRemoteAudio(room, true);
        speakHazardAudio(packet).finally(() => {
          duckRemoteAudio(room, false);
          echoGuardRef.current.end();
        });
      }

      // Relay so a rider on any side reaches the whole ride: mesh -> room (any online neighbour
      // pushes an offline rider's hazard into the room), and every hazard onward over the mesh, so
      // riders spread out along the road pass it bike to bike beyond one radio hop. Duplicates are
      // dropped by rememberHazardId, so this can't loop.
      if (source === 'mesh' && isOnlineRef.current) {
        publishToCloud(packet).catch(() => {});
      }
      nearbyMeshService.broadcastHazard(packet).catch(() => {});
    },
    [publishToCloud, rememberHazardId, room],
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
    () => nearbyMeshService.onHazardReceived(packet => handleIncomingHazard(packet, 'mesh')),
    [handleIncomingHazard],
  );

  // Send on every channel that is up: the cloud reaches online riders anywhere, the mesh reaches
  // offline riders nearby. Called for a hazard this rider's own mic just detected -- the sender
  // side of the flow, entirely separate from handleIncomingHazard above.
  const broadcastHazard = (packet: HazardPacket) => {
    rememberHazardId(packet.id);
    // This rider was just TOLD about this hazard type: anything their mic picks up for it now is
    // almost certainly an echo of the readout or of the rider who reported it, and sending it on
    // is exactly what would bounce it back and start a loop. Drop it. (One-way on purpose -- see
    // recentSentHazardsRef above.)
    if (isWithinHazardWindow(recentReceivedHazardsRef.current, packet.hazard)) {
      return;
    }
    // This rider's own mic already reported this hazard type a moment ago -- don't send/show it
    // again.
    if (!claimHazardWindow(recentSentHazardsRef.current, packet.hazard)) {
      return;
    }
    // Silent, visual-only confirmation -- no TTS. The rider already knows what they just said.
    setBannerAlert({ packet, kind: 'sent' });
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

    const sends = [attempt('mesh', nearbyMeshService.broadcastHazard(packet))];
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
        isEchoLikely: () => echoGuardRef.current.isEchoLikely(),
        onError: setVoiceError,
      }),
    [session.riderName],
  );

  const dismissHazard = useCallback(() => setBannerAlert(null), []);

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

  const mapStatusMessage = useMemo(() => {
    if (locationPermissionGranted === null) {
      return 'Checking location permission...';
    }
    if (locationPermissionGranted === false) {
      return "Location sharing is unavailable. The intercom still works normally.";
    }

    const hasLocalLocation = locations.some(
      location => location.participantIdentity === localParticipant.identity,
    );
    if (!hasLocalLocation) {
      return 'Waiting for your GPS location...';
    }

    const hasRemoteLocation = locations.some(
      location => location.participantIdentity !== localParticipant.identity,
    );
    if (!hasRemoteLocation) {
      return 'No rider locations yet.';
    }

    return null;
  }, [locationPermissionGranted, locations, localParticipant.identity]);
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

  // Secondary status lines (mesh, hazard heard/sent) are collapsed into one row of small
  // single-line chips instead of the old stack of full-width lines -- that stack, at variable
  // height depending on how long the latest hazard transcript was, is what kept shifting the
  // Mute/Leave buttons around during testing (a 2-line "Heard: ..." pushes everything below it
  // down). Each chip is capped to one line with an ellipsis, so the header's height is now
  // predictable regardless of what the hazard system heard.
  const secondaryChips: Array<{ key: string; text: string; tone: 'default' | 'warning' }> = [];
  secondaryChips.push({
    key: 'mesh',
    text: meshStatus.active
      ? `Mesh: ${meshStatus.peers} nearby`
      : 'Mesh: idle',
    tone: 'default',
  });
  if (lastHeard) {
    secondaryChips.push({ key: 'heard', text: `Heard: "${lastHeard}"`, tone: 'default' });
  }
  if (lastSent) {
    secondaryChips.push({ key: 'sent', text: `Sent: ${lastSent}`, tone: 'default' });
  }

  const warningLines = [
    backgroundWarning,
    meshError ?? meshStatus.error ? `Mesh problem: ${meshError ?? meshStatus.error}` : null,
    voiceError ? `Hazard voice detection off: ${voiceError}` : null,
  ].filter(Boolean) as string[];

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.md }]}>
      {/* Visual presence notifications */}
      {presenceToast ? <PresenceToast message={presenceToast} /> : null}
      {bannerAlert ? (
        <HazardAlertBanner
          packet={bannerAlert.packet}
          kind={bannerAlert.kind}
          top={insets.top + 8}
          onDismiss={dismissHazard}
        />
      ) : null}

      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <View>
            <Text style={styles.title}>RIDEAZE</Text>
            <Text style={styles.roomLabel}>Room {session.roomCode.toUpperCase()} · {riderCount}/{MAX_RIDERS} riders</Text>
          </View>
          <View style={[styles.hudPill, transport === 'mesh' ? styles.hudPillMesh : styles.hudPillCloud]}>
            <Text style={[styles.hudText, transport === 'mesh' && styles.hudTextMesh]}>
              {transport === 'cloud' ? 'CLOUD' : transport === 'mesh' ? 'MESH' : 'CONNECTING'}
            </Text>
          </View>
        </View>

        <Text style={[styles.status, displayedError && styles.statusError]} numberOfLines={1}>
          {displayedError ? `Error: ${displayedError}` : statusLabel}
          {transport !== 'cloud' ? ` · ${offlinePeerCount} offline nearby` : ''}
        </Text>

        <View style={styles.chipRow}>
          {secondaryChips.map(chip => (
            <View key={chip.key} style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1} ellipsizeMode="tail">
                {chip.text}
              </Text>
            </View>
          ))}
        </View>

        {warningLines.length > 0 ? (
          <Text style={styles.warningText} numberOfLines={1} ellipsizeMode="tail">
            {warningLines[0]}
          </Text>
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
      </View>

      {tab === 'intercom' ? (
        <>
          <ScrollView style={styles.riderList} contentContainerStyle={styles.riderListContent}>
            <RiderRow participant={localParticipant} isLocal />
            {sortedRemoteParticipants.map((p) => (
              <RiderRow key={p.identity} participant={p} isLocal={false} />
            ))}
          </ScrollView>
          <MuteButton muted={!isMicrophoneEnabled} onPress={handleToggleMute} size="large" />
        </>
      ) : (
        <View style={styles.mapContainer}>
          {locationPermissionGranted === false ? (
            <Text style={styles.locationWarning}>
              Location sharing is off (permission denied). Your position won't appear on the map, but the intercom still works normally.
            </Text>
          ) : null}
          <RiderMap
            locations={locations}
            localIdentity={localParticipant.identity}
            statusMessage={mapStatusMessage}
            destination={currentDestination}
          />
          {session.isHost ? (
            <Pressable
              style={styles.changeDestinationButton}
              accessibilityRole="button"
              accessibilityLabel="Change destination"
              hitSlop={8}
              onPress={() => {
                setDestinationQuery(currentDestination?.name ?? '');
                setDestinationError(null);
                setDestinationEditorVisible(true);
              }}
            >
              <Text style={styles.changeDestinationButtonText}>Change destination</Text>
            </Pressable>
          ) : null}
          {/* Floating, compact on the Map tab -- the map is the primary content here, so the
              mic control shrinks to a reachable corner button instead of a full-size sibling
              that would otherwise claim a third of the screen. Positioned mid-right, clear of
              RiderMap's own top status overlay and its bottom Fit Group / Center Me controls. */}
          <View style={styles.floatingMuteWrap} pointerEvents="box-none">
            <MuteButton muted={!isMicrophoneEnabled} onPress={handleToggleMute} size="small" />
          </View>
        </View>
      )}

      {/* Leave button */}
      <Pressable style={styles.leaveButton} onPress={onLeave}>
        <Text style={styles.leaveButtonText}>Leave Ride</Text>
      </Pressable>

      <DiagnosticsModal visible={diagnosticsVisible} onClose={() => setDiagnosticsVisible(false)} />

      <Modal
        visible={destinationEditorVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!destinationUpdating) {
            setDestinationEditorVisible(false);
          }
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.destinationModalCard}>
            <Text style={styles.destinationModalTitle}>Change destination</Text>
            <Text style={styles.destinationModalDescription}>
              The new destination and route will update for everyone in this ride.
            </Text>
            <TextInput
              style={styles.destinationInput}
              value={destinationQuery}
              onChangeText={setDestinationQuery}
              placeholder="Search for a place"
              placeholderTextColor={color.textMuted}
              editable={!destinationUpdating}
              autoCapitalize="words"
              autoFocus
            />
            {destinationError ? <Text style={styles.destinationError}>{destinationError}</Text> : null}
            <View style={styles.destinationModalActions}>
              <Pressable
                style={styles.destinationCancelButton}
                disabled={destinationUpdating}
                onPress={() => setDestinationEditorVisible(false)}
              >
                <Text style={styles.destinationCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.destinationSaveButton}
                disabled={destinationUpdating}
                onPress={handleChangeDestination}
              >
                {destinationUpdating ? (
                  <ActivityIndicator color={color.onAccent} />
                ) : (
                  <Text style={styles.destinationSaveText}>Update route</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg, paddingHorizontal: spacing.xl },
  header: { marginBottom: spacing.sm },
  headerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title: { ...type.title, fontSize: 20, color: color.accent, letterSpacing: 1.5 },
  roomLabel: { ...type.caption, color: color.textMuted, marginTop: spacing.xs / 2 },
  hudPill: { paddingVertical: spacing.xs, paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1 },
  hudPillCloud: { borderColor: color.accentBorder, backgroundColor: color.accentMuted },
  hudPillMesh: { borderColor: color.warningBorder, backgroundColor: color.warningMuted },
  hudText: { color: color.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  hudTextMesh: { color: color.warning },
  status: {
    fontSize: 14,
    color: color.textSecondary,
    marginTop: spacing.sm,
    fontWeight: '600',
  },
  statusError: { color: color.danger },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  chip: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs / 2,
    paddingHorizontal: spacing.sm,
    maxWidth: '100%',
  },
  chipText: { fontSize: 11, color: color.textSecondary },
  warningText: { fontSize: 12, color: color.warning, marginTop: spacing.sm },
  utilityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  keepAwakeRow: { flexDirection: 'row', alignItems: 'center' },
  keepAwakeLabel: { color: color.textSecondary, fontSize: 13, marginRight: spacing.sm },
  diagnosticsLink: { paddingVertical: spacing.xs, paddingHorizontal: spacing.xs },
  diagnosticsLinkText: { color: color.accent, fontSize: 13, fontWeight: '600' },
  tabs: { flexDirection: 'row', marginTop: spacing.md, backgroundColor: color.surface, borderRadius: radius.md, padding: spacing.xs },
  tabButton: { flex: 1, paddingVertical: spacing.md - 2, borderRadius: radius.sm, alignItems: 'center' },
  tabButtonActive: { backgroundColor: color.surfaceRaised },
  tabButtonText: { color: color.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  tabButtonTextActive: { color: color.accent },
  riderList: { flex: 1, marginTop: spacing.md },
  riderListContent: { paddingVertical: spacing.xs },
  mapContainer: { flex: 1, marginTop: spacing.md, borderRadius: radius.lg, overflow: 'hidden' },
  floatingMuteWrap: {
    position: 'absolute',
    top: '50%',
    right: spacing.lg,
    marginTop: -32,
    zIndex: 2,
    elevation: 4,
  },
  changeDestinationButton: {
    position: 'absolute',
    top: 112,
    right: spacing.md,
    zIndex: 3,
    elevation: 6,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.accentBorder,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  changeDestinationButtonText: { color: color.accent, fontSize: 12, fontWeight: '700' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  destinationModalCard: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: spacing.xl,
  },
  destinationModalTitle: { ...type.title, color: color.textPrimary, fontSize: 20 },
  destinationModalDescription: {
    ...type.body,
    color: color.textSecondary,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  destinationInput: {
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    color: color.textPrimary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  destinationError: { color: color.danger, fontSize: 13, marginTop: spacing.sm },
  destinationModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  destinationCancelButton: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  destinationCancelText: { color: color.textSecondary, fontWeight: '600' },
  destinationSaveButton: {
    minWidth: 120,
    minHeight: 44,
    backgroundColor: color.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  destinationSaveText: { color: color.onAccent, fontWeight: '700' },
  locationWarning: { fontSize: 13, color: color.warning, padding: spacing.md, backgroundColor: color.surface },
  leaveButton: {
    marginTop: spacing.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.dangerBorder,
    borderRadius: radius.lg,
    paddingVertical: spacing.md + 2,
    alignItems: 'center',
  },
  leaveButtonText: { color: '#f87171', fontSize: 15, fontWeight: '600' },
});
