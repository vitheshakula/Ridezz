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
import { useAuth } from '../context/AuthContext';
import { color, inputStyle, primaryButtonStyle, radius, spacing, type } from '../theme';

export const API_BASE_URL = API_URL || 'http://localhost:5000/api';

export const LoginPage = ({ navigation }: any) => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Check your details', 'Enter both your email and password to continue.');
      return;
    }

    setIsLoading(true);
    try {
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

        <View style={styles.formCard}>
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

          <Text style={styles.label}>Password</Text>
          <View style={styles.passwordContainer}>
            <TextInput
              style={styles.passwordInput}
              placeholder="Enter your password"
              placeholderTextColor={color.textMuted}
              secureTextEntry={!showPassword}
              autoComplete="password"
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.toggleBtn}>
              <Text style={styles.toggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.forgotBtn}
            onPress={() => navigation.navigate('ForgotPassword')}
          >
            <Text style={styles.forgotText}>Forgot password?</Text>
          </TouchableOpacity>

          <TouchableOpacity
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

          <TouchableOpacity style={styles.switchAuthBtn} onPress={() => navigation.navigate('SignupPage')}>
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
  forgotText: { color: color.textSecondary, fontSize: 13, fontWeight: '600' },
  buttonDisabled: { opacity: 0.55 },
  primaryButtonText: { color: color.onAccent, fontSize: 16, fontWeight: '800' },
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center', paddingVertical: spacing.xs },
  switchAuthText: { color: color.textSecondary, fontSize: 14 },
  linkText: { color: color.accent, fontWeight: '700' },
});
