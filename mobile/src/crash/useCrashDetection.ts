import { useCallback, useEffect, useRef, useState } from 'react';
import { DevSettings } from 'react-native';
import { crashNative, isCrashDetectionAvailable, subscribeToCrashEvents } from './crashNative';
import {
  describeDecision,
  type CrashCalibrationResult,
  type CrashSos,
  type CrashState,
} from './crashTypes';
import { logDiagnosticEvent } from '../services/diagnosticsLog';

const REMINDER_MS = 8000;

export type CrashSensorStatus = 'off' | 'starting' | 'active' | 'unsupported' | 'error';

export interface UseCrashDetectionOptions {
  enabled: boolean;
  onSos: (sos: CrashSos) => void;
  announce?: (text: string) => Promise<void> | void;
}

export interface UseCrashDetectionResult {
  state: CrashState;
  status: CrashSensorStatus;
  statusDetail: string | null;
  cancel(): void;
  sendNow(): void;
  acknowledge(): void;
  calibrate(): Promise<CrashCalibrationResult>;
  simulate(): void;
}

let devSimulate: (() => void) | null = null;
let devMenuRegistered = false;
function registerDevMenu(): void {
  if (!__DEV__ || devMenuRegistered) {
    return;
  }
  devMenuRegistered = true;
  DevSettings.addMenuItem('Rideaze: simulate crash', () => devSimulate?.());
}

export function useCrashDetection({
  enabled,
  onSos,
  announce,
}: UseCrashDetectionOptions): UseCrashDetectionResult {
  const [state, setState] = useState<CrashState>({ phase: 'idle' });
  const [status, setStatus] = useState<CrashSensorStatus>('off');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);

  const onSosRef = useRef(onSos);
  onSosRef.current = onSos;
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const countdownEndsAtRef = useRef(0);
  const handledSosIds = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (!isCrashDetectionAvailable()) {
      setStatus('unsupported');
      setStatusDetail('Crash detection is not available on this platform');
      return;
    }
    let cancelled = false;
    setStatus('starting');

    const deliver = (sos: CrashSos) => {
      if (handledSosIds.current.has(sos.sosId)) {
        return;
      }
      handledSosIds.current.add(sos.sosId);
      logDiagnosticEvent('crash_sos', `alert sent (${sos.severity}, ${sos.trigger})`);
      onSosRef.current(sos);
      crashNative.consumePendingSos().catch(() => {});
    };

    const unsubscribe = subscribeToCrashEvents({
      onCandidate: candidate => {
        countdownEndsAtRef.current = Date.now() + candidate.countdownMs;
        setState({
          phase: 'countdown',
          confidence: candidate.confidence,
          severity: candidate.severity,
          countdownEndsAt: countdownEndsAtRef.current,
          countdownMs: candidate.countdownMs,
        });
        logDiagnosticEvent(
          'crash_countdown',
          `countdown started (${candidate.path}/${candidate.confidence}, ${candidate.severity})`,
        );
      },
      onCancelled: reason => {
        setState({ phase: 'cancelled', cancelReason: reason });
        logDiagnosticEvent('crash_countdown', `cancelled (${reason})`);
      },
      onCountdownExpired: sos => {
        setState(prev => ({ ...prev, phase: 'sos', countdownEndsAt: undefined }));
        deliver(sos);
      },
      onStateChanged: phase => {
        if (phase === 'idle') {
          setState({ phase: 'idle' });
        }
      },
      onDecision: raw => logDiagnosticEvent('crash_decision', describeDecision(raw)),
      onMonitorStatus: s => {
        logDiagnosticEvent(
          'crash_sensors',
          `sensors ${s.sensorsStalled ? 'STALLED' : 'ok'}, gnss ${s.gnss}`,
        );
        setStatusDetail(`gnss ${s.gnss}${s.sensorsStalled ? ', sensors stalled' : ''}`);
      },
    });

    crashNative
      .startMonitoring()
      .then(info => {
        if (cancelled) {
          return;
        }
        const detail =
          `accel ±${info.accelMaxRangeG.toFixed(1)} g, gyro ${
            info.hasGyroscope ? 'yes' : 'none'
          }, ` + `gravity ${info.hasGravity ? 'yes' : 'none'}, gnss ${info.gnss}`;
        logDiagnosticEvent('crash_sensors', `monitoring started: ${detail}`);
        if (!info.foregroundServiceActive) {
          logDiagnosticEvent(
            'crash_sensors',
            'no foreground service: Android may stop sensor delivery in the background',
          );
        }
        setStatus('active');
        setStatusDetail(detail);
        return crashNative.consumePendingSos().then(pending => {
          if (pending && !cancelled) {
            deliver(pending);
          }
        });
      })
      .catch((e: { code?: string; message?: string }) => {
        if (cancelled) {
          return;
        }
        const unsupported =
          e?.code === 'crash_unsupported_accelerometer' || e?.code === 'crash_no_accelerometer';
        setStatus(unsupported ? 'unsupported' : 'error');
        setStatusDetail(e?.message ?? 'unknown error');
        logDiagnosticEvent('crash_sensors', `start failed: ${e?.code ?? ''} ${e?.message ?? ''}`);
      });

    return () => {
      cancelled = true;
      unsubscribe();
      crashNative.stopMonitoring();
      setStatus('off');
    };
  }, [enabled]);

  useEffect(() => {
    if (state.phase !== 'countdown') {
      return;
    }
    const speak = () => {
      const seconds = Math.max(0, Math.round((countdownEndsAtRef.current - Date.now()) / 1000));
      Promise.resolve(
        announceRef.current?.(
          `Are you okay? Alerting your group in ${seconds} seconds. Tap I'm okay to cancel.`,
        ),
      ).catch(() => {});
    };
    speak();
    const reminder = setInterval(speak, REMINDER_MS);
    return () => clearInterval(reminder);
  }, [state.phase]);

  const simulate = useCallback(() => {
    crashNative.simulateCrash().catch(() => {});
  }, []);
  useEffect(() => {
    registerDevMenu();
    devSimulate = simulate;
    return () => {
      if (devSimulate === simulate) {
        devSimulate = null;
      }
    };
  }, [simulate]);

  return {
    state,
    status,
    statusDetail,
    cancel: useCallback(() => {
      crashNative.cancelCrashAlert().catch(() => {});
    }, []),
    sendNow: useCallback(() => {
      crashNative.sendAlertNow().catch(() => {});
    }, []),
    acknowledge: useCallback(() => {
      crashNative.acknowledgeAlert().catch(() => {});
    }, []),
    calibrate: crashNative.calibrateRidingAngle,
    simulate,
  };
}
