import { isRoomCode, ROOM_CODE_LENGTH, sanitizeRoomCodeInput } from '../src/utils/roomCode';

describe('isRoomCode', () => {
  it.each(['10000', '10001', '54321', '99998', '99999'])('accepts %s', code => {
    expect(isRoomCode(code)).toBe(true);
  });

  it.each([
    ['a leading zero', '09999'],
    ['all zeros', '00000'],
    ['six digits', '100000'],
    ['four digits', '1234'],
    ['empty', ''],
    ['surrounding spaces', ' 54321 '],
    ['a letter', '5432a'],
    ['a decimal point', '5.4321'],
    ['a minus sign', '-5432'],
    ['a number, not text', 54321],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isRoomCode(value)).toBe(false);
  });
});

describe('sanitizeRoomCodeInput', () => {
  it('keeps digits only', () => {
    expect(sanitizeRoomCodeInput('5a4-3 2x1')).toBe('54321');
    expect(sanitizeRoomCodeInput('ABC')).toBe('');
  });

  it('never returns more than five digits', () => {
    expect(ROOM_CODE_LENGTH).toBe(5);
    expect(sanitizeRoomCodeInput('987654321')).toBe('98765');
  });

  it('passes a good code through unchanged', () => {
    expect(sanitizeRoomCodeInput('54321')).toBe('54321');
    expect(sanitizeRoomCodeInput('')).toBe('');
  });
});
