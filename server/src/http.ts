import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

declare global {
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

/** Reuses a bounded caller-provided correlation id, or creates one local to this request. */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const supplied = req.get('x-request-id')?.trim();
  req.requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

/** One compact completion event per request; deliberately excludes headers, query strings and bodies. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const path = requestPath(req);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.log(
      JSON.stringify({
        event: 'http_request',
        requestId: req.requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
    );
  });
  next();
};

function safeErrorDetails(error: unknown): { errorName: string; errorMessage: string } {
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

/** Structured operational error with correlation context and bounded/redacted error text. */
export function logRequestError(
  req: Request,
  event: string,
  error: unknown,
  level: 'error' | 'warn' = 'error',
): void {
  console[level](
    JSON.stringify({
      event,
      requestId: req.requestId ?? 'unavailable',
      method: req.method,
      path: requestPath(req),
      ...safeErrorDetails(error),
    }),
  );
}

/** Express 4 ignores a rejected promise from an async handler, leaving the request hanging.
 * This forwards it to the error handler instead. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** JSON fallthrough for requests that did not match any API route. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ message: 'Not found.' });
};

/** Last-resort handler: a JSON body like every other error, and no internals leaked to the client. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Malformed JSON body etc. -- the client's fault.
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ message: 'Invalid request.' });
    return;
  }
  logRequestError(req, 'http_error', err);
  res.status(500).json({ message: 'Internal server error' });
};
