import { Pressable, StyleSheet, Text } from 'react-native';

interface MuteButtonProps {
  muted: boolean;
  onPress: () => void;
}

export default function MuteButton({ muted, onPress }: MuteButtonProps) {
  return (
    <Pressable
      style={[styles.button, muted ? styles.muted : styles.unmuted]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
    >
      <Text style={styles.label}>{muted ? 'UNMUTE' : 'MUTE'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 200,
    height: 200,
    borderRadius: 100,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  unmuted: {
    backgroundColor: '#238636',
  },
  muted: {
    backgroundColor: '#da3633',
  },
  label: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
