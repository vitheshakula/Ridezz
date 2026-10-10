import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';
import { brand, font, homeType } from '../homeTheme';
import type { CrashState } from '../crash/crashTypes';
import { logDiagnosticEvent } from '../services/diagnosticsLog';

interface CrashAlertModalProps {
  state: CrashState;
  /** Distance from the top of the screen: the hazard banner slot under the HUD. */
  top: number;
  /** Cancels a running countdown (calls cancelCrashAlert on the native bridge). */
  onCancel: () => void;
  /** Skip the rest of the countdown and alert the group now. */
  onSendNow: () => void;
  /** Dismiss the "SOS dispatched" screen. */
  onAcknowledge: () => void;
}

/** Stage 1: quick window to cancel a false trigger. Stage 2 is whatever remains of the countdown. */
export const QUICK_CANCEL_MS = 10_000;
/** How long the "motion detected" notice stays after the phone sees normal riding resume. */
export const MOTION_NOTICE_MS = 3000;
const TICK_MS = 100;

/**
 * Vibration patterns. Index 0 is the gentle stage-1 pulse; 1-3 escalate through the check-in
 * window: the buzz gets longer and the pauses shorter as the deadline nears.
 */
export const VIBRATION_STAGES: readonly number[][] = [
  [0, 300, 700],
  [0, 400, 600],
  [0, 500, 300],
  [0, 700, 120],
];

/** Pattern index: 0 during stage 1, then 1/2/3 across thirds of the check-in window. */
export function vibrationStage(
  quickWindow: boolean,
  checkInFractionLeft: number,
): number {
  if (quickWindow) {
    return 0;
  }
  return checkInFractionLeft > 2 / 3 ? 1 : checkInFractionLeft > 1 / 3 ? 2 : 3;
}

/**
 * Compact two-stage crash card, anchored in the hazard banner slot so the map stays visible.
 *  - Stage 1 (first 10 s): pulsing "Crash Warning: 10s" and one Cancel (X) pill.
 *  - Stage 2 (rest of the countdown, 30 s with the default native setting): countdown, a green
 *    I'M OK and a red ALERT GROUP button, with escalating vibration.
 *  - Expiry: "SOS dispatched". The native service sends the SOS itself when the countdown ends.
 * If the phone sees normal riding resume it shows a brief "motion detected" notice instead.
 */
export default function CrashAlertModal({
  state,
  top,
  onCancel,
  onSendNow,
  onAcknowledge,
}: CrashAlertModalProps) {
  const counting = state.phase === 'countdown';
  const endsAt = state.countdownEndsAt;
  const totalMs =
    state.countdownMs && state.countdownMs > 0 ? state.countdownMs : 40_000;
  // A countdown no longer than the quick window is all stage 1.
  const quickMs = Math.min(QUICK_CANCEL_MS, totalMs);
  const motionResumed =
    state.phase === 'cancelled' && state.cancelReason === 'riding_resumed';
  const [now, setNow] = useState(() => Date.now());
  const [motionNoticeDone, setMotionNoticeDone] = useState(false);

  useEffect(() => {
    if (!counting) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [counting]);

  useEffect(() => {
    if (!motionResumed) {
      setMotionNoticeDone(false);
      return;
    }
    const id = setTimeout(() => setMotionNoticeDone(true), MOTION_NOTICE_MS);
    return () => clearTimeout(id);
  }, [motionResumed]);

  const msLeft = counting && endsAt ? Math.max(0, endsAt - now) : 0;
  const elapsedMs = totalMs - msLeft;
  const quickWindow = elapsedMs < quickMs;
  // Time and fraction left in the stage currently on screen.
  const stageMs = quickWindow ? quickMs : totalMs - quickMs;
  const stageLeftMs = quickWindow ? quickMs - elapsedMs : msLeft;
  const fractionLeft =
    stageMs > 0 ? Math.min(1, Math.max(0, stageLeftMs / stageMs)) : 0;
  const vibration = vibrationStage(quickWindow, fractionLeft);

  useEffect(() => {
    if (!counting) {
      return;
    }
    Vibration.vibrate(VIBRATION_STAGES[vibration], true);
    return () => Vibration.cancel();
  }, [counting, vibration]);

  // Pulsing warning dot, and a quick fade when stage 2 takes over so the switch is not abrupt.
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!counting) {
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.25,
          duration: 450,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 450,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [counting, pulse]);
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!counting) {
      return;
    }
    fade.setValue(0.3);
    Animated.timing(fade, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [counting, quickWindow, fade]);

  // One long buzz when the SOS goes out, so the rider knows without looking.
  const dispatched = state.phase === 'sos';
  useEffect(() => {
    if (dispatched) {
      Vibration.vibrate(800);
    }
  }, [dispatched]);

  if (motionResumed) {
    if (motionNoticeDone) {
      return null;
    }
    return (
      <View
        style={[styles.card, { top, borderColor: brand.warning }]}
        accessibilityLiveRegion="assertive"
        testID="crash-motion-notice"
      >
        <Text style={[styles.title, { color: brand.warning }]}>
          MOTION DETECTED
        </Text>
        <Text style={styles.sub}>
          Moving normally again, alert cancelled. Nobody was notified.
        </Text>
      </View>
    );
  }

  if (!counting && !dispatched) {
    return null;
  }

  const secondsLeft = Math.ceil(stageLeftMs / 1000);
  const tone = quickWindow ? brand.warning : brand.danger;

  if (dispatched) {
    return (
      <View
        style={[styles.card, { top, borderColor: brand.danger }]}
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
        testID="crash-alert-modal"
      >
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={[styles.title, { color: brand.danger }]}>
              SOS DISPATCHED
            </Text>
            <Text style={styles.sub}>
              Your group has your last known position.
            </Text>
          </View>
          <Pressable
            style={[styles.pill, styles.okFill]}
            onPress={onAcknowledge}
            accessibilityRole="button"
            accessibilityLabel="I'm OK, dismiss"
            testID="crash-acknowledge"
          >
            <Text style={styles.okLabel}>I&apos;M OK</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <Animated.View
      style={[styles.card, { top, borderColor: tone, opacity: fade }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      testID={quickWindow ? 'crash-stage-1' : 'crash-stage-2'}
    >
      <View style={styles.row}>
        <Animated.View
          style={[styles.dot, { backgroundColor: tone, opacity: pulse }]}
        />
        <Text
          style={[styles.title, styles.flex, { color: tone }]}
          accessibilityLabel={`${
            quickWindow ? 'Crash warning' : 'Are you OK'
          }, ${secondsLeft} seconds left`}
        >
          {quickWindow ? 'Crash Warning: ' : 'Are you OK? '}
          <Text testID="crash-seconds">{secondsLeft}</Text>s
        </Text>
        {quickWindow ? (
          <Pressable
            style={[styles.pill, styles.cancelFill]}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel, false alarm"
            testID="crash-cancel"
          >
            <Text style={styles.cancelLabel}>Cancel ✕</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.bar,
            { backgroundColor: tone, width: `${fractionLeft * 100}%` },
          ]}
          testID="crash-progress"
        />
      </View>
      {quickWindow ? null : (
        <>
          <Text style={styles.sub}>
            Your group is alerted when this reaches zero.
          </Text>
          <View style={styles.buttons}>
            <Pressable
              style={[styles.pill, styles.okFill, styles.flex]}
              onPress={() => {
                logDiagnosticEvent(
                  'crash_countdown',
                  'rider confirmed OK during check-in (no injury)',
                );
                onCancel();
              }}
              accessibilityRole="button"
              accessibilityLabel="I'm OK, cancel the alert"
              testID="crash-im-ok"
            >
              <Text style={styles.okLabel}>I&apos;M OK</Text>
            </Pressable>
            <Pressable
              style={[styles.pill, styles.alertFill, styles.flex]}
              onPress={onSendNow}
              accessibilityRole="button"
              accessibilityLabel="Alert my group now"
              testID="crash-send-now"
            >
              <Text style={styles.alertLabel}>ALERT GROUP</Text>
            </Pressable>
          </View>
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 20,
    elevation: 20,
    borderRadius: 16,
    borderWidth: 2,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 8,
    backgroundColor: brand.card,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex: { flex: 1 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  title: { fontFamily: font.heading, fontSize: 18, lineHeight: 24 },
  sub: { ...homeType.bodySmall, color: brand.textSecondary },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: brand.surfaceHighest,
  },
  bar: { height: 6, borderRadius: 3 },
  buttons: { flexDirection: 'row', gap: 10 },
  pill: {
    minHeight: 52,
    minWidth: 52,
    borderRadius: 26,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelFill: {
    backgroundColor: brand.primaryMuted,
    borderWidth: 1,
    borderColor: brand.primary,
  },
  cancelLabel: {
    fontFamily: font.headingExtraBold,
    fontSize: 16,
    color: brand.primary,
  },
  okFill: { backgroundColor: brand.success },
  okLabel: {
    fontFamily: font.headingExtraBold,
    fontSize: 16,
    color: brand.darkest,
  },
  alertFill: { backgroundColor: brand.danger },
  alertLabel: {
    fontFamily: font.headingExtraBold,
    fontSize: 16,
    color: '#FFFFFF',
  },
});
