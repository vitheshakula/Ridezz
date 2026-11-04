export const NOT_ALLOWED_MESSAGE =
  'This app is in private testing and your account is not on the list.';

export function isEmailAllowed(allowed: ReadonlySet<string> | null, email: string): boolean {
  return allowed === null || allowed.has(email);
}
