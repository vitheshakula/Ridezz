import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import BrandLockup from '../components/BrandLockup';
import { color, radius, spacing, type } from '../theme';

export const ForgotPassword = ({ navigation }: any) => {
  return (
    <View style={styles.container}>
      <BrandLockup />
      <View style={styles.card}>
        <Text style={styles.eyebrow}>ACCOUNT ACCESS</Text>
        <Text style={styles.title}>Password reset is coming soon.</Text>
        <Text style={styles.description}>
          For now, contact your Rideaze server administrator to restore access to your account.
        </Text>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.navigate('LoginPage')}
          activeOpacity={0.85}
        >
          <Text style={styles.backButtonText}>Back to sign in</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg, padding: spacing.xxl, paddingTop: spacing.huge },
  card: {
    marginTop: 'auto',
    marginBottom: 'auto',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.xl,
    padding: spacing.xxl,
  },
  eyebrow: { ...type.overline, color: color.accent, marginBottom: spacing.md },
  title: { ...type.title, fontSize: 28, lineHeight: 34, color: color.textPrimary, marginBottom: spacing.md },
  description: { ...type.body, color: color.textSecondary, marginBottom: spacing.xxl },
  backButton: {
    minHeight: 50,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: { color: color.textPrimary, fontWeight: '700', fontSize: 15 },
});
