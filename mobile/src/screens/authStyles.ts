import { StyleSheet } from 'react-native';
import { spacing } from '../theme';
import { brand, font, homeRadius, homeType } from '../homeTheme';

/** Shared look for Login, Signup and Forgot Password (new design system). Style keys match what
 * those screens already reference, so their markup and test IDs are unchanged. */
export const authStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: brand.bg },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  header: { alignItems: 'center', marginBottom: spacing.xl, gap: spacing.xs },
  appTitle: { ...homeType.headlineMedium, color: brand.textPrimary, letterSpacing: 2, marginTop: spacing.sm },
  subTitle: { ...homeType.labelSmall, color: brand.primary, textTransform: 'uppercase' },

  card: {
    backgroundColor: brand.card,
    borderRadius: homeRadius.card,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    padding: spacing.xl,
  },
  cardTitle: { ...homeType.headlineMedium, color: brand.textPrimary, marginBottom: spacing.sm },
  label: { ...homeType.labelSmall, color: brand.outline, marginBottom: spacing.sm, marginTop: spacing.md },

  input: {
    minHeight: 52,
    backgroundColor: brand.darkest,
    borderRadius: homeRadius.input,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    ...homeType.bodyLarge,
    color: brand.textPrimary,
  },
  inputError: { borderColor: brand.danger },
  fieldError: { ...homeType.bodySmall, color: brand.danger, marginBottom: spacing.sm },
  formError: {
    ...homeType.bodySmall,
    color: brand.danger,
    textAlign: 'center',
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: homeRadius.input,
    backgroundColor: brand.dangerMuted,
    borderWidth: 1,
    borderColor: brand.dangerBorder,
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    backgroundColor: brand.darkest,
    borderRadius: homeRadius.input,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    marginBottom: spacing.sm,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    ...homeType.bodyLarge,
    color: brand.textPrimary,
  },
  toggleBtn: { minHeight: 44, minWidth: 56, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  toggleText: { ...homeType.labelMedium, color: brand.primary },
  forgotBtn: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', marginBottom: spacing.md },
  forgotText: { ...homeType.labelMedium, color: brand.textSecondary },

  primaryButton: {
    minHeight: 52,
    marginTop: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: homeRadius.button,
    backgroundColor: brand.primary,
  },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { ...homeType.button, color: brand.onPrimary, textTransform: 'uppercase' },

  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg },
  dividerLine: { flex: 1, height: 1, backgroundColor: brand.inputBorder },
  dividerText: { ...homeType.labelSmall, color: brand.outline, marginHorizontal: spacing.md },
  switchAuthBtn: { marginTop: spacing.lg, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  switchAuthText: { ...homeType.bodyMedium, color: brand.textSecondary },
  linkText: { fontFamily: font.label, color: brand.primary },

  // Forgot password
  centered: { justifyContent: 'center', padding: spacing.xl },
  cardCentered: { alignItems: 'center' },
  description: { ...homeType.bodyMedium, color: brand.textSecondary, textAlign: 'center', marginBottom: spacing.xl },
  backButton: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    borderRadius: homeRadius.button,
    backgroundColor: brand.darkest,
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  backButtonText: { ...homeType.labelLarge, color: brand.primary },
});
