import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
<<<<<<< HEAD
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import axios from 'axios';
import { API_URL } from '@env';
import BrandLockup from '../components/BrandLockup';
import { useAuth } from '../context/AuthContext';
import { color, inputStyle, primaryButtonStyle, radius, spacing, type } from '../theme';

export const API_BASE_URL = API_URL || 'http://localhost:5000/api';
=======
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { login as loginRequest } from '../services/AuthService';
import { color, radius, spacing, type, cardStyle, primaryButtonStyle, inputStyle } from '../theme';
import { describeAuthError } from '../utils/authErrors';
import { validateSignIn, type SignInErrors } from '../utils/authValidation';
>>>>>>> master

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
<<<<<<< HEAD
    if (!email.trim() || !password) {
      Alert.alert('Check your details', 'Enter both your email and password to continue.');
=======
    const problems = validateSignIn(email, password);
    setErrors(problems);
    setFormError(null);
    if (problems.email || problems.password) {
>>>>>>> master
      return;
    }

    setIsLoading(true);
    try {
<<<<<<< HEAD
      const response = await axios.post(
        `${API_BASE_URL}/auth/login`,
        { email: email.trim().toLowerCase(), password },
        { timeout: 5000 },
      );
      await login(response.data.token, response.data.user);
      navigation?.navigate('JoinScreen');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Check your email and password, then try again.';
      Alert.alert('Could not sign in', message);
=======
      const result = await loginRequest(email, password);
      await login(result.token, result.user);
      navigation?.navigate('JoinScreen');
    } catch (error) {
      setFormError(describeAuthError(error, 'Sign in failed. Please try again.'));
>>>>>>> master
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
        <View style={styles.topBar}>
          <BrandLockup />
          <TouchableOpacity onPress={() => navigation.navigate('Dashboard')} hitSlop={12}>
            <Text style={styles.topBarAction}>Home</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.intro}>
          <Text style={styles.eyebrow}>WELCOME BACK</Text>
          <Text style={styles.pageTitle}>Ready for the next ride?</Text>
          <Text style={styles.pageDescription}>Sign in to create a room or join your crew.</Text>
        </View>

<<<<<<< HEAD
        <View style={styles.formCard}>
          <Text style={styles.label}>Email address</Text>
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            placeholderTextColor={color.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
=======
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
>>>>>>> master
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
              placeholder="Enter your password"
              placeholderTextColor={color.textMuted}
              secureTextEntry={!showPassword}
<<<<<<< HEAD
              autoComplete="password"
=======
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password"
              textContentType="password"
>>>>>>> master
              value={password}
              onChangeText={value => {
                setPassword(value);
                clearError('password');
              }}
              onSubmitEditing={handleLogin}
            />
            <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.toggleBtn}>
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
            activeOpacity={0.88}
          >
            {isLoading ? (
              <ActivityIndicator color={color.onAccent} />
            ) : (
              <Text style={styles.primaryButtonText}>Sign in</Text>
            )}
          </TouchableOpacity>

<<<<<<< HEAD
          <TouchableOpacity style={styles.switchAuthBtn} onPress={() => navigation.navigate('SignupPage')}>
=======
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
>>>>>>> master
            <Text style={styles.switchAuthText}>
              New to Rideaze? <Text style={styles.linkText}>Create an account</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  scrollContent: { flexGrow: 1, padding: spacing.xxl, paddingTop: spacing.xxxl },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topBarAction: { ...type.label, color: color.textSecondary },
  intro: { marginTop: spacing.huge, marginBottom: spacing.xxxl },
  eyebrow: { ...type.overline, color: color.accent, marginBottom: spacing.md },
  pageTitle: { ...type.hero, color: color.textPrimary, maxWidth: 330 },
  pageDescription: { ...type.body, color: color.textSecondary, marginTop: spacing.md },
  formCard: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.xl,
    padding: spacing.xl,
  },
  label: { ...type.label, color: color.textSecondary, marginBottom: spacing.sm, marginTop: spacing.sm },
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
  passwordInput: {
    flex: 1,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: color.textPrimary,
    fontSize: 16,
  },
  toggleBtn: { minHeight: 52, justifyContent: 'center', paddingHorizontal: spacing.lg },
  toggleText: { color: color.accent, fontWeight: '700', fontSize: 13 },
  forgotBtn: { alignSelf: 'flex-end', marginBottom: spacing.xxl, marginTop: spacing.xs },
<<<<<<< HEAD
  forgotText: { color: color.textSecondary, fontSize: 13, fontWeight: '600' },
  buttonDisabled: { opacity: 0.55 },
  primaryButtonText: { color: color.onAccent, fontSize: 16, fontWeight: '800' },
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center', paddingVertical: spacing.xs },
=======
  forgotText: { color: color.textSecondary, fontSize: 13 },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: color.onAccent, fontSize: 16, fontWeight: '700' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: color.border },
  dividerText: { color: color.textMuted, fontSize: 12, marginHorizontal: spacing.md, fontWeight: '600' },
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center' },
>>>>>>> master
  switchAuthText: { color: color.textSecondary, fontSize: 14 },
  linkText: { color: color.accent, fontWeight: '700' },
});
