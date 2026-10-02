import bcrypt from 'bcryptjs';
import { Router, type RequestHandler } from 'express';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import {
  emailError,
  isAllowedEmailDomain,
  nameError,
  normalizeEmail,
  passwordError,
} from '../auth/validation';
import { isEmailAllowed, NOT_ALLOWED_MESSAGE } from '../auth/access';
import { signAuthToken } from '../auth/tokens';
import { createUserWithRoomCode, ensureRoomCode, withRoomCode } from '../auth/roomCode';
import { toAuthUser } from '../auth/user';
import type { GoogleIdentity, GoogleVerifier } from '../auth/google';
import type { Env } from '../config/env';
import { asyncHandler } from '../http';
import { reconcileGoogleAccount } from '../services/googleAuthService';

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

  // Every way of signing in ends here, so this is where a rider from before room codes existed is
  // given theirs: whoever gets a session gets a room code with it.
  const session = async (account: User) => {
    const user = await withRoomCode(prisma, account);
    return { token: signAuthToken(user.id, env.jwtSecret), user: toAuthUser(user) };
  };

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
        const user = await createUserWithRoomCode(prisma, {
          riderName: cleanName,
          email: cleanEmail,
          password: passwordHash,
        });
        return res.status(201).json(await session(user));
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
      return res.status(200).json(await session(user));
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

      const result = await reconcileGoogleAccount(prisma, identity, email, mode);
      if (result.kind === 'not_found') {
        return res.status(404).json({
          message: 'No account found for this Google account. Create an account first.',
          code: 'ACCOUNT_NOT_FOUND',
        });
      }
      if (result.kind === 'conflict') {
        return res.status(409).json({ message: 'This email is already linked to a different Google account.' });
      }
      return res.status(200).json(await session(result.user));
    }),
  );

  // ---- Session ----------------------------------------------------------------------------

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const me = req.user!;
      return res.json({ user: { ...me, roomCode: me.roomCode ?? (await ensureRoomCode(prisma, me.id)) } });
    }),
  );

  return router;
}
