import React, {
  createContext,
  useCallback,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { revokeSession, type RiderUser } from '../services/AuthService';
import { onSessionEvent, readAccessToken, saveTokens } from '../services/sessionTokens';
import { parseStoredUser } from '../utils/authStorage';
import { createLogger } from '../utils/logger';

const log = createLogger('Auth');

export type { RiderUser };

interface AuthContextType {
  token: string | null;
  user: RiderUser | null;
  isLoading: boolean;
  login: (token: string, userData: RiderUser, refreshToken?: string) => Promise<void>;
  updateUser: (userData: RiderUser) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const USER_KEY = '@ridezz_user_profile';

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<RiderUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    const restoreSession = async () => {
      try {
        const storedToken = await readAccessToken();
        const storedUser = await AsyncStorage.getItem(USER_KEY);

        const restoredUser = parseStoredUser(storedUser);
        if (storedToken && restoredUser) {
          setToken(storedToken);
          setUser(restoredUser);
        }
      } catch (error) {
        log.error('Failed to restore auth session:', error);
      } finally {
        setIsLoading(false);
      }
    };

    restoreSession();
  }, []);

  useEffect(
    () =>
      onSessionEvent(event => {
        if (event.type === 'refreshed') {
          setToken(event.token);
          return;
        }
        setToken(null);
        setUser(null);
        AsyncStorage.removeItem(USER_KEY).catch(error =>
          log.error('Failed to clear the expired session profile:', error),
        );
      }),
    [],
  );

  const login = async (newToken: string, userData: RiderUser, refreshToken?: string) => {
    try {
      await saveTokens({ token: newToken, refreshToken: refreshToken ?? null });
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(userData));
      setToken(newToken);
      setUser(userData);
    } catch (error) {
      log.error('Failed to persist login session:', error);
    }
  };

  const updateUser = useCallback(async (userData: RiderUser) => {
    setUser(userData);
    try {
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(userData));
    } catch (error) {
      log.error('Failed to persist updated profile:', error);
    }
  }, []);

  const logout = async () => {
    try {
      await revokeSession();
      await AsyncStorage.removeItem(USER_KEY);
      setToken(null);
      setUser(null);
    } catch (error) {
      log.error('Failed to clear auth session:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ token, user, isLoading, login, updateUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
