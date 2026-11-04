import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode, sendError } from './errors';
import { logger } from './logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express request types can only be augmented through its namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function requestPath(req: Request): string {
  return req.originalUrl.split('?', 1)[0] || req.path;
}

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const supplied = req.get('x-request-id')?.trim();
  req.requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const path = requestPath(req);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger().info('http_request', {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });
  next();
};

export function safeErrorDetails(error: unknown): { errorName: string; errorMessage: string } {
  if (!(error instanceof Error)) {
    return { errorName: 'NonError', errorMessage: 'A non-Error value was thrown.' };
  }

  const errorMessage = error.message
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\b/g, '[redacted-token]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
  return { errorName: error.name, errorMessage };
}

export function logRequestError(
  req: Request,
  event: string,
  error: unknown,
  level: 'error' | 'warn' = 'error',
): void {
  logger()[level](event, {
    requestId: req.requestId ?? 'unavailable',
    method: req.method,
    path: requestPath(req),
    ...safeErrorDetails(error),
  });
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendError(res, 404, ErrorCode.NotFound, 'Not found.');
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    sendError(res, err.status, ErrorCode.InvalidRequest, 'Invalid request.');
    return;
  }
  logRequestError(req, 'http_error', err);
  sendError(res, 500, ErrorCode.InternalError, 'Internal server error');
};
