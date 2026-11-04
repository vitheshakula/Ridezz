export const ALLOWED_EMAIL_DOMAIN = 'gmail.com';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 24;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const GMAIL_LOCAL_PART = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9.]{0,28}[a-z0-9])?$/;

export function isAllowedEmailDomain(email: string): boolean {
  return email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

export function emailError(email: string): string | null {
  if (!isAllowedEmailDomain(email)) {
    return 'Invalid Gmail format';
  }
  const local = email.slice(0, -(ALLOWED_EMAIL_DOMAIN.length + 1));
  return GMAIL_LOCAL_PART.test(local) ? null : 'Invalid Gmail format';
}

export function passwordError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} bytes`;
  }
  return null;
}

export function nameError(name: string): string | null {
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    return `Rider name must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters`;
  }
  return null;
}

export function fallbackRiderName(email: string): string {
  const fromEmail = email
    .split('@')[0]
    ?.replace(/[^a-z0-9]/gi, '')
    .slice(0, NAME_MAX_LENGTH);
  return fromEmail || 'Rider';
}
