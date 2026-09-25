/**
 * Design tokens for the redesigned Home screens (Dashboard, JoinScreen, Profile).
 * Kept separate from theme.ts so screens not yet redesigned keep their current look.
 *
 * Fonts: Manrope (headings/metrics) and Inter (body, labels, buttons, navigation), bundled as
 * static files in android/app/src/main/assets/fonts. On Android a family name is the file name,
 * and each weight is its own file, so weight is chosen through `font` below -- do not also set
 * `fontWeight` on these styles or Android will fake-bold the already-bold file.
 */

export const brand = {
  primary: '#12CFE4',
  onPrimary: '#00363D',
  primaryMuted: 'rgba(18, 207, 228, 0.14)',
  primaryBorder: 'rgba(18, 207, 228, 0.35)',
  secondary: '#4B7BFF',
  tertiary: '#8B5CF6',

  bg: '#0C141E',
  surface: '#111923',
  surfaceLow: '#141C26',
  card: '#18202A',
  surfaceHigh: '#232B35',
  surfaceHighest: '#2D3540',
  darkest: '#070F18',

  textPrimary: '#DBE3F1',
  textSecondary: '#BBC9CC',
  outline: '#859396',
  outlineVariant: '#3C494B',
  inputBorder: '#263442',

  success: '#22C55E',
  warning: '#F59E0B',
  danger: '#EF4444',
  dangerMuted: 'rgba(239, 68, 68, 0.12)',
  dangerBorder: 'rgba(239, 68, 68, 0.4)',
} as const;

export const font = {
  headingSemiBold: 'Manrope-SemiBold',
  heading: 'Manrope-Bold',
  headingExtraBold: 'Manrope-ExtraBold',
  body: 'Inter-Regular',
  bodyMedium: 'Inter-Medium',
  label: 'Inter-SemiBold',
  bold: 'Inter-Bold',
} as const;

export const homeType = {
  displayLarge: { fontSize: 40, lineHeight: 48, letterSpacing: -0.8, fontFamily: font.headingExtraBold },
  headlineLarge: { fontSize: 32, lineHeight: 40, letterSpacing: -0.32, fontFamily: font.heading },
  headlineMedium: { fontSize: 24, lineHeight: 32, fontFamily: font.heading },
  headlineSmall: { fontSize: 20, lineHeight: 28, fontFamily: font.headingSemiBold },
  bodyLarge: { fontSize: 16, lineHeight: 24, fontFamily: font.body },
  bodyMedium: { fontSize: 14, lineHeight: 20, fontFamily: font.body },
  bodySmall: { fontSize: 12, lineHeight: 16, fontFamily: font.body },
  labelLarge: { fontSize: 14, lineHeight: 20, letterSpacing: 0.14, fontFamily: font.label },
  labelMedium: { fontSize: 12, lineHeight: 16, letterSpacing: 0.24, fontFamily: font.label },
  labelSmall: { fontSize: 10, lineHeight: 14, letterSpacing: 0.4, fontFamily: font.bold },
  button: { fontSize: 16, lineHeight: 24, letterSpacing: 0.5, fontFamily: font.bold },
} as const;

export const homeRadius = {
  input: 14,
  card: 16,
  button: 14,
  pill: 999,
} as const;
