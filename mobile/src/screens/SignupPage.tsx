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
import { API_URL } from '@env';
import { color, radius, spacing, type, cardStyle, primaryButtonStyle, inputStyle } from '../theme';

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
      Alert.alert('Validation Error', 'Rider Name is required.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      Alert.alert('Validation Error', 'Please enter a valid email.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Validation Error', 'Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Validation Error', 'Passwords do not match.');
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
        { timeout: 5000 }
       );

      Alert.alert('Success', 'Account created successfully!', [
        { text: 'OK', onPress: () => navigation.navigate('LoginPage') },
      ]);
    } catch (error: any) {
      const message = error.response?.data?.message || 'Registration failed.';
      Alert.alert('Signup Error', message);
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
            style={styles.input}
            placeholder="e.g. GhostRider, Alex"
            placeholderTextColor={color.textMuted}
            value={riderName}
            onChangeText={setRiderName}
          />

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

          <Text style={styles.label}>Password (Min. 8 chars)</Text>
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

          <Text style={styles.label}>Confirm Password</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor={color.textMuted}
            secureTextEntry={!showPassword}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />

          <TouchableOpacity
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
  switchAuthBtn: { marginTop: spacing.xl, alignItems: 'center' },
  switchAuthText: { color: color.textSecondary, fontSize: 14 },
  linkText: { color: color.accent, fontWeight: '600' },
});
