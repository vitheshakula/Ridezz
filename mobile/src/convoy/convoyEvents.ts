import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  shortRiderId,
  type ConvoyAlert,
  type PackEventType,
} from './convoyPacket';

/** Raised by the native detector for this rider, and by JS for every alert that arrives from a peer. */
export const PACK_SEPARATION_EVENT = 'onPackSeparationAlert';
export const RIDER_LOST_CONTACT_EVENT = 'onRiderLostContact';
export const PACK_RECOVERED_EVENT = 'onPackRecovered';
export const RIDER_STATE_EVENT = 'onRiderStateChanged';

const EVENT_TYPES: readonly string[] = [
  'BREAKDOWN',
  'SEPARATION',
  'LOST_CONTACT',
];

/**
 * Payload of onPackSeparationAlert and onRiderLostContact.
 *  - From the native detector (`subjectId` absent): about this rider ('self') or, for lost contact,
 *    about a peer by the id the app gave the detector.
 *  - From a peer's packet, re-raised by JS (`subjectId` present): `self` is false.
 */
export interface PackAlertEvent {
  eventType: PackEventType;
  riderId: string;
  riderName: string | null;
  self: boolean;
  lastKnownLat: number | null;
  lastKnownLng: number | null;
  speedKmh: number | null;
  distanceMeters: number | null;
  lastSeenAt: number | null;
  /** Lost contact with every known peer at once: usually this phone's link, not the riders'. */
  groupSilent: boolean;
  timestamp: number;
  subjectId?: string;
}

/** Payload of onPackRecovered. */
export interface PackRecoveredEvent {
  eventType: PackEventType;
  riderId: string;
  timestamp: number;
  subjectId?: string;
}

export interface RiderStateEvent {
  state: 'RIDER_STOPPED' | 'RIDER_MOVING';
  timestamp: number;
  latitude: number | null;
  longitude: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function decodePackAlert(raw: unknown): PackAlertEvent | null {
  if (
    !isObject(raw) ||
    typeof raw.eventType !== 'string' ||
    !EVENT_TYPES.includes(raw.eventType)
  ) {
    return null;
  }
  const timestamp = num(raw.timestamp);
  if (
    typeof raw.riderId !== 'string' ||
    raw.riderId.length === 0 ||
    timestamp === null
  ) {
    return null;
  }
  const lat = num(raw.lastKnownLat);
  const lng = num(raw.lastKnownLng);
  const hasPosition =
    lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    eventType: raw.eventType as PackEventType,
    riderId: raw.riderId,
    riderName:
      typeof raw.riderName === 'string' && raw.riderName.length > 0
        ? raw.riderName
        : null,
    self: raw.self === true,
    lastKnownLat: hasPosition ? lat : null,
    lastKnownLng: hasPosition ? lng : null,
    speedKmh: num(raw.speedKmh),
    distanceMeters: num(raw.distanceMeters),
    lastSeenAt: num(raw.lastSeenAt),
    groupSilent: raw.groupSilent === true,
    timestamp,
    ...(typeof raw.subjectId === 'string' ? { subjectId: raw.subjectId } : {}),
  };
}

export function decodePackRecovered(raw: unknown): PackRecoveredEvent | null {
  if (
    !isObject(raw) ||
    typeof raw.eventType !== 'string' ||
    !EVENT_TYPES.includes(raw.eventType)
  ) {
    return null;
  }
  const timestamp = num(raw.timestamp);
  if (
    typeof raw.riderId !== 'string' ||
    raw.riderId.length === 0 ||
    timestamp === null
  ) {
    return null;
  }
  return {
    eventType: raw.eventType as PackEventType,
    riderId: raw.riderId,
    timestamp,
    ...(typeof raw.subjectId === 'string' ? { subjectId: raw.subjectId } : {}),
  };
}

export function decodeRiderState(raw: unknown): RiderStateEvent | null {
  if (
    !isObject(raw) ||
    (raw.state !== 'RIDER_STOPPED' && raw.state !== 'RIDER_MOVING')
  ) {
    return null;
  }
  const timestamp = num(raw.timestamp);
  if (timestamp === null) {
    return null;
  }
  return {
    state: raw.state,
    timestamp,
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
  };
}

export interface PackEventHandlers {
  onAlert?: (event: PackAlertEvent) => void;
  onLostContact?: (event: PackAlertEvent) => void;
  onRecovered?: (event: PackRecoveredEvent) => void;
  onRiderState?: (event: RiderStateEvent) => void;
}

/** Subscribes to the native + re-raised convoy events. Malformed payloads are dropped. */
export function subscribeToPackEvents(handlers: PackEventHandlers): () => void {
  const subs = [
    DeviceEventEmitter.addListener(PACK_SEPARATION_EVENT, (raw: unknown) => {
      const event = decodePackAlert(raw);
      if (event) {
        handlers.onAlert?.(event);
      }
    }),
    DeviceEventEmitter.addListener(RIDER_LOST_CONTACT_EVENT, (raw: unknown) => {
      const event = decodePackAlert(raw);
      if (event) {
        handlers.onLostContact?.(event);
      }
    }),
    DeviceEventEmitter.addListener(PACK_RECOVERED_EVENT, (raw: unknown) => {
      const event = decodePackRecovered(raw);
      if (event) {
        handlers.onRecovered?.(event);
      }
    }),
    DeviceEventEmitter.addListener(RIDER_STATE_EVENT, (raw: unknown) => {
      const event = decodeRiderState(raw);
      if (event) {
        handlers.onRiderState?.(event);
      }
    }),
  ];
  return () => subs.forEach(sub => sub.remove());
}

/** Re-raises an alert (or recovery) that arrived from another rider on the same JS events. */
export function emitPeerConvoyAlert(alert: ConvoyAlert): void {
  if (alert.recovered) {
    const event: PackRecoveredEvent = {
      eventType: alert.eventType,
      riderId: alert.subjectId,
      subjectId: alert.subjectId,
      timestamp: alert.timestamp,
    };
    DeviceEventEmitter.emit(PACK_RECOVERED_EVENT, event);
    return;
  }
  const event: PackAlertEvent = {
    eventType: alert.eventType,
    riderId: alert.subjectId,
    subjectId: alert.subjectId,
    riderName: alert.subjectName || null,
    self: false,
    lastKnownLat: alert.lastKnownLat,
    lastKnownLng: alert.lastKnownLng,
    speedKmh: alert.speedKmh,
    distanceMeters: alert.distanceMeters,
    lastSeenAt: null,
    groupSilent: false,
    timestamp: alert.timestamp,
  };
  DeviceEventEmitter.emit(
    alert.eventType === 'LOST_CONTACT'
      ? RIDER_LOST_CONTACT_EVENT
      : PACK_SEPARATION_EVENT,
    event,
  );
}

/** A peer position as the native detector wants it. */
export interface PackPeer {
  id: string;
  name?: string;
  latitude: number;
  longitude: number;
  speedMps?: number;
  /** The sender's fix time. Only a CHANGE matters (a new fix = the rider is alive). */
  timestamp: number;
}

interface PackNativeModule {
  updatePackPeers(peers: PackPeer[]): Promise<boolean>;
}

const getNative = (): PackNativeModule | undefined =>
  NativeModules.CrashDetection;

export const packNative = {
  /** Hands the latest peer positions to the native detector. Safe to call when it is not running. */
  updatePeers: (peers: PackPeer[]): Promise<boolean> =>
    Platform.OS === 'android' && getNative()?.updatePackPeers
      ? getNative()!
          .updatePackPeers(peers)
          .catch(() => false)
      : Promise.resolve(false),
};

/** The stable key an alert is stored under for a native `riderId`. */
export function subjectKeyFor(riderId: string, selfId: string): string {
  return riderId === 'self' ? selfId : shortRiderId(riderId);
}
