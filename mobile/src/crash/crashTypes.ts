/**
 * Types and decoders for the native crash-detection bridge (android/.../crash/CrashDetectionModule).
 * The detection pipeline itself lives in Kotlin; JS only mirrors its state and dispatches the alert.
 */

export type CrashPhase = 'idle' | 'countdown' | 'sos' | 'cancelled';
export type CrashConfidence = 'high' | 'medium';
export type CrashSeverity = 'SEVERE' | 'HIGH' | 'MODERATE' | 'UNKNOWN';

/** What the UI needs. Mirrors the native state; the countdown clock is local to JS. */
export interface CrashState {
  phase: CrashPhase;
  confidence?: CrashConfidence;
  severity?: CrashSeverity;
  /** Epoch ms (this device's clock) at which the countdown ends. Set during 'countdown'. */
  countdownEndsAt?: number;
  /** Full length of the countdown that just started (ms); scales the progress ring. */
  countdownMs?: number;
  /** 'user' | 'riding_resumed'. Set during 'cancelled'. */
  cancelReason?: string;
}

/** Result of startMonitoring(). */
export interface CrashMonitoringInfo {
  accelMaxRangeG: number;
  hasGyroscope: boolean;
  hasGravity: boolean;
  /** 'active' | 'permission_missing' | 'provider_disabled' | 'unavailable' */
  gnss: string;
  samplingHz: number;
  /** False means Android may freeze the process once the app is backgrounded. */
  foregroundServiceActive: boolean;
  alreadyRunning: boolean;
}

/** Payload of onCrashCandidateDetected: every pipeline stage agreed; start the countdown UI. */
export interface CrashCandidate {
  countdownMs: number;
  confidence: CrashConfidence;
  severity: CrashSeverity;
  path: string;
}

/** Payload of onCountdownExpired, and of consumePendingSos(). */
export interface CrashSos {
  sosId: string;
  /** Epoch ms when the alert was dispatched. */
  timestamp: number;
  impactTimestamp: number;
  latitude: number | null;
  longitude: number | null;
  locationAgeMs: number | null;
  speedBeforeImpactMps: number | null;
  speedBeforeImpactKmh: number | null;
  severity: CrashSeverity;
  confidence: CrashConfidence;
  path: string;
  peakG: number;
  /** 'expired' (countdown ran out) | 'user_sent' (rider skipped the wait). */
  trigger: string;
}

export interface CrashCalibrationResult {
  success: boolean;
  /** 'busy' | 'not_steady' | 'no_data' | 'interrupted' | 'not_monitoring'. */
  reason: string | null;
  deltaDeg: number | null;
}

export interface CrashMonitorStatus {
  sensorsStalled: boolean;
  gnss: string;
}

const SEVERITIES: readonly string[] = ['SEVERE', 'HIGH', 'MODERATE', 'UNKNOWN'];
const CONFIDENCES: readonly string[] = ['high', 'medium'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function decodeCrashCandidate(raw: unknown): CrashCandidate | null {
  if (!isObject(raw)) {
    return null;
  }
  const countdownMs = num(raw.countdownMs);
  if (
    countdownMs === null ||
    countdownMs <= 0 ||
    typeof raw.confidence !== 'string' ||
    !CONFIDENCES.includes(raw.confidence) ||
    typeof raw.severity !== 'string' ||
    !SEVERITIES.includes(raw.severity)
  ) {
    return null;
  }
  return {
    countdownMs,
    confidence: raw.confidence as CrashConfidence,
    severity: raw.severity as CrashSeverity,
    path: typeof raw.path === 'string' ? raw.path : 'unknown',
  };
}

export function decodeCrashSos(raw: unknown): CrashSos | null {
  if (!isObject(raw)) {
    return null;
  }
  const timestamp = num(raw.timestamp);
  const impactTimestamp = num(raw.impactTimestamp);
  const peakG = num(raw.peakG);
  if (
    typeof raw.sosId !== 'string' ||
    raw.sosId.length === 0 ||
    timestamp === null ||
    impactTimestamp === null ||
    peakG === null ||
    typeof raw.severity !== 'string' ||
    !SEVERITIES.includes(raw.severity) ||
    typeof raw.confidence !== 'string' ||
    !CONFIDENCES.includes(raw.confidence)
  ) {
    return null;
  }
  // A position is only trusted as a pair, and only if it is a real coordinate.
  const lat = num(raw.latitude);
  const lng = num(raw.longitude);
  const hasPosition = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    sosId: raw.sosId,
    timestamp,
    impactTimestamp,
    latitude: hasPosition ? lat : null,
    longitude: hasPosition ? lng : null,
    locationAgeMs: hasPosition ? num(raw.locationAgeMs) : null,
    speedBeforeImpactMps: num(raw.speedBeforeImpactMps),
    speedBeforeImpactKmh: num(raw.speedBeforeImpactKmh),
    severity: raw.severity as CrashSeverity,
    confidence: raw.confidence as CrashConfidence,
    path: typeof raw.path === 'string' ? raw.path : 'unknown',
    peakG,
    trigger: typeof raw.trigger === 'string' ? raw.trigger : 'expired',
  };
}

export function decodeMonitorStatus(raw: unknown): CrashMonitorStatus | null {
  if (!isObject(raw) || typeof raw.sensorsStalled !== 'boolean' || typeof raw.gnss !== 'string') {
    return null;
  }
  return { sensorsStalled: raw.sensorsStalled, gnss: raw.gnss };
}

export function decodeCalibration(raw: unknown): CrashCalibrationResult {
  if (!isObject(raw) || typeof raw.success !== 'boolean') {
    return { success: false, reason: 'no_data', deltaDeg: null };
  }
  return {
    success: raw.success,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    deltaDeg: num(raw.deltaDeg),
  };
}

/** One-line description of a native onCrashDecision payload for the diagnostics log. */
export function describeDecision(raw: unknown): string {
  if (!isObject(raw)) {
    return 'unreadable decision';
  }
  if (raw.outcome === 'rejected') {
    const peak = num(raw.peakG);
    return `rejected (${String(raw.reason)})${peak === null ? '' : `, peak ${peak.toFixed(1)} g`}`;
  }
  const e = isObject(raw.evidence) ? raw.evidence : {};
  const f = (v: unknown, digits = 1) => {
    const n = num(v);
    return n === null ? '-' : n.toFixed(digits);
  };
  return (
    `${String(e.path)}/${String(e.confidence)}: peak ${f(e.peakG)} g, gyro ${f(e.maxGyroRadS)} rad/s, ` +
    `tilt ${f(e.tiltDeg, 0)}°, still ${f((num(e.stillMs) ?? 0) / 1000)} s, ` +
    `speed ${f(e.preSpeedMps)}→${f(e.postSpeedMps)} m/s`
  );
}
