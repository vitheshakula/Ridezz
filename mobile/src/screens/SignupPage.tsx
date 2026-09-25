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
          <Text style={styles.appTitle}>RIDEZZ</Text>
          <Text style={styles.subTitle}>Create Rider Profile</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sign Up</Text>

          <Text style={styles.label}>Rider Handle / Name</Text>
          <TextInput
            testID="signup-name"
            style={[styles.input, errors.name && styles.inputError]}
            placeholder="e.g. GhostRider, Alex"
            placeholderTextColor="#666"
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
            placeholderTextColor="#666"
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
              placeholderTextColor="#666"
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
            placeholderTextColor="#666"
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
            style={[styles.primaryButton, isLoading && styles.buttonDisabled]}
            onPress={handleSignup}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#000" />
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
  container: { flex: 1, backgroundColor: '#121212' },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 24 },
  appTitle: { fontSize: 36, fontWeight: '900', color: '#22c55e', letterSpacing: 2 },
  subTitle: { fontSize: 14, color: '#888', marginTop: 4, textTransform: 'uppercase' },
  card: { backgroundColor: '#1e1e1e', borderRadius: 16, padding: 24, borderWidth: 1, borderColor: '#2e2e2e' },
  cardTitle: { fontSize: 22, fontWeight: '700', color: '#fff', marginBottom: 20 },
  label: { fontSize: 13, fontWeight: '600', color: '#aaa', marginBottom: 6 },
  input: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#fff',
    fontSize: 15,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#3a3a3a',
  },
  inputError: { borderColor: '#ef4444', marginBottom: 6 },
  fieldError: { color: '#f87171', fontSize: 12, marginBottom: 12 },
  formError: { color: '#f87171', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3a3a3a',
    marginBottom: 16,
  },
  passwordInput: { flex: 1, paddingHorizontal: 16, paddingVertical: 12, color: '#fff', fontSize: 15 },
  toggleBtn: { paddingHorizontal: 14 },
  toggleText: { color: '#22c55e', fontWeight: '600', fontSize: 12 },
  primaryButton: {
    backgroundColor: '#22c55e',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: '#000', fontSize: 16, fontWeight: '700' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 18 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#333' },
  dividerText: { color: '#777', fontSize: 12, marginHorizontal: 12, fontWeight: '600' },
  switchAuthBtn: { marginTop: 20, alignItems: 'center' },
  switchAuthText: { color: '#888', fontSize: 14 },
  linkText: { color: '#22c55e', fontWeight: '600' },
});
