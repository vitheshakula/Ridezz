import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEnv } from './env';

const SECRET = 'x'.repeat(40);

describe('loadEnv', () => {
  it('refuses to start without a JWT secret rather than falling back to a guessable one', () => {
    assert.throws(() => loadEnv({}), /JWT_SECRET is not set/);
    assert.throws(() => loadEnv({ JWT_SECRET: '   ' }), /JWT_SECRET is not set/);
  });

  it('refuses a short JWT secret', () => {
    assert.throws(() => loadEnv({ JWT_SECRET: 'short' }), /too short/);
    assert.throws(() => loadEnv({ JWT_SECRET: 'x'.repeat(31) }), /too short/);
    assert.doesNotThrow(() => loadEnv({ JWT_SECRET: 'x'.repeat(32) }));
  });

  it('reads the configured values', () => {
    const env = loadEnv({
      JWT_SECRET: SECRET,
      PORT: '4321',
      GOOGLE_CLIENT_ID: ' my-client-id ',
      LIVEKIT_API_KEY: 'k',
      LIVEKIT_API_SECRET: 's',
      LIVEKIT_URL: 'wss://x.example',
    });
    assert.equal(env.port, 4321);
    assert.equal(env.jwtSecret, SECRET);
    assert.equal(env.googleClientId, 'my-client-id');
    assert.deepEqual(env.livekit, { apiKey: 'k', apiSecret: 's', url: 'wss://x.example' });
  });

  it('treats a missing or blank Google client id as Google sign-in disabled', () => {
    assert.equal(loadEnv({ JWT_SECRET: SECRET }).googleClientId, null);
    assert.equal(loadEnv({ JWT_SECRET: SECRET, GOOGLE_CLIENT_ID: '  ' }).googleClientId, null);
  });

  it('keeps the previous defaults for port and LiveKit so existing setups do not break', () => {
    const env = loadEnv({ JWT_SECRET: SECRET });
    assert.equal(env.port, 5000);
    assert.equal(env.livekit.url, 'ws://127.0.0.1:7880');
  });
});

describe('ALLOWED_EMAILS', () => {
  it('is open to everyone when unset or blank', () => {
    assert.equal(loadEnv({ JWT_SECRET: SECRET }).allowedEmails, null);
    assert.equal(loadEnv({ JWT_SECRET: SECRET, ALLOWED_EMAILS: '' }).allowedEmails, null);
    assert.equal(loadEnv({ JWT_SECRET: SECRET, ALLOWED_EMAILS: ' , ; \n ' }).allowedEmails, null);
  });

  it('accepts commas, semicolons, spaces and newlines, in any case', () => {
    const env = loadEnv({ JWT_SECRET: SECRET, ALLOWED_EMAILS: ' A@gmail.com,b@gmail.com;\nC@GMAIL.com  d@gmail.com ' });
    assert.deepEqual([...(env.allowedEmails ?? [])].sort(), ['a@gmail.com', 'b@gmail.com', 'c@gmail.com', 'd@gmail.com']);
  });
});

describe('ALLOWED_EMAILS (regression)', () => {
  it('does not split addresses on the letter "s" or other characters that are part of them', () => {
    const env = loadEnv({ JWT_SECRET: SECRET, ALLOWED_EMAILS: 'mike.smith@gmail.com, ross.stevens@gmail.com' });
    assert.deepEqual([...(env.allowedEmails ?? [])].sort(), ['mike.smith@gmail.com', 'ross.stevens@gmail.com']);
  });
});
