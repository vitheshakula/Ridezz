import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useDiagnosticsLog } from '../hooks/useDiagnosticsLog';
import type { DiagnosticEvent } from '../utils/diagnostics';

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

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Diagnostics</Text>
          <Pressable style={styles.closeButton} onPress={onClose}>
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
    backgroundColor: '#0d1117',
    paddingTop: 56,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
  },
  closeButton: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    backgroundColor: '#21262d',
    borderRadius: 8,
  },
  closeButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  empty: {
    color: '#6b7280',
    fontSize: 14,
    marginTop: 24,
  },
  listContent: {
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
  },
  time: {
    color: '#6b7280',
    fontSize: 13,
    width: 76,
    fontVariant: ['tabular-nums'],
  },
  message: {
    color: '#c9d1d9',
    fontSize: 14,
    flex: 1,
  },
});
