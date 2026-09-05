import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

export const ForgotPassword = ({ navigation }: any) => {
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <Text style={styles.iconText}>✉</Text>
        </View>
        <Text style={styles.title}>Password Reset</Text>
        <Text style={styles.description}>
          Self-service password reset is currently under development. Contact your ride admin or server host to reset your password.
        </Text>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.navigate('LoginPage')}
        >
          <Text style={styles.backButtonText}>← Back to Login</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#1e1e1e', borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: '#2e2e2e' },
  iconCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(34, 197, 94, 0.15)', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  iconText: { fontSize: 24, color: '#22c55e' },
  title: { fontSize: 22, fontWeight: '700', color: '#fff', marginBottom: 12 },
  description: { fontSize: 14, color: '#888', textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  backButton: { backgroundColor: '#2a2a2a', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  backButtonText: { color: '#22c55e', fontWeight: '600', fontSize: 14 },
});