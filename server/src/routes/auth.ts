import { Router, type RequestHandler } from 'express';
import type { PrismaClient, User } from '@prisma/client';
import {
  emailError,
  isAllowedEmailDomain,
  nameError,
  normalizeEmail,
  passwordError,
} from '../auth/validation';
import { isEmailAllowed, NOT_ALLOWED_MESSAGE } from '../auth/access';
import { signAuthToken } from '../auth/tokens';
import type { GoogleIdentity, GoogleVerifier } from '../auth/google';
import type { Env } from '../config/env';
import { asyncHandler, logRequestError } from '../http';
import { loginWithPassword, prepareCurrentUser, prepareSessionUser, registerWithPassword } from '../services/authService';
import { reconcileGoogleAccount } from '../services/googleAuthService';

interface AuthRouterDeps {
  prisma: PrismaClient;
  env: Env;
  requireAuth: RequestHandler;
  /** Absent when GOOGLE_CLIENT_ID isn't configured; Google endpoints then answer 503. */
  verifyGoogleIdToken?: GoogleVerifier;
}

export function createAuthRouter({ prisma, env, requireAuth, verifyGoogleIdToken }: AuthRouterDeps): Router {
  const router = Router();

  // Every way of signing in ends here, so this is where a rider from before room codes existed is
  // given theirs: whoever gets a session gets a room code with it.
  const session = async (account: User) => {
    const user = await prepareSessionUser(prisma, account);
    return { token: signAuthToken(user.id, env.jwtSecret), user };
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
      const result = await registerWithPassword(prisma, {
        riderName: cleanName,
        email: cleanEmail,
        password,
      });
      if (result.kind === 'duplicate') {
        return res.status(409).json(taken);
      }
      return res.status(201).json(await session(result.user));
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

      const result = await loginWithPassword(prisma, cleanEmail, password);
      if (result.kind === 'google_only') {
        return res.status(401).json({ message: 'This account uses Google sign-in. Tap "Continue with Google".' });
      }
      if (result.kind === 'invalid_credentials') {
        return res.status(401).json({ message: 'Invalid credentials.' });
      }
      return res.status(200).json(await session(result.user));
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
        logRequestError(req, 'google_token_rejected', err, 'warn');
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
      return res.json({ user: await prepareCurrentUser(prisma, req.user!) });
    }),
  );

  return router;
}
