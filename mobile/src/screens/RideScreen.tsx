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
  useSpeakingParticipants,
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
import { brand, font, homeType } from '../homeTheme';
import { Logo } from '../components/Logo';
import {
  ChevronIcon,
  CloseIcon,
  GearIcon,
  LogoutIcon,
  PeopleIcon,
  StatusDot,
} from '../components/HomeIcons';
import { formatDistance, haversineDistanceMeters } from '../utils/riderLocation';
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
  const speakers = useSpeakingParticipants();
  const speakingIdentities = useMemo(() => speakers.map(p => p.identity), [speakers]);
  const localSpeaking = speakers.some(p => p.isLocal);
  const remoteSpeaking = speakers.some(p => !p.isLocal);
  const { token: authToken } = useAuth();
  // Layout-only state: measured HUD / panel heights (so map overlays stay clear of them),
  // whether the rider list is expanded, and the settings sheet.
  const [hudHeight, setHudHeight] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
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

  const warningLines = [
    backgroundWarning,
    meshError ?? meshStatus.error ? `Mesh problem: ${meshError ?? meshStatus.error}` : null,
    voiceError ? `Hazard voice detection off: ${voiceError}` : null,
  ].filter(Boolean) as string[];

  // --- Presentation-only values (all derived from the state above) ------------------------------
  const onlineCount = riderCount;
  const connectionTone =
    connectionState === ConnectionState.Connected && !connectError
      ? brand.success
      : connectionState === ConnectionState.Reconnecting ||
          connectionState === ConnectionState.SignalReconnecting ||
          connectionState === ConnectionState.Connecting
        ? brand.warning
        : brand.danger;
  const transportLabel = transport === 'cloud' ? 'CLOUD' : transport === 'mesh' ? 'MESH' : 'CONNECTING';
  const meshProblem = meshError ?? meshStatus.error;
  const meshLabel = meshProblem
    ? 'MESH UNAVAILABLE'
    : meshStatus.active
      ? `MESH ACTIVE · ${meshStatus.peers} NEARBY`
      : 'MESH IDLE';
  const meshTone = meshProblem ? brand.warning : meshStatus.active ? brand.primary : brand.outline;

  const voiceState: { label: string; tone: string } = (() => {
    if (
      connectionState === ConnectionState.Reconnecting ||
      connectionState === ConnectionState.SignalReconnecting
    ) {
      return { label: 'RECONNECTING', tone: brand.warning };
    }
    if (connectionState === ConnectionState.Disconnected) {
      return { label: meshMode ? 'VOICE OFFLINE' : 'OFFLINE', tone: brand.danger };
    }
    if (connectionState === ConnectionState.Connecting) {
      return { label: 'CONNECTING', tone: brand.warning };
    }
    if (!isMicrophoneEnabled) {
      return { label: 'MUTED', tone: brand.danger };
    }
    if (localSpeaking) {
      return { label: 'TALKING', tone: brand.success };
    }
    if (remoteSpeaking) {
      return { label: 'ANOTHER RIDER TALKING', tone: brand.primary };
    }
    return { label: 'ACTIVE', tone: brand.primary };
  })();

  const localLocation = locations.find(l => l.participantIdentity === localParticipant.identity);
  const distanceLabelFor = (identity: string): string | null => {
    const remote = locations.find(l => l.participantIdentity === identity);
    return localLocation && remote
      ? formatDistance(haversineDistanceMeters(localLocation, remote))
      : null;
  };

  const hudBottom = insets.top + 8 + hudHeight;
  const bannerTop = hudBottom + 8;

  return (
    <View style={styles.container}>
      <View style={StyleSheet.absoluteFill}>
        <RiderMap
          locations={locations}
          localIdentity={localParticipant.identity}
          statusMessage={mapStatusMessage}
          destination={currentDestination}
          topInset={hudBottom}
          bottomInset={panelHeight}
          speakingIdentities={speakingIdentities}
          onChangeDestination={
            session.isHost
              ? () => {
                  setDestinationQuery(currentDestination?.name ?? '');
                  setDestinationError(null);
                  setDestinationEditorVisible(true);
                }
              : undefined
          }
        />
      </View>

      {/* Visual presence notifications */}
      {presenceToast ? <PresenceToast message={presenceToast} /> : null}
      {bannerAlert ? (
        <HazardAlertBanner
          packet={bannerAlert.packet}
          kind={bannerAlert.kind}
          top={bannerTop}
          onDismiss={dismissHazard}
        />
      ) : null}

      <View
        style={[styles.hud, { top: insets.top + 8 }]}
        onLayout={e => setHudHeight(e.nativeEvent.layout.height)}
      >
        <View style={styles.hudTop}>
          <Logo size={34} />
          <View style={styles.hudTitleBlock}>
            <Text style={styles.hudTitle}>RIDEAZE</Text>
            <Text style={styles.hudRoom} numberOfLines={1}>
              Room {session.roomCode.toUpperCase()} · {riderCount}/{MAX_RIDERS} riders
            </Text>
          </View>
          <View style={styles.timerPill}>
            <RideTimer />
          </View>
          <Pressable
            style={styles.iconButton}
            onPress={() => setSettingsVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Ride settings"
          >
            <GearIcon size={22} color={brand.textPrimary} />
          </Pressable>
        </View>

        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <StatusDot color={connectionTone} size={8} />
            <Text style={styles.chipText} numberOfLines={1}>
              {statusLabel.toUpperCase()} · {transportLabel}
            </Text>
          </View>
          <View style={styles.chip}>
            <PeopleIcon size={14} color={brand.textSecondary} />
            <Text style={styles.chipText}>
              {riderCount}/{MAX_RIDERS}
            </Text>
          </View>
          <View style={[styles.chip, { borderColor: meshTone }]}>
            <Text style={[styles.chipText, { color: meshTone }]} numberOfLines={1}>
              {meshLabel}
            </Text>
          </View>
        </View>

        {displayedError ? (
          <Text style={[styles.hudNotice, { color: brand.danger }]} numberOfLines={2}>
            Error: {displayedError}
          </Text>
        ) : warningLines.length > 0 ? (
          <Text style={[styles.hudNotice, { color: brand.warning }]} numberOfLines={2}>
            {warningLines[0]}
          </Text>
        ) : transport !== 'cloud' ? (
          <Text style={[styles.hudNotice, { color: brand.textSecondary }]} numberOfLines={1}>
            {offlinePeerCount} offline nearby
          </Text>
        ) : null}
      </View>

      <View
        style={[styles.panel, { paddingBottom: insets.bottom + 12 }]}
        onLayout={e => setPanelHeight(e.nativeEvent.layout.height)}
      >
        <View style={styles.panelHandle} />

        <Pressable
          style={styles.panelHeader}
          onPress={() => setPanelExpanded(v => !v)}
          accessibilityRole="button"
          accessibilityLabel={panelExpanded ? 'Hide riders' : 'Show riders'}
        >
          <View>
            <Text style={styles.panelTitle}>
              {riderCount} {riderCount === 1 ? 'RIDER' : 'RIDERS'} · {onlineCount} ONLINE
            </Text>
            <Text style={[styles.panelSub, { color: meshTone }]}>{meshLabel}</Text>
          </View>
          <ChevronIcon size={22} color={brand.textSecondary} up={!panelExpanded} />
        </Pressable>

        {panelExpanded ? (
          <ScrollView style={styles.riderList} contentContainerStyle={styles.riderListContent}>
            <RiderRow participant={localParticipant} isLocal />
            {sortedRemoteParticipants.map(p => (
              <RiderRow
                key={p.identity}
                participant={p}
                isLocal={false}
                distanceLabel={distanceLabelFor(p.identity)}
              />
            ))}
          </ScrollView>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.avatarStrip}
            contentContainerStyle={styles.avatarStripContent}
          >
            {[localParticipant, ...sortedRemoteParticipants].map(p => {
              const label = (p.name || p.identity || '?').trim();
              const speaking = speakingIdentities.includes(p.identity);
              return (
                <View
                  key={p.identity}
                  style={[styles.stripAvatar, speaking && styles.stripAvatarSpeaking]}
                  accessibilityLabel={label}
                >
                  <Text style={styles.stripInitial}>{label.charAt(0).toUpperCase() || '?'}</Text>
                </View>
              );
            })}
          </ScrollView>
        )}

        <View style={styles.controlsRow}>
          <View style={styles.controlSide}>
            <Pressable
              style={styles.leaveButton}
              onPress={onLeave}
              accessibilityRole="button"
              accessibilityLabel="Leave Ride"
            >
              <LogoutIcon size={20} color="#f87171" />
              <Text style={styles.leaveButtonText}>Leave Ride</Text>
            </Pressable>
          </View>

          <View style={styles.controlCenter}>
            <MuteButton
              muted={!isMicrophoneEnabled}
              onPress={handleToggleMute}
              size="large"
              talking={localSpeaking}
            />
            <Text style={[styles.voiceState, { color: voiceState.tone }]} numberOfLines={1}>
              {voiceState.label}
            </Text>
          </View>

          <View style={styles.controlSide}>
            <Pressable
              style={styles.sideButton}
              onPress={() => setPanelExpanded(v => !v)}
              accessibilityRole="button"
              accessibilityLabel={panelExpanded ? 'Hide riders' : 'Show riders'}
            >
              <PeopleIcon size={22} color={brand.textPrimary} />
              <Text style={styles.sideButtonText}>{riderCount}</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <DiagnosticsModal visible={diagnosticsVisible} onClose={() => setDiagnosticsVisible(false)} />

      <Modal
        visible={settingsVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSettingsVisible(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setSettingsVisible(false)}>
          <Pressable
            style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}
            onPress={() => {}}
          >
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Ride settings</Text>
              <Pressable
                style={styles.iconButton}
                onPress={() => setSettingsVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close settings"
              >
                <CloseIcon size={20} color={brand.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.sheetRow}>
              <Text style={styles.sheetRowLabel}>Keep screen awake</Text>
              <Switch
                value={keepAwakeEnabled}
                onValueChange={setKeepAwakeEnabled}
                trackColor={{ false: brand.surfaceHighest, true: brand.primaryBorder }}
                thumbColor={keepAwakeEnabled ? brand.primary : brand.outline}
              />
            </View>

            <Pressable
              style={styles.sheetRow}
              onPress={() => {
                setSettingsVisible(false);
                setDiagnosticsVisible(true);
              }}
              accessibilityRole="button"
            >
              <Text style={styles.sheetRowLabel}>Diagnostics</Text>
              <Text style={styles.sheetRowAction}>Open</Text>
            </Pressable>

            {lastHeard ? (
              <Text style={styles.sheetNote} numberOfLines={2}>
                Heard: "{lastHeard}"
              </Text>
            ) : null}
            {lastSent ? (
              <Text style={styles.sheetNote} numberOfLines={2}>
                Sent: {lastSent}
              </Text>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

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
              placeholderTextColor={brand.outline}
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
                  <ActivityIndicator color={brand.onPrimary} />
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

/** Elapsed time since this rider joined the ride. Owns its own 1s tick so the rest of the
 * screen doesn't re-render every second. */
function RideTimer() {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return <Text style={styles.timerText}>{h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`}</Text>;
}

const SURFACE = 'rgba(17, 25, 35, 0.94)';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: brand.bg },
  hud: {
    position: 'absolute',
    left: 12,
    right: 12,
    padding: 10,
    borderRadius: 18,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    gap: 8,
  },
  hudTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hudTitleBlock: { flex: 1 },
  hudTitle: { ...homeType.headlineSmall, fontSize: 18, lineHeight: 22, color: brand.textPrimary, letterSpacing: 1 },
  hudRoom: { ...homeType.labelSmall, color: brand.primary },
  timerPill: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: brand.darkest,
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  timerText: { fontFamily: font.heading, fontSize: 14, lineHeight: 18, color: brand.textPrimary },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: brand.darkest,
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: brand.darkest,
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  chipText: { ...homeType.labelSmall, color: brand.textSecondary, flexShrink: 1 },
  hudNotice: { ...homeType.bodySmall },

  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 8,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(12, 20, 30, 0.97)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: brand.inputBorder,
    elevation: 12,
  },
  panelHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: brand.surfaceHighest,
  },
  panelHeader: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  panelTitle: { ...homeType.labelLarge, color: brand.textPrimary, letterSpacing: 0.6 },
  panelSub: { ...homeType.labelSmall },
  riderList: { maxHeight: 190 },
  riderListContent: { paddingBottom: 4 },
  avatarStrip: { flexGrow: 0 },
  avatarStripContent: { gap: 8, paddingVertical: 4 },
  stripAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: brand.success,
    backgroundColor: brand.darkest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripAvatarSpeaking: { backgroundColor: 'rgba(34, 197, 94, 0.25)' },
  stripInitial: { ...homeType.labelLarge, color: brand.textPrimary },

  controlsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  controlSide: { flex: 1, alignItems: 'center' },
  controlCenter: { flex: 1.2, alignItems: 'center' },
  voiceState: { ...homeType.labelSmall, marginTop: 6, textAlign: 'center' },
  leaveButton: {
    minWidth: 96,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: brand.dangerMuted,
    borderWidth: 1,
    borderColor: brand.dangerBorder,
  },
  leaveButtonText: { ...homeType.labelMedium, color: '#f87171' },
  sideButton: {
    minWidth: 56,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: brand.card,
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  sideButtonText: { ...homeType.labelSmall, color: brand.textPrimary },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.6)', justifyContent: 'flex-end' },
  sheet: {
    padding: 16,
    gap: 8,
    backgroundColor: brand.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { ...homeType.headlineSmall, color: brand.textPrimary },
  sheetRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: brand.card,
  },
  sheetRowLabel: { ...homeType.labelLarge, color: brand.textPrimary },
  sheetRowAction: { ...homeType.labelMedium, color: brand.primary },
  sheetNote: { ...homeType.bodySmall, color: brand.textSecondary, paddingHorizontal: 4 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    justifyContent: 'center',
    padding: 24,
  },
  destinationModalCard: {
    backgroundColor: brand.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    padding: 20,
  },
  destinationModalTitle: { ...homeType.headlineSmall, color: brand.textPrimary },
  destinationModalDescription: {
    ...homeType.bodyMedium,
    color: brand.textSecondary,
    marginTop: 8,
    marginBottom: 16,
  },
  destinationInput: {
    ...homeType.bodyLarge,
    minHeight: 52,
    backgroundColor: brand.darkest,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    borderRadius: 14,
    color: brand.textPrimary,
    paddingHorizontal: 16,
  },
  destinationError: { ...homeType.bodySmall, color: brand.danger, marginTop: 8 },
  destinationModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 20,
  },
  destinationCancelButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 16 },
  destinationCancelText: { ...homeType.labelLarge, color: brand.textSecondary },
  destinationSaveButton: {
    minWidth: 120,
    minHeight: 48,
    backgroundColor: brand.primary,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  destinationSaveText: { ...homeType.labelLarge, color: brand.onPrimary },
});
