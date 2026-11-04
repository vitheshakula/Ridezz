import React, {
  createContext,
  useCallback,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TOKEN_KEY, type RiderUser } from '../services/AuthService';
import { parseStoredUser } from '../utils/authStorage';
import { createLogger } from '../utils/logger';

const log = createLogger('Auth');

export type { RiderUser };

interface AuthContextType {
  token: string | null;
  user: RiderUser | null;
  isLoading: boolean;
  login: (token: string, userData: RiderUser) => Promise<void>;
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
        const storedToken = await AsyncStorage.getItem(TOKEN_KEY);
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

  const login = async (newToken: string, userData: RiderUser) => {
    try {
      await AsyncStorage.setItem(TOKEN_KEY, newToken);
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
      await AsyncStorage.removeItem(TOKEN_KEY);
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
