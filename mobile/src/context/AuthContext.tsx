import React, { createContext, useCallback, useContext, useState, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TOKEN_KEY, type RiderUser } from '../services/AuthService';
import { parseStoredUser } from '../utils/authStorage';

export type { RiderUser };

interface AuthContextType {
  token: string | null;
  user: RiderUser | null;
  isLoading: boolean;
  login: (token: string, userData: RiderUser) => Promise<void>;
  /** Replaces the saved profile (e.g. once the server has supplied the rider's room code). */
  updateUser: (userData: RiderUser) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const USER_KEY = '@ridezz_user_profile';

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<RiderUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Restore session from storage on app launch
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
        console.error('Failed to restore auth session:', error);
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
      console.error('Failed to persist login session:', error);
    }
  };

  // Stable identity, so an effect that depends on it doesn't re-run on every render.
  const updateUser = useCallback(async (userData: RiderUser) => {
    setUser(userData);
    try {
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(userData));
    } catch (error) {
      console.error('Failed to persist updated profile:', error);
    }
  }, []);

  const logout = async () => {
    try {
      await AsyncStorage.removeItem(TOKEN_KEY);
      await AsyncStorage.removeItem(USER_KEY);
      setToken(null);
      setUser(null);
    } catch (error) {
      console.error('Failed to clear auth session:', error);
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