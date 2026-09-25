import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import Geolocation from '@react-native-community/geolocation';
import {
  RoomEvent,
  type DataPacket_Kind,
  type Participant,
  type RemoteParticipant,
  type Room,
} from 'livekit-client';
import {
  LOCATION_TOPIC,
  decodeLocationPayload,
  encodeLocationPayload,
  markRiderDisconnected,
  upsertRiderLocation,
  type RiderLocation,
  type RiderLocationState,
} from '../utils/riderLocation';
import { logDiagnosticEvent } from '../services/diagnosticsLog';

/** Motorcycle-appropriate balance between freshness and battery/data: not a
 * maximum-precision GPS lock, roughly one fix every 3-5s, and only published
 * when the rider has actually moved a meaningful distance. */
const WATCH_OPTIONS = {
  enableHighAccuracy: false,
  distanceFilter: 15, // meters
  interval: 4000, // ms
  fastestInterval: 3000, // ms
};

let hasConfiguredGeolocation = false;
function ensureGeolocationConfigured() {
  if (hasConfiguredGeolocation) {
    return;
  }
  hasConfiguredGeolocation = true;
  Geolocation.setRNConfiguration({
    // We handle the runtime permission prompt ourselves (JoinScreen), so the
    // library shouldn't also try to request it.
    skipPermissionRequests: true,
    locationProvider: 'auto',
    // Keep receiving fixes while the screen is locked. This relies on Ridezz's
    // own foreground service (type includes "location") to justify continued
    // access -- Android treats location used by an active location-typed
    // foreground service as foreground access, so ACCESS_BACKGROUND_LOCATION
    // is deliberately not requested.
    enableBackgroundLocationUpdates: true,
  });
}

export interface UseRiderLocationsResult {
  /** All known rider locations, local rider included. */
  locations: RiderLocation[];
  /** null while permission status is still being checked. */
  locationPermissionGranted: boolean | null;
}

/** Publishes the local rider's GPS fixes over LiveKit's lossy data channel on a
 * dedicated topic, and maintains the latest known location per rider (local +
 * remote) from packets received on that same topic. Location failures never
 * throw or otherwise affect the audio room -- this hook only ever narrows to
 * "permission granted or not" for the UI. */
export function useRiderLocations(
  room: Room,
  localIdentity: string,
  localName: string,
): UseRiderLocationsResult {
  const [state, setState] = useState<RiderLocationState>({});
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);

  // localIdentity/localName aren't known yet on the very first render or two (the
  // LiveKit server hasn't confirmed the local participant's identity until shortly
  // after connect). Reading them via a ref -- rather than depending on them in the
  // effect below -- means a long-lived, already-running GPS watch always attributes
  // fixes to whatever the current identity is, instead of requiring the watch to be
  // torn down and restarted (which, on a stationary phone, may never receive a fresh
  // fix at all, since the OS suppresses redundant deliveries inside distanceFilter).
  const identityRef = useRef(localIdentity);
  const nameRef = useRef(localName);
  // Holds the most recent raw GPS fix regardless of whether an identity was available
  // to store it under yet. Confirmed on-device: getCurrentPosition's cached-location fast
  // path can resolve within the same tick the room connects, *before* LiveKit has assigned
  // localParticipant.identity -- without this, that fix is silently dropped (handleFix's
  // identity check below fails) and never retried, since it's a one-shot seed, leaving the
  // map stuck on "Waiting for your GPS location..." even though a real fix was received.
  const latestFixRef = useRef<
    { lat: number; lng: number; accuracy: number; speed?: number; heading?: number; timestamp: number } | null
  >(null);
  useEffect(() => {
    identityRef.current = localIdentity;
    nameRef.current = localName;
    if (localIdentity && latestFixRef.current) {
      const payload = latestFixRef.current;
      setState(prev =>
        upsertRiderLocation(prev, {
          identity: localIdentity,
          name: localName,
          payload: { v: 1, ...payload },
        }),
      );
      room.localParticipant
        .publishData(encodeLocationPayload(payload), { reliable: false, topic: LOCATION_TOPIC })
        .catch(() => {});
    }
  }, [localIdentity, localName, room]);

  useEffect(() => {
    let cancelled = false;
    let watchId: number | null = null;
    let hadErrorSinceLastFix = false;

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
            `First fix: ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)} (±${Math.round(position.coords.accuracy)}m)`,
          );
        }
        if (hadErrorSinceLastFix) {
          hadErrorSinceLastFix = false;
          logDiagnosticEvent('location_resumed', 'Location updates resumed');
        }
        // speed/heading come back as null (not undefined, not omitted) from the native
        // module when the OS doesn't have a value -- normalize so our optional-field
        // wire format (and decodeLocationPayload's validation) sees them as genuinely
        // absent rather than a JSON-serialized "null" it would then have to special-case.
        const payload = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          speed: position.coords.speed ?? undefined,
          heading: position.coords.heading ?? undefined,
          timestamp: position.timestamp,
        };
        latestFixRef.current = payload;
        if (!cancelled && identityRef.current) {
          setState(prev =>
            upsertRiderLocation(prev, {
              identity: identityRef.current,
              name: nameRef.current,
              payload: { v: 1, ...payload },
            }),
          );
        }
        if (identityRef.current) {
          room.localParticipant
            .publishData(encodeLocationPayload(payload), {
              reliable: false,
              topic: LOCATION_TOPIC,
            })
            .catch(() => {
              // Best-effort -- a dropped location update isn't worth surfacing as an error.
            });
        }
      };

      // Seed an immediate fix via getCurrentPosition, separate from watchPosition below.
      // Confirmed on-device: this OEM's LocationManagerService drops delivery ("dropped
      // delivery - too close") to a *live* registration -- including the very first one --
      // whenever the new fix isn't meaningfully different from the provider's last cached
      // location, which is the common case on a stationary phone. A large maximumAge makes
      // the native geolocation module satisfy this from Android's cached last-known-location
      // instead of registering a live update, sidestepping that throttling entirely. Without
      // this seed, a stationary rider could wait indefinitely and the map would stay stuck on
      // "Waiting for your GPS location...".
      Geolocation.getCurrentPosition(
        handleFix,
        (err: { code?: number; message?: string }) => {
          // Best-effort only -- watchPosition below is the real ongoing source, and a
          // rider moving will still get fixes even if this one-shot seed fails/times out.
          // Logged (not swallowed) so a stuck "Waiting for GPS location..." is diagnosable
          // from the in-app Diagnostics log instead of needing a debugger attached.
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
          // GPS unavailable/failed after permission was granted -- location sharing
          // just stays stale/off for this rider; the intercom itself is unaffected.
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
    }

    start();

    return () => {
      cancelled = true;
      if (watchId !== null) {
        Geolocation.clearWatch(watchId);
      }
    };
  }, [room]);

  useEffect(() => {
    function handleData(
      payload: Uint8Array,
      participant?: Participant,
      _kind?: DataPacket_Kind,
      topic?: string,
    ) {
      if (topic !== LOCATION_TOPIC || !participant) {
        return;
      }
      const decoded = decodeLocationPayload(payload);
      if (!decoded) {
        return;
      }
      setState(prev =>
        upsertRiderLocation(prev, {
          identity: participant.identity,
          name: participant.name || participant.identity,
          payload: decoded,
        }),
      );
    }

    function handleDisconnected(participant: RemoteParticipant) {
      setState(prev => markRiderDisconnected(prev, participant.identity));
    }

    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.ParticipantDisconnected, handleDisconnected);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.ParticipantDisconnected, handleDisconnected);
    };
  }, [room]);

  return {
    locations: Object.values(state),
    locationPermissionGranted: permissionGranted,
  };
}
