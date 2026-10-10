import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  decodeCalibration,
  decodeCrashCandidate,
  decodeCrashSos,
  decodeMonitorStatus,
  type CrashCalibrationResult,
  type CrashCandidate,
  type CrashMonitoringInfo,
  type CrashMonitorStatus,
  type CrashPhase,
  type CrashSos,
} from './crashTypes';

/** Optional tuning overrides for startMonitoring(); anything out of range keeps its default. */
export interface CrashMonitoringOptions {
  impactG?: number;
  rotationRadS?: number;
  tiltDeg?: number;
  countdownSeconds?: number;
  enableLowSpeedLaydown?: boolean;
}

interface CrashDetectionNative {
  startMonitoring(options: CrashMonitoringOptions | null): Promise<CrashMonitoringInfo>;
  stopMonitoring(): Promise<void>;
  cancelCrashAlert(): Promise<boolean>;
  sendAlertNow(): Promise<boolean>;
  acknowledgeAlert(): Promise<boolean>;
  calibrateRidingAngle(): Promise<unknown>;
  clearRidingCalibration(): Promise<boolean>;
  consumePendingSos(): Promise<unknown>;
  simulateCrash(): Promise<void>;
}

// Looked up per call (not captured at import) so it always reflects the registered native module.
const getNative = (): CrashDetectionNative | undefined => NativeModules.CrashDetection;

export const isCrashDetectionAvailable = (): boolean =>
  Platform.OS === 'android' && !!getNative();

function requireNative(): CrashDetectionNative {
  const native = getNative();
  if (Platform.OS !== 'android' || !native) {
    throw new Error('Crash detection is not available on this platform');
  }
  return native;
}

export const crashNative = {
  startMonitoring: (options?: CrashMonitoringOptions) =>
    requireNative().startMonitoring(options ?? null),
  stopMonitoring: (): Promise<void> =>
    isCrashDetectionAvailable() ? requireNative().stopMonitoring().catch(() => {}) : Promise.resolve(),
  /** "I'm OK" -- from a tap, or from a voice command once one is wired up. */
  cancelCrashAlert: () => requireNative().cancelCrashAlert(),
  sendAlertNow: () => requireNative().sendAlertNow(),
  acknowledgeAlert: () => requireNative().acknowledgeAlert(),
  /** Pins the riding reference to the phone's current attitude. Hold the phone steady ~2 s. */
  calibrateRidingAngle: async (): Promise<CrashCalibrationResult> =>
    decodeCalibration(await requireNative().calibrateRidingAngle()),
  clearRidingCalibration: () => requireNative().clearRidingCalibration(),
  /** An alert whose event may have been missed; returns it once and forgets it. */
  consumePendingSos: async (): Promise<CrashSos | null> =>
    decodeCrashSos(await requireNative().consumePendingSos()),
  simulateCrash: () => requireNative().simulateCrash(),
};

export interface CrashEventHandlers {
  onCandidate?: (candidate: CrashCandidate) => void;
  onCancelled?: (reason: string) => void;
  onCountdownExpired?: (sos: CrashSos) => void;
  onStateChanged?: (phase: CrashPhase) => void;
  onDecision?: (raw: unknown) => void;
  onMonitorStatus?: (status: CrashMonitorStatus) => void;
}

const PHASES: readonly string[] = ['idle', 'countdown', 'sos', 'cancelled'];

/** Subscribes to the native events. Malformed payloads are dropped. Returns an unsubscribe. */
export function subscribeToCrashEvents(handlers: CrashEventHandlers): () => void {
  const subs = [
    DeviceEventEmitter.addListener('onCrashCandidateDetected', (raw: unknown) => {
      const candidate = decodeCrashCandidate(raw);
      if (candidate) {
        handlers.onCandidate?.(candidate);
      }
    }),
    DeviceEventEmitter.addListener('onCrashCancelled', (raw: unknown) => {
      const reason = (raw as { reason?: unknown } | null)?.reason;
      handlers.onCancelled?.(typeof reason === 'string' ? reason : 'user');
    }),
    DeviceEventEmitter.addListener('onCountdownExpired', (raw: unknown) => {
      const sos = decodeCrashSos(raw);
      if (sos) {
        handlers.onCountdownExpired?.(sos);
      }
    }),
    DeviceEventEmitter.addListener('onCrashStateChanged', (raw: unknown) => {
      const phase = (raw as { phase?: unknown } | null)?.phase;
      if (typeof phase === 'string' && PHASES.includes(phase)) {
        handlers.onStateChanged?.(phase as CrashPhase);
      }
    }),
    DeviceEventEmitter.addListener('onCrashDecision', (raw: unknown) => handlers.onDecision?.(raw)),
    DeviceEventEmitter.addListener('onCrashMonitorStatus', (raw: unknown) => {
      const status = decodeMonitorStatus(raw);
      if (status) {
        handlers.onMonitorStatus?.(status);
      }
    }),
  ];
  return () => subs.forEach(sub => sub.remove());
}
