import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import { createUserWithRoomCode, ensureRoomCode, withRoomCode } from '../auth/roomCode';
import { toAuthUser, type AuthUser } from '../auth/user';

const BCRYPT_ROUNDS = 10;

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export interface PasswordCrypto {
  hash(password: string, rounds: number): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

const defaultPasswordCrypto: PasswordCrypto = {
  hash: (password, rounds) => bcrypt.hash(password, rounds),
  compare: (password, hash) => bcrypt.compare(password, hash),
};

interface PasswordRegistration {
  riderName: string;
  email: string;
  password: string;
}

export type PasswordRegistrationResult = { kind: 'ok'; user: User } | { kind: 'duplicate' };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function registerWithPassword(
  prisma: PrismaClient,
  { riderName, email, password }: PasswordRegistration,
  passwordCrypto: PasswordCrypto = defaultPasswordCrypto,
): Promise<PasswordRegistrationResult> {
  if (await prisma.user.findUnique({ where: { email } })) {
    return { kind: 'duplicate' };
  }

  const passwordHash = await passwordCrypto.hash(password, BCRYPT_ROUNDS);
  try {
    const user = await createUserWithRoomCode(prisma, {
      riderName,
      email,
      password: passwordHash,
    });
    return { kind: 'ok', user };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { kind: 'duplicate' };
    }
    throw err;
  }
}

export type PasswordLoginResult =
  | { kind: 'ok'; user: User }
  | { kind: 'invalid_credentials' }
  | { kind: 'google_only' };

export async function loginWithPassword(
  prisma: PrismaClient,
  email: string,
  password: string,
  passwordCrypto: PasswordCrypto = defaultPasswordCrypto,
): Promise<PasswordLoginResult> {
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordMatches = await passwordCrypto.compare(password, user?.password ?? DUMMY_HASH);

  if (user && !user.password) {
    return { kind: 'google_only' };
  }
  if (!user || !passwordMatches) {
    return { kind: 'invalid_credentials' };
  }
  return { kind: 'ok', user };
}

export async function prepareSessionUser(prisma: PrismaClient, account: User): Promise<AuthUser> {
  return toAuthUser(await withRoomCode(prisma, account));
}

export async function prepareCurrentUser(prisma: PrismaClient, user: AuthUser): Promise<AuthUser> {
  return { ...user, roomCode: user.roomCode ?? (await ensureRoomCode(prisma, user.id)) };
}
