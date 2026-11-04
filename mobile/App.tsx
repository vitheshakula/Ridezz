import React, { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import BootSplash from 'react-native-bootsplash';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { Dashboard } from './src/screens/Dashboard';
import { LoginPage } from './src/screens/LoginPage';
import { SignupPage } from './src/screens/SignupPage';
import { ForgotPassword } from './src/screens/ForgotPassword';
import JoinScreen, { type RideSession } from './src/screens/JoinScreen';
import RideScreen from './src/screens/RideScreen';
import ProfileScreen from './src/screens/ProfileScreen';

export type ScreenName =
  | 'Dashboard'
  | 'LoginPage'
  | 'SignupPage'
  | 'ForgotPassword'
  | 'JoinScreen'
  | 'ProfileScreen';

function MainContent() {
  const { user, isLoading } = useAuth();
  const [currentScreen, setCurrentScreen] = useState<ScreenName>('Dashboard');
  const [session, setSession] = useState<RideSession | null>(null);

  const handleLeave = useCallback(() => setSession(null), []);

  useEffect(() => {
    if (!isLoading) {
      BootSplash.hide({ fade: true });
    }
  }, [isLoading]);

  if (isLoading) {
    return null;
  }

  const navigation = {
    navigate: (screen: ScreenName) => setCurrentScreen(screen),
  };

  if (session) {
    return <RideScreen session={session} onLeave={handleLeave} />;
  }

  if (user && currentScreen === 'ProfileScreen') {
    return <ProfileScreen navigation={navigation} />;
  }

  if (user || currentScreen === 'JoinScreen') {
    return <JoinScreen onJoined={setSession} navigation={navigation} />;
  }

  return (
    <>
      <StatusBar barStyle="light-content" />
      {currentScreen === 'Dashboard' && <Dashboard navigation={navigation} />}
      {currentScreen === 'LoginPage' && <LoginPage navigation={navigation} />}
      {currentScreen === 'SignupPage' && <SignupPage navigation={navigation} />}
      {currentScreen === 'ForgotPassword' && <ForgotPassword navigation={navigation} />}
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
