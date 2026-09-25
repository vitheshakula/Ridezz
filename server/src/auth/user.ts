import type { User } from '@prisma/client';

/** What the API and the token strategy expose about an account. Never includes the password hash. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export function toAuthUser(user: Pick<User, 'id' | 'email' | 'riderName' | 'emailVerified'>): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.riderName,
    emailVerified: user.emailVerified,
  };
}
