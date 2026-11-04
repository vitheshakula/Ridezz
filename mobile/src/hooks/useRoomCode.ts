import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { fetchProfile } from '../services/AuthService';
import { isRoomCode } from '../utils/roomCode';

export type RoomCodeStatus = 'ready' | 'loading' | 'error';

export function useRoomCode() {
  const { user, token, updateUser } = useAuth();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const roomCode = user?.roomCode ?? null;
  const needsFetch = Boolean(user && token && !roomCode);

  useEffect(() => {
    if (!needsFetch || !user) {
      return;
    }
    let cancelled = false;
    setFailed(false);
    fetchProfile()
      .then(profile => {
        if (cancelled) {
          return;
        }
        if (isRoomCode(profile.roomCode)) {
          updateUser({ ...user, roomCode: profile.roomCode });
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, user, updateUser, attempt]);

  const status: RoomCodeStatus = roomCode ? 'ready' : needsFetch && !failed ? 'loading' : 'error';

  return {
    roomCode,
    status,
    retry: () => {
      setFailed(false);
      setAttempt(count => count + 1);
    },
  };
}
