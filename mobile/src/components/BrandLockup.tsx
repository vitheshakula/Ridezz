import { StyleSheet, Text, View } from 'react-native';
import { color, spacing, type } from '../theme';

interface BrandLockupProps {
  compact?: boolean;
  inverse?: boolean;
}

/** A code-native wordmark keeps the brand crisp on every density without
 * pretending an emoji is a logo. It is intentionally simple until a final
 * production brand asset is supplied. */
export default function BrandLockup({ compact = false, inverse = false }: BrandLockupProps) {
  return (
    <View style={styles.row} accessibilityLabel="Rideaze">
      <Text style={[styles.wordmark, compact && styles.wordmarkCompact]}>
        RIDE<Text style={inverse ? styles.inverseAccent : styles.accent}>AZE</Text>
      </Text>
      {!compact ? <View style={styles.signalDot} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wordmark: {
    ...type.overline,
    color: color.textPrimary,
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: 2.4,
  },
  wordmarkCompact: { fontSize: 14, lineHeight: 18, letterSpacing: 2 },
  accent: { color: color.accent },
  inverseAccent: { color: color.textPrimary },
  signalDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: color.accent,
    marginLeft: spacing.sm,
  },
});
