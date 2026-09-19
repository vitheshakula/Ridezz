/**
 * Ridezz - Motorcycle group intercom
 *
 * @format
 */

import React, { useCallback, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { Dashboard } from './src/screens/Dashboard';
import { LoginPage } from './src/screens/LoginPage';
import { SignupPage } from './src/screens/SignupPage';
import { ForgotPassword } from './src/screens/ForgotPassword';
import JoinScreen, { type RideSession } from './src/screens/JoinScreen';
import RideScreen from './src/screens/RideScreen';

export type ScreenName =
  | 'Dashboard'
  | 'LoginPage'
  | 'SignupPage'
  | 'ForgotPassword'
  | 'JoinScreen';

function MainContent() {
  const { user } = useAuth();
  const [currentScreen, setCurrentScreen] = useState<ScreenName>('Dashboard');
  const [session, setSession] = useState<RideSession | null>(null);

  const handleLeave = useCallback(() => setSession(null), []);

  const navigation = {
    navigate: (screen: ScreenName) => setCurrentScreen(screen),
  };

  // 1. In active voice room
  if (session) {
    return <RideScreen session={session} onLeave={handleLeave} />;
  }

  // 2. Logged-in user or directed to JoinScreen
  if (user || currentScreen === 'JoinScreen') {
    return <JoinScreen onJoined={setSession} navigation={navigation} />;
  }

  // 3. Unauthenticated auth stack
  return (
    <>
      <StatusBar barStyle="light-content" />
      {currentScreen === 'Dashboard' && (
        <Dashboard navigation={navigation} onJoined={setSession} />
      )}
      {currentScreen === 'LoginPage' && (
        <LoginPage navigation={navigation} />
      )}
      {currentScreen === 'SignupPage' && (
        <SignupPage navigation={navigation} />
      )}
      {currentScreen === 'ForgotPassword' && (
        <ForgotPassword navigation={navigation} />
      )}
      
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <MainContent />
      </AuthProvider>
    </SafeAreaProvider>
  );
}