export const ROOM_CODE_LENGTH = 5;

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{4}$/.test(value);
}

export function sanitizeRoomCodeInput(text: string): string {
  return text.replace(/\D/g, '').slice(0, ROOM_CODE_LENGTH);
}
