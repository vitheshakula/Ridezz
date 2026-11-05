import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const REFRESH_TOKEN_BYTES = 32;

export function signAuthToken(userId: string, secret: string, ttlSeconds: number): string {
  return jwt.sign({}, secret, { subject: userId, expiresIn: ttlSeconds, algorithm: 'HS256' });
}

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isWellFormedRefreshToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}
