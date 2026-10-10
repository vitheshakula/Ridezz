import { Pressable, StyleSheet, Text, View } from 'react-native';
import { brand, font, homeType } from '../homeTheme';
import { describeAlert, type PackAlert } from '../convoy/packAlerts';

interface PackAlertCardProps {
  /** The alert to feature (see mostSevere). */
  alert: PackAlert;
  /** How many further alerts are active. */
  moreCount: number;
  top: number;
  now: number;
  onDismiss: () => void;
}

const TONE = {
  BREAKDOWN: brand.danger,
  SEPARATION: brand.warning,
  LOST_CONTACT: brand.outline,
} as const;

const LABEL = {
  BREAKDOWN: 'BREAKDOWN',
  SEPARATION: 'SEPARATED',
  LOST_CONTACT: 'LOST CONTACT',
} as const;

/** Compact convoy card in the hazard banner slot: who, what, and how far. Does not cover the map. */
export default function PackAlertCard({
  alert,
  moreCount,
  top,
  now,
  onDismiss,
}: PackAlertCardProps) {
  const tone = TONE[alert.eventType];
  const { title, detail } = describeAlert(alert, now);
  return (
    <View
      style={[styles.card, { top, borderColor: tone }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="pack-alert-card"
    >
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <View style={styles.text}>
        <Text style={[styles.tag, { color: tone }]}>
          {LABEL[alert.eventType]}
          {moreCount > 0 ? `  +${moreCount} more` : ''}
        </Text>
        <Text style={styles.title} numberOfLines={2} testID="pack-alert-title">
          {title}
        </Text>
        {detail ? (
          <Text
            style={styles.detail}
            numberOfLines={1}
            testID="pack-alert-detail"
          >
            {detail}
          </Text>
        ) : null}
      </View>
      <Pressable
        style={styles.close}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss convoy alert"
        hitSlop={8}
        testID="pack-alert-dismiss"
      >
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 15,
    elevation: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 16,
    borderWidth: 2,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: brand.card,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  text: { flex: 1 },
  tag: { ...homeType.labelSmall },
  title: {
    fontFamily: font.heading,
    fontSize: 17,
    lineHeight: 22,
    color: brand.textPrimary,
  },
  detail: { ...homeType.bodySmall, color: brand.textSecondary },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: brand.surfaceHigh,
  },
  closeText: { fontFamily: font.bold, fontSize: 16, color: brand.textPrimary },
});
