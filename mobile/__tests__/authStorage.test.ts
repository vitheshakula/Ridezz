import { parseStoredUser } from '../src/utils/authStorage';

describe('parseStoredUser', () => {
  it('reads a current profile', () => {
    const json = JSON.stringify({ id: 'u1', email: 'a@gmail.com', name: 'Alex', emailVerified: true });
    expect(parseStoredUser(json)).toEqual({ id: 'u1', email: 'a@gmail.com', name: 'Alex', emailVerified: true });
  });

  it('upgrades a profile saved by the previous build (rider_name) instead of signing the rider out', () => {
    const json = JSON.stringify({ id: 'u1', email: 'a@gmail.com', rider_name: 'Alex' });
    expect(parseStoredUser(json)).toEqual({ id: 'u1', email: 'a@gmail.com', name: 'Alex', emailVerified: false });
  });

  it('prefers name over the legacy field when both exist', () => {
    const json = JSON.stringify({ id: 'u1', email: 'a@gmail.com', name: 'New', rider_name: 'Old' });
    expect(parseStoredUser(json)?.name).toBe('New');
  });

  it('treats a missing verified flag as unverified', () => {
    expect(parseStoredUser(JSON.stringify({ id: 'u1', email: 'a@gmail.com', name: 'A' }))?.emailVerified).toBe(false);
  });

  it.each([
    ['nothing stored', null],
    ['an empty string', ''],
    ['invalid JSON', '{not json'],
    ['a JSON string', '"hello"'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['no id', JSON.stringify({ email: 'a@gmail.com', name: 'A' })],
    ['no email', JSON.stringify({ id: 'u1', name: 'A' })],
    ['no name at all', JSON.stringify({ id: 'u1', email: 'a@gmail.com' })],
    ['an empty name', JSON.stringify({ id: 'u1', email: 'a@gmail.com', name: '' })],
    ['a wrongly typed id', JSON.stringify({ id: 7, email: 'a@gmail.com', name: 'A' })],
  ])('returns null for %s, so the rider is treated as signed out', (_label, json) => {
    expect(parseStoredUser(json as string | null)).toBeNull();
  });
});
