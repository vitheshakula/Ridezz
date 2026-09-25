import { Pressable, StyleSheet, Text } from 'react-native';
import { brand, homeType } from '../homeTheme';
import { MicIcon, MicOffIcon } from './HomeIcons';

interface MuteButtonProps {
  muted: boolean;
  onPress: () => void;
  /** 'large' is the hero voice control (80dp). 'small' is a 56dp variant for tighter layouts. */
  size?: 'large' | 'small';
  /** Lit while this rider is actually being heard (LiveKit's own speaking detection). */
  talking?: boolean;
}

export default function MuteButton({ muted, onPress, size = 'large', talking = false }: MuteButtonProps) {
  const isSmall = size === 'small';
  const iconColor = muted ? brand.textPrimary : brand.onPrimary;
  const iconSize = isSmall ? 24 : 32;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        isSmall ? styles.small : styles.large,
        muted ? styles.muted : styles.unmuted,
        talking && !muted && styles.talking,
        pressed && styles.pressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
    >
      {muted ? <MicOffIcon size={iconSize} color={iconColor} /> : <MicIcon size={iconSize} color={iconColor} />}
      {isSmall ? null : <Text style={[styles.label, { color: iconColor }]}>{muted ? 'UNMUTE' : 'MUTE'}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    borderWidth: 3,
  },
  large: { width: 80, height: 80, borderRadius: 40, gap: 2 },
  small: { width: 56, height: 56, borderRadius: 28 },
  unmuted: { backgroundColor: brand.primary, borderColor: 'rgba(18, 207, 228, 0.35)' },
  muted: { backgroundColor: brand.danger, borderColor: 'rgba(239, 68, 68, 0.4)' },
  talking: { borderColor: brand.success },
  pressed: { opacity: 0.85 },
  label: { ...homeType.labelSmall, letterSpacing: 0.6 },
});
