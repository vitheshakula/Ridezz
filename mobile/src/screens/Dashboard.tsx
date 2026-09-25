import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, spacing, type, primaryButtonStyle, secondaryButtonStyle } from '../theme';

const FEATURES: Array<{ icon: string; label: string }> = [
  { icon: '🎙️', label: 'Full-duplex voice, up to 10 riders' },
  { icon: '📍', label: 'Live group location on the map' },
  { icon: '🔒', label: 'Keeps talking with the phone locked' },
];

/** Unauthenticated landing screen -- Sign In / Create Account. Only ever reached
 * while logged out: App.tsx routes any logged-in user straight to JoinScreen. */
export const Dashboard = ({ navigation }: any) => {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xxl }]}>
      <StatusBar barStyle="light-content" />

      <View style={styles.centerContent}>
        <View style={styles.logoBadge}>
          <Text style={styles.logoBadgeText}>⚡</Text>
        </View>

        <Text style={styles.welcomeTitle}>Welcome to Rideaze</Text>
        <Text style={styles.heroSubtitle}>
          Budget motorcycle group intercom for riders who want to stay connected on the road.
        </Text>

        <View style={styles.featureList}>
          {FEATURES.map(f => (
            <View key={f.label} style={styles.featureRow}>
              <Text style={styles.featureIcon}>{f.icon}</Text>
              <Text style={styles.featureLabel}>{f.label}</Text>
            </View>
          ))}
        </View>

        <View style={styles.authButtonGroup}>
          <TouchableOpacity
            style={primaryButtonStyle}
            onPress={() => navigation?.navigate('LoginPage')}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>SIGN IN</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={secondaryButtonStyle}
            onPress={() => navigation?.navigate('SignupPage')}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>CREATE ACCOUNT</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg, paddingHorizontal: spacing.xxl },
  centerContent: { flex: 1, justifyContent: 'center' },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: color.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: color.border,
  },
  logoBadgeText: { fontSize: 28 },
  welcomeTitle: { ...type.hero, color: color.textPrimary, marginBottom: spacing.sm },
  heroSubtitle: { ...type.subtitle, color: color.textSecondary, marginBottom: spacing.xxl, lineHeight: 21 },
  featureList: { marginBottom: spacing.xxxl, gap: spacing.md },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  featureIcon: { fontSize: 18, width: 26 },
  featureLabel: { ...type.caption, color: color.textSecondary, flex: 1 },
  authButtonGroup: { width: '100%', gap: spacing.md },
  primaryBtnText: { color: color.onAccent, fontSize: 15, fontWeight: '800', letterSpacing: 1 },
  secondaryBtnText: { color: color.textPrimary, fontSize: 15, fontWeight: '700', letterSpacing: 1 },
});
