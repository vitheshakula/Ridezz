import { Pressable, StyleSheet, Text } from 'react-native';
import { color, radius, spacing, type } from '../theme';

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
        <>
          <Text style={[styles.smallLabel, muted && styles.smallLabelMuted]}>MIC</Text>
          <Text style={[styles.smallState, muted && styles.smallStateMuted]}>
            {muted ? 'OFF' : 'ON'}
          </Text>
        </>
      ) : (
        <>
          <Text style={[styles.overline, muted && styles.overlineMuted]}>MICROPHONE</Text>
          <Text style={[styles.label, muted && styles.labelMuted]}>{muted ? 'Muted' : 'Live'}</Text>
          <Text style={[styles.helper, muted && styles.helperMuted]}>
            {muted ? 'Tap to speak' : 'Tap to mute'}
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
  large: {
    width: 184,
    height: 184,
    borderRadius: 46,
  },
  small: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
  },
  unmuted: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  muted: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.danger,
  },
  label: {
    color: color.onAccent,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '800',
    letterSpacing: -0.7,
    marginTop: spacing.xs,
  },
  labelMuted: { color: color.textPrimary },
  overline: { ...type.overline, color: 'rgba(16, 19, 0, 0.62)' },
  overlineMuted: { color: color.danger },
  helper: { ...type.caption, color: 'rgba(16, 19, 0, 0.72)', marginTop: spacing.sm },
  helperMuted: { color: color.textMuted },
  smallLabel: { ...type.overline, color: color.onAccent, fontSize: 9 },
  smallLabelMuted: { color: color.textMuted },
  smallState: { color: color.onAccent, fontSize: 16, fontWeight: '800', marginTop: 1 },
  smallStateMuted: { color: color.danger },
});
