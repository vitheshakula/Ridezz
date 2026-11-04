import jwt from 'jsonwebtoken';

const TOKEN_TTL = '30d';

export function signAuthToken(userId: string, secret: string): string {
  return jwt.sign({}, secret, { subject: userId, expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}
