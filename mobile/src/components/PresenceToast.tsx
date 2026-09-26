import { StyleSheet, Text, View } from 'react-native';

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
    top: 0,
    left: 24,
    right: 24,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  text: {
    color: '#c9d1d9',
    fontSize: 14,
  },
});
