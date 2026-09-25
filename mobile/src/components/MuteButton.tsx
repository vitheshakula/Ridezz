import { Pressable, StyleSheet, Text } from 'react-native';

interface MuteButtonProps {
  muted: boolean;
  onPress: () => void;
  /** 'large' is the primary tactile control on the Intercom tab (glove-friendly
   * tap target). 'small' is a compact floating variant for the Map tab, where
   * the map itself is the primary content and the button just needs to stay
   * reachable, not dominate the screen. */
  size?: 'large' | 'small';
}

export default function MuteButton({ muted, onPress, size = 'large' }: MuteButtonProps) {
  const isSmall = size === 'small';
  return (
    <Pressable
      style={[
        styles.button,
        isSmall ? styles.small : styles.large,
        muted ? styles.muted : styles.unmuted,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
    >
      {isSmall ? (
        <Text style={styles.smallIcon}>{muted ? '🔇' : '🎙️'}</Text>
      ) : (
        <Text style={styles.label}>{muted ? 'UNMUTE' : 'MUTE'}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  large: {
    width: 180,
    height: 180,
    borderRadius: 90,
  },
  small: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
  },
  unmuted: {
    backgroundColor: '#238636',
  },
  muted: {
    backgroundColor: '#da3633',
  },
  label: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 1,
  },
  smallIcon: {
    fontSize: 24,
  },
});
