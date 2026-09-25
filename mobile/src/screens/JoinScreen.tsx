import React, { useCallback, useState, useEffect } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
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
import type { RideDestination } from '../components/RiderMap';
import BrandLockup from '../components/BrandLockup';
import { color, radius, spacing, type, primaryButtonStyle, inputStyle } from '../theme';

import { API_URL } from '@env';
import { geocodeDestination } from '../services/destinationService';

export const API_BASE_URL = API_URL || 'http://localhost:5000/api';

export interface RideSession {
  serverUrl: string;
  token: string;
  riderName: string;
  roomCode: string;
  isHost: boolean;
  destination?: RideDestination | null;
}

function destinationFromRoomResponse(data: any): RideDestination | null {
  const lat = data?.destinationLat;
  const lng = data?.destinationLng;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }
  return { name: data?.destinationName ?? null, latitude: lat, longitude: lng };
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
  const { user, token, logout } = useAuth();

  const [mode, setMode] = useState<'join' | 'create'>('join');
  const [riderName, setRiderName] = useState(user?.rider_name || '');
  const [roomCode, setRoomCode] = useState('');
  const [destination, setDestination] = useState('');
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

    if (!token) {
      setError('Your session has expired. Please sign in again.');
      return;
    }

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
          'Rideaze cannot start the voice intercom without microphone permission. Please allow it in the prompt.',
          [{ text: 'OK' }]
        );
        setIsLoading(false);
        return;
      }

      let response;
      if (mode === 'create') {
        const trimmedDestination = destination.trim();
        let destinationFix: RideDestination | null = null;
        if (trimmedDestination) {
          destinationFix = await geocodeDestination(trimmedDestination);
          if (!destinationFix) {
            setError(`Couldn't find "${trimmedDestination}". Try a more specific search.`);
            setIsLoading(false);
            return;
          }
        }

        response = await axios.post(
          `${API_BASE_URL}/rooms/create`,
          {
            destinationName: destinationFix?.name ?? undefined,
            destinationLat: destinationFix?.latitude ?? undefined,
            destinationLng: destinationFix?.longitude ?? undefined,
          },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 },
        );
      } else {
        response = await axios.post(
          `${API_BASE_URL}/rooms/join`,
          { roomCode: trimmedCode },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 },
        );
      }

      const { roomCode: activeCode, token: liveKitToken, serverUrl, isHost } = response.data;

      onJoined({
        serverUrl,
        token: liveKitToken,
        riderName: trimmedName,
        roomCode: activeCode,
        isHost: Boolean(isHost),
        destination: destinationFromRoomResponse(response.data),
      });
    } catch (err: any) {
      const message = err.response?.data?.message || 'Could not connect to ride room.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, riderName, roomCode, destination, mode, token, onJoined]);

  return (
    <KeyboardAvoidingView
      style={[
        styles.container,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xl },
      ]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.topBar}>
        <BrandLockup compact />
        <View style={styles.profileArea}>
          <View style={styles.profileCopy}>
            <Text style={styles.activeRiderLabel}>SIGNED IN AS</Text>
            <Text style={styles.activeRiderName}>{user?.rider_name || 'Rider'}</Text>
          </View>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(user?.rider_name || 'R').trim().charAt(0).toUpperCase()}
            </Text>
          </View>
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.8}>
            <Text style={styles.logoutBtnText}>Log out</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.eyebrow}>YOUR NEXT SESSION</Text>
        <Text style={styles.title}>Where are we riding?</Text>
        <Text style={styles.subtitle}>
          Join with a crew code, or create a new room and invite the group.
        </Text>

        <View style={styles.formCard}>
          <View style={styles.tabContainer}>
            <TouchableOpacity
              style={[styles.tab, mode === 'join' && styles.activeTab]}
              onPress={() => {
                setMode('join');
                setError(null);
              }}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, mode === 'join' && styles.activeTabText]}>
                Join a ride
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, mode === 'create' && styles.activeTab]}
              onPress={() => {
                setMode('create');
                setError(null);
              }}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, mode === 'create' && styles.activeTabText]}>
                Start a ride
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Rider name</Text>
            <TextInput
              style={styles.input}
              value={riderName}
              onChangeText={setRiderName}
              placeholder="e.g. Alex"
              placeholderTextColor={color.textMuted}
              autoCapitalize="words"
              editable={!isLoading}
            />

            {mode === 'join' && (
              <>
                <View style={styles.fieldHeading}>
                  <Text style={styles.label}>Ride code</Text>
                  <Text style={styles.fieldHint}>6 characters</Text>
                </View>
                <TextInput
                  style={[styles.input, styles.codeInput]}
                  value={roomCode}
                  onChangeText={(val) => setRoomCode(val.toUpperCase())}
                  placeholder="e.g. 8K2M9X"
                  placeholderTextColor={color.textMuted}
                  autoCapitalize="characters"
                  maxLength={6}
                  editable={!isLoading}
                />
              </>
            )}

            {mode === 'create' && (
              <>
                <View style={styles.fieldHeading}>
                  <Text style={styles.label}>Destination</Text>
                  <Text style={styles.fieldHint}>Optional</Text>
                </View>
                <TextInput
                  style={styles.input}
                  value={destination}
                  onChangeText={setDestination}
                  placeholder="e.g. Golconda Fort, Hyderabad"
                  placeholderTextColor={color.textMuted}
                  autoCapitalize="words"
                  editable={!isLoading}
                />
              </>
            )}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[primaryButtonStyle, isLoading && styles.buttonDisabled]}
            disabled={isLoading}
            onPress={handleAction}
          >
            {isLoading ? (
              <ActivityIndicator color={color.onAccent} />
            ) : (
              <Text style={styles.mainButtonText}>
                {mode === 'create' ? 'Create ride' : 'Join ride'}
              </Text>
            )}
          </Pressable>

          <Text style={styles.safetyNote}>
            Voice, location, and hazard detection activate only after you enter the ride.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.bg,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  profileArea: { flexDirection: 'row', alignItems: 'center' },
  profileCopy: { alignItems: 'flex-end', marginRight: spacing.sm },
  activeRiderLabel: { ...type.overline, color: color.textMuted, fontSize: 9, lineHeight: 12 },
  activeRiderName: { fontSize: 13, fontWeight: '700', color: color.textPrimary, marginTop: 2 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accentMuted,
    borderWidth: 1,
    borderColor: color.accentBorder,
  },
  avatarText: { color: color.accent, fontSize: 13, fontWeight: '800' },
  logoutBtn: {
    paddingVertical: spacing.sm,
    paddingLeft: spacing.md,
  },
  logoutBtnText: {
    color: color.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxxl,
  },
  eyebrow: { ...type.overline, color: color.accent, marginBottom: spacing.md },
  title: {
    ...type.hero,
    color: color.textPrimary,
    maxWidth: 340,
  },
  subtitle: {
    ...type.body,
    color: color.textSecondary,
    marginTop: spacing.md,
    marginBottom: spacing.xxl,
    maxWidth: 350,
  },
  formCard: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.border,
    padding: spacing.xl,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: color.bgSoft,
    borderRadius: radius.md,
    padding: spacing.xs,
    marginBottom: spacing.xl,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  activeTab: {
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.borderStrong,
  },
  tabText: { ...type.label, color: color.textMuted },
  activeTabText: {
    color: color.textPrimary,
  },
  form: {
    marginBottom: spacing.lg,
  },
  label: {
    ...type.label,
    color: color.textSecondary,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  fieldHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldHint: { ...type.caption, color: color.textMuted, marginTop: spacing.md, marginBottom: spacing.sm },
  input: { ...inputStyle },
  codeInput: {
    textAlign: 'center',
    letterSpacing: 4,
    fontSize: 21,
    fontWeight: '800',
  },
  error: {
    color: color.danger,
    ...type.caption,
    backgroundColor: color.dangerMuted,
    borderWidth: 1,
    borderColor: color.dangerBorder,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  buttonDisabled: {
    backgroundColor: color.surfaceRaised,
    opacity: 0.6,
  },
  mainButtonText: {
    color: color.onAccent,
    fontSize: 16,
    fontWeight: '800',
  },
  safetyNote: { ...type.caption, color: color.textMuted, textAlign: 'center', marginTop: spacing.lg },
});
