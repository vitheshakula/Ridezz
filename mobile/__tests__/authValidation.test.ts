import {
  INVALID_GMAIL,
  normalizeEmail,
  validateEmail,
  validateName,
  validateNewPassword,
  validateRegistration,
  validateSignIn,
} from '../src/utils/authValidation';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Alex.Rider@GMAIL.com ')).toBe('alex.rider@gmail.com');
  });
});

describe('validateEmail', () => {
  it.each(['alex@gmail.com', 'alex.rider99@gmail.com', 'a@gmail.com', '  ALEX@Gmail.com  ', `${'a'.repeat(30)}@gmail.com`])(
    'accepts %s',
    email => {
      expect(validateEmail(email)).toBeNull();
    },
  );

  it.each([
    ['a non-Gmail domain', 'alex@yahoo.com'],
    ['a look-alike domain', 'alex@gmail.com.evil.io'],
    ['a similar domain', 'alex@notgmail.com'],
    ['no @', 'alex'],
    ['no local part', '@gmail.com'],
    ['a leading dot', '.alex@gmail.com'],
    ['a trailing dot', 'alex.@gmail.com'],
    ['a doubled dot', 'al..ex@gmail.com'],
    ['a space', 'al ex@gmail.com'],
    ['a plus tag', 'alex+spam@gmail.com'],
    ['31 characters before the @', `${'a'.repeat(31)}@gmail.com`],
  ])('rejects %s', (_label, email) => {
    expect(validateEmail(email)).toBe(INVALID_GMAIL);
  });

  it('asks for an address when the field is empty rather than calling it malformed', () => {
    expect(validateEmail('')).toBe('Enter your Gmail address');
    expect(validateEmail('   ')).toBe('Enter your Gmail address');
  });
});

describe('validateNewPassword', () => {
  it('requires at least 8 characters', () => {
    expect(validateNewPassword('1234567')).toBe('Password must be at least 8 characters');
    expect(validateNewPassword('12345678')).toBeNull();
  });
});

describe('validateName', () => {
  it('requires 2-24 characters after trimming', () => {
    expect(validateName(' a ')).toMatch(/2-24/);
    expect(validateName('Al')).toBeNull();
    expect(validateName('a'.repeat(24))).toBeNull();
    expect(validateName('a'.repeat(25))).toMatch(/2-24/);
  });
});

describe('validateSignIn', () => {
  it('passes a Gmail address and any non-empty password', () => {
    expect(validateSignIn('alex@gmail.com', 'x')).toEqual({});
  });

  it('does not apply the new-password length rule, so an older short password can still sign in', () => {
    expect(validateSignIn('alex@gmail.com', 'short')).toEqual({});
  });

  it('reports each problem against its own field', () => {
    expect(validateSignIn('alex@yahoo.com', '')).toEqual({
      email: INVALID_GMAIL,
      password: 'Enter your password',
    });
  });
});

describe('validateRegistration', () => {
  const valid = ['Alex', 'alex@gmail.com', 'longenough1', 'longenough1'] as const;

  it('passes a complete, matching form', () => {
    expect(validateRegistration(...valid)).toEqual({});
  });

  it('reports every problem at once, each against its own field', () => {
    expect(validateRegistration('A', 'alex@yahoo.com', 'short', 'short')).toEqual({
      name: expect.stringMatching(/2-24/),
      email: INVALID_GMAIL,
      password: 'Password must be at least 8 characters',
    });
  });

  it('flags a mismatched confirmation only once the password itself is acceptable', () => {
    expect(validateRegistration('Alex', 'alex@gmail.com', 'longenough1', 'different1')).toEqual({
      confirmPassword: 'Passwords do not match',
    });
    // A too-short password is the more useful thing to fix first.
    expect(validateRegistration('Alex', 'alex@gmail.com', 'short', 'other')).toEqual({
      password: 'Password must be at least 8 characters',
    });
  });
});
