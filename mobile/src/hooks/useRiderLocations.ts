import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import Geolocation from '@react-native-community/geolocation';
import {
  ConnectionState,
  RoomEvent,
  type DataPacket_Kind,
  type Participant,
  type RemoteParticipant,
  type Room,
} from 'livekit-client';
import {
  LOCATION_REQUEST_TOPIC,
  LOCATION_TOPIC,
  decodeLocationPayload,
  encodeLocationPayload,
  markRiderDisconnected,
  upsertRiderLocation,
  type RiderLocation,
  type RiderLocationState,
} from '../utils/riderLocation';
import { logDiagnosticEvent } from '../services/diagnosticsLog';
import { createLogger } from '../utils/logger';

const log = createLogger('RideLoc');

const WATCH_OPTIONS = {
  enableHighAccuracy: true,
  distanceFilter: 15,
  interval: 4000,
  fastestInterval: 3000,
};

const REBROADCAST_INTERVAL_MS = 5000;

const ACTIVE_REFRESH_INTERVAL_MS = 15000;

let hasConfiguredGeolocation = false;
function ensureGeolocationConfigured() {
  if (hasConfiguredGeolocation) {
    return;
  }
  hasConfiguredGeolocation = true;
  Geolocation.setRNConfiguration({
    skipPermissionRequests: true,
    locationProvider: 'auto',
    enableBackgroundLocationUpdates: true,
  });
}

export interface UseRiderLocationsResult {
  locations: RiderLocation[];
  locationPermissionGranted: boolean | null;
}

export function useRiderLocations(
  room: Room,
  localIdentity: string,
  localName: string,
): UseRiderLocationsResult {
  const [state, setState] = useState<RiderLocationState>({});
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);

  const identityRef = useRef(localIdentity);
  const nameRef = useRef(localName);
  const latestFixRef = useRef<{
    lat: number;
    lng: number;
    accuracy: number;
    speed?: number;
    heading?: number;
    timestamp: number;
  } | null>(null);

  const publishCurrentFix = useCallback((): void => {
    const fix = latestFixRef.current;
    const identity = room.localParticipant?.identity || identityRef.current;
    if (!fix || !identity) {
      log.debug(`publishCurrentFix skipped: hasFix=${!!fix} identity=${identity || '(none)'}`);
      return;
    }
    const payload = { ...fix, timestamp: Date.now() };
    setState(prev =>
      upsertRiderLocation(prev, { identity, name: nameRef.current, payload: { v: 1, ...payload } }),
    );
    room.localParticipant
      .publishData(encodeLocationPayload(payload), { reliable: true, topic: LOCATION_TOPIC })
      .then(() => log.debug(`publishCurrentFix sent for ${identity}`))
      .catch(err => log.warn(`publishCurrentFix FAILED for ${identity}:`, err));
  }, [room]);

  useEffect(() => {
    identityRef.current = localIdentity;
    nameRef.current = localName;
    if (localIdentity && latestFixRef.current) {
      publishCurrentFix();
    }
  }, [localIdentity, localName, room, publishCurrentFix]);

  useEffect(() => {
    let cancelled = false;
    let watchId: number | null = null;
    let rebroadcastTimer: ReturnType<typeof setInterval> | null = null;
    let activeRefreshTimer: ReturnType<typeof setInterval> | null = null;
    let hadErrorSinceLastFix = false;
    const currentIdentity = () => room.localParticipant?.identity || identityRef.current;

    async function start() {
      if (Platform.OS !== 'android') {
        if (!cancelled) {
          setPermissionGranted(false);
        }
        return;
      }

      const granted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      if (cancelled) {
        return;
      }
      setPermissionGranted(granted);
      if (!granted) {
        logDiagnosticEvent('location_permission_unavailable', 'Location permission not granted');
        return;
      }

      logDiagnosticEvent('location_started', 'Location sharing started');
      ensureGeolocationConfigured();

      let hasLoggedFirstFix = false;
      const handleFix = (position: {
        coords: {
          latitude: number;
          longitude: number;
          accuracy: number;
          speed?: number | null;
          heading?: number | null;
        };
        timestamp: number;
      }) => {
        if (!hasLoggedFirstFix) {
          hasLoggedFirstFix = true;
          logDiagnosticEvent(
            'location_fix_received',
            `First fix: ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(
              4,
            )} (±${Math.round(position.coords.accuracy)}m)`,
          );
        }
        if (hadErrorSinceLastFix) {
          hadErrorSinceLastFix = false;
          logDiagnosticEvent('location_resumed', 'Location updates resumed');
        }
        const payload = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          speed: position.coords.speed ?? undefined,
          heading: position.coords.heading ?? undefined,
          timestamp: position.timestamp,
        };
        latestFixRef.current = payload;
        const identity = currentIdentity();
        if (!cancelled && identity) {
          setState(prev =>
            upsertRiderLocation(prev, {
              identity,
              name: nameRef.current,
              payload: { v: 1, ...payload },
            }),
          );
        }
        if (identity) {
          room.localParticipant
            .publishData(encodeLocationPayload(payload), {
              reliable: true,
              topic: LOCATION_TOPIC,
            })
            .catch(() => {});
        }
      };

      Geolocation.getCurrentPosition(
        handleFix,
        (err: { code?: number; message?: string }) => {
          logDiagnosticEvent(
            'location_error',
            `Initial fix failed: code ${err?.code ?? '?'} - ${err?.message ?? 'unknown error'}`,
          );
        },
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 5 * 60 * 1000 },
      );

      watchId = Geolocation.watchPosition(
        handleFix,
        (err: { code?: number; message?: string }) => {
          logDiagnosticEvent(
            'location_error',
            `Watch error: code ${err?.code ?? '?'} - ${err?.message ?? 'unknown error'}`,
          );
          if (!hadErrorSinceLastFix) {
            hadErrorSinceLastFix = true;
            logDiagnosticEvent('location_paused', 'Location updates interrupted');
          }
        },
        WATCH_OPTIONS,
      );

      rebroadcastTimer = setInterval(() => {
        const fix = latestFixRef.current;
        const identity = currentIdentity();
        if (cancelled || !fix || !identity || hadErrorSinceLastFix) {
          return;
        }
        const payload = { ...fix, timestamp: Date.now() };
        setState(prev =>
          upsertRiderLocation(prev, {
            identity,
            name: nameRef.current,
            payload: { v: 1, ...payload },
          }),
        );
        room.localParticipant
          .publishData(encodeLocationPayload(payload), { reliable: true, topic: LOCATION_TOPIC })
          .catch(() => {});
      }, REBROADCAST_INTERVAL_MS);

      activeRefreshTimer = setInterval(() => {
        if (cancelled) {
          return;
        }
        Geolocation.getCurrentPosition(
          handleFix,
          (err: { code?: number; message?: string }) => {
            logDiagnosticEvent(
              'location_error',
              `Active refresh failed: code ${err?.code ?? '?'} - ${
                err?.message ?? 'unknown error'
              }`,
            );
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        );
      }, ACTIVE_REFRESH_INTERVAL_MS);
    }

    start();

    const handleConnectionStateChanged = (newState: ConnectionState) => {
      if (newState !== ConnectionState.Connected || cancelled) {
        return;
      }
      log.debug(
        `ConnectionStateChanged -> Connected (identity=${
          room.localParticipant?.identity || identityRef.current
        })`,
      );
      publishCurrentFix();
      room.localParticipant
        .publishData(new Uint8Array(0), { reliable: true, topic: LOCATION_REQUEST_TOPIC })
        .then(() => log.debug('location-request broadcast sent'))
        .catch(err => log.warn('location-request broadcast FAILED:', err));
    };
    room.on(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged);

    return () => {
      cancelled = true;
      room.off(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged);
      if (watchId !== null) {
        Geolocation.clearWatch(watchId);
      }
      if (rebroadcastTimer !== null) {
        clearInterval(rebroadcastTimer);
      }
      if (activeRefreshTimer !== null) {
        clearInterval(activeRefreshTimer);
      }
    };
  }, [room, publishCurrentFix]);

  useEffect(() => {
    function handleData(
      payload: Uint8Array,
      participant?: Participant,
      _kind?: DataPacket_Kind,
      topic?: string,
    ) {
      if (topic === LOCATION_REQUEST_TOPIC) {
        log.debug(`location-request received from ${participant?.identity ?? '(unknown)'}`);
        publishCurrentFix();
        return;
      }
      if (topic !== LOCATION_TOPIC || !participant) {
        return;
      }
      const decoded = decodeLocationPayload(payload);
      if (!decoded) {
        log.warn(`location payload from ${participant.identity} failed to decode`);
        return;
      }
      log.debug(
        `location DataReceived from ${participant.identity}: ${decoded.lat.toFixed(
          5,
        )},${decoded.lng.toFixed(5)} age=${Date.now() - decoded.timestamp}ms`,
      );
      setState(prev => {
        if (prev[participant.identity] && !prev[participant.identity].connected) {
          log.debug(`${participant.identity} resumed after being marked disconnected`);
          logDiagnosticEvent(
            'remote_location_resumed',
            `${participant.name || participant.identity} sending location again`,
          );
        }
        return upsertRiderLocation(prev, {
          identity: participant.identity,
          name: participant.name || participant.identity,
          payload: decoded,
        });
      });
    }

    function handleDisconnected(participant: RemoteParticipant) {
      log.debug(`ParticipantDisconnected: ${participant.identity}`);
      logDiagnosticEvent(
        'remote_participant_disconnected',
        `${participant.name || participant.identity} disconnected`,
      );
      setState(prev => markRiderDisconnected(prev, participant.identity));
    }

    function handleConnected(participant: RemoteParticipant) {
      log.debug(`ParticipantConnected: ${participant.identity}`);
    }

    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.ParticipantDisconnected, handleDisconnected);
    room.on(RoomEvent.ParticipantConnected, handleConnected);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.ParticipantDisconnected, handleDisconnected);
      room.off(RoomEvent.ParticipantConnected, handleConnected);
    };
  }, [room, publishCurrentFix]);

  return {
    locations: Object.values(state),
    locationPermissionGranted: permissionGranted,
  };
}
