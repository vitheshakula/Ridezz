import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { brand } from '../homeTheme';
import { Logo } from '../components/Logo';
import { authStyles as styles } from './authStyles';

export const ForgotPassword = ({ navigation }: any) => {
  return (
    <View style={[styles.container, styles.centered]}>
      <View style={[styles.card, styles.cardCentered]}>
        <Logo size={64} />
        <Text style={[styles.cardTitle, { marginTop: 12, color: brand.textPrimary }]}>Password Reset</Text>
        <Text style={styles.description}>
          Self-service password reset is currently under development. Contact your ride admin or server host to reset your password.
        </Text>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.navigate('LoginPage')}
          activeOpacity={0.85}
        >
          <Text style={styles.backButtonText}>← Back to Login</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
