import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
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

function formatLogForCopy(events: DiagnosticEvent[]): string {
  return events
    .map(e => `${new Date(e.timestamp).toISOString()}  ${e.type}  ${e.message}`)
    .join('\n');
}

function renderItem({ item }: { item: DiagnosticEvent }) {
  return (
    <View style={styles.row}>
      <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
      <Text style={styles.message}>{item.message}</Text>
    </View>
  );
}

export default function DiagnosticsModal({ visible, onClose }: DiagnosticsModalProps) {
  const events = useDiagnosticsLog();
  const reversed = [...events].reverse();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    Clipboard.setString(formatLogForCopy(events));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={[
          styles.container,
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Diagnostics</Text>
          <View style={styles.headerActions}>
            {events.length > 0 ? (
              <Pressable style={styles.closeButton} onPress={handleCopy} hitSlop={8}>
                <Text style={styles.closeButtonText}>{copied ? 'Copied' : 'Copy log'}</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.closeButton} onPress={onClose} hitSlop={8}>
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          </View>
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
  headerActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
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
