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

/** Motorcycle-appropriate balance between freshness and battery/data: roughly one fix every
 * 3-5s, and only published when the rider has actually moved a meaningful distance.
 * enableHighAccuracy requests the GPS chip instead of network/cell-tower positioning -- the
 * latter is what produced ~19m of apparent drift between two phones sitting side by side in
 * testing. This costs more battery than the previous network-based fix; distanceFilter/interval
 * are left as they were since publish frequency (not single-fix accuracy) is what those control. */
const WATCH_OPTIONS = {
  enableHighAccuracy: true,
  distanceFilter: 15, // meters
  interval: 4000, // ms
  fastestInterval: 3000, // ms
};

/** How often the latest fix is re-broadcast while the rider isn't moving. distanceFilter means
 * a stationary phone gets no new fixes, and the lossy data channel neither retries dropped
 * packets nor replays them to riders who join later -- without this, a rider who stays put is
 * invisible to anyone who joined after their one broadcast, and ages to "offline" for everyone. */
const REBROADCAST_INTERVAL_MS = 5000;

/** How often a genuinely fresh GPS fix is forced via getCurrentPosition, independent of
 * watchPosition. REBROADCAST_INTERVAL_MS above only re-sends whatever fix watchPosition last
 * delivered -- if watchPosition itself has silently stalled (confirmed on one OEM: delivery
 * dropped as "too close" to the provider's last cached location, see WATCH_OPTIONS), that cached
 * fix never changes and every rebroadcast keeps resending the same stale packet, so a rider who
 * reconnects after an outage can stay invisible to everyone else indefinitely. This timer doesn't
 * depend on watchPosition at all, so it keeps the rider visible even if the watch is stuck. */
const ACTIVE_REFRESH_INTERVAL_MS = 15000;

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

  // Shared by the reconnect handler, the LOCATION_REQUEST_TOPIC responder, and the initial-identity
  // effect below -- all three just want "(re-)send whatever fix we already have, right now",
  // never a fresh GPS read of their own. Reads the refs fresh on every call rather than closing
  // over a render's values, so it stays correct no matter which render's closure an effect captured.
  // useCallback'd on [room] alone (refs don't need to be deps) so effects depending on it don't
  // re-run every render.
  const publishCurrentFix = useCallback((): void => {
    const fix = latestFixRef.current;
    const identity = room.localParticipant?.identity || identityRef.current;
    if (!fix || !identity) {
      console.log(`[RideLoc] publishCurrentFix skipped: hasFix=${!!fix} identity=${identity || '(none)'}`);
      return;
    }
    const payload = { ...fix, timestamp: Date.now() };
    setState(prev =>
      upsertRiderLocation(prev, { identity, name: nameRef.current, payload: { v: 1, ...payload } }),
    );
    room.localParticipant
      .publishData(encodeLocationPayload(payload), { reliable: true, topic: LOCATION_TOPIC })
      .then(() => console.log(`[RideLoc] publishCurrentFix sent for ${identity}`))
      .catch(err => console.warn(`[RideLoc] publishCurrentFix FAILED for ${identity}:`, err));
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
    // Read from the room itself: the identity passed in from the screen can stay empty on some
    // devices (confirmed on the host phone), which silently stopped that rider ever being sent.
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

      // Re-send the last fix, stamped "still here as of now". Skipped while the watch is
      // reporting errors, so a rider whose GPS is actually lost still ages to stale/offline.
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

      // Independent of watchPosition -- see ACTIVE_REFRESH_INTERVAL_MS. A failure here is
      // best-effort only: watchPosition is still the primary source, and this is purely a
      // safety net against it having silently stalled.
      activeRefreshTimer = setInterval(() => {
        if (cancelled) {
          return;
        }
        Geolocation.getCurrentPosition(
          handleFix,
          (err: { code?: number; message?: string }) => {
            logDiagnosticEvent(
              'location_error',
              `Active refresh failed: code ${err?.code ?? '?'} - ${err?.message ?? 'unknown error'}`,
            );
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        );
      }, ACTIVE_REFRESH_INTERVAL_MS);
    }

    start();

    // Re-publish this rider's last-known fix the moment the room is reachable again, instead of
    // waiting up to REBROADCAST_INTERVAL_MS for the timer -- covers both LiveKit's own transient
    // reconnect and this app's own full reconnect-after-Disconnected retry (RideScreen), since
    // both end in the same ConnectionStateChanged -> Connected transition. Without this, a rider
    // who comes back online can sit at their stale pre-outage position (shown "stale"/"offline")
    // for up to 5 seconds even though their phone has had a connection the whole time.
    const handleConnectionStateChanged = (newState: ConnectionState) => {
      if (newState !== ConnectionState.Connected || cancelled) {
        return;
      }
      console.log(
        `[RideLoc] ConnectionStateChanged -> Connected (identity=${room.localParticipant?.identity || identityRef.current})`,
      );
      publishCurrentFix();
      // Confirmed on-device: after a long outage, LiveKit does a full rejoin (new participant
      // SID) rather than a lightweight reconnect -- this device's whole room view is rebuilt from
      // scratch, and no other rider has a reason to single it out for an extra broadcast. Without
      // this, every other rider stays stuck at their pre-outage position (shown stale/OFFLINE)
      // until their own next organic REBROADCAST_INTERVAL_MS tick -- see LOCATION_REQUEST_TOPIC.
      room.localParticipant
        .publishData(new Uint8Array(0), { reliable: true, topic: LOCATION_REQUEST_TOPIC })
        .then(() => console.log('[RideLoc] location-request broadcast sent'))
        .catch(err => console.warn('[RideLoc] location-request broadcast FAILED:', err));
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
        // Someone just (re)joined and wants everyone's current position right away -- see
        // LOCATION_REQUEST_TOPIC's doc comment. A no-op if we have no fix of our own yet.
        console.log(`[RideLoc] location-request received from ${participant?.identity ?? '(unknown)'}`);
        publishCurrentFix();
        return;
      }
      if (topic !== LOCATION_TOPIC || !participant) {
        return;
      }
      const decoded = decodeLocationPayload(payload);
      if (!decoded) {
        console.warn(`[RideLoc] location payload from ${participant.identity} failed to decode`);
        return;
      }
      console.log(
        `[RideLoc] location DataReceived from ${participant.identity}: ${decoded.lat.toFixed(5)},${decoded.lng.toFixed(5)} age=${Date.now() - decoded.timestamp}ms`,
      );
      setState(prev => {
        // Diagnostic only: tells us, after the fact, whether this rider's location data ever
        // actually resumed flowing once they'd gone stale/offline -- the one thing a screenshot of
        // "still shows OFFLINE" can't show, since by definition it's taken while nothing has
        // arrived yet.
        if (prev[participant.identity] && !prev[participant.identity].connected) {
          console.log(`[RideLoc] ${participant.identity} resumed after being marked disconnected`);
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
      console.log(`[RideLoc] ParticipantDisconnected: ${participant.identity}`);
      logDiagnosticEvent(
        'remote_participant_disconnected',
        `${participant.name || participant.identity} disconnected`,
      );
      setState(prev => markRiderDisconnected(prev, participant.identity));
    }

    function handleConnected(participant: RemoteParticipant) {
      console.log(`[RideLoc] ParticipantConnected: ${participant.identity}`);
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
