import { useCallback, useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';
import { logDiagnosticEvent } from '../services/diagnosticsLog';
import type { ConvoyCoordinator } from './convoyCoordinator';
import {
  packNative,
  subjectKeyFor,
  subscribeToPackEvents,
  type PackAlertEvent,
  type PackPeer,
} from './convoyEvents';
import {
  GROUP_SILENT_KEY,
  expireAlerts,
  removeAlert,
  spokenLine,
  upsertAlert,
  type PackAlert,
} from './packAlerts';

/** How often the latest peer positions are handed to the native detector. */
export const PEER_PUSH_MS = 1000;
const EXPIRE_CHECK_MS = 10_000;

export interface UsePackSeparationOptions {
  /** Every known peer (not this rider) with the latest position and fix time. */
  peers: readonly PackPeer[];
  /** This rider's id on the mesh (the id packets are sent under) and display name. */
  selfId: string;
  selfName: string;
  coordinator: ConvoyCoordinator;
  /** Speaks a short line through the app's echo-guarded audio path. */
  announce?: (text: string) => Promise<void> | void;
  clock?: () => number;
}

export interface UsePackSeparationResult {
  alerts: PackAlert[];
  dismiss(key: string): void;
}

/**
 * Convoy awareness. Feeds peer positions to the native detector, turns its events (this rider
 * stopped / separated, a peer went silent) and peers' packets into one list of active alerts for the
 * banner and map pins, and broadcasts this phone's own alerts to the group.
 */
export function usePackSeparation({
  peers,
  selfId,
  selfName,
  coordinator,
  announce,
  clock = Date.now,
}: UsePackSeparationOptions): UsePackSeparationResult {
  const [alerts, setAlerts] = useState<PackAlert[]>([]);
  const alertsRef = useRef<PackAlert[]>([]);
  alertsRef.current = alerts;

  const peersRef = useRef(peers);
  peersRef.current = peers;
  const coordinatorRef = useRef(coordinator);
  coordinatorRef.current = coordinator;
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const selfRef = useRef({ selfId, selfName });
  selfRef.current = { selfId, selfName };
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const speak = useCallback((alert: PackAlert) => {
    Promise.resolve(announceRef.current?.(spokenLine(alert))).catch(() => {});
  }, []);

  useEffect(() => {
    const push = () => {
      packNative.updatePeers(peersRef.current as PackPeer[]).catch(() => {});
    };
    push();
    const id = setInterval(push, PEER_PUSH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(
      () => setAlerts(prev => expireAlerts(prev, clockRef.current())),
      EXPIRE_CHECK_MS,
    );
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const show = (next: PackAlert) =>
      setAlerts(prev => upsertAlert(prev, next));

    const fromEvent = (event: PackAlertEvent, key: string): PackAlert => ({
      key,
      eventType: event.eventType,
      name: event.self ? selfRef.current.selfName : event.riderName ?? '',
      self: event.self,
      lat: event.lastKnownLat,
      lng: event.lastKnownLng,
      speedKmh: event.speedKmh,
      distanceMeters: event.distanceMeters,
      at: clockRef.current(),
      lastSeenAt:
        event.eventType === 'LOST_CONTACT' && event.lastSeenAt !== null
          ? event.lastSeenAt
          : null,
      groupSilent: event.groupSilent,
    });

    const broadcast = (
      alert: PackAlert,
      subjectId: string,
      event: PackAlertEvent,
    ) =>
      coordinatorRef.current
        .submitLocal({
          eventType: event.eventType,
          recovered: false,
          subjectId,
          subjectName: alert.name,
          timestamp: event.timestamp,
          lastKnownLat: event.lastKnownLat ?? 0,
          lastKnownLng: event.lastKnownLng ?? 0,
          speedKmh: event.speedKmh ?? 0,
          distanceMeters: event.distanceMeters,
        })
        .catch(() => {});

    return subscribeToPackEvents({
      onAlert: event => {
        if (event.subjectId) {
          // A peer's alert that arrived over the mesh.
          const alert = fromEvent(event, event.subjectId);
          show(alert);
          logDiagnosticEvent(
            'convoy',
            `${event.eventType} from peer ${alert.name || event.subjectId}`,
          );
          Vibration.vibrate([0, 250, 100, 250]);
          speak(alert);
          return;
        }
        // This rider's own breakdown / separation: tell the group first, then the rider.
        const alert = fromEvent(
          { ...event, self: true },
          selfRef.current.selfId,
        );
        broadcast(alert, selfRef.current.selfId, event);
        show(alert);
        logDiagnosticEvent(
          'convoy',
          `${event.eventType} (self)${
            event.distanceMeters !== null
              ? `, ${Math.round(event.distanceMeters)} m from group`
              : ''
          }`,
        );
        Vibration.vibrate(150);
        speak(alert);
      },

      onLostContact: event => {
        if (event.subjectId) {
          const alert = fromEvent(event, event.subjectId);
          show(alert);
          logDiagnosticEvent(
            'convoy',
            `lost contact reported for ${alert.name || event.subjectId}`,
          );
          speak(alert);
          return;
        }
        const key = event.groupSilent
          ? GROUP_SILENT_KEY
          : subjectKeyFor(event.riderId, selfRef.current.selfId);
        const alert = fromEvent(event, key);
        // A peer that already told the group about this rider is not announced again.
        const duplicate =
          !event.groupSilent &&
          coordinatorRef.current.heardRecently(key, 'LOST_CONTACT');
        show(alert);
        logDiagnosticEvent(
          'convoy',
          `lost contact with ${alert.name || key}${
            event.groupSilent ? ' (everyone)' : ''
          }`,
        );
        if (!duplicate) {
          if (!event.groupSilent) {
            broadcast(alert, key, event);
          }
          speak(alert);
        }
      },

      onRecovered: event => {
        const fromPeer = Boolean(event.subjectId);
        const key =
          event.subjectId ??
          subjectKeyFor(event.riderId, selfRef.current.selfId);
        const known = alertsRef.current.find(
          a => a.key === key && a.eventType === event.eventType,
        );
        setAlerts(prev => {
          let next = removeAlert(prev, key, event.eventType);
          if (event.eventType === 'LOST_CONTACT') {
            next = removeAlert(next, GROUP_SILENT_KEY, 'LOST_CONTACT');
          }
          return next;
        });
        logDiagnosticEvent(
          'convoy',
          `${event.eventType} cleared for ${known?.name || key}`,
        );
        if (!fromPeer && known) {
          coordinatorRef.current
            .submitLocal({
              eventType: event.eventType,
              recovered: true,
              subjectId: key,
              subjectName: known.name,
              timestamp: event.timestamp,
              lastKnownLat: known.lat ?? 0,
              lastKnownLng: known.lng ?? 0,
              speedKmh: known.speedKmh ?? 0,
              distanceMeters: null,
            })
            .catch(() => {});
        }
      },
    });
  }, [speak]);

  const dismiss = useCallback((key: string) => {
    setAlerts(prev => prev.filter(a => a.key !== key));
  }, []);

  return { alerts, dismiss };
}
