import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { brand, font, homeType } from '../homeTheme';
import type { CrashState } from '../crash/crashTypes';

interface CrashCountdownProps {
  state: CrashState;
  /** "I'm OK": cancels a running countdown. */
  onCancel: () => void;
  /** Skip the rest of the countdown and alert the group now. */
  onSendNow: () => void;
  /** Dismiss the "alert sent" screen. */
  onAcknowledge: () => void;
}

/**
 * Full-screen "Are you OK?" overlay. Rendered only while a crash countdown is running or an alert
 * has just been sent; it covers the ride screen so a rider (or a bystander) cannot miss it, and its
 * main control is one large button because it may be pressed with a gloved hand.
 */
export default function CrashCountdown({
  state,
  onCancel,
  onSendNow,
  onAcknowledge,
}: CrashCountdownProps) {
  const counting = state.phase === 'countdown';
  const endsAt = state.countdownEndsAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!counting) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [counting]);

  if (state.phase !== 'countdown' && state.phase !== 'sos') {
    return null;
  }

  const secondsLeft = counting && endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;

  return (
    <View style={styles.overlay} accessibilityViewIsModal accessibilityLiveRegion="assertive">
      {counting ? (
        <>
          <Text style={styles.heading}>ARE YOU OK?</Text>
          <Text style={styles.count} accessibilityLabel={`${secondsLeft} seconds left`}>
            {secondsLeft}
          </Text>
          <Text style={styles.body}>
            A possible crash was detected. Your group is alerted when this reaches zero.
          </Text>
          <Pressable
            style={styles.okButton}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="I'm OK, cancel the alert"
          >
            <Text style={styles.okLabel}>I&apos;M OK</Text>
          </Pressable>
          <Pressable
            style={styles.sendButton}
            onPress={onSendNow}
            accessibilityRole="button"
            accessibilityLabel="Alert my group now"
          >
            <Text style={styles.sendLabel}>ALERT GROUP NOW</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.heading}>ALERT SENT</Text>
          <Text style={styles.body}>
            Your group has been told you may be down. Tap below when you are safe.
          </Text>
          <Pressable
            style={styles.okButton}
            onPress={onAcknowledge}
            accessibilityRole="button"
            accessibilityLabel="I'm OK, dismiss"
          >
            <Text style={styles.okLabel}>I&apos;M OK</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: '#B91C1C',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  heading: {
    ...homeType.headlineLarge,
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  count: {
    fontFamily: font.headingExtraBold,
    fontSize: 120,
    lineHeight: 132,
    color: '#FFFFFF',
    marginVertical: 8,
  },
  body: {
    ...homeType.bodyLarge,
    color: '#FEE2E2',
    textAlign: 'center',
    marginBottom: 32,
  },
  okButton: {
    width: '100%',
    minHeight: 96,
    borderRadius: 20,
    backgroundColor: brand.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  okLabel: {
    fontFamily: font.headingExtraBold,
    fontSize: 32,
    color: brand.darkest,
  },
  sendButton: {
    marginTop: 16,
    width: '100%',
    minHeight: 56,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendLabel: {
    fontFamily: font.heading,
    fontSize: 16,
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
});
