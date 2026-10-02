import { Prisma, type PrismaClient, type User } from '@prisma/client';
import type { GoogleIdentity } from '../auth/google';
import { createUserWithRoomCode } from '../auth/roomCode';
import { fallbackRiderName, NAME_MAX_LENGTH } from '../auth/validation';

export type GoogleMode = 'login' | 'signup';

export type GoogleAccountResult =
  | { kind: 'ok'; user: User }
  | { kind: 'conflict' }
  | { kind: 'not_found' };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Resolves the account for a Google-verified identity.
 *
 * Login only finds an existing account; signup may create one. An existing password account with
 * the verified email is linked to Google and loses its unverified password credential.
 */
export async function reconcileGoogleAccount(
  prisma: PrismaClient,
  identity: GoogleIdentity,
  email: string,
  mode: GoogleMode,
): Promise<GoogleAccountResult> {
  const byGoogleId = await prisma.user.findUnique({ where: { googleId: identity.googleId } });
  if (byGoogleId) {
    return { kind: 'ok', user: byGoogleId };
  }

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    if (byEmail.googleId && byEmail.googleId !== identity.googleId) {
      return { kind: 'conflict' };
    }
    const linked = await prisma.user.update({
      where: { id: byEmail.id },
      data: { googleId: identity.googleId, emailVerified: true, password: null },
    });
    return { kind: 'ok', user: linked };
  }

  if (mode === 'login') {
    return { kind: 'not_found' };
  }

  try {
    const created = await createUserWithRoomCode(prisma, {
      riderName: (identity.name?.trim() || fallbackRiderName(email)).slice(0, NAME_MAX_LENGTH),
      email,
      googleId: identity.googleId,
      emailVerified: true,
      password: null,
    });
    return { kind: 'ok', user: created };
  } catch (err) {
    // The same person's first two requests raced; the other one created the account.
    if (isUniqueViolation(err)) {
      const existing = await prisma.user.findUnique({ where: { googleId: identity.googleId } });
      return existing ? { kind: 'ok', user: existing } : { kind: 'conflict' };
    }
    throw err;
  }
}
