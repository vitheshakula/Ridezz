export const ALLOWED_EMAIL_DOMAIN = 'gmail.com';
export const PASSWORD_MIN_LENGTH = 8;
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 24;

export const INVALID_GMAIL = 'Invalid Gmail format';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const GMAIL_LOCAL_PART = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9.]{0,28}[a-z0-9])?$/;

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
