import { StyleSheet, Text, View } from 'react-native';
import { useIsMuted, useIsSpeaking } from '@livekit/react-native';
import { Track, type Participant } from 'livekit-client';
import { useParticipantConnectionQuality } from '../hooks/useParticipantConnectionQuality';
import { connectionQualityLabel, riderStatusLabel } from '../utils/riderPresence';
import { color, radius, spacing, type } from '../theme';

interface RiderRowProps {
  participant: Participant;
  isLocal: boolean;
}

export default function RiderRow({ participant, isLocal }: RiderRowProps) {
  const isSpeaking = useIsSpeaking(participant);
  const isMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const quality = useParticipantConnectionQuality(participant);
  const qualityLabel = connectionQualityLabel(quality);

  const statusLabel = riderStatusLabel(isMuted, isSpeaking, qualityLabel);
  const displayName = participant.name || participant.identity;

  return (
    <View style={[styles.row, isSpeaking && styles.rowSpeaking]}>
      <View style={[styles.avatar, isSpeaking && styles.avatarSpeaking]}>
        <Text style={[styles.avatarText, isSpeaking && styles.avatarTextSpeaking]}>
          {displayName.trim().charAt(0).toUpperCase() || 'R'}
        </Text>
      </View>
      <View style={styles.identity}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
          {isLocal ? <Text style={styles.youBadge}>YOU</Text> : null}
        </View>
        <Text style={styles.connectionCopy}>{isSpeaking ? 'Speaking now' : 'Connected to ride'}</Text>
      </View>
      {statusLabel ? (
        <View style={[styles.statusPill, isMuted && styles.statusPillMuted, qualityLabel && !isMuted && styles.statusPillWarning]}>
          <Text style={[styles.statusLabel, isMuted && styles.statusMuted, qualityLabel && !isMuted && styles.statusWarning]}>
            {statusLabel}
          </Text>
        </View>
      ) : <Text style={styles.readyLabel}>Ready</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 68,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    width: '100%',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    marginBottom: spacing.sm,
  },
  rowSpeaking: { backgroundColor: color.accentMuted, borderColor: color.accentBorder },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.border,
    marginRight: spacing.md,
  },
  avatarSpeaking: { backgroundColor: color.accent, borderColor: color.accent },
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
  connectionCopy: { ...type.caption, color: color.textMuted, marginTop: 2 },
  statusPill: { backgroundColor: color.successMuted, borderRadius: radius.pill, paddingVertical: 5, paddingHorizontal: spacing.sm },
  statusPillMuted: { backgroundColor: color.surfaceRaised },
  statusPillWarning: { backgroundColor: color.warningMuted },
  statusLabel: {
    fontSize: 11,
    color: color.success,
    fontWeight: '700',
  },
  statusMuted: {
    color: color.textMuted,
  },
  statusWarning: {
    color: color.warning,
  },
  readyLabel: { ...type.caption, color: color.textMuted, marginLeft: spacing.sm },
});
