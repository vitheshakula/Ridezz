import { StyleSheet, Text, View } from 'react-native';
import { useIsMuted, useIsSpeaking } from '@livekit/react-native';
import { Track, type Participant } from 'livekit-client';
import { useParticipantConnectionQuality } from '../hooks/useParticipantConnectionQuality';
import {
  connectionQualityLabel,
  riderStatusLabel,
} from '../utils/riderPresence';
import { color, radius, spacing, type } from '../theme';
import { MicOffIcon } from './HomeIcons';

interface RiderRowProps {
  participant: Participant;
  isLocal: boolean;
  /** Straight-line distance from the local rider, when both riders have a GPS fix. */
  distanceLabel?: string | null;
}

export default function RiderRow({
  participant,
  isLocal,
  distanceLabel,
}: RiderRowProps) {
  const isSpeaking = useIsSpeaking(participant);
  const isMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const quality = useParticipantConnectionQuality(participant);
  const qualityLabel = connectionQualityLabel(quality);
  const statusLabel = riderStatusLabel(isMuted, isSpeaking, qualityLabel);
  const displayName = participant.name || participant.identity;
  const weak = Boolean(qualityLabel) && !isMuted;

  return (
    <View style={[styles.row, isSpeaking && styles.rowSpeaking]}>
      <View
        style={[
          styles.avatar,
          isSpeaking && styles.avatarSpeaking,
          weak && styles.avatarWarning,
        ]}
      >
        <Text
          style={[styles.avatarText, isSpeaking && styles.avatarTextSpeaking]}
        >
          {displayName.trim().charAt(0).toUpperCase() || 'R'}
        </Text>
      </View>

      <View style={styles.identity}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {displayName}
          </Text>
          {isLocal ? <Text style={styles.youBadge}>YOU</Text> : null}
        </View>
        <Text
          style={[styles.connectionCopy, weak && styles.connectionWarning]}
          numberOfLines={1}
        >
          {statusLabel || 'Connected'}
          {distanceLabel && !isLocal ? ` · ${distanceLabel}` : ''}
        </Text>
      </View>

      {isMuted ? (
        <View style={styles.mutedBadge}>
          <MicOffIcon size={16} color={color.textMuted} />
          <Text style={styles.mutedText}>Muted</Text>
        </View>
      ) : isSpeaking ? (
        <Text style={styles.speakingText}>Speaking</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    width: '100%',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    marginBottom: spacing.xs,
  },
  rowSpeaking: {
    backgroundColor: color.accentMuted,
    borderColor: color.accentBorder,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceRaised,
    borderWidth: 2,
    borderColor: color.success,
    marginRight: spacing.md,
  },
  avatarSpeaking: { backgroundColor: color.accent, borderColor: color.accent },
  avatarWarning: { borderColor: color.warning },
  avatarText: { color: color.textSecondary, fontSize: 15, fontWeight: '800' },
  avatarTextSpeaking: { color: color.onAccent },
  identity: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: {
    flexShrink: 1,
    fontSize: 16,
    color: color.textPrimary,
    fontWeight: '700',
  },
  youBadge: {
    ...type.overline,
    fontSize: 9,
    lineHeight: 13,
    color: color.accent,
    marginLeft: spacing.sm,
  },
  connectionCopy: { ...type.caption, color: color.success, marginTop: 2 },
  connectionWarning: { color: color.warning },
  mutedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: spacing.sm,
  },
  mutedText: {
    ...type.caption,
    color: color.textMuted,
    marginLeft: spacing.xs,
  },
  speakingText: {
    ...type.caption,
    color: color.accent,
    fontWeight: '700',
    marginLeft: spacing.sm,
  },
});
