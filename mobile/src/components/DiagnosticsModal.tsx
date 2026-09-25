import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDiagnosticsLog } from '../hooks/useDiagnosticsLog';
import type { DiagnosticEvent } from '../utils/diagnostics';
import { color, radius, spacing, type } from '../theme';

interface DiagnosticsModalProps {
  visible: boolean;
  onClose: () => void;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderItem({ item }: { item: DiagnosticEvent }) {
  return (
    <View style={styles.row}>
      <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
      <Text style={styles.message}>{item.message}</Text>
    </View>
  );
}

/** Read-only view of the in-memory session diagnostics log -- what a rider
 * needs to glance at during/after a road test without adb. Newest event first. */
export default function DiagnosticsModal({ visible, onClose }: DiagnosticsModalProps) {
  const events = useDiagnosticsLog();
  const reversed = [...events].reverse();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Diagnostics</Text>
          <Pressable style={styles.closeButton} onPress={onClose} hitSlop={8}>
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </View>
        {reversed.length === 0 ? (
          <Text style={styles.empty}>No events yet.</Text>
        ) : (
          <FlatList
            data={reversed}
            keyExtractor={(item, index) => `${item.timestamp}-${index}`}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.bg,
    paddingHorizontal: spacing.xl,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  title: { ...type.title, color: color.textPrimary },
  closeButton: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
  },
  closeButtonText: {
    color: color.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  empty: {
    color: color.textMuted,
    fontSize: 14,
    marginTop: spacing.xxl,
  },
  listContent: {
    paddingBottom: spacing.xxxl + spacing.sm,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  time: {
    color: color.textMuted,
    fontSize: 13,
    width: 76,
    fontVariant: ['tabular-nums'],
  },
  message: {
    color: color.textSecondary,
    fontSize: 14,
    flex: 1,
  },
});
