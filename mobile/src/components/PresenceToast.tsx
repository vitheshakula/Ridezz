import { StyleSheet, Text, View } from 'react-native';
import { color, radius, spacing, type } from '../theme';

interface PresenceToastProps {
  message: string;
}

/** Non-blocking, auto-dismissing banner -- never something the rider has to tap
 * away. See useRiderPresenceToasts for the queue/timing that drives this. */
export default function PresenceToast({ message }: PresenceToastProps) {
  return (
    <View style={styles.container} pointerEvents="none">
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.xxl,
    right: spacing.xxl,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    zIndex: 20,
    elevation: 10,
  },
  text: {
    ...type.label,
    color: color.textPrimary,
  },
});
