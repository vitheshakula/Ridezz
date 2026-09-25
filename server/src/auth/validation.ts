/**
 * Input rules for registration. Mirrored client-side in mobile/src/utils/authValidation.ts for
 * instant feedback -- this copy is the authoritative one; never rely on the app having checked.
 */

/** Only addresses at this domain can register. One place to change if that ever widens. */
export const ALLOWED_EMAIL_DOMAIN = 'gmail.com';

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt silently ignores everything past 72 bytes, so a longer password gives a false sense of security. */
export const PASSWORD_MAX_LENGTH = 72;

export const NAME_MIN_LENGTH = 2;
/** Matches the limit the hazard packets and mesh advertisements already apply to rider names. */
export const NAME_MAX_LENGTH = 24;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Letters, digits and single dots; no leading/trailing/doubled dot; 1-30 chars (Gmail's rules,
 * relaxed on the minimum so older, shorter Gmail addresses are not rejected). */
const GMAIL_LOCAL_PART = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9.]{0,28}[a-z0-9])?$/;

export function isAllowedEmailDomain(email: string): boolean {
  return email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

/** Expects an already-normalized address. Returns a user-facing message, or null when valid. */
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

/** Expects a trimmed name. */
export function nameError(name: string): string | null {
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    return `Rider name must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters`;
  }
  return null;
}

/** A display name for an account that arrives without one (Google may omit it). */
export function fallbackRiderName(email: string): string {
  const fromEmail = email.split('@')[0]?.replace(/[^a-z0-9]/gi, '').slice(0, NAME_MAX_LENGTH);
  return fromEmail || 'Rider';
}
