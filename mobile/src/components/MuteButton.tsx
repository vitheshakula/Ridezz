import { Pressable, StyleSheet, Text } from 'react-native';
import { color, radius, spacing, type } from '../theme';
import { MicIcon, MicOffIcon } from './HomeIcons';

interface MuteButtonProps {
  muted: boolean;
  onPress: () => void;
  size?: 'large' | 'small';
  /** Lit while LiveKit reports that this rider is actively speaking. */
  talking?: boolean;
}

export default function MuteButton({
  muted,
  onPress,
  size = 'large',
  talking = false,
}: MuteButtonProps) {
  const isSmall = size === 'small';
  const iconColor = muted ? color.textPrimary : color.onAccent;
  const iconSize = isSmall ? 22 : 30;

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
      {muted ? (
        <MicOffIcon size={iconSize} color={iconColor} />
      ) : (
        <MicIcon size={iconSize} color={iconColor} />
      )}
      {isSmall ? null : (
        <>
          <Text style={[styles.overline, muted && styles.overlineMuted]}>
            MICROPHONE
          </Text>
          <Text style={[styles.label, muted && styles.labelMuted]}>
            {muted ? 'Muted' : 'Live'}
          </Text>
          <Text style={[styles.helper, muted && styles.helperMuted]}>
            {muted
              ? 'Tap to speak'
              : talking
              ? 'Your crew can hear you'
              : 'Tap to mute'}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    borderWidth: 1,
  },
  large: { width: 152, height: 152, borderRadius: 40 },
  small: { width: 58, height: 58, borderRadius: radius.lg },
  unmuted: { backgroundColor: color.accent, borderColor: color.accent },
  muted: { backgroundColor: color.surfaceRaised, borderColor: color.danger },
  talking: { borderWidth: 4, borderColor: color.success },
  pressed: { opacity: 0.84, transform: [{ scale: 0.98 }] },
  overline: {
    ...type.overline,
    color: 'rgba(16, 19, 0, 0.62)',
    marginTop: spacing.xs,
  },
  overlineMuted: { color: color.danger },
  label: {
    color: color.onAccent,
    fontSize: 28,
    lineHeight: 33,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  labelMuted: { color: color.textPrimary },
  helper: {
    ...type.caption,
    color: 'rgba(16, 19, 0, 0.72)',
    marginTop: spacing.xs,
  },
  helperMuted: { color: color.textMuted },
});
