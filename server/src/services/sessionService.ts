import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isEmailAllowed } from '../auth/access';
import { generateRefreshToken, hashRefreshToken, signAuthToken } from '../auth/tokens';

export interface SessionPolicy {
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  allowedEmails: ReadonlySet<string> | null;
}

export interface SessionTokens {
  token: string;
  refreshToken: string;
  expiresIn: number;
}

export type RefreshResult =
  | { kind: 'ok'; userId: string; tokens: SessionTokens }
  | { kind: 'invalid' }
  | { kind: 'reused'; userId: string; familyId: string };

const MILLISECONDS_PER_SECOND = 1000;

function expiry(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * MILLISECONDS_PER_SECOND);
}

async function storeRefreshToken(
  prisma: Pick<PrismaClient, 'refreshToken'>,
  userId: string,
  familyId: string,
  policy: SessionPolicy,
  now: Date,
): Promise<string> {
  const refreshToken = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: expiry(now, policy.refreshTokenTtlSeconds),
    },
  });
  return refreshToken;
}

function accessToken(
  userId: string,
  policy: SessionPolicy,
): Pick<SessionTokens, 'token' | 'expiresIn'> {
  return {
    token: signAuthToken(userId, policy.jwtSecret, policy.accessTokenTtlSeconds),
    expiresIn: policy.accessTokenTtlSeconds,
  };
}

export async function startSession(
  prisma: PrismaClient,
  userId: string,
  policy: SessionPolicy,
  now: Date = new Date(),
): Promise<SessionTokens> {
  await prisma.refreshToken.deleteMany({ where: { userId, expiresAt: { lt: now } } });
  const refreshToken = await storeRefreshToken(prisma, userId, randomUUID(), policy, now);
  return { ...accessToken(userId, policy), refreshToken };
}

export async function refreshSession(
  prisma: PrismaClient,
  presentedToken: string,
  policy: SessionPolicy,
  now: Date = new Date(),
): Promise<RefreshResult> {
  const tokenHash = hashRefreshToken(presentedToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { email: true } } },
  });
  if (!stored || stored.expiresAt <= now) {
    return { kind: 'invalid' };
  }
  if (stored.usedAt) {
    await revokeFamily(prisma, stored.familyId, now);
    return { kind: 'reused', userId: stored.userId, familyId: stored.familyId };
  }
  if (stored.revokedAt) {
    return { kind: 'invalid' };
  }
  if (!isEmailAllowed(policy.allowedEmails, stored.user.email)) {
    await revokeFamily(prisma, stored.familyId, now);
    return { kind: 'invalid' };
  }

  const refreshToken = await prisma.$transaction(async tx => {
    const { count } = await tx.refreshToken.updateMany({
      where: { id: stored.id, usedAt: null, revokedAt: null },
      data: { usedAt: now, revokedAt: now },
    });
    if (count !== 1) {
      return null;
    }
    return storeRefreshToken(tx, stored.userId, stored.familyId, policy, now);
  });
  if (!refreshToken) {
    await revokeFamily(prisma, stored.familyId, now);
    return { kind: 'reused', userId: stored.userId, familyId: stored.familyId };
  }
  return {
    kind: 'ok',
    userId: stored.userId,
    tokens: { ...accessToken(stored.userId, policy), refreshToken },
  };
}

async function revokeFamily(prisma: PrismaClient, familyId: string, now: Date): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  });
}

export async function endSession(
  prisma: PrismaClient,
  presentedToken: string,
  now: Date = new Date(),
): Promise<void> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(presentedToken) },
    select: { familyId: true },
  });
  if (stored) {
    await revokeFamily(prisma, stored.familyId, now);
  }
}
