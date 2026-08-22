import { StyleSheet, Text, View } from 'react-native';
import { useIsMuted, useIsSpeaking } from '@livekit/react-native';
import { Track, type Participant } from 'livekit-client';
import { useParticipantConnectionQuality } from '../hooks/useParticipantConnectionQuality';
import { connectionQualityLabel, riderStatusLabel } from '../utils/riderPresence';

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

  return (
    <View style={styles.row}>
      <View style={[styles.dot, isSpeaking && styles.dotSpeaking]} />
      <Text style={styles.name} numberOfLines={1}>
        {participant.name || participant.identity}
      </Text>
      {isLocal ? <Text style={styles.youBadge}>You</Text> : null}
      {statusLabel ? (
        <Text style={[styles.statusLabel, isMuted && styles.statusMuted, qualityLabel && !isMuted && styles.statusWarning]}>
          {statusLabel}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    width: '100%',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#30363d',
    marginRight: 10,
  },
  dotSpeaking: {
    backgroundColor: '#3fb950',
  },
  name: {
    flex: 1,
    fontSize: 17,
    color: '#ffffff',
  },
  youBadge: {
    fontSize: 13,
    color: '#9ca3af',
    marginLeft: 8,
  },
  statusLabel: {
    fontSize: 13,
    color: '#3fb950',
    marginLeft: 8,
  },
  statusMuted: {
    color: '#9ca3af',
  },
  statusWarning: {
    color: '#d29922',
  },
});
