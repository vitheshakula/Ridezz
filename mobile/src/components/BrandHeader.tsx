import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { spacing } from '../theme';
import { brand, homeType } from '../homeTheme';
import { Logo } from './Logo';

interface BrandHeaderProps {
  subtitle: string;
  right?: React.ReactNode;
}

/** Top bar shared by the Home screens: logo mark, RIDEAZE wordmark, screen name, optional action. */
export function BrandHeader({ subtitle, right }: BrandHeaderProps) {
  return (
    <View style={styles.header}>
      <View style={styles.brand}>
        <Logo size={36} />
        <View>
          <Text style={styles.name}>RIDEAZE</Text>
          <Text style={styles.sub}>{subtitle}</Text>
        </View>
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    backgroundColor: 'rgba(12, 20, 30, 0.92)',
    borderBottomWidth: 1,
    borderBottomColor: brand.inputBorder,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { ...homeType.headlineSmall, color: brand.textPrimary, letterSpacing: 1 },
  sub: { ...homeType.labelSmall, color: brand.primary },
});
