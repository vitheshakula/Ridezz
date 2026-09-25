import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '../theme';
import { brand, homeType } from '../homeTheme';
import { PersonIcon, RidesIcon } from './HomeIcons';

export type NavTab = 'rides' | 'profile';

interface BottomNavProps {
  active: NavTab;
  onRides: () => void;
  onProfile: () => void;
}

/** Bottom navigation for the logged-in area. Only lists destinations that exist
 * (Rides = JoinScreen, Profile = ProfileScreen) -- no placeholder tabs. */
export function BottomNav({ active, onRides, onProfile }: BottomNavProps) {
  const insets = useSafeAreaInsets();
  const items: Array<{ key: NavTab; label: string; onPress: () => void; Icon: typeof PersonIcon }> = [
    { key: 'rides', label: 'Rides', onPress: onRides, Icon: RidesIcon },
    { key: 'profile', label: 'Profile', onPress: onProfile, Icon: PersonIcon },
  ];

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.sm }]}>
      {items.map(({ key, label, onPress, Icon }) => {
        const isActive = key === active;
        const tint = isActive ? brand.primary : brand.outline;
        return (
          <TouchableOpacity
            key={key}
            style={styles.item}
            onPress={onPress}
            activeOpacity={0.8}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
          >
            <Icon size={22} color={tint} />
            <Text style={[styles.label, { color: tint }]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: brand.surface,
    borderTopWidth: 1,
    borderTopColor: brand.inputBorder,
    paddingTop: spacing.sm,
  },
  item: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  label: { ...homeType.labelSmall },
});
