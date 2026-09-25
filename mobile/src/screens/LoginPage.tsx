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
  Alert,
} from 'react-native';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { color, radius, spacing, type, cardStyle, primaryButtonStyle, inputStyle } from '../theme';

import { API_URL } from '@env';

export const API_BASE_URL = API_URL || 'http://localhost:5000/api';

export const LoginPage = ({ navigation }: any) => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Validation Error', 'Please fill in both email and password.');
      return;
    }

    setIsLoading(true);
    try {
      const response = await axios.post(
        `${API_BASE_URL}/auth/login`,
        {
          email: email.trim().toLowerCase(),
          password,
        },
        { timeout: 5000 }
      );

      // 1. Await token & user storage into AsyncStorage/State
      await login(response.data.token, response.data.user);

      // 2. Redirect to JoinScreen
      navigation?.navigate('JoinScreen');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Login failed. Please check your credentials.';
      Alert.alert('Sign In Failed', message);
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

          <Text style={styles.label}>Email Address</Text>
          <TextInput
            style={styles.input}
            placeholder="rider@example.com"
            placeholderTextColor={color.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
          />

          <Text style={styles.label}>Password</Text>
          <View style={styles.passwordContainer}>
            <TextInput
              style={styles.passwordInput}
              placeholder="••••••••"
              placeholderTextColor={color.textMuted}
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(!showPassword)}
              style={styles.toggleBtn}
            >
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
            activeOpacity={0.85}
          >
            {isLoading ? (
              <ActivityIndicator color={color.onAccent} />
            ) : (
              <Text style={styles.primaryButtonText}>Sign In</Text>
            )}
          </TouchableOpacity>

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
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center' },
  switchAuthText: { color: color.textSecondary, fontSize: 14 },
  linkText: { color: color.accent, fontWeight: '600' },
});
