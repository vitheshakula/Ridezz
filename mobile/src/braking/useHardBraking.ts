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

export const PEER_BRAKE_FLASH_MS = 4000;

export interface UseHardBrakingOptions {
  onLocalBraking: (event: HardBrakingDetected) => void;
  announce?: (text: string) => Promise<void> | void;
}

export function useHardBraking({ onLocalBraking, announce }: UseHardBrakingOptions): void {
  const onLocalRef = useRef(onLocalBraking);
  onLocalRef.current = onLocalBraking;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  useEffect(
    () =>
      subscribeToBrakingEvents({
        onHardBraking: event => {
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
