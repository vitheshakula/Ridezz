import React, { useCallback, useState, useEffect } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';

const API_URL = 'http://localhost:5000/api';

export interface RideSession {
  serverUrl: string;
  token: string;
  riderName: string;
  roomCode: string;
}

interface JoinScreenProps {
  onJoined: (session: RideSession) => void;
  navigation?: any;
}

async function requestAllRidePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const permissionsToRequest: any[] = [
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  ];

  if (Platform.Version >= 33) {
    permissionsToRequest.push('android.permission.POST_NOTIFICATIONS');
  }

  if (Platform.Version >= 31) {
    permissionsToRequest.push('android.permission.BLUETOOTH_CONNECT');
  }

  try {
    const statuses = await PermissionsAndroid.requestMultiple(permissionsToRequest);

    const micGranted =
      statuses[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
      PermissionsAndroid.RESULTS.GRANTED;

    return micGranted;
  } catch (err) {
    console.warn('Failed to prompt permissions:', err);
    return false;
  }
}

export default function JoinScreen({ onJoined, navigation }: JoinScreenProps) {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();

  const [mode, setMode] = useState<'join' | 'create'>('join');
  const [riderName, setRiderName] = useState(user?.rider_name || '');
  const [roomCode, setRoomCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.rider_name) {
      setRiderName(user.rider_name);
    }
  }, [user]);

  const handleLogout = async () => {
    await logout();
    if (navigation?.navigate) {
      navigation.navigate('LoginPage');
    }
  };

  const handleAction = useCallback(async () => {
    if (isLoading) return;

    const trimmedName = riderName.trim();
    const trimmedCode = roomCode.trim().toUpperCase();

    if (!trimmedName) {
      setError('Please enter your rider name.');
      return;
    }

    if (mode === 'join' && !trimmedCode) {
      setError('Please enter the 6-character room code.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const micAllowed = await requestAllRidePermissions();
      if (!micAllowed) {
        setError('Microphone permission is required to talk.');
        Alert.alert(
          'Microphone Required',
          'Ridezz cannot start the voice intercom without microphone permission. Please allow it in the prompt.',
          [{ text: 'OK' }]
        );
        setIsLoading(false);
        return;
      }

      let response;
      if (mode === 'create') {
        response = await axios.post(`${API_URL}/rooms/create`, {
          riderName: trimmedName,
          userId: user?.id,
        });
      } else {
        response = await axios.post(`${API_URL}/rooms/join`, {
          roomCode: trimmedCode,
          riderName: trimmedName,
        });
      }

      const { roomCode: activeCode, token, serverUrl } = response.data;

      onJoined({
        serverUrl,
        token,
        riderName: trimmedName,
        roomCode: activeCode,
      });
    } catch (err: any) {
      const message = err.response?.data?.message || 'Could not connect to ride room.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, riderName, roomCode, mode, user, onJoined]);

  return (
    <KeyboardAvoidingView
      style={[
        styles.container,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.topBar}>
        <View>
          <Text style={styles.activeRiderLabel}>Logged In As</Text>
          <Text style={styles.activeRiderName}>{user?.rider_name || 'Rider'}</Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutBtnText}>Log Out</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        <Text style={styles.title}>RIDEZZ</Text>
        <Text style={styles.subtitle}>Group ride intercom</Text>

        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tab, mode === 'join' && styles.activeTab]}
            onPress={() => {
              setMode('join');
              setError(null);
            }}
          >
            <Text style={[styles.tabText, mode === 'join' && styles.activeTabText]}>
              JOIN ROOM
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, mode === 'create' && styles.activeTab]}
            onPress={() => {
              setMode('create');
              setError(null);
            }}
          >
            <Text style={[styles.tabText, mode === 'create' && styles.activeTabText]}>
              CREATE ROOM
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Rider Name</Text>
          <TextInput
            style={styles.input}
            value={riderName}
            onChangeText={setRiderName}
            placeholder="e.g. Alex"
            placeholderTextColor="#6b7280"
            autoCapitalize="words"
            editable={!isLoading}
          />

          {mode === 'join' && (
            <>
              <Text style={styles.label}>6-Character Room Code</Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                value={roomCode}
                onChangeText={(val) => setRoomCode(val.toUpperCase())}
                placeholder="e.g. 8K2M9X"
                placeholderTextColor="#6b7280"
                autoCapitalize="characters"
                maxLength={6}
                editable={!isLoading}
              />
            </>
          )}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.mainButton, isLoading && styles.buttonDisabled]}
          disabled={isLoading}
          onPress={handleAction}
        >
          {isLoading ? (
            <ActivityIndicator color="#000000" />
          ) : (
            <Text style={styles.mainButtonText}>
              {mode === 'create' ? 'Create & Start Ride' : 'Join Ride'}
            </Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  activeRiderLabel: {
    fontSize: 11,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  activeRiderName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#22c55e',
    marginTop: 2,
  },
  logoutBtn: {
    backgroundColor: '#261b1b',
    borderWidth: 1,
    borderColor: '#7f1d1d',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  logoutBtnText: {
    color: '#f87171',
    fontSize: 13,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 38,
    fontWeight: '900',
    color: '#22c55e',
    textAlign: 'center',
    letterSpacing: 2,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 28,
    textTransform: 'uppercase',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#1e1e1e',
    borderRadius: 10,
    padding: 4,
    marginBottom: 20,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  activeTab: {
    backgroundColor: '#2e2e2e',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
  },
  activeTabText: {
    color: '#22c55e',
  },
  form: {
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    color: '#aaa',
    marginBottom: 6,
    marginTop: 12,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#1e1e1e',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: '#ffffff',
  },
  codeInput: {
    textAlign: 'center',
    letterSpacing: 4,
    fontSize: 20,
    fontWeight: '700',
  },
  error: {
    color: '#ef4444',
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
  },
  mainButton: {
    backgroundColor: '#22c55e',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#2a2a2a',
    opacity: 0.6,
  },
  mainButtonText: {
    color: '#000000',
    fontSize: 17,
    fontWeight: '700',
  },
});