import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { HAZARD_LABELS, type HazardPacket } from '../services/SpeechHazardService';
import { brand, font, homeType } from '../homeTheme';
import { CRITICAL_HAZARDS, HazardGlyph } from './HazardIcons';

/** How long a hazard banner stays up before it dismisses itself. */
export const HAZARD_BANNER_MS = 5000;

export type HazardBannerKind = 'sent' | 'received';

interface HazardAlertBannerProps {
  packet: HazardPacket;
  /** 'sent': this rider's own detected hazard, shown as immediate send confirmation.
   * 'received': a hazard that arrived from another rider, over the cloud or the mesh. */
  kind: HazardBannerKind;
  top: number;
  onDismiss: () => void;
}

export default function HazardAlertBanner({ packet, kind, top, onDismiss }: HazardAlertBannerProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, HAZARD_BANNER_MS);
    return () => clearTimeout(timer);
  }, [packet.id, onDismiss]);

  const label = HAZARD_LABELS[packet.hazard];
  const isSent = kind === 'sent';
  // Received alerts: red for critical categories, amber for cautions. Sent: green confirmation.
  const tone = isSent ? brand.success : CRITICAL_HAZARDS.has(packet.hazard) ? brand.danger : brand.warning;
  const heading = isSent ? 'HAZARD SENT' : CRITICAL_HAZARDS.has(packet.hazard) ? 'CRITICAL HAZARD' : 'ROAD HAZARD';

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
        <HazardGlyph type={packet.hazard} size={28} color={brand.darkest} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.heading, { color: tone }]}>{heading}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.by} numberOfLines={1}>
          {isSent ? 'Sent to your group' : `Reported by ${packet.senderName}`}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 10,
    elevation: 10,
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 2,
    padding: 12,
    backgroundColor: brand.card,
  },
  glyph: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1 },
  heading: { ...homeType.labelSmall },
  label: { fontFamily: font.heading, fontSize: 20, lineHeight: 26, color: brand.textPrimary },
  by: { ...homeType.bodySmall, color: brand.textSecondary },
});
