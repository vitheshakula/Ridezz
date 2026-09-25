/** Shown to anyone the allowlist turns away. */
export const NOT_ALLOWED_MESSAGE = 'This app is in private testing and your account is not on the list.';

/** True when there is no allowlist (open to any Gmail account) or the address is on it.
 * Expects an already-normalized (trimmed, lowercased) address. */
export function isEmailAllowed(allowed: ReadonlySet<string> | null, email: string): boolean {
  return allowed === null || allowed.has(email);
}
