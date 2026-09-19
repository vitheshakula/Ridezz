import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  StatusBar,
} from 'react-native';
import { useAuth } from '../context/AuthContext';

export const Dashboard = ({ navigation, onJoined }: any) => {
  const { user, logout } = useAuth();
  const [roomCode, setRoomCode] = useState('');

  const handleJoinRide = () => {
    if (!roomCode.trim()) {
      Alert.alert('Enter Room', 'Please enter a ride or room code.');
      return;
    }

    const payload = {
      roomName: roomCode.trim().toUpperCase(),
      riderName: user?.rider_name || 'Rider',
    };

    if (onJoined) {
      onJoined(payload);
    } else if (navigation?.navigate) {
      navigation.navigate('ActiveRoom', payload);
    }
  };

  // 🔹 If rider is NOT logged in: Show Welcome Screen with Login & Sign Up buttons
  if (!user) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#121212" />

        <View style={styles.centerContent}>
          <View style={styles.logoBadge}>
            <Text style={styles.logoBadgeText}>⚡</Text>
          </View>

          <Text style={styles.welcomeTitle}>Welcome to Ridezz</Text>
          <Text style={styles.heroSubtitle}>
            Budget motorcycle group intercom. Connect up to 10 riders over persistent voice audio.
          </Text>

          <View style={styles.authButtonGroup}>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => navigation?.navigate('LoginPage')}
            >
              <Text style={styles.primaryBtnText}>SIGN IN</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => navigation?.navigate('SignupPage')}
            >
              <Text style={styles.secondaryBtnText}>CREATE ACCOUNT</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // 🔹 If rider IS logged in: Show Room Code Entry
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#121212" />

      {/* Top Bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.riderHandle}>{user.rider_name}</Text>
          <Text style={styles.statusIndicator}>● Ready to ride</Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
          <Text style={styles.logoutText}>Leave</Text>
        </TouchableOpacity>
      </View>

      {/* Center Action */}
      <View style={styles.centerContent}>
        <Text style={styles.heroTitle}>Join Intercom</Text>
        <Text style={styles.heroSubtitle}>
          Connect with up to 10 riders over persistent cellular/Wi-Fi WebRTC.
        </Text>

        <TextInput
          style={styles.roomInput}
          placeholder="ENTER ROOM CODE (e.g. RIDE-99)"
          placeholderTextColor="#555"
          autoCapitalize="characters"
          value={roomCode}
          onChangeText={setRoomCode}
        />

        <TouchableOpacity style={styles.primaryBtn} onPress={handleJoinRide}>
          <Text style={styles.primaryBtnText}>CONNECT TO ROOM</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212', padding: 24 },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 20,
  },
  riderHandle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  statusIndicator: { fontSize: 12, color: '#22c55e', marginTop: 2 },
  logoutBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: '#222' },
  logoutText: { color: '#ef4444', fontSize: 12, fontWeight: '600' },
  centerContent: { flex: 1, justifyContent: 'center' },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1e1e1e',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  logoBadgeText: { fontSize: 28 },
  welcomeTitle: { fontSize: 32, fontWeight: '900', color: '#fff', marginBottom: 8 },
  heroTitle: { fontSize: 28, fontWeight: '900', color: '#fff', marginBottom: 8 },
  heroSubtitle: { fontSize: 15, color: '#888', marginBottom: 32, lineHeight: 22 },
  authButtonGroup: { width: '100%', gap: 14 },
  roomInput: {
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#333',
    paddingHorizontal: 20,
    paddingVertical: 16,
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 16,
  },
  primaryBtn: {
    backgroundColor: '#22c55e',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#000', fontSize: 15, fontWeight: '800', letterSpacing: 1 },
  secondaryBtn: {
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  secondaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 1 },
});