import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StatusBar, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '../theme';
import { brand, homeRadius, homeType } from '../homeTheme';
import { LockIcon, MicIcon, PinIcon } from '../components/HomeIcons';
import { BrandHeader } from '../components/BrandHeader';

const FEATURES: Array<{ Icon: React.ComponentType<{ size?: number; color: string }>; label: string; color: string }> = [
  { Icon: MicIcon, label: 'Full-duplex voice, up to 10 riders', color: brand.primary },
  { Icon: PinIcon, label: 'Live group location on the map', color: brand.secondary },
  { Icon: LockIcon, label: 'Keeps talking with the phone locked', color: brand.tertiary },
];

/** Unauthenticated landing screen -- Sign In / Create Account. Only ever reached
 * while logged out: App.tsx routes any logged-in user straight to JoinScreen. */
export const Dashboard = ({ navigation }: any) => {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" />

      <BrandHeader subtitle="DASHBOARD" />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxxl }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Ready to ride?</Text>
          <Text style={styles.heroSubtitle}>
            Budget motorcycle group intercom for riders who want to stay connected on the road.
          </Text>
        </View>

        <View style={styles.featureCard}>
          {FEATURES.map(({ Icon, label, color }) => (
            <View key={label} style={styles.featureRow}>
              <View style={[styles.featureIcon, { borderColor: color }]}>
                <Icon size={18} color={color} />
              </View>
              <Text style={styles.featureLabel}>{label}</Text>
            </View>
          ))}
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation?.navigate('LoginPage')}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>SIGN IN</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => navigation?.navigate('SignupPage')}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>CREATE ACCOUNT</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: brand.bg },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing.xl, paddingTop: spacing.xxl, gap: spacing.xl },
  hero: { gap: spacing.sm },
  heroTitle: { ...homeType.displayLarge, color: brand.textPrimary },
  heroSubtitle: { ...homeType.bodyMedium, color: brand.textSecondary },
  featureCard: {
    backgroundColor: brand.card,
    borderRadius: homeRadius.card,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    backgroundColor: brand.darkest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureLabel: { ...homeType.bodyMedium, color: brand.textPrimary, flex: 1 },
  actions: { gap: spacing.md },
  primaryBtn: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: homeRadius.button,
    backgroundColor: brand.primary,
  },
  primaryBtnText: { ...homeType.button, color: brand.onPrimary },
  secondaryBtn: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: homeRadius.button,
    backgroundColor: brand.card,
    borderWidth: 1,
    borderColor: brand.outlineVariant,
  },
  secondaryBtnText: { ...homeType.button, color: brand.textPrimary },
});
