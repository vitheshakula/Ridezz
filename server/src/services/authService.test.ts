import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import type { AuthUser } from '../auth/user';
import {
  loginWithPassword,
  type PasswordCrypto,
  prepareCurrentUser,
  prepareSessionUser,
  registerWithPassword,
} from './authService';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    riderName: 'Alex',
    email: 'alex@gmail.com',
    password: null,
    googleId: null,
    emailVerified: false,
    roomCode: '54321',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'alex@gmail.com',
    name: 'Alex',
    emailVerified: false,
    roomCode: '54321',
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

function roomCodePrisma() {
  let assignedCode: string | undefined;
  const prisma = {
    user: {
      findUnique: async (args: any) => {
        if ('id' in args.where) {
          return { roomCode: null };
        }
        assignedCode = args.where.roomCode;
        return null;
      },
      updateMany: async (args: any) => {
        assert.equal(args.data.roomCode, assignedCode);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, assignedCode: () => assignedCode };
}

describe('registerWithPassword', () => {
  it('hashes the password at cost 10 and creates an account with a permanent room code', async () => {
    let createArgs: any;
    const prisma = {
      user: {
        findUnique: async () => null,
        create: async (args: any) => {
          createArgs = args;
          return user({ password: args.data.password, roomCode: args.data.roomCode });
        },
      },
    } as unknown as PrismaClient;

    const result = await registerWithPassword(prisma, {
      riderName: 'Alex',
      email: 'alex@gmail.com',
      password: 'correct horse battery',
    });

    assert.equal(result.kind, 'ok');
    assert.notEqual(createArgs.data.password, 'correct horse battery');
    assert.match(createArgs.data.password, /^\$2[aby]\$10\$/);
    assert.equal(bcrypt.compareSync('correct horse battery', createArgs.data.password), true);
    assert.match(createArgs.data.roomCode, /^[1-9]\d{4}$/);
    assert.equal(result.kind === 'ok' ? result.user.roomCode : null, createArgs.data.roomCode);
  });

  it('reports an existing email as duplicate without hashing or writing', async () => {
    let hashes = 0;
    let writes = 0;
    const passwordCrypto: PasswordCrypto = {
      hash: async () => {
        hashes++;
        return 'unused';
      },
      compare: async () => false,
    };
    const prisma = {
      user: {
        findUnique: async () => user(),
        create: async () => {
          writes++;
          return user();
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(
      await registerWithPassword(
        prisma,
        { riderName: 'Alex', email: 'alex@gmail.com', password: 'correct horse battery' },
        passwordCrypto,
      ),
      { kind: 'duplicate' },
    );
    assert.equal(hashes, 0);
    assert.equal(writes, 0);
  });

  it('maps a raced Prisma unique conflict to duplicate', async () => {
    let findCalls = 0;
    const passwordCrypto: PasswordCrypto = {
      hash: async (_password, rounds) => {
        assert.equal(rounds, 10);
        return 'bcrypt-hash';
      },
      compare: async () => false,
    };
    const prisma = {
      user: {
        findUnique: async () => {
          findCalls++;
          return null;
        },
        create: async () => {
          throw uniqueViolation('email');
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(
      await registerWithPassword(
        prisma,
        { riderName: 'Alex', email: 'alex@gmail.com', password: 'correct horse battery' },
        passwordCrypto,
      ),
      { kind: 'duplicate' },
    );
    assert.equal(findCalls, 2, 'email lookup, then room-code availability lookup');
  });
});

describe('loginWithPassword', () => {
  it('returns the user when the password matches', async () => {
    const password = 'correct horse battery';
    const existing = user({ password: await bcrypt.hash(password, 4) });
    const prisma = {
      user: {
        findUnique: async (args: any) => {
          assert.deepEqual(args, { where: { email: existing.email } });
          return existing;
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await loginWithPassword(prisma, existing.email, password), {
      kind: 'ok',
      user: existing,
    });
  });

  it('rejects a wrong password', async () => {
    const existing = user({ password: await bcrypt.hash('right password', 4) });
    const prisma = {
      user: { findUnique: async () => existing },
    } as unknown as PrismaClient;

    assert.deepEqual(await loginWithPassword(prisma, existing.email, 'wrong password'), {
      kind: 'invalid_credentials',
    });
  });

  it('compares a nonexistent account against the cost-10 dummy hash', async () => {
    let comparedHash = '';
    const passwordCrypto: PasswordCrypto = {
      hash: async () => 'unused',
      compare: async (_password, hash) => {
        comparedHash = hash;
        return false;
      },
    };
    const prisma = {
      user: { findUnique: async () => null },
    } as unknown as PrismaClient;

    assert.deepEqual(
      await loginWithPassword(prisma, 'missing@gmail.com', 'wrong password', passwordCrypto),
      {
        kind: 'invalid_credentials',
      },
    );
    assert.match(comparedHash, /^\$2[aby]\$10\$/);
    assert.equal(bcrypt.compareSync('not-a-real-password', comparedHash), true);
  });

  it('still performs the dummy comparison before identifying a Google-only account', async () => {
    let comparisons = 0;
    const passwordCrypto: PasswordCrypto = {
      hash: async () => 'unused',
      compare: async (_password, hash) => {
        comparisons++;
        assert.match(hash, /^\$2[aby]\$10\$/);
        return false;
      },
    };
    const prisma = {
      user: { findUnique: async () => user({ password: null, googleId: 'google-123' }) },
    } as unknown as PrismaClient;

    assert.deepEqual(
      await loginWithPassword(prisma, 'alex@gmail.com', 'anything', passwordCrypto),
      {
        kind: 'google_only',
      },
    );
    assert.equal(comparisons, 1);
  });
});

describe('authenticated user preparation', () => {
  it('assigns a missing room code while preparing a legacy account for a session', async () => {
    const legacy = user({ password: 'bcrypt-hash', roomCode: null });
    const setup = roomCodePrisma();

    const prepared = await prepareSessionUser(setup.prisma, legacy);

    assert.match(prepared.roomCode ?? '', /^[1-9]\d{4}$/);
    assert.equal(prepared.roomCode, setup.assignedCode());
    assert.equal('password' in prepared, false);
    assert.deepEqual(
      {
        id: prepared.id,
        email: prepared.email,
        name: prepared.name,
        emailVerified: prepared.emailVerified,
      },
      {
        id: legacy.id,
        email: legacy.email,
        name: legacy.riderName,
        emailVerified: legacy.emailVerified,
      },
    );
  });

  it('keeps an existing current-user room code without accessing Prisma', async () => {
    const existing = authUser();
    const prisma = {
      user: {
        findUnique: async () => assert.fail('room code should not be read'),
        updateMany: async () => assert.fail('room code should not be written'),
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await prepareCurrentUser(prisma, existing), existing);
  });

  it('assigns a room code to a current user who is missing one', async () => {
    const setup = roomCodePrisma();
    const prepared = await prepareCurrentUser(setup.prisma, authUser({ roomCode: null }));

    assert.match(prepared.roomCode ?? '', /^[1-9]\d{4}$/);
    assert.equal(prepared.roomCode, setup.assignedCode());
  });
});
