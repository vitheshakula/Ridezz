/**
 * Shared design tokens. Every screen should pull colors/spacing/radius/type
 * from here instead of hardcoding literals -- the pre-makeover inconsistency
 * (Dashboard's card at #1e1e1e, Login's input at #2a2a2a, Diagnostics modal's
 * background at #0d1117 vs every other screen's #121212) came directly from
 * each screen inventing its own values independently.
 */

export const color = {
  // Asphalt neutrals. The subtle warm cast keeps the UI from reading like a
  // generic developer-tool dark theme while preserving excellent contrast.
  bg: '#090B0C',
  bgSoft: '#0F1213',
  surface: '#141819',
  surfaceRaised: '#1A1F21',
  surfacePressed: '#22282A',
  border: '#272D2F',
  borderStrong: '#363E41',

  // Text
  textPrimary: '#F6F7F2',
  textSecondary: '#AAB1AD',
  textMuted: '#707975',

  // Brand
  accent: '#D7FF3F',
  accentPressed: '#BCE72D',
  accentMuted: 'rgba(215, 255, 63, 0.10)',
  accentBorder: 'rgba(215, 255, 63, 0.30)',
  onAccent: '#101300',

  // Status
  success: '#42D77D',
  successMuted: 'rgba(66, 215, 125, 0.12)',
  info: '#70A7FF',
  danger: '#FF665E',
  dangerMuted: 'rgba(239, 68, 68, 0.12)',
  dangerBorder: '#7f1d1d',
  warning: '#f59e0b',
  warningMuted: 'rgba(245, 158, 11, 0.14)',
  warningBorder: '#92400e',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 42, lineHeight: 46, fontWeight: '800' as const, letterSpacing: -1.4 },
  hero: { fontSize: 34, lineHeight: 39, fontWeight: '800' as const, letterSpacing: -0.8 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.35 },
  subtitle: { fontSize: 16, lineHeight: 23, fontWeight: '500' as const },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  overline: { fontSize: 11, lineHeight: 16, fontWeight: '700' as const, letterSpacing: 1.3, textTransform: 'uppercase' as const },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '500' as const },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: '500' as const },
} as const;

/** Common card container: consistent surface, border, radius, padding --
 * used so every screen's "content panel" reads as the same component. */
export const cardStyle = {
  backgroundColor: color.surface,
  borderRadius: radius.xl,
  borderWidth: 1,
  borderColor: color.border,
  padding: spacing.xl,
} as const;

export const primaryButtonStyle = {
  backgroundColor: color.accent,
  borderRadius: radius.md,
  minHeight: 54,
  paddingVertical: spacing.md,
  paddingHorizontal: spacing.xl,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};

export const secondaryButtonStyle = {
  backgroundColor: color.surfaceRaised,
  borderRadius: radius.md,
  minHeight: 54,
  paddingVertical: spacing.md,
  paddingHorizontal: spacing.xl,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  borderWidth: 1,
  borderColor: color.border,
};

export const inputStyle = {
  backgroundColor: color.surfaceRaised,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: color.border,
  paddingHorizontal: spacing.lg,
  minHeight: 52,
  paddingVertical: spacing.md,
  color: color.textPrimary,
  fontSize: 16,
};

export const shadow = {
  shadowColor: '#000000',
  shadowOffset: { width: 0, height: 12 },
  shadowOpacity: 0.24,
  shadowRadius: 24,
  elevation: 8,
} as const;
