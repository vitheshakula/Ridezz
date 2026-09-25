import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { spacing } from '../theme';
import { brand, homeRadius, homeType } from '../homeTheme';
import { BottomNav } from '../components/BottomNav';
import { LogoutIcon, StatusDot } from '../components/HomeIcons';
import { BrandHeader } from '../components/BrandHeader';

interface ProfileScreenProps {
  navigation?: { navigate: (screen: 'JoinScreen' | 'ProfileScreen' | 'LoginPage') => void };
}

/** Rider profile. Shows only what the app actually knows about the signed-in rider
 * (name, email, whether Google verified the address) plus the existing Log Out action.
 * Hardware / mesh / SOS preferences from the design are not shown: no such settings exist yet. */
export default function ProfileScreen({ navigation }: ProfileScreenProps) {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const name = user?.name || 'Rider';
  const initial = name.trim().charAt(0).toUpperCase() || 'R';

  const handleLogout = async () => {
    await logout();
    navigation?.navigate('LoginPage');
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <BrandHeader subtitle="RIDER PROFILE" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Profile</Text>

        <View style={styles.identityCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.email} numberOfLines={1}>
            {user?.email || ''}
          </Text>
          {user?.emailVerified ? (
            <View style={styles.badge}>
              <StatusDot color={brand.success} size={6} />
              <Text style={styles.badgeText}>Google verified</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ACCOUNT</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Rider name</Text>
            <Text style={styles.rowValue} numberOfLines={1}>
              {name}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Email</Text>
            <Text style={styles.rowValue} numberOfLines={1}>
              {user?.email || '—'}
            </Text>
          </View>
        </View>

        <View style={styles.danger}>
          <Text style={styles.dangerTitle}>DANGER ZONE</Text>
          <Text style={styles.dangerText}>Signs you out of this device.</Text>
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.85}>
            <LogoutIcon size={18} color="#f87171" />
            <Text style={styles.logoutText}>LOG OUT</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <BottomNav
        active="profile"
        onRides={() => navigation?.navigate('JoinScreen')}
        onProfile={() => navigation?.navigate('ProfileScreen')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: brand.bg },
  content: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, gap: spacing.lg },
  title: { ...homeType.headlineLarge, color: brand.textPrimary },

  identityCard: {
    alignItems: 'center',
    backgroundColor: brand.card,
    borderRadius: homeRadius.card,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    padding: spacing.xl,
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: brand.primaryMuted,
    borderWidth: 2,
    borderColor: brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...homeType.displayLarge, color: brand.primary },
  name: { ...homeType.headlineMedium, color: brand.textPrimary, marginTop: spacing.md },
  email: { ...homeType.bodyMedium, color: brand.textSecondary, marginTop: spacing.xs },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm - 2,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 1,
    borderRadius: homeRadius.pill,
    backgroundColor: brand.darkest,
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  badgeText: { ...homeType.labelSmall, color: brand.textSecondary },

  section: {
    backgroundColor: brand.card,
    borderRadius: homeRadius.card,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: { ...homeType.labelSmall, color: brand.outline, marginBottom: spacing.xs },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: homeRadius.input,
    backgroundColor: brand.surfaceLow,
  },
  rowLabel: { ...homeType.labelLarge, color: brand.textPrimary },
  rowValue: { ...homeType.bodyMedium, color: brand.textSecondary, flexShrink: 1, textAlign: 'right' },

  danger: {
    backgroundColor: brand.dangerMuted,
    borderRadius: homeRadius.card,
    borderWidth: 1,
    borderColor: brand.dangerBorder,
    padding: spacing.lg,
  },
  dangerTitle: { ...homeType.labelSmall, color: '#f87171' },
  dangerText: { ...homeType.bodySmall, color: brand.textSecondary, marginTop: spacing.xs },
  logoutBtn: {
    minHeight: 52,
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: homeRadius.button,
    backgroundColor: brand.darkest,
  },
  logoutText: { ...homeType.button, color: '#f87171' },
});
