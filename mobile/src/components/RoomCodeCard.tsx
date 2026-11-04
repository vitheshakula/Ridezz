import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useRoomCode } from '../hooks/useRoomCode';
import { spacing } from '../theme';
import { brand, homeRadius, homeType } from '../homeTheme';

export const COPIED_FEEDBACK_MS = 2000;

export function RoomCodeCard() {
  const { roomCode, status, retry } = useRoomCode();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const handlePress = () => {
    if (status === 'error') {
      retry();
      return;
    }
    if (status !== 'ready' || !roomCode) {
      return;
    }
    Clipboard.setString(roomCode);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={
        status === 'ready'
          ? `Room Code: ${roomCode}. Tap to copy`
          : status === 'loading'
          ? 'Loading your room code'
          : 'Could not load your room code. Tap to retry'
      }
    >
      <Text style={styles.caption}>YOUR PERMANENT ROOM CODE</Text>

      {status === 'ready' ? (
        <>
          <Text style={styles.value}>
            Room Code: <Text style={styles.digits}>{roomCode}</Text>
          </Text>
          <Text style={[styles.hint, copied && styles.hintCopied]}>
            {copied
              ? 'Copied to clipboard'
              : 'Tap to copy. Share it so your group can join your ride.'}
          </Text>
        </>
      ) : status === 'loading' ? (
        <View style={styles.statusRow}>
          <ActivityIndicator color={brand.primary} />
          <Text style={styles.hint}>Getting your room code…</Text>
        </View>
      ) : (
        <Text style={[styles.hint, styles.hintError]}>
          Couldn't load your room code. Tap to try again.
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: brand.primaryMuted,
    borderRadius: homeRadius.card,
    borderWidth: 1,
    borderColor: brand.primaryBorder,
    padding: spacing.xl,
  },
  pressed: { opacity: 0.85 },
  caption: { ...homeType.labelSmall, color: brand.primary },
  value: { ...homeType.headlineSmall, color: brand.textPrimary },
  digits: { ...homeType.displayLarge, color: brand.primary, letterSpacing: 6 },
  hint: { ...homeType.bodySmall, color: brand.textSecondary, textAlign: 'center' },
  hintCopied: { color: brand.success },
  hintError: { color: brand.danger },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
