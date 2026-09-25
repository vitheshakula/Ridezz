import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import passport from 'passport';
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';
import { isEmailAllowed } from '../auth/access';
import { toAuthUser, type AuthUser } from '../auth/user';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // Makes `req.user` the account Passport loaded, typed instead of `{}`.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthUser {}
  }
}

/** A private Passport instance (not the shared global), so each app/test has its own strategies. */
export type PassportInstance = InstanceType<typeof passport.Passport>;

interface TokenPayload {
  sub?: string;
  /** Claim used by tokens issued before `sub` was adopted; still valid for their 30 days. */
  userId?: string;
}

/**
 * Builds the Passport instance with the JWT strategy: reads `Authorization: Bearer <token>`,
 * verifies the signature and expiry, then loads the account so a deleted user's still-unexpired
 * token stops working immediately -- and likewise for one whose owner has since been taken off the
 * allowlist.
 */
export function configurePassport(
  prisma: PrismaClient,
  jwtSecret: string,
  allowedEmails: ReadonlySet<string> | null = null,
): PassportInstance {
  const instance = new passport.Passport();
  instance.use(
    'jwt',
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: jwtSecret,
        algorithms: ['HS256'],
      },
      async (payload: TokenPayload, done) => {
        try {
          const id = payload.sub ?? payload.userId;
          const user = id ? await prisma.user.findUnique({ where: { id } }) : null;
          done(null, user && isEmailAllowed(allowedEmails, user.email) ? toAuthUser(user) : false);
        } catch (err) {
          done(err, false);
        }
      },
    ),
  );
  return instance;
}

/** Route guard: 401 with a JSON body (like every other error here) unless the bearer token is valid. */
export function createRequireAuth(instance: PassportInstance): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    instance.authenticate('jwt', { session: false }, (err: unknown, user: AuthUser | false) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        return res.status(401).json({ message: 'Authentication required.' });
      }
      req.user = user;
      next();
    })(req, res, next);
  };
}
