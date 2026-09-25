import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  HAZARD_LABELS,
  type HazardPacket,
} from '../services/SpeechHazardService';
import { color, radius, spacing, type } from '../theme';
import { CRITICAL_HAZARDS, HazardGlyph } from './HazardIcons';

export const HAZARD_BANNER_MS = 5000;

export type HazardBannerKind = 'sent' | 'received';

interface HazardAlertBannerProps {
  packet: HazardPacket;
  kind: HazardBannerKind;
  top: number;
  onDismiss: () => void;
}

export default function HazardAlertBanner({
  packet,
  kind,
  top,
  onDismiss,
}: HazardAlertBannerProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, HAZARD_BANNER_MS);
    return () => clearTimeout(timer);
  }, [packet.id, onDismiss]);

  const label = HAZARD_LABELS[packet.hazard];
  const isSent = kind === 'sent';
  const isCritical = CRITICAL_HAZARDS.has(packet.hazard);
  const tone = isSent
    ? color.success
    : isCritical
    ? color.danger
    : color.warning;
  const heading = isSent
    ? 'HAZARD SHARED'
    : isCritical
    ? 'CRITICAL HAZARD'
    : 'ROAD HAZARD';

  return (
    <Pressable
      style={[styles.banner, { top, borderColor: tone }]}
      onPress={onDismiss}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      accessibilityLabel={
        isSent ? `Hazard sent: ${label}` : `${packet.senderName}: ${label}`
      }
    >
      <View style={[styles.glyph, { backgroundColor: tone }]}>
        <HazardGlyph type={packet.hazard} size={26} color={color.bg} />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.heading, { color: tone }]}>{heading}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.byline} numberOfLines={1}>
          {isSent ? 'Sent to your group' : `Reported by ${packet.senderName}`}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 10,
    elevation: 10,
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    backgroundColor: color.surface,
  },
  glyph: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  copy: { flex: 1 },
  heading: { ...type.overline },
  label: {
    ...type.title,
    fontSize: 19,
    lineHeight: 24,
    color: color.textPrimary,
  },
  byline: { ...type.caption, color: color.textSecondary },
});
