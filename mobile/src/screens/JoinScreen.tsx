import { useCallback, useState } from 'react';
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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { joinRoom, type ConnectionDetails } from '../services/livekit';

export interface RideSession extends ConnectionDetails {
  riderName: string;
  roomCode: string;
}

interface JoinScreenProps {
  onJoined: (session: RideSession) => void;
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

export default function JoinScreen({ onJoined }: JoinScreenProps) {
  const insets = useSafeAreaInsets();
  const [riderName, setRiderName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canJoin =
    riderName.trim().length > 0 && roomCode.trim().length > 0 && !isJoining;

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
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Ridezz</Text>
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
            <ActivityIndicator color="#ffffff" />
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
    backgroundColor: '#0d1117',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 40,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#9ca3af',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 40,
  },
  form: {
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    color: '#9ca3af',
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#ffffff',
  },
  error: {
    color: '#f85149',
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
  },
  joinButton: {
    backgroundColor: '#2f81f7',
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
  },
  joinButtonDisabled: {
    backgroundColor: '#30363d',
  },
  joinButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
});
