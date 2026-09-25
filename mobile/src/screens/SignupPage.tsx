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
import { color, inputStyle, primaryButtonStyle, radius, spacing, type } from '../theme';

export const API_BASE_URL = API_URL || 'http://localhost:5000/api';
=======
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { register } from '../services/AuthService';
import { color, radius, spacing, type, cardStyle, primaryButtonStyle, inputStyle } from '../theme';
import { describeAuthError } from '../utils/authErrors';
import { validateRegistration, type RegistrationErrors } from '../utils/authValidation';
>>>>>>> master

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
<<<<<<< HEAD
    if (!riderName.trim()) {
      Alert.alert('Choose a rider name', 'This is how your crew will see you in the room.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      Alert.alert('Check your email', 'Enter a valid email address to continue.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Password too short', 'Use at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Passwords do not match', 'Re-enter the same password in both fields.');
=======
    const problems = validateRegistration(riderName, email, password, confirmPassword);
    setErrors(problems);
    setFormError(null);
    if (Object.keys(problems).length > 0) {
>>>>>>> master
      return;
    }

    setIsLoading(true);
    try {
<<<<<<< HEAD
      await axios.post(
        `${API_BASE_URL}/auth/signup`,
        {
          rider_name: riderName.trim(),
          email: email.trim().toLowerCase(),
          password,
        },
        { timeout: 5000 },
      );

      Alert.alert('Account ready', 'You can now sign in and start a ride.', [
        { text: 'Sign in', onPress: () => navigation.navigate('LoginPage') },
      ]);
    } catch (error: any) {
      const message = error.response?.data?.message || 'We could not create your account right now.';
      Alert.alert('Could not create account', message);
=======
      // The server signs the new rider in as part of registering, so no second trip to Sign In.
      const result = await register(riderName, email, password);
      await login(result.token, result.user);
      navigation?.navigate('JoinScreen');
    } catch (error) {
      setFormError(describeAuthError(error, 'Registration failed. Please try again.'));
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
          <Text style={styles.eyebrow}>SET UP YOUR PROFILE</Text>
          <Text style={styles.pageTitle}>Join the crew.</Text>
          <Text style={styles.pageDescription}>
            Create your rider identity. You can be on a live room in less than a minute.
          </Text>
        </View>

        <View style={styles.formCard}>
          <Text style={styles.label}>Rider name</Text>
          <TextInput
<<<<<<< HEAD
            style={styles.input}
            placeholder="What should your crew call you?"
=======
            testID="signup-name"
            style={[styles.input, errors.name && styles.inputError]}
            placeholder="e.g. GhostRider, Alex"
>>>>>>> master
            placeholderTextColor={color.textMuted}
            autoComplete="name"
            textContentType="nickname"
            value={riderName}
<<<<<<< HEAD
            onChangeText={setRiderName}
            autoCapitalize="words"
=======
            onChangeText={value => {
              setRiderName(value);
              clearError('name');
            }}
>>>>>>> master
          />
          {errors.name ? <Text style={styles.fieldError}>{errors.name}</Text> : null}

<<<<<<< HEAD
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
            testID="signup-email"
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

<<<<<<< HEAD
          <View style={styles.labelRow}>
            <Text style={styles.label}>Password</Text>
            <Text style={styles.helper}>8+ characters</Text>
          </View>
          <View style={styles.passwordContainer}>
=======
          <Text style={styles.label}>Password (min. 8 characters)</Text>
          <View style={[styles.passwordContainer, errors.password && styles.inputError]}>
>>>>>>> master
            <TextInput
              testID="signup-password"
              style={styles.passwordInput}
              placeholder="Create a password"
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
            <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.toggleBtn}>
              <Text style={styles.toggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>
          {errors.password ? <Text style={styles.fieldError}>{errors.password}</Text> : null}

          <Text style={styles.label}>Confirm password</Text>
          <TextInput
<<<<<<< HEAD
            style={styles.input}
            placeholder="Enter it once more"
=======
            testID="signup-confirm"
            style={[styles.input, errors.confirmPassword && styles.inputError]}
            placeholder="••••••••"
>>>>>>> master
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
            activeOpacity={0.88}
          >
            {isLoading ? (
              <ActivityIndicator color={color.onAccent} />
            ) : (
              <Text style={styles.primaryButtonText}>Create account</Text>
            )}
          </TouchableOpacity>

<<<<<<< HEAD
          <TouchableOpacity style={styles.switchAuthBtn} onPress={() => navigation.navigate('LoginPage')}>
=======
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
>>>>>>> master
            <Text style={styles.switchAuthText}>
              Already registered? <Text style={styles.linkText}>Sign in</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  scrollContent: { flexGrow: 1, padding: spacing.xxl, paddingTop: spacing.xxxl, paddingBottom: spacing.huge },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topBarAction: { ...type.label, color: color.textSecondary },
  intro: { marginTop: spacing.huge, marginBottom: spacing.xxxl },
  eyebrow: { ...type.overline, color: color.accent, marginBottom: spacing.md },
  pageTitle: { ...type.hero, color: color.textPrimary },
  pageDescription: { ...type.body, color: color.textSecondary, marginTop: spacing.md, maxWidth: 340 },
  formCard: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.xl,
    padding: spacing.xl,
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { ...type.label, color: color.textSecondary, marginBottom: spacing.sm, marginTop: spacing.sm },
  helper: { ...type.caption, color: color.textMuted, marginTop: spacing.sm, marginBottom: spacing.sm },
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
  submitBtn: { marginTop: spacing.sm },
<<<<<<< HEAD
  buttonDisabled: { opacity: 0.55 },
  primaryButtonText: { color: color.onAccent, fontSize: 16, fontWeight: '800' },
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center', paddingVertical: spacing.xs },
=======
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
