export const color = {
  bg: '#0d0f12',
  surface: '#17191d',
  surfaceRaised: '#1e2126',
  border: '#2a2d33',
  borderStrong: '#383c44',

  textPrimary: '#f5f6f7',
  textSecondary: '#9aa0a8',
  textMuted: '#6b7178',

  accent: '#22c55e',
  accentMuted: 'rgba(34, 197, 94, 0.14)',
  accentBorder: '#166534',
  onAccent: '#06120a',

  danger: '#ef4444',
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
} as const;

export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

export const type = {
  hero: { fontSize: 34, fontWeight: '900' as const, letterSpacing: 1.5 },
  title: { fontSize: 22, fontWeight: '800' as const },
  subtitle: { fontSize: 14, fontWeight: '500' as const },
  label: {
    fontSize: 12,
    fontWeight: '700' as const,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
  },
  body: { fontSize: 15, fontWeight: '500' as const },
  caption: { fontSize: 12, fontWeight: '500' as const },
} as const;

export const cardStyle = {
  backgroundColor: color.surface,
  borderRadius: radius.xl,
  borderWidth: 1,
  borderColor: color.border,
  padding: spacing.xxl,
} as const;

export const primaryButtonStyle = {
  backgroundColor: color.accent,
  borderRadius: radius.lg,
  paddingVertical: spacing.lg,
  alignItems: 'center' as const,
};

export const secondaryButtonStyle = {
  backgroundColor: color.surfaceRaised,
  borderRadius: radius.lg,
  paddingVertical: spacing.lg,
  alignItems: 'center' as const,
  borderWidth: 1,
  borderColor: color.border,
};

export const inputStyle = {
  backgroundColor: color.surfaceRaised,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: color.border,
  paddingHorizontal: spacing.lg,
  paddingVertical: spacing.md + 2,
  color: color.textPrimary,
  fontSize: 15,
};
