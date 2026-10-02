import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

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
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Malformed JSON body etc. -- the client's fault.
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ message: 'Invalid request.' });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
};
