import { useCallback, useEffect, useRef, useState } from 'react';
import { DevSettings } from 'react-native';
import {
  crashNative,
  isCrashDetectionAvailable,
  subscribeToCrashEvents,
} from './crashNative';
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
  /**
   * Called once per alert when a countdown runs out (or the rider skips it). Dispatch the SOS to
   * the group from here: the payload carries timestamp, position, speed before impact and severity.
   */
  onSos: (sos: CrashSos) => void;
  /**
   * Speaks a line through the app's audio path. RideScreen supplies one wrapped in its echo guard
   * so the always-on speech recogniser does not hear the phone's own announcement.
   */
  announce?: (text: string) => Promise<void> | void;
}

export interface UseCrashDetectionResult {
  state: CrashState;
  status: CrashSensorStatus;
  statusDetail: string | null;
  /** "I'm OK": cancels a running countdown. Also the hook for a voice override. */
  cancel(): void;
  sendNow(): void;
  acknowledge(): void;
  /** Pins the riding reference to the phone's current attitude. */
  calibrate(): Promise<CrashCalibrationResult>;
  /** Starts a countdown without any sensor evidence (debug builds only). */
  simulate(): void;
}

// Dev menu entries can only be added, never removed, so register once and route to whichever
// hook instance is currently mounted.
let devSimulate: (() => void) | null = null;
let devMenuRegistered = false;
function registerDevMenu(): void {
  if (!__DEV__ || devMenuRegistered) {
    return;
  }
  devMenuRegistered = true;
  DevSettings.addMenuItem('Rideaze: simulate crash', () => devSimulate?.());
}

/** Mirrors the native crash pipeline into React state and hands finished alerts to [onSos]. */
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

  // Native monitoring + event mirror.
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

    // An alert is delivered at most once, whether it arrives by event or by recovery.
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
        // 'countdown', 'cancelled' and 'sos' are set with their details by the handlers above.
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
          `accel ±${info.accelMaxRangeG.toFixed(1)} g, gyro ${info.hasGyroscope ? 'yes' : 'none'}, ` +
          `gravity ${info.hasGravity ? 'yes' : 'none'}, gnss ${info.gnss}`;
        logDiagnosticEvent('crash_sensors', `monitoring started: ${detail}`);
        if (!info.foregroundServiceActive) {
          logDiagnosticEvent(
            'crash_sensors',
            'no foreground service: Android may stop sensor delivery in the background',
          );
        }
        setStatus('active');
        setStatusDetail(detail);
        // Recover an alert that fired while no JS listener was attached.
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

  // Spoken reminders while a countdown runs (the escalating vibration lives in CrashAlertModal).
  // The wording avoids the app's hazard words ("crash", "accident", "help") so nothing hears itself.
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
