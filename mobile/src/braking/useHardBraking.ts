import { useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';
import { logDiagnosticEvent } from '../services/diagnosticsLog';
import type { BrakeAlert } from './brakePacket';
import {
  describeBrakingDecision,
  subscribeToBrakingEvents,
  subscribeToPeerBrakingAlerts,
  type HardBrakingDetected,
} from './brakingEvents';

/** How long the brake flasher stays up after the latest alert from a rider ahead. */
export const PEER_BRAKE_FLASH_MS = 4000;

export interface UseHardBrakingOptions {
  /** Hand this rider's own braking alert to the mesh (see createBrakeCoordinator). */
  onLocalBraking: (event: HardBrakingDetected) => void;
  /** Speaks a short line through the app's echo-guarded audio path. */
  announce?: (text: string) => Promise<void> | void;
}

/**
 * Local side of the hard-braking feature: when the native detector raises an alert, send it to the
 * group first, then give the rider a short haptic tick and a spoken confirmation. The native
 * detector runs inside the shared sensor monitor that useCrashDetection starts, so this hook only
 * listens; it does not start or stop any sensors.
 */
export function useHardBraking({ onLocalBraking, announce }: UseHardBrakingOptions): void {
  const onLocalRef = useRef(onLocalBraking);
  onLocalRef.current = onLocalBraking;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  useEffect(
    () =>
      subscribeToBrakingEvents({
        onHardBraking: event => {
          // Transmit before any presentation work: this is the latency-critical step.
          onLocalRef.current(event);
          logDiagnosticEvent(
            'braking',
            `hard braking ${event.peakDecelG.toFixed(2)} g at ${event.speedKmh.toFixed(0)} km/h ` +
              `(${event.source}, ${Math.max(0, event.raisedAt - event.onsetAt)} ms after onset)`,
          );
          Vibration.vibrate(150);
          Promise.resolve(announceRef.current?.('Warning sent.')).catch(() => {});
        },
        onDecision: raw => logDiagnosticEvent('braking', describeBrakingDecision(raw)),
      }),
    [],
  );
}

export interface UsePeerBrakingOptions {
  announce?: (text: string) => Promise<void> | void;
}

/**
 * Rider-behind side: the latest braking alert from another rider while it is still fresh, for the
 * brake flasher. Raises a strong vibration and a spoken warning for each new alert.
 */
export function usePeerBraking({ announce }: UsePeerBrakingOptions = {}): BrakeAlert | null {
  const [alert, setAlert] = useState<BrakeAlert | null>(null);
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const off = subscribeToPeerBrakingAlerts(next => {
      setAlert(next);
      clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setAlert(null), PEER_BRAKE_FLASH_MS);
      logDiagnosticEvent(
        'braking',
        `rider ahead braking ${next.peakDecelG.toFixed(2)} g at ${next.speedKmh.toFixed(0)} km/h`,
      );
      Vibration.vibrate([0, 250, 100, 250, 100, 400]);
      Promise.resolve(announceRef.current?.('Warning. Heavy braking ahead.')).catch(() => {});
    });
    return () => {
      off();
      clearTimeout(clearTimer.current);
    };
  }, []);

  return alert;
}
