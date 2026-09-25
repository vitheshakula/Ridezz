import React, { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { loginWithGoogle, type GoogleMode } from '../services/AuthService';
import { radius, spacing } from '../theme';
import { describeAuthError, errorCode } from '../utils/authErrors';

interface GoogleSignInButtonProps {
  /** 'login' signs in an existing account only; 'signup' creates one if needed. */
  mode: GoogleMode;
  navigation?: { navigate: (screen: 'JoinScreen' | 'SignupPage') => void };
  /** Disables the button while the surrounding form is busy. */
  disabled?: boolean;
  label?: string;
}

export function GoogleSignInButton({
  mode,
  navigation,
  disabled = false,
  label = mode === 'login' ? 'Sign in with Google' : 'Sign up with Google',
}: GoogleSignInButtonProps) {
  const { login } = useAuth();
  const [isBusy, setIsBusy] = useState(false);

  const handlePress = async () => {
    if (isBusy || disabled) {
      return;
    }
    setIsBusy(true);
    try {
      const result = await loginWithGoogle(mode);
      if (!result) {
        return; // backed out of the account picker -- nothing to report
      }
      await login(result.token, result.user);
      navigation?.navigate('JoinScreen');
    } catch (error) {
      const message = describeAuthError(error, 'Google sign-in failed. Please try again.');
      if (mode === 'login' && errorCode(error) === 'ACCOUNT_NOT_FOUND') {
        // Not a failure so much as a fork in the road: offer the way forward.
        Alert.alert('No account found', message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Create account', onPress: () => navigation?.navigate('SignupPage') },
        ]);
      } else {
        Alert.alert('Google Sign-In Failed', message);
      }
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <TouchableOpacity
      style={[styles.button, (isBusy || disabled) && styles.buttonDisabled]}
      onPress={handlePress}
      disabled={isBusy || disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {isBusy ? (
        <ActivityIndicator color="#1f1f1f" />
      ) : (
        <View style={styles.content}>
          <Text style={styles.glyph}>G</Text>
          <Text style={styles.label}>{label}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#ffffff',
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  content: { flexDirection: 'row', alignItems: 'center' },
  glyph: { fontSize: 18, fontWeight: '800', color: '#4285f4', marginRight: spacing.md },
  label: { fontSize: 16, fontWeight: '600', color: '#1f1f1f' },
});
