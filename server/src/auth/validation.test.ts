import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emailError,
  fallbackRiderName,
  isAllowedEmailDomain,
  nameError,
  normalizeEmail,
  passwordError,
} from './validation';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    assert.equal(normalizeEmail('  Alex.Rider@GMAIL.com '), 'alex.rider@gmail.com');
  });
});

describe('emailError', () => {
  for (const ok of ['alex@gmail.com', 'alex.rider99@gmail.com', 'a@gmail.com', `${'a'.repeat(30)}@gmail.com`]) {
    it(`accepts ${ok}`, () => assert.equal(emailError(ok), null));
  }

  const bad: Array<[string, string]> = [
    ['non-Gmail domain', 'alex@yahoo.com'],
    ['look-alike domain', 'alex@gmail.com.evil.io'],
    ['subdomain trick', 'alex@notgmail.com'],
    ['no domain', 'alex'],
    ['empty local part', '@gmail.com'],
    ['leading dot', '.alex@gmail.com'],
    ['trailing dot', 'alex.@gmail.com'],
    ['doubled dot', 'al..ex@gmail.com'],
    ['space', 'al ex@gmail.com'],
    ['plus tag', 'alex+spam@gmail.com'],
    ['underscore', 'al_ex@gmail.com'],
    ['too long', `${'a'.repeat(31)}@gmail.com`],
    ['second @', 'a@b@gmail.com'],
  ];
  for (const [label, email] of bad) {
    it(`rejects ${label}`, () => assert.equal(emailError(email), 'Invalid Gmail format'));
  }
});

describe('isAllowedEmailDomain', () => {
  it('only accepts exactly @gmail.com', () => {
    assert.equal(isAllowedEmailDomain('a@gmail.com'), true);
    assert.equal(isAllowedEmailDomain('a@googlemail.com'), false);
    assert.equal(isAllowedEmailDomain('a@gmail.com.au'), false);
  });
});

describe('passwordError', () => {
  it('requires at least 8 characters', () => {
    assert.equal(passwordError('1234567'), 'Password must be at least 8 characters');
    assert.equal(passwordError('12345678'), null);
  });

  it('rejects more than 72 bytes, which bcrypt would silently truncate', () => {
    assert.equal(passwordError('a'.repeat(72)), null);
    assert.match(passwordError('a'.repeat(73)) ?? '', /at most 72/);
    // 37 two-byte characters = 74 bytes despite being only 37 characters long.
    assert.match(passwordError('é'.repeat(37)) ?? '', /at most 72/);
  });
});

describe('nameError', () => {
  it('requires 2-24 characters', () => {
    assert.match(nameError('a') ?? '', /2-24/);
    assert.equal(nameError('Al'), null);
    assert.equal(nameError('a'.repeat(24)), null);
    assert.match(nameError('a'.repeat(25)) ?? '', /2-24/);
  });
});

describe('fallbackRiderName', () => {
  it('derives a name from the address, capped and cleaned', () => {
    assert.equal(fallbackRiderName('alex.rider@gmail.com'), 'alexrider');
    assert.equal(fallbackRiderName(`${'x'.repeat(40)}@gmail.com`).length, 24);
    assert.equal(fallbackRiderName('...@gmail.com'), 'Rider');
  });
});
