import bcrypt from 'bcryptjs';
import { Router, type RequestHandler } from 'express';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import {
  emailError,
  fallbackRiderName,
  isAllowedEmailDomain,
  nameError,
  NAME_MAX_LENGTH,
  normalizeEmail,
  passwordError,
} from '../auth/validation';
import { isEmailAllowed, NOT_ALLOWED_MESSAGE } from '../auth/access';
import { signAuthToken } from '../auth/tokens';
import { toAuthUser } from '../auth/user';
import type { GoogleIdentity, GoogleVerifier } from '../auth/google';
import type { Env } from '../config/env';
import { asyncHandler } from '../http';

const BCRYPT_ROUNDS = 10;

/** Compared against when the email is unknown, so a miss costs the same time as a wrong password
 * and the response time can't be used to discover which emails have accounts. */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

interface AuthRouterDeps {
  prisma: PrismaClient;
  env: Env;
  requireAuth: RequestHandler;
  /** Absent when GOOGLE_CLIENT_ID isn't configured; Google endpoints then answer 503. */
  verifyGoogleIdToken?: GoogleVerifier;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function createAuthRouter({ prisma, env, requireAuth, verifyGoogleIdToken }: AuthRouterDeps): Router {
  const router = Router();

  const session = (user: User) => ({
    token: signAuthToken(user.id, env.jwtSecret),
    user: toAuthUser(user),
  });

  // ---- Email + password -------------------------------------------------------------------

  router.post(
    ['/signup', '/register'],
    asyncHandler(async (req, res) => {
      const { name, email, password } = req.body ?? {};
      if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ message: 'Name, email and password are required.' });
      }
      const cleanName = name.trim();
      const cleanEmail = normalizeEmail(email);
      const problem = nameError(cleanName) ?? emailError(cleanEmail) ?? passwordError(password);
      if (problem) {
        return res.status(400).json({ message: problem });
      }
      if (!isEmailAllowed(env.allowedEmails, cleanEmail)) {
        return res.status(403).json({ message: NOT_ALLOWED_MESSAGE });
      }

      const taken = { message: 'An account with this email already exists.' };
      if (await prisma.user.findUnique({ where: { email: cleanEmail } })) {
        return res.status(409).json(taken);
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      try {
        // Created unverified: the address was typed in, not proven to belong to this person.
        const user = await prisma.user.create({
          data: { riderName: cleanName, email: cleanEmail, password: passwordHash },
        });
        return res.status(201).json(session(user));
      } catch (err) {
        // Two sign-ups for the same address racing past the check above.
        if (isUniqueViolation(err)) {
          return res.status(409).json(taken);
        }
        throw err;
      }
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
      }

      const cleanEmail = normalizeEmail(email);
      if (!isEmailAllowed(env.allowedEmails, cleanEmail)) {
        return res.status(403).json({ message: NOT_ALLOWED_MESSAGE });
      }

      const user = await prisma.user.findUnique({ where: { email: cleanEmail } });
      const passwordMatches = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);

      if (user && !user.password) {
        return res.status(401).json({ message: 'This account uses Google sign-in. Tap "Continue with Google".' });
      }
      if (!user || !passwordMatches) {
        return res.status(401).json({ message: 'Invalid credentials.' });
      }
      return res.status(200).json(session(user));
    }),
  );

  // ---- Google -----------------------------------------------------------------------------

  /** The public web client id the app must request its Google token for. Not a secret. */
  router.get('/google/config', (_req, res) => {
    if (!env.googleClientId) {
      return res.status(503).json({ message: 'Google sign-in is not configured on the server.' });
    }
    return res.json({ clientId: env.googleClientId });
  });

  router.post(
    '/google',
    asyncHandler(async (req, res) => {
      if (!verifyGoogleIdToken) {
        return res.status(503).json({ message: 'Google sign-in is not configured on the server.' });
      }
      const { idToken, mode = 'login' } = req.body ?? {};
      if (typeof idToken !== 'string' || !idToken) {
        return res.status(400).json({ message: 'A Google ID token is required.' });
      }
      if (mode !== 'login' && mode !== 'signup') {
        return res.status(400).json({ message: 'Mode must be "login" or "signup".' });
      }

      let identity: GoogleIdentity;
      try {
        identity = await verifyGoogleIdToken(idToken);
      } catch (err) {
        console.warn('Google ID token rejected:', err instanceof Error ? err.message : err);
        return res.status(401).json({ message: 'Google sign-in failed. Please try again.' });
      }

      const email = normalizeEmail(identity.email);
      if (!identity.emailVerified) {
        return res.status(401).json({ message: 'Your Google email address is not verified.' });
      }
      if (!isAllowedEmailDomain(email)) {
        return res.status(403).json({ message: 'Only Gmail accounts are supported.' });
      }
      if (!isEmailAllowed(env.allowedEmails, email)) {
        return res.status(403).json({ message: NOT_ALLOWED_MESSAGE });
      }

      const result = await findOrCreateGoogleUser(prisma, identity, email, mode);
      if (result.kind === 'not_found') {
        return res.status(404).json({
          message: 'No account found for this Google account. Create an account first.',
          code: 'ACCOUNT_NOT_FOUND',
        });
      }
      if (result.kind === 'conflict') {
        return res.status(409).json({ message: 'This email is already linked to a different Google account.' });
      }
      return res.status(200).json(session(result.user));
    }),
  );

  // ---- Session ----------------------------------------------------------------------------

  router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  return router;
}

type GoogleMode = 'login' | 'signup';

type GoogleAccountResult =
  | { kind: 'ok'; user: User }
  | { kind: 'conflict' }
  | { kind: 'not_found' };

/**
 * Resolves the account for a Google-verified identity.
 *
 * - **login** only ever finds an account that already exists. Someone who has never registered
 *   gets 'not_found' and NOTHING is created -- signing in must not be a back door to sign-up.
 * - **signup** finds the account, or creates it.
 *
 * An existing email + password account for this address is linked and marked verified in either
 * mode -- but its password is deleted. That account was never proven to belong to the address:
 * whoever registered it may not own the mailbox, and keeping their password would let them keep
 * signing in to the real owner's account after the owner proves themselves with Google.
 */
async function findOrCreateGoogleUser(
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
    const created = await prisma.user.create({
      data: {
        riderName: (identity.name?.trim() || fallbackRiderName(email)).slice(0, NAME_MAX_LENGTH),
        email,
        googleId: identity.googleId,
        emailVerified: true,
        password: null,
      },
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
