import React from 'react';
import {
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BrandLockup from '../components/BrandLockup';
import {
  color,
  primaryButtonStyle,
  secondaryButtonStyle,
  spacing,
  type,
} from '../theme';

const FEATURES = [
  { value: '10', label: 'riders in one room' },
  { value: 'LIVE', label: 'voice and location' },
  { value: 'MESH', label: 'hazards beyond signal' },
];

/** The logged-out front door. It gives the product a confident point of view
 * before asking the rider to make an account. */
export const Dashboard = ({ navigation }: any) => {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + spacing.xxl,
          paddingBottom: insets.bottom + spacing.xl,
        },
      ]}
    >
      <StatusBar barStyle="light-content" />

      <View style={styles.topBar}>
        <BrandLockup />
        <Text style={styles.topMeta}>GROUP INTERCOM</Text>
      </View>

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>BUILT FOR THE OPEN ROAD</Text>
        <Text style={styles.heroTitle}>Ride together.{`\n`}Stay in sync.</Text>
        <Text style={styles.heroSubtitle}>
          Clear group audio, live crew location, and spoken hazard
          alerts—without taking your hands off the bars.
        </Text>

        <View style={styles.featureRail}>
          {FEATURES.map((feature, index) => (
            <View
              key={feature.value}
              style={[
                styles.feature,
                index !== FEATURES.length - 1 && styles.featureBorder,
              ]}
            >
              <Text style={styles.featureValue}>{feature.value}</Text>
              <Text style={styles.featureLabel}>{feature.label}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={primaryButtonStyle}
          onPress={() => navigation?.navigate('LoginPage')}
          activeOpacity={0.88}
        >
          <Text style={styles.primaryText}>Sign in to ride</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={secondaryButtonStyle}
          onPress={() => navigation?.navigate('SignupPage')}
          activeOpacity={0.82}
        >
          <Text style={styles.secondaryText}>Create an account</Text>
        </TouchableOpacity>

        <Text style={styles.footnote}>
          Audio continues while your phone is locked.
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.bg,
    paddingHorizontal: spacing.xxl,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topMeta: { ...type.overline, color: color.textMuted, fontSize: 10 },
  hero: { flex: 1, justifyContent: 'center', paddingBottom: spacing.xl },
  eyebrow: { ...type.overline, color: color.accent, marginBottom: spacing.lg },
  heroTitle: { ...type.display, color: color.textPrimary, maxWidth: 340 },
  heroSubtitle: {
    ...type.subtitle,
    color: color.textSecondary,
    maxWidth: 355,
    marginTop: spacing.lg,
  },
  featureRail: {
    flexDirection: 'row',
    marginTop: spacing.xxxl,
    paddingVertical: spacing.lg,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: color.border,
  },
  feature: { flex: 1, paddingHorizontal: spacing.md },
  featureBorder: { borderRightWidth: 1, borderRightColor: color.border },
  featureValue: {
    color: color.textPrimary,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  featureLabel: {
    ...type.caption,
    color: color.textMuted,
    marginTop: spacing.xs,
  },
  actions: { gap: spacing.md },
  primaryText: { color: color.onAccent, fontSize: 16, fontWeight: '800' },
  secondaryText: { color: color.textPrimary, fontSize: 16, fontWeight: '700' },
  footnote: {
    ...type.caption,
    color: color.textMuted,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
});
