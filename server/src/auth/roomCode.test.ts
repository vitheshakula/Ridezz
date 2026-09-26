import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateRoomCode, isRoomCode, ROOM_CODE_MAX, ROOM_CODE_MIN } from './roomCode';

describe('generateRoomCode', () => {
  it('draws from exactly 10000 to 99999 (the RNG upper bound is exclusive)', () => {
    let asked: [number, number] | null = null;
    generateRoomCode((min, max) => {
      asked = [min, max];
      return min;
    });
    assert.deepEqual(asked, [10000, 100000]);
    assert.equal(ROOM_CODE_MIN, 10000);
    assert.equal(ROOM_CODE_MAX, 99999);
  });

  it('writes the lowest and highest values as five digits', () => {
    assert.equal(generateRoomCode(() => 10000), '10000');
    assert.equal(generateRoomCode(() => 99999), '99999');
  });

  it('always produces a valid code with the real random source', () => {
    for (let i = 0; i < 5000; i++) {
      const code = generateRoomCode();
      assert.ok(isRoomCode(code), code);
      assert.ok(Number(code) >= 10000 && Number(code) <= 99999, code);
    }
  });
});

describe('isRoomCode', () => {
  it('accepts every five-digit number from 10000 to 99999', () => {
    for (const ok of ['10000', '10001', '54321', '99998', '99999']) {
      assert.equal(isRoomCode(ok), true, ok);
    }
  });

  it('rejects anything else', () => {
    const bad: unknown[] = [
      '09999', // leading zero: below the range
      '00000',
      '100000', // six digits
      '1234', // four digits
      '',
      ' 54321',
      '54321 ',
      '5432a',
      'ABCDE',
      '5.4321',
      '-5432',
      54321, // a number, not text
      null,
      undefined,
    ];
    for (const value of bad) {
      assert.equal(isRoomCode(value), false, String(value));
    }
  });
});
