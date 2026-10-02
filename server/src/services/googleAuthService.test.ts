import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import type { GoogleIdentity } from '../auth/google';
import { reconcileGoogleAccount } from './googleAuthService';

const identity: GoogleIdentity = {
  googleId: 'google-123',
  email: 'alex.rider@gmail.com',
  emailVerified: true,
  name: 'Google Rider',
};

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    riderName: 'Alex',
    email: identity.email,
    password: null,
    googleId: identity.googleId,
    emailVerified: true,
    roomCode: '54321',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target: [target] },
  });
}

describe('reconcileGoogleAccount', () => {
  it('returns an existing user found by Google id without writing', async () => {
    const existing = user();
    let writes = 0;
    const prisma = {
      user: {
        findUnique: async (args: any) => {
          assert.deepEqual(args, { where: { googleId: identity.googleId } });
          return existing;
        },
        update: async () => {
          writes++;
          return existing;
        },
        create: async () => {
          writes++;
          return existing;
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await reconcileGoogleAccount(prisma, identity, identity.email, 'login'), {
      kind: 'ok',
      user: existing,
    });
    assert.equal(writes, 0);
  });

  it('links an existing email account, verifies it and clears its password', async () => {
    const existing = user({ googleId: null, emailVerified: false, password: 'bcrypt-hash' });
    const linked = user({ id: existing.id });
    let updateArgs: any;
    const prisma = {
      user: {
        findUnique: async (args: any) => ('googleId' in args.where ? null : existing),
        update: async (args: any) => {
          updateArgs = args;
          return linked;
        },
      },
    } as unknown as PrismaClient;

    const result = await reconcileGoogleAccount(prisma, identity, identity.email, 'login');

    assert.deepEqual(result, { kind: 'ok', user: linked });
    assert.deepEqual(updateArgs, {
      where: { id: existing.id },
      data: { googleId: identity.googleId, emailVerified: true, password: null },
    });
  });

  it('reports not found in login mode without writing', async () => {
    let writes = 0;
    const prisma = {
      user: {
        findUnique: async () => null,
        update: async () => {
          writes++;
          return user();
        },
        create: async () => {
          writes++;
          return user();
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await reconcileGoogleAccount(prisma, identity, identity.email, 'login'), {
      kind: 'not_found',
    });
    assert.equal(writes, 0);
  });

  it('creates a verified passwordless signup with a permanent room code', async () => {
    const signupIdentity = { ...identity, name: null, email: 'wanderer.one@gmail.com' };
    let createArgs: any;
    const prisma = {
      user: {
        findUnique: async () => null,
        create: async (args: any) => {
          createArgs = args;
          return user({
            riderName: args.data.riderName,
            email: args.data.email,
            googleId: args.data.googleId,
            roomCode: args.data.roomCode,
          });
        },
      },
    } as unknown as PrismaClient;

    const result = await reconcileGoogleAccount(prisma, signupIdentity, signupIdentity.email, 'signup');

    assert.equal(result.kind, 'ok');
    assert.match(createArgs.data.roomCode, /^[1-9]\d{4}$/);
    assert.deepEqual(createArgs.data, {
      riderName: 'wandererone',
      email: signupIdentity.email,
      googleId: signupIdentity.googleId,
      emailVerified: true,
      password: null,
      roomCode: createArgs.data.roomCode,
    });
    assert.equal(result.kind === 'ok' ? result.user.roomCode : null, createArgs.data.roomCode);
  });

  it('reports conflict when the email belongs to another Google account without writing', async () => {
    const existing = user({ googleId: 'different-google-id' });
    let writes = 0;
    const prisma = {
      user: {
        findUnique: async (args: any) => ('googleId' in args.where ? null : existing),
        update: async () => {
          writes++;
          return existing;
        },
        create: async () => {
          writes++;
          return existing;
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await reconcileGoogleAccount(prisma, identity, identity.email, 'signup'), {
      kind: 'conflict',
    });
    assert.equal(writes, 0);
  });

  it('recovers the winning account after a concurrent signup unique violation', async () => {
    const winner = user();
    let googleIdLookups = 0;
    const prisma = {
      user: {
        findUnique: async (args: any) => {
          if ('googleId' in args.where) {
            googleIdLookups++;
            return googleIdLookups === 1 ? null : winner;
          }
          return null;
        },
        create: async () => {
          throw uniqueViolation('googleId');
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await reconcileGoogleAccount(prisma, identity, identity.email, 'signup'), {
      kind: 'ok',
      user: winner,
    });
    assert.equal(googleIdLookups, 2);
  });

  it('reports conflict when a signup unique violation has no matching Google account', async () => {
    let creates = 0;
    const prisma = {
      user: {
        findUnique: async () => null,
        create: async () => {
          creates++;
          throw uniqueViolation('email');
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await reconcileGoogleAccount(prisma, identity, identity.email, 'signup'), {
      kind: 'conflict',
    });
    assert.equal(creates, 1);
  });
});
