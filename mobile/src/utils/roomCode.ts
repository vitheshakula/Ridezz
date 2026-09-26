/**
 * A rider's permanent room code: exactly five digits, 10000 to 99999. The server issues it once
 * per account and never changes it; when a rider hosts a ride, it is the ride's code.
 */
export const ROOM_CODE_LENGTH = 5;

/** True for exactly the strings "10000" to "99999". */
export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{4}$/.test(value);
}

/** Room-code text as typed or pasted, reduced to what can be a code: digits only, at most five. */
export function sanitizeRoomCodeInput(text: string): string {
  return text.replace(/\D/g, '').slice(0, ROOM_CODE_LENGTH);
}
