import type { User } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
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
