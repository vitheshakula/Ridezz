import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { hashRefreshToken } from '../auth/tokens';
import { refreshSession, type SessionPolicy } from './sessionService';

const POLICY: SessionPolicy = {
  jwtSecret: 'x'.repeat(40),
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 86_400,
  allowedEmails: null,
};

const NOW = new Date('2026-11-05T10:00:00Z');
const PRESENTED = 'A'.repeat(43);

function fakePrisma(revokedConcurrently: boolean, state: { usedAt?: Date; revokedAt?: Date } = {}) {
  const familyRevocations: string[] = [];
  const created: unknown[] = [];
  const refreshToken = {
    findUnique: async ({ where }: { where: { tokenHash: string } }) =>
      where.tokenHash === hashRefreshToken(PRESENTED)
        ? {
            id: 'token-1',
            userId: 'user-1',
            familyId: 'family-1',
            expiresAt: new Date(NOW.getTime() + 60_000),
            usedAt: state.usedAt ?? null,
            revokedAt: state.revokedAt ?? null,
            user: { email: 'rider@gmail.com' },
          }
        : null,
    updateMany: async ({ where }: { where: { id?: string; familyId?: string } }) => {
      if (where.familyId) {
        familyRevocations.push(where.familyId);
        return { count: 1 };
      }
      return { count: revokedConcurrently ? 0 : 1 };
    },
    create: async (args: unknown) => {
      created.push(args);
      return {};
    },
  };
  const prisma = {
    refreshToken,
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ refreshToken }),
  } as unknown as PrismaClient;
  return { prisma, familyRevocations, created };
}

describe('refreshSession', () => {
  it('rotates a valid token inside one transaction', async () => {
    const { prisma, created, familyRevocations } = fakePrisma(false);
    const result = await refreshSession(prisma, PRESENTED, POLICY, NOW);
    assert.equal(result.kind, 'ok');
    assert.equal(created.length, 1);
    assert.deepEqual(familyRevocations, []);
  });

  it('treats losing a concurrent rotation as reuse and revokes the family', async () => {
    const { prisma, created, familyRevocations } = fakePrisma(true);
    const result = await refreshSession(prisma, PRESENTED, POLICY, NOW);
    assert.deepEqual(result, { kind: 'reused', userId: 'user-1', familyId: 'family-1' });
    assert.equal(created.length, 0);
    assert.deepEqual(familyRevocations, ['family-1']);
  });

  it('rejects a token it does not know', async () => {
    const { prisma } = fakePrisma(false);
    assert.deepEqual(await refreshSession(prisma, 'B'.repeat(43), POLICY, NOW), {
      kind: 'invalid',
    });
  });

  it('treats a used token as reuse and revokes its sign-in', async () => {
    const usedAt = new Date(NOW.getTime() - 1000);
    const { prisma, familyRevocations } = fakePrisma(false, { usedAt, revokedAt: usedAt });
    const result = await refreshSession(prisma, PRESENTED, POLICY, NOW);
    assert.equal(result.kind, 'reused');
    assert.deepEqual(familyRevocations, ['family-1']);
  });

  it('rejects a token revoked by logout without treating it as theft', async () => {
    const { prisma, familyRevocations, created } = fakePrisma(false, {
      revokedAt: new Date(NOW.getTime() - 1000),
    });
    assert.deepEqual(await refreshSession(prisma, PRESENTED, POLICY, NOW), { kind: 'invalid' });
    assert.deepEqual(familyRevocations, []);
    assert.equal(created.length, 0);
  });
});
