import type { Response } from 'express';

export const ErrorCode = {
  InvalidRequest: 'INVALID_REQUEST',
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthenticated: 'UNAUTHENTICATED',
  SessionExpired: 'SESSION_EXPIRED',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  GoogleOnlyAccount: 'GOOGLE_ONLY_ACCOUNT',
  GoogleTokenRejected: 'GOOGLE_TOKEN_REJECTED',
  EmailNotVerified: 'EMAIL_NOT_VERIFIED',
  NotAllowed: 'NOT_ALLOWED',
  EmailDomainNotSupported: 'EMAIL_DOMAIN_NOT_SUPPORTED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  AccountNotFound: 'ACCOUNT_NOT_FOUND',
  RoomNotFound: 'ROOM_NOT_FOUND',
  EmailTaken: 'EMAIL_TAKEN',
  GoogleAccountConflict: 'GOOGLE_ACCOUNT_CONFLICT',
  RoomCodeConflict: 'ROOM_CODE_CONFLICT',
  RateLimited: 'RATE_LIMITED',
  GoogleSignInDisabled: 'GOOGLE_SIGN_IN_DISABLED',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  InternalError: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorBody {
  message: string;
  code: ErrorCode;
}

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
): Response<ErrorBody> {
  return res.status(status).json({ message, code });
}
