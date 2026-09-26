import type { User } from '@prisma/client';

/** What the API and the token strategy expose about an account. Never includes the password hash. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  /** The rider's permanent 5-digit code. Null only for an account that predates the feature and
   * hasn't signed in, fetched its profile or hosted since -- every response built for the rider
   * (sign-in, sign-up, profile) fills it in first. */
  roomCode: string | null;
}

export function toAuthUser(
  user: Pick<User, 'id' | 'email' | 'riderName' | 'emailVerified' | 'roomCode'>,
): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.riderName,
    emailVerified: user.emailVerified,
    roomCode: user.roomCode,
  };
}
