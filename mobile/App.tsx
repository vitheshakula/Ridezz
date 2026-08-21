/**
 * Ridezz - Motorcycle group intercom
 *
 * @format
 */

import { useCallback, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import JoinScreen, { type RideSession } from './src/screens/JoinScreen';
import RideScreen from './src/screens/RideScreen';

function App() {
  const [session, setSession] = useState<RideSession | null>(null);

  const handleLeave = useCallback(() => setSession(null), []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      {session ? (
        <RideScreen session={session} onLeave={handleLeave} />
      ) : (
        <JoinScreen onJoined={setSession} />
      )}
    </SafeAreaProvider>
  );
}

export default App;
