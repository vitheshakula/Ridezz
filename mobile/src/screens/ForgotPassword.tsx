import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { color, spacing, type, cardStyle } from '../theme';

export const ForgotPassword = ({ navigation }: any) => {
  return (
    <View style={styles.container}>
      <View style={[cardStyle, styles.card]}>
        <View style={styles.iconCircle}>
          <Text style={styles.iconText}>✉</Text>
        </View>
        <Text style={styles.title}>Password Reset</Text>
        <Text style={styles.description}>
          Self-service password reset is currently under development. Contact your ride admin or server host to reset your password.
        </Text>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.navigate('LoginPage')}
          activeOpacity={0.85}
        >
          <Text style={styles.backButtonText}>← Back to Login</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg, justifyContent: 'center', padding: spacing.xxl },
  card: { alignItems: 'center' },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: color.accentMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  iconText: { fontSize: 24, color: color.accent },
  title: { ...type.title, color: color.textPrimary, marginBottom: spacing.md },
  description: { ...type.body, color: color.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: spacing.xxl },
  backButton: { backgroundColor: color.surfaceRaised, paddingVertical: spacing.md, paddingHorizontal: spacing.xxl, borderRadius: 8 },
  backButtonText: { color: color.accent, fontWeight: '600', fontSize: 14 },
});
