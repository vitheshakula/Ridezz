import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
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

export const SignupPage = ({ navigation }: any) => {
  const [riderName, setRiderName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSignup = async () => {
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
      return;
    }

    setIsLoading(true);
    try {
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
            style={styles.input}
            placeholder="What should your crew call you?"
            placeholderTextColor={color.textMuted}
            value={riderName}
            onChangeText={setRiderName}
            autoCapitalize="words"
          />

          <Text style={styles.label}>Email address</Text>
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            placeholderTextColor={color.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            value={email}
            onChangeText={setEmail}
          />

          <View style={styles.labelRow}>
            <Text style={styles.label}>Password</Text>
            <Text style={styles.helper}>8+ characters</Text>
          </View>
          <View style={styles.passwordContainer}>
            <TextInput
              style={styles.passwordInput}
              placeholder="Create a password"
              placeholderTextColor={color.textMuted}
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.toggleBtn}>
              <Text style={styles.toggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.label}>Confirm password</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter it once more"
            placeholderTextColor={color.textMuted}
            secureTextEntry={!showPassword}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />

          <TouchableOpacity
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

          <TouchableOpacity style={styles.switchAuthBtn} onPress={() => navigation.navigate('LoginPage')}>
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
  buttonDisabled: { opacity: 0.55 },
  primaryButtonText: { color: color.onAccent, fontSize: 16, fontWeight: '800' },
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center', paddingVertical: spacing.xs },
  switchAuthText: { color: color.textSecondary, fontSize: 14 },
  linkText: { color: color.accent, fontWeight: '700' },
});
