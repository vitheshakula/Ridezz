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
import { login as loginRequest } from '../services/AuthService';
import { color, radius, spacing, type, cardStyle, primaryButtonStyle, inputStyle } from '../theme';
import { describeAuthError } from '../utils/authErrors';
import { validateSignIn, type SignInErrors } from '../utils/authValidation';

export const LoginPage = ({ navigation }: any) => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<SignInErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const clearError = (field: keyof SignInErrors) => {
    setFormError(null);
    if (errors[field]) {
      setErrors(current => ({ ...current, [field]: undefined }));
    }
  };

  const handleLogin = async () => {
    const problems = validateSignIn(email, password);
    setErrors(problems);
    setFormError(null);
    if (problems.email || problems.password) {
      return;
    }

    setIsLoading(true);
    try {
      const result = await loginRequest(email, password);
      await login(result.token, result.user);
      navigation?.navigate('JoinScreen');
    } catch (error) {
      setFormError(describeAuthError(error, 'Sign in failed. Please try again.'));
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
          <Text style={styles.subTitle}>Group Voice Intercom</Text>
        </View>

        <View style={cardStyle}>
          <Text style={styles.cardTitle}>Sign In</Text>

          <Text style={styles.label}>Gmail Address</Text>
          <TextInput
            testID="login-email"
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

          <Text style={styles.label}>Password</Text>
          <View style={[styles.passwordContainer, errors.password && styles.inputError]}>
            <TextInput
              testID="login-password"
              style={styles.passwordInput}
              placeholder="••••••••"
              placeholderTextColor={color.textMuted}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password"
              textContentType="password"
              value={password}
              onChangeText={value => {
                setPassword(value);
                clearError('password');
              }}
              onSubmitEditing={handleLogin}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(!showPassword)}
              style={styles.toggleBtn}
            >
              <Text style={styles.toggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>
          {errors.password ? <Text style={styles.fieldError}>{errors.password}</Text> : null}

          <TouchableOpacity
            style={styles.forgotBtn}
            onPress={() => navigation.navigate('ForgotPassword')}
          >
            <Text style={styles.forgotText}>Forgot password?</Text>
          </TouchableOpacity>

          {formError ? <Text style={styles.formError}>{formError}</Text> : null}

          <TouchableOpacity
            testID="login-submit"
            style={[primaryButtonStyle, isLoading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={isLoading}
            activeOpacity={0.85}
          >
            {isLoading ? (
              <ActivityIndicator color={color.onAccent} />
            ) : (
              <Text style={styles.primaryButtonText}>Sign In</Text>
            )}
          </TouchableOpacity>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>

          <GoogleSignInButton mode="login" navigation={navigation} disabled={isLoading} />

          <TouchableOpacity
            style={styles.switchAuthBtn}
            onPress={() => navigation.navigate('SignupPage')}
          >
            <Text style={styles.switchAuthText}>
              Don't have an account? <Text style={styles.linkText}>Create one</Text>
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
    marginBottom: spacing.sm,
  },
  passwordInput: { flex: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2, color: color.textPrimary, fontSize: 15 },
  toggleBtn: { paddingHorizontal: spacing.md + 2 },
  toggleText: { color: color.accent, fontWeight: '600', fontSize: 12 },
  forgotBtn: { alignSelf: 'flex-end', marginBottom: spacing.xxl, marginTop: spacing.xs },
  forgotText: { color: color.textSecondary, fontSize: 13 },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: color.onAccent, fontSize: 16, fontWeight: '700' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: color.border },
  dividerText: { color: color.textMuted, fontSize: 12, marginHorizontal: spacing.md, fontWeight: '600' },
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center' },
  switchAuthText: { color: color.textSecondary, fontSize: 14 },
  linkText: { color: color.accent, fontWeight: '600' },
});
