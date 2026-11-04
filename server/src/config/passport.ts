import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import passport from 'passport';
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';
import { isEmailAllowed } from '../auth/access';
import { toAuthUser, type AuthUser } from '../auth/user';
import { ErrorCode, sendError } from '../errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express request types can only be augmented through its namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging needs an interface
    interface User extends AuthUser {}
  }
}

const AUTH_USER_FIELDS = {
  id: true,
  email: true,
  riderName: true,
  emailVerified: true,
  roomCode: true,
} as const;

export type PassportInstance = InstanceType<typeof passport.Passport>;

interface TokenPayload {
  sub?: string;
  userId?: string;
}

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
          const user = id
            ? await prisma.user.findUnique({ where: { id }, select: AUTH_USER_FIELDS })
            : null;
          done(null, user && isEmailAllowed(allowedEmails, user.email) ? toAuthUser(user) : false);
        } catch (err) {
          done(err, false);
        }
      },
    ),
  );
  return instance;
}

export function createRequireAuth(instance: PassportInstance): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    instance.authenticate('jwt', { session: false }, (err: unknown, user: AuthUser | false) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        return sendError(res, 401, ErrorCode.Unauthenticated, 'Authentication required.');
      }
      req.user = user;
      next();
    })(req, res, next);
  };
}
