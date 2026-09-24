import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { HAZARD_LABELS, type HazardPacket } from '../services/SpeechHazardService';

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

  const label = HAZARD_LABELS[packet.hazard].toUpperCase();

  return (
    <Pressable
      style={[styles.banner, kind === 'sent' ? styles.bannerSent : styles.bannerReceived, { top }]}
      onPress={onDismiss}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text style={styles.title}>
        {kind === 'sent' ? `HAZARD SENT: ${label}` : `${packet.senderName.toUpperCase()}: ${label}`}
      </Text>
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
    borderRadius: 12,
    borderWidth: 2,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  // Received: this rider did not send it -- an alert from someone else, in red.
  bannerReceived: { backgroundColor: '#dc2626', borderColor: '#ef4444' },
  // Sent: this rider's own detected hazard -- a confirmation, not an alert, in green.
  bannerSent: { backgroundColor: '#16a34a', borderColor: '#22c55e' },
  title: { color: '#ffffff', fontSize: 18, fontWeight: '800', letterSpacing: 1 },
});
