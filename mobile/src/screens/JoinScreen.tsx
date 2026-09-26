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
import { useAuth } from '../context/AuthContext';
import type { RideDestination } from '../components/RiderMap';
import { spacing } from '../theme';
import { brand, font, homeRadius, homeType } from '../homeTheme';
import { LockIcon, PersonIcon, PinIcon, PlusIcon } from '../components/HomeIcons';
import { BottomNav } from '../components/BottomNav';
import { BrandHeader } from '../components/BrandHeader';
import { api } from '../services/AuthService';
import { geocodeDestination } from '../services/destinationService';
import { describeAuthError, isUnauthorized } from '../utils/authErrors';

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
  const [riderName, setRiderName] = useState(user?.name || '');
  const [roomCode, setRoomCode] = useState('');
  const [destination, setDestination] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<'name' | 'code' | 'destination' | null>(null);

  useEffect(() => {
    if (user?.name) {
      setRiderName(user.name);
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

        response = await api.post(
          '/rooms/create',
          {
            riderName: trimmedName,
            destinationName: destinationFix?.name ?? undefined,
            destinationLat: destinationFix?.latitude ?? undefined,
            destinationLng: destinationFix?.longitude ?? undefined,
          },
          { timeout: 8000 },
        );
      } else {
        response = await api.post(
          '/rooms/join',
          { roomCode: trimmedCode, riderName: trimmedName },
          { timeout: 8000 },
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
    } catch (err) {
      if (isUnauthorized(err)) {
        await logout();
        navigation?.navigate('LoginPage');
        return;
      }
      setError(describeAuthError(err, 'Could not connect to ride room.'));
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, riderName, roomCode, destination, mode, token, onJoined, logout, navigation]);

  const isCreate = mode === 'create';
  const initial = (user?.name || 'R').trim().charAt(0).toUpperCase() || 'R';

  const switchMode = (next: 'join' | 'create') => {
    setMode(next);
    setError(null);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <BrandHeader
        subtitle="DASHBOARD"
        right={
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.8}>
            <Text style={styles.logoutBtnText}>Log Out</Text>
          </TouchableOpacity>
        }
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: spacing.xxxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.identityCard}>
          <View style={styles.identityText}>
            <Text style={styles.identityBrand}>RIDEAZE</Text>
            <Text style={styles.identityCaption}>LOGGED IN AS</Text>
            <Text style={styles.identityName} numberOfLines={1}>
              {user?.name || 'Rider'}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.avatar}
            onPress={() => navigation?.navigate('ProfileScreen')}
            activeOpacity={0.8}
            accessibilityLabel="Open profile"
          >
            <Text style={styles.avatarText}>{initial}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Ready to ride?</Text>
          <Text style={styles.heroSubtitle}>
            Join your group or create a new connected ride session.
          </Text>
        </View>

        <View style={styles.segmented}>
          <TouchableOpacity
            style={[styles.segment, !isCreate && styles.segmentActive]}
            onPress={() => switchMode('join')}
            activeOpacity={0.85}
          >
            <PersonIcon size={16} color={!isCreate ? brand.onPrimary : brand.textSecondary} />
            <Text style={[styles.segmentText, !isCreate && styles.segmentTextActive]}>JOIN RIDE</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segment, isCreate && styles.segmentActive]}
            onPress={() => switchMode('create')}
            activeOpacity={0.85}
          >
            <PlusIcon size={16} color={isCreate ? brand.onPrimary : brand.textSecondary} />
            <Text style={[styles.segmentText, isCreate && styles.segmentTextActive]}>CREATE RIDE</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{isCreate ? 'Create a ride' : 'Join a ride'}</Text>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{isCreate ? 'LEADER MODE' : 'PACK MEMBER'}</Text>
            </View>
          </View>
          <Text style={styles.cardDescription}>
            {isCreate
              ? 'Create a connected ride and invite your group.'
              : 'Enter the 6-character ride code shared by your pack leader.'}
          </Text>

          <Text style={styles.fieldLabel}>RIDER NAME</Text>
          <TextInput
            style={[styles.input, focused === 'name' && styles.inputFocused]}
            value={riderName}
            onChangeText={setRiderName}
            onFocus={() => setFocused('name')}
            onBlur={() => setFocused(null)}
            placeholder="e.g. Alex"
            placeholderTextColor={brand.outline}
            autoCapitalize="words"
            editable={!isLoading}
          />

          {!isCreate && (
            <>
              <Text style={styles.fieldLabel}>RIDE SQUAD PIN</Text>
              <TextInput
                style={[styles.input, styles.codeInput, focused === 'code' && styles.inputFocused]}
                value={roomCode}
                onChangeText={val => setRoomCode(val.toUpperCase())}
                onFocus={() => setFocused('code')}
                onBlur={() => setFocused(null)}
                placeholder="e.g. 8K2M9X"
                placeholderTextColor={brand.outlineVariant}
                autoCapitalize="characters"
                maxLength={6}
                editable={!isLoading}
              />
            </>
          )}

          {isCreate && (
            <>
              <Text style={styles.fieldLabel}>DESTINATION (OPTIONAL)</Text>
              <View style={[styles.inputRow, focused === 'destination' && styles.inputFocused]}>
                <PinIcon size={18} color={brand.outline} />
                <TextInput
                  style={styles.inputRowText}
                  value={destination}
                  onChangeText={setDestination}
                  onFocus={() => setFocused('destination')}
                  onBlur={() => setFocused(null)}
                  placeholder="e.g. Golconda Fort, Hyderabad"
                  placeholderTextColor={brand.outline}
                  autoCapitalize="words"
                  editable={!isLoading}
                />
              </View>
            </>
          )}

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>
                {isCreate ? 'Unable to create ride' : 'Unable to join ride'}
              </Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              isLoading && styles.buttonDisabled,
              pressed && !isLoading && styles.buttonPressed,
            ]}
            disabled={isLoading}
            onPress={handleAction}
          >
            {isLoading ? <ActivityIndicator color={brand.onPrimary} /> : null}
            <Text style={styles.primaryButtonText}>
              {isLoading
                ? isCreate
                  ? 'CREATING RIDE...'
                  : 'JOINING RIDE...'
                : isCreate
                  ? 'CREATE RIDE'
                  : 'JOIN RIDE'}
            </Text>
          </Pressable>

          <View style={styles.privacyRow}>
            <LockIcon size={12} color={brand.textSecondary} />
            <Text style={styles.privacyText}>
              Your rider name &amp; live location will be shared with the squad.
            </Text>
          </View>
        </View>

        <View style={styles.recentHeader}>
          <Text style={styles.recentTitle}>Recent Rides</Text>
        </View>
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>NO RECENT RIDES</Text>
          <Text style={styles.emptyText}>Your completed rides will appear here.</Text>
        </View>
      </ScrollView>

      <BottomNav
        active="rides"
        onRides={() => navigation?.navigate('JoinScreen')}
        onProfile={() => navigation?.navigate('ProfileScreen')}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: brand.bg },
  logoutBtn: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: homeRadius.button,
    backgroundColor: brand.dangerMuted,
    borderWidth: 1,
    borderColor: brand.dangerBorder,
  },
  logoutBtnText: { ...homeType.labelMedium, color: '#f87171' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.lg },

  identityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: brand.card,
    borderRadius: homeRadius.card,
    padding: spacing.lg,
  },
  identityText: { flex: 1, paddingRight: spacing.md },
  identityBrand: { ...homeType.labelLarge, color: brand.textPrimary, letterSpacing: 1 },
  identityCaption: { ...homeType.labelSmall, color: brand.primary, marginTop: spacing.xs },
  identityName: { ...homeType.bodyMedium, color: brand.textSecondary, marginTop: 2 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: brand.primaryMuted,
    borderWidth: 1,
    borderColor: brand.primaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...homeType.headlineSmall, color: brand.primary },

  hero: { paddingVertical: spacing.sm },
  heroTitle: { ...homeType.headlineLarge, color: brand.textPrimary },
  heroSubtitle: { ...homeType.bodyMedium, color: brand.textSecondary, marginTop: spacing.sm },

  segmented: {
    flexDirection: 'row',
    backgroundColor: brand.darkest,
    borderRadius: homeRadius.pill,
    padding: 4,
  },
  segment: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: homeRadius.pill,
  },
  segmentActive: { backgroundColor: brand.primary },
  segmentText: { ...homeType.labelLarge, color: brand.textSecondary },
  segmentTextActive: { color: brand.onPrimary, fontFamily: font.bold },

  card: {
    backgroundColor: brand.card,
    borderRadius: homeRadius.card,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  cardTitle: { ...homeType.headlineSmall, color: brand.textPrimary, flexShrink: 1 },
  chip: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: homeRadius.pill,
    backgroundColor: brand.primaryMuted,
    borderWidth: 1,
    borderColor: brand.primaryBorder,
  },
  chipText: { ...homeType.labelSmall, color: brand.primary },
  cardDescription: { ...homeType.bodyMedium, color: brand.textSecondary, marginTop: spacing.sm },

  fieldLabel: { ...homeType.labelSmall, color: brand.outline, marginTop: spacing.lg, marginBottom: spacing.sm },
  input: {
    minHeight: 52,
    backgroundColor: brand.darkest,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    borderRadius: homeRadius.input,
    paddingHorizontal: spacing.lg,
    ...homeType.bodyLarge,
    color: brand.textPrimary,
  },
  inputFocused: { borderColor: brand.primary },
  codeInput: {
    textAlign: 'center',
    letterSpacing: 8,
    fontSize: 24,
    lineHeight: 30,
    fontFamily: font.heading,
  },
  inputRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: brand.darkest,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    borderRadius: homeRadius.input,
    paddingHorizontal: spacing.lg,
  },
  inputRowText: { flex: 1, ...homeType.bodyLarge, color: brand.textPrimary, paddingVertical: spacing.md },

  errorBox: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: homeRadius.input,
    backgroundColor: brand.dangerMuted,
    borderWidth: 1,
    borderColor: brand.dangerBorder,
  },
  errorTitle: { ...homeType.labelLarge, color: brand.danger },
  errorText: { ...homeType.bodySmall, color: brand.textPrimary, marginTop: 2 },

  primaryButton: {
    minHeight: 52,
    marginTop: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: homeRadius.button,
    backgroundColor: brand.primary,
  },
  primaryButtonText: { ...homeType.button, color: brand.onPrimary },
  buttonDisabled: { opacity: 0.6 },
  buttonPressed: { opacity: 0.85 },

  privacyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  privacyText: { flex: 1, fontSize: 11, lineHeight: 15, fontFamily: font.body, color: brand.textSecondary },

  recentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  recentTitle: { ...homeType.headlineSmall, color: brand.textPrimary },
  emptyCard: {
    alignItems: 'center',
    padding: spacing.xl,
    borderRadius: homeRadius.card,
    backgroundColor: brand.surfaceLow,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    borderStyle: 'dashed',
  },
  emptyTitle: { ...homeType.labelSmall, color: brand.outline },
  emptyText: { ...homeType.bodySmall, color: brand.textSecondary, marginTop: spacing.xs },
});
