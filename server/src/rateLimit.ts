import type { Request, RequestHandler } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import { ErrorCode, sendError } from './errors';

export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  message: string;
  store?: Store;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

export function createRateLimiter({
  windowMs,
  limit,
  message,
  store,
  keyGenerator,
  skip,
}: RateLimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    store,
    keyGenerator,
    skip,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    handler: (_req, res) => sendError(res, 429, ErrorCode.RateLimited, message),
  });
}
