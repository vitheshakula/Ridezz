import { StyleSheet, Text, View } from 'react-native';
import { useIsMuted, useIsSpeaking } from '@livekit/react-native';
import { Track, type Participant } from 'livekit-client';
import { useParticipantConnectionQuality } from '../hooks/useParticipantConnectionQuality';
import { connectionQualityLabel, riderStatusLabel } from '../utils/riderPresence';
import { brand, homeType } from '../homeTheme';
import { MicOffIcon } from './HomeIcons';

interface RiderRowProps {
  participant: Participant;
  isLocal: boolean;
  /** Straight-line distance from the local rider, already formatted (e.g. "240 m"); omitted when
   * either rider has no GPS fix. */
  distanceLabel?: string | null;
}

export default function RiderRow({ participant, isLocal, distanceLabel }: RiderRowProps) {
  const isSpeaking = useIsSpeaking(participant);
  const isMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const quality = useParticipantConnectionQuality(participant);
  const qualityLabel = connectionQualityLabel(quality);

  const statusLabel = riderStatusLabel(isMuted, isSpeaking, qualityLabel);
  const displayName = participant.name || participant.identity;
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';
  const weak = Boolean(qualityLabel) && !isMuted;
  const ring = isSpeaking ? brand.success : weak ? brand.warning : isMuted ? brand.outline : brand.success;

  return (
    <View style={styles.row}>
      <View style={[styles.avatar, { borderColor: ring }, isSpeaking && styles.avatarSpeaking]}>
        <Text style={styles.initial}>{initial}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {displayName}
          {isLocal ? <Text style={styles.youBadge}>  You</Text> : null}
        </Text>
        <Text style={[styles.status, weak && styles.statusWarning]} numberOfLines={1}>
          {statusLabel || 'Connected'}
          {distanceLabel && !isLocal ? `  ·  ${distanceLabel}` : ''}
        </Text>
      </View>
      {isMuted ? <MicOffIcon size={18} color={brand.outline} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
    width: '100%',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    backgroundColor: brand.darkest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarSpeaking: { backgroundColor: 'rgba(34, 197, 94, 0.18)' },
  initial: { ...homeType.labelLarge, color: brand.textPrimary },
  body: { flex: 1 },
  name: { ...homeType.labelLarge, fontSize: 15, color: brand.textPrimary },
  youBadge: { ...homeType.labelSmall, color: brand.primary },
  status: { ...homeType.bodySmall, color: brand.success },
  statusWarning: { color: brand.warning },
});
