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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { joinRoom, type ConnectionDetails } from '../services/livekit';
import { useAuth } from '../context/AuthContext';

export interface RideSession extends ConnectionDetails {
  riderName: string;
  roomCode: string;
}

interface JoinScreenProps {
  onJoined: (session: RideSession) => void;
  navigation?: any;
}

async function ensureMicrophonePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  const alreadyGranted = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  );
  if (alreadyGranted) {
    return true;
  }
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: 'Microphone access',
      message: 'Ridezz needs your microphone so other riders can hear you.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

async function requestNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  try {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      {
        title: 'Show ride status',
        message: 'Ridezz shows an ongoing notification while your intercom is active.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      },
    );
  } catch {
    // Ignore older Android versions
  }
}

async function requestLocationPermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
    title: 'Share your location',
    message: 'Ridezz can show mounted riders where everyone in the group is. Optional.',
    buttonPositive: 'Allow',
    buttonNegative: 'Deny',
  });
}

export default function JoinScreen({ onJoined, navigation }: JoinScreenProps) {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  
  // Default to authenticated rider's name if present
  const [riderName, setRiderName] = useState(user?.rider_name || '');
  const [roomCode, setRoomCode] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.rider_name) {
      setRiderName(user.rider_name);
    }
  }, [user]);

  const canJoin =
    riderName.trim().length > 0 && roomCode.trim().length > 0 && !isJoining;

  const handleLogout = async () => {
    await logout();
    if (navigation?.navigate) {
      navigation.navigate('LoginPage');
    }
  };

  const handleJoinRide = useCallback(async () => {
    if (isJoining) {
      return;
    }
    const trimmedName = riderName.trim();
    const trimmedCode = roomCode.trim();
    if (!trimmedName || !trimmedCode) {
      return;
    }

    setIsJoining(true);
    setError(null);
    try {
      const hasMicPermission = await ensureMicrophonePermission();
      if (!hasMicPermission) {
        setError('Microphone permission is required to join a ride.');
        return;
      }
      await requestNotificationPermission();
      await requestLocationPermission();
      const details = await joinRoom(trimmedName, trimmedCode);
      onJoined({ ...details, riderName: trimmedName, roomCode: trimmedCode });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join the room. Try again.');
    } finally {
      setIsJoining(false);
    }
  }, [isJoining, riderName, roomCode, onJoined]);

  return (
    <KeyboardAvoidingView
      style={[
        styles.container,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Top Bar with User Info & Logout Button */}
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

        <View style={styles.form}>
          <Text style={styles.label}>Rider Name</Text>
          <TextInput
            style={styles.input}
            value={riderName}
            onChangeText={setRiderName}
            placeholder="e.g. Alex"
            placeholderTextColor="#6b7280"
            autoCapitalize="words"
            autoCorrect={false}
            editable={!isJoining}
          />

          <Text style={styles.label}>Room Code</Text>
          <TextInput
            style={styles.input}
            value={roomCode}
            onChangeText={setRoomCode}
            placeholder="e.g. TEST01"
            placeholderTextColor="#6b7280"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!isJoining}
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.joinButton, !canJoin && styles.joinButtonDisabled]}
          disabled={!canJoin}
          onPress={handleJoinRide}
        >
          {isJoining ? (
            <ActivityIndicator color="#000000" />
          ) : (
            <Text style={styles.joinButtonText}>Join Ride</Text>
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
    marginBottom: 36,
    textTransform: 'uppercase',
  },
  form: {
    marginBottom: 24,
  },
  label: {
    fontSize: 13,
    color: '#aaa',
    marginBottom: 6,
    marginTop: 14,
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
  error: {
    color: '#ef4444',
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
  },
  joinButton: {
    backgroundColor: '#22c55e',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  joinButtonDisabled: {
    backgroundColor: '#2a2a2a',
    opacity: 0.6,
  },
  joinButtonText: {
    color: '#000000',
    fontSize: 17,
    fontWeight: '700',
  },
});