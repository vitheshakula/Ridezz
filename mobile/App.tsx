/**
 * Ridezz - Motorcycle group intercom
 *
 * @format
 */

import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <JoinScreen />
    </SafeAreaProvider>
  );
}

function JoinScreen() {
  const insets = useSafeAreaInsets();
  const [riderName, setRiderName] = useState('');
  const [roomCode, setRoomCode] = useState('');

  const canJoin = riderName.trim().length > 0 && roomCode.trim().length > 0;

  const handleJoinRide = () => {
    // Room connection wiring lands with the LiveKit token/backend integration.
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
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
          />

          <Text style={styles.label}>Room Code</Text>
          <TextInput
            style={styles.input}
            value={roomCode}
            onChangeText={setRoomCode}
            placeholder="e.g. sunday-ride"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <Pressable
          style={[styles.joinButton, !canJoin && styles.joinButtonDisabled]}
          disabled={!canJoin}
          onPress={handleJoinRide}
        >
          <Text style={styles.joinButtonText}>Join Ride</Text>
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
    marginBottom: 32,
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

export default App;
