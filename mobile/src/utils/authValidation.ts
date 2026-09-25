/**
 * Instant, client-side form checks. The server (server/src/auth/validation.ts) enforces the same
 * rules and is the authority -- this copy only exists to give feedback before a network round
 * trip, so keep the two in step.
 */

export const ALLOWED_EMAIL_DOMAIN = 'gmail.com';
export const PASSWORD_MIN_LENGTH = 8;
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 24;

export const INVALID_GMAIL = 'Invalid Gmail format';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Letters, digits and single dots; no leading/trailing/doubled dot; 1-30 chars. */
const GMAIL_LOCAL_PART = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9.]{0,28}[a-z0-9])?$/;

/** Returns a message to show under the field, or null when the address is acceptable. */
export function validateEmail(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (!email) {
    return 'Enter your Gmail address';
  }
  const suffix = `@${ALLOWED_EMAIL_DOMAIN}`;
  if (!email.endsWith(suffix)) {
    return INVALID_GMAIL;
  }
  return GMAIL_LOCAL_PART.test(email.slice(0, -suffix.length)) ? null : INVALID_GMAIL;
}

/** For choosing a NEW password (sign-up). */
export function validateNewPassword(password: string): string | null {
  return password.length >= PASSWORD_MIN_LENGTH
    ? null
    : `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
}

export function validateName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    return `Rider name must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters`;
  }
  return null;
}

export interface SignInErrors {
  email?: string;
  password?: string;
}

/** Sign-in only asks that a password was entered: length rules belong to choosing one, and
 * enforcing them here could lock out an older account whose password predates them. */
export function validateSignIn(email: string, password: string): SignInErrors {
  const errors: SignInErrors = {};
  const emailProblem = validateEmail(email);
  if (emailProblem) {
    errors.email = emailProblem;
  }
  if (!password) {
    errors.password = 'Enter your password';
  }
  return errors;
}

export interface RegistrationErrors extends SignInErrors {
  name?: string;
  confirmPassword?: string;
}

export function validateRegistration(
  name: string,
  email: string,
  password: string,
  confirmPassword: string,
): RegistrationErrors {
  const errors: RegistrationErrors = {};
  const nameProblem = validateName(name);
  const emailProblem = validateEmail(email);
  const passwordProblem = validateNewPassword(password);
  if (nameProblem) {
    errors.name = nameProblem;
  }
  if (emailProblem) {
    errors.email = emailProblem;
  }
  if (passwordProblem) {
    errors.password = passwordProblem;
  } else if (password !== confirmPassword) {
    errors.confirmPassword = 'Passwords do not match';
  }
  return errors;
}
