import { DeviceEventEmitter } from 'react-native';
import type { BrakeAlert } from './brakePacket';

export const PEER_BRAKING_EVENT = 'onPeerBrakingAlertReceived';

export type BrakingSource = 'imu' | 'gnss_only';

export interface HardBrakingDetected {
  seq: number;
  onsetAt: number;
  raisedAt: number;
  speedKmh: number;
  peakDecelG: number;
  headingDeg: number | null;
  source: BrakingSource;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function decodeHardBraking(raw: unknown): HardBrakingDetected | null {
  if (!isObject(raw)) {
    return null;
  }
  const seq = num(raw.seq);
  const onsetAt = num(raw.onsetAt);
  const raisedAt = num(raw.raisedAt);
  const speedKmh = num(raw.speedKmh);
  const peakDecelG = num(raw.peakDecelG);
  if (
    seq === null ||
    onsetAt === null ||
    raisedAt === null ||
    speedKmh === null ||
    speedKmh < 0 ||
    peakDecelG === null ||
    peakDecelG <= 0 ||
    (raw.source !== 'imu' && raw.source !== 'gnss_only')
  ) {
    return null;
  }
  const heading = num(raw.headingDeg);
  return {
    seq,
    onsetAt,
    raisedAt,
    speedKmh,
    peakDecelG,
    headingDeg: heading !== null && heading >= 0 && heading < 360 ? heading : null,
    source: raw.source,
  };
}

export function describeBrakingDecision(raw: unknown): string {
  if (!isObject(raw)) {
    return 'unreadable decision';
  }
  if (raw.outcome === 'rejected') {
    const peak = num(raw.peakDecelG);
    return `rejected (${String(raw.reason)})${peak === null ? '' : `, peak ${peak.toFixed(2)} g`}`;
  }
  if (raw.outcome === 'confirmed') {
    const drop = num(raw.dropMps);
    return `confirmed by GNSS${
      drop === null ? '' : `, speed fell ${(drop * 3.6).toFixed(0)} km/h`
    }`;
  }
  return String(raw.outcome);
}

export interface BrakingEventHandlers {
  onHardBraking?: (event: HardBrakingDetected) => void;
  onDecision?: (raw: unknown) => void;
}

export function subscribeToBrakingEvents(handlers: BrakingEventHandlers): () => void {
  const subs = [
    DeviceEventEmitter.addListener('onHardBrakingDetected', (raw: unknown) => {
      const event = decodeHardBraking(raw);
      if (event) {
        handlers.onHardBraking?.(event);
      }
    }),
    DeviceEventEmitter.addListener('onHardBrakingDecision', (raw: unknown) =>
      handlers.onDecision?.(raw),
    ),
  ];
  return () => subs.forEach(sub => sub.remove());
}

export function emitPeerBrakingAlert(alert: BrakeAlert): void {
  DeviceEventEmitter.emit(PEER_BRAKING_EVENT, alert);
}

export function subscribeToPeerBrakingAlerts(handler: (alert: BrakeAlert) => void): () => void {
  const sub = DeviceEventEmitter.addListener(PEER_BRAKING_EVENT, (raw: unknown) => {
    if (isObject(raw) && typeof raw.senderId === 'string' && num(raw.timestamp) !== null) {
      handler(raw as unknown as BrakeAlert);
    }
  });
  return () => sub.remove();
}
