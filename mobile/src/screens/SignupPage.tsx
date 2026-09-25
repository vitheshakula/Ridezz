import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { register } from '../services/AuthService';
import { color, radius, spacing, type, cardStyle, primaryButtonStyle, inputStyle } from '../theme';
import { describeAuthError } from '../utils/authErrors';
import { validateRegistration, type RegistrationErrors } from '../utils/authValidation';

export const SignupPage = ({ navigation }: any) => {
  const { login } = useAuth();
  const [riderName, setRiderName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const clearError = (field: keyof RegistrationErrors) => {
    setFormError(null);
    if (errors[field]) {
      setErrors(current => ({ ...current, [field]: undefined }));
    }
  };

  const handleSignup = async () => {
    const problems = validateRegistration(riderName, email, password, confirmPassword);
    setErrors(problems);
    setFormError(null);
    if (Object.keys(problems).length > 0) {
      return;
    }

    setIsLoading(true);
    try {
      // The server signs the new rider in as part of registering, so no second trip to Sign In.
      const result = await register(riderName, email, password);
      await login(result.token, result.user);
      navigation?.navigate('JoinScreen');
    } catch (error) {
      setFormError(describeAuthError(error, 'Registration failed. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.logoBadge}>
            <Text style={styles.logoBadgeText}>⚡</Text>
          </View>
          <Text style={styles.appTitle}>RIDEAZE</Text>
          <Text style={styles.subTitle}>Create Rider Profile</Text>
        </View>

        <View style={cardStyle}>
          <Text style={styles.cardTitle}>Sign Up</Text>

          <Text style={styles.label}>Rider Handle / Name</Text>
          <TextInput
            testID="signup-name"
            style={[styles.input, errors.name && styles.inputError]}
            placeholder="e.g. GhostRider, Alex"
            placeholderTextColor={color.textMuted}
            autoComplete="name"
            textContentType="nickname"
            value={riderName}
            onChangeText={value => {
              setRiderName(value);
              clearError('name');
            }}
          />
          {errors.name ? <Text style={styles.fieldError}>{errors.name}</Text> : null}

          <Text style={styles.label}>Gmail Address</Text>
          <TextInput
            testID="signup-email"
            style={[styles.input, errors.email && styles.inputError]}
            placeholder="rider@gmail.com"
            placeholderTextColor={color.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            value={email}
            onChangeText={value => {
              setEmail(value);
              clearError('email');
            }}
          />
          {errors.email ? <Text style={styles.fieldError}>{errors.email}</Text> : null}

          <Text style={styles.label}>Password (min. 8 characters)</Text>
          <View style={[styles.passwordContainer, errors.password && styles.inputError]}>
            <TextInput
              testID="signup-password"
              style={styles.passwordInput}
              placeholder="••••••••"
              placeholderTextColor={color.textMuted}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
              value={password}
              onChangeText={value => {
                setPassword(value);
                clearError('password');
              }}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(!showPassword)}
              style={styles.toggleBtn}
            >
              <Text style={styles.toggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>
          {errors.password ? <Text style={styles.fieldError}>{errors.password}</Text> : null}

          <Text style={styles.label}>Confirm Password</Text>
          <TextInput
            testID="signup-confirm"
            style={[styles.input, errors.confirmPassword && styles.inputError]}
            placeholder="••••••••"
            placeholderTextColor={color.textMuted}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            value={confirmPassword}
            onChangeText={value => {
              setConfirmPassword(value);
              clearError('confirmPassword');
            }}
            onSubmitEditing={handleSignup}
          />
          {errors.confirmPassword ? <Text style={styles.fieldError}>{errors.confirmPassword}</Text> : null}

          {formError ? <Text style={styles.formError}>{formError}</Text> : null}

          <TouchableOpacity
            testID="signup-submit"
            style={[primaryButtonStyle, styles.submitBtn, isLoading && styles.buttonDisabled]}
            onPress={handleSignup}
            disabled={isLoading}
            activeOpacity={0.85}
          >
            {isLoading ? (
              <ActivityIndicator color={color.onAccent} />
            ) : (
              <Text style={styles.primaryButtonText}>Create Account</Text>
            )}
          </TouchableOpacity>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>

          <GoogleSignInButton mode="signup" navigation={navigation} disabled={isLoading} />

          <TouchableOpacity
            style={styles.switchAuthBtn}
            onPress={() => navigation.navigate('LoginPage')}
          >
            <Text style={styles.switchAuthText}>
              Already have an account? <Text style={styles.linkText}>Sign In</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: spacing.xxl },
  header: { alignItems: 'center', marginBottom: spacing.xxl },
  logoBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: color.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: color.border,
  },
  logoBadgeText: { fontSize: 22 },
  appTitle: { ...type.hero, fontSize: 30, color: color.accent },
  subTitle: { ...type.label, color: color.textMuted, marginTop: spacing.xs },
  cardTitle: { ...type.title, color: color.textPrimary, marginBottom: spacing.xl },
  label: { ...type.label, color: color.textSecondary, marginBottom: spacing.sm, marginTop: spacing.md, textTransform: 'none' },
  input: { ...inputStyle, marginBottom: spacing.lg },
  inputError: { borderColor: color.danger, marginBottom: spacing.sm },
  fieldError: { color: color.danger, fontSize: 12, marginBottom: spacing.md },
  formError: { color: color.danger, fontSize: 13, textAlign: 'center', marginBottom: spacing.md },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    marginBottom: spacing.lg,
  },
  passwordInput: { flex: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2, color: color.textPrimary, fontSize: 15 },
  toggleBtn: { paddingHorizontal: spacing.md + 2 },
  toggleText: { color: color.accent, fontWeight: '600', fontSize: 12 },
  submitBtn: { marginTop: spacing.sm },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: color.onAccent, fontSize: 16, fontWeight: '700' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: color.border },
  dividerText: { color: color.textMuted, fontSize: 12, marginHorizontal: spacing.md, fontWeight: '600' },
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center' },
  switchAuthText: { color: color.textSecondary, fontSize: 14 },
  linkText: { color: color.accent, fontWeight: '600' },
});
