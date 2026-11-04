import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
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
import { GoogleUnavailableError, type GoogleIdentity, type GoogleVerifier } from '../auth/google';
import type { Env } from '../config/env';
import { ErrorCode, sendError } from '../errors';
import { asyncHandler, logRequestError } from '../http';
import { logger } from '../logger';
import {
  loginWithPassword,
  prepareCurrentUser,
  prepareSessionUser,
  registerWithPassword,
} from '../services/authService';
import { reconcileGoogleAccount } from '../services/googleAuthService';

interface AuthRouterDeps {
  prisma: PrismaClient;
  env: Env;
  requireAuth: RequestHandler;
  verifyGoogleIdToken?: GoogleVerifier;
}

const GOOGLE_DISABLED_MESSAGE = 'Google sign-in is not configured on the server.';

function createAccountLoginLimiter(env: Env): RequestHandler {
  return rateLimit({
    windowMs: env.authRateLimit.windowMs,
    limit: env.authRateLimit.perAccountMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: req => typeof req.body?.email !== 'string',
    keyGenerator: req => `login:${normalizeEmail(req.body.email)}`,
    handler: (_req, res) =>
      sendError(
        res,
        429,
        ErrorCode.RateLimited,
        'Too many sign-in attempts for this account. Please try again later.',
      ),
  });
}

export function createAuthRouter({
  prisma,
  env,
  requireAuth,
  verifyGoogleIdToken,
}: AuthRouterDeps): Router {
  const router = Router();

  const session = async (account: User) => {
    const user = await prepareSessionUser(prisma, account);
    return { token: signAuthToken(user.id, env.jwtSecret), user };
  };

  router.post(
    ['/signup', '/register'],
    asyncHandler(async (req, res) => {
      const { name, email, password } = req.body ?? {};
      if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
        return sendError(
          res,
          400,
          ErrorCode.ValidationFailed,
          'Name, email and password are required.',
        );
      }
      const cleanName = name.trim();
      const cleanEmail = normalizeEmail(email);
      const problem = nameError(cleanName) ?? emailError(cleanEmail) ?? passwordError(password);
      if (problem) {
        return sendError(res, 400, ErrorCode.ValidationFailed, problem);
      }
      if (!isEmailAllowed(env.allowedEmails, cleanEmail)) {
        return sendError(res, 403, ErrorCode.NotAllowed, NOT_ALLOWED_MESSAGE);
      }

      const result = await registerWithPassword(prisma, {
        riderName: cleanName,
        email: cleanEmail,
        password,
      });
      if (result.kind === 'duplicate') {
        return sendError(
          res,
          409,
          ErrorCode.EmailTaken,
          'An account with this email already exists.',
        );
      }
      logger().info('user_registered', {
        requestId: req.requestId,
        userId: result.user.id,
        method: 'password',
      });
      return res.status(201).json(await session(result.user));
    }),
  );

  router.post(
    '/login',
    createAccountLoginLimiter(env),
    asyncHandler(async (req, res) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return sendError(res, 400, ErrorCode.ValidationFailed, 'Email and password are required.');
      }

      const cleanEmail = normalizeEmail(email);
      if (!isEmailAllowed(env.allowedEmails, cleanEmail)) {
        return sendError(res, 403, ErrorCode.NotAllowed, NOT_ALLOWED_MESSAGE);
      }

      const result = await loginWithPassword(prisma, cleanEmail, password);
      if (result.kind === 'google_only') {
        return sendError(
          res,
          401,
          ErrorCode.GoogleOnlyAccount,
          'This account uses Google sign-in. Tap "Continue with Google".',
        );
      }
      if (result.kind === 'invalid_credentials') {
        logger().warn('user_sign_in_failed', { requestId: req.requestId, method: 'password' });
        return sendError(res, 401, ErrorCode.InvalidCredentials, 'Invalid credentials.');
      }
      logger().info('user_signed_in', {
        requestId: req.requestId,
        userId: result.user.id,
        method: 'password',
      });
      return res.status(200).json(await session(result.user));
    }),
  );

  router.get('/google/config', (_req, res) => {
    if (!env.googleClientId) {
      return sendError(res, 503, ErrorCode.GoogleSignInDisabled, GOOGLE_DISABLED_MESSAGE);
    }
    return res.json({ clientId: env.googleClientId });
  });

  router.post(
    '/google',
    asyncHandler(async (req, res) => {
      if (!verifyGoogleIdToken) {
        return sendError(res, 503, ErrorCode.GoogleSignInDisabled, GOOGLE_DISABLED_MESSAGE);
      }
      const { idToken, mode = 'login' } = req.body ?? {};
      if (typeof idToken !== 'string' || !idToken) {
        return sendError(res, 400, ErrorCode.ValidationFailed, 'A Google ID token is required.');
      }
      if (mode !== 'login' && mode !== 'signup') {
        return sendError(res, 400, ErrorCode.ValidationFailed, 'Mode must be "login" or "signup".');
      }

      let identity: GoogleIdentity;
      try {
        identity = await verifyGoogleIdToken(idToken);
      } catch (err) {
        if (err instanceof GoogleUnavailableError) {
          logRequestError(req, 'google_unavailable', err.cause, 'error');
          return sendError(
            res,
            503,
            ErrorCode.ServiceUnavailable,
            'Google sign-in is temporarily unavailable. Please try again shortly.',
          );
        }
        logRequestError(req, 'google_token_rejected', err, 'warn');
        return sendError(
          res,
          401,
          ErrorCode.GoogleTokenRejected,
          'Google sign-in failed. Please try again.',
        );
      }

      const email = normalizeEmail(identity.email);
      if (!identity.emailVerified) {
        return sendError(
          res,
          401,
          ErrorCode.EmailNotVerified,
          'Your Google email address is not verified.',
        );
      }
      if (!isAllowedEmailDomain(email)) {
        return sendError(
          res,
          403,
          ErrorCode.EmailDomainNotSupported,
          'Only Gmail accounts are supported.',
        );
      }
      if (!isEmailAllowed(env.allowedEmails, email)) {
        return sendError(res, 403, ErrorCode.NotAllowed, NOT_ALLOWED_MESSAGE);
      }

      const result = await reconcileGoogleAccount(prisma, identity, email, mode);
      if (result.kind === 'not_found') {
        return sendError(
          res,
          404,
          ErrorCode.AccountNotFound,
          'No account found for this Google account. Create an account first.',
        );
      }
      if (result.kind === 'conflict') {
        return sendError(
          res,
          409,
          ErrorCode.GoogleAccountConflict,
          'This email is already linked to a different Google account.',
        );
      }
      logger().info('user_signed_in', {
        requestId: req.requestId,
        userId: result.user.id,
        method: 'google',
        mode,
      });
      return res.status(200).json(await session(result.user));
    }),
  );

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      return res.json({ user: await prepareCurrentUser(prisma, req.user!) });
    }),
  );

  return router;
}
