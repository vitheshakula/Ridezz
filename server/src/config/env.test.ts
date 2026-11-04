import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEnv } from './env';

const SECRET = 'x'.repeat(40);
const VALID_ENV: NodeJS.ProcessEnv = {
  JWT_SECRET: SECRET,
  DATABASE_URL: 'postgresql://user:password@localhost:5432/ridezz',
  LIVEKIT_API_KEY: 'livekit-key',
  LIVEKIT_API_SECRET: 'livekit-secret',
  LIVEKIT_URL: 'wss://livekit.example',
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...VALID_ENV, ...overrides };
}

describe('loadEnv', () => {
  it('refuses to start without a JWT secret rather than falling back to a guessable one', () => {
    assert.throws(() => loadEnv(env({ JWT_SECRET: undefined })), /JWT_SECRET is not set/);
    assert.throws(() => loadEnv(env({ JWT_SECRET: '   ' })), /JWT_SECRET is not set/);
  });

  it('refuses a short JWT secret', () => {
    assert.throws(() => loadEnv(env({ JWT_SECRET: 'short' })), /too short/);
    assert.throws(() => loadEnv(env({ JWT_SECRET: 'x'.repeat(31) })), /too short/);
    assert.doesNotThrow(() => loadEnv(env({ JWT_SECRET: 'x'.repeat(32) })));
  });

  it('reads the configured values', () => {
    const result = loadEnv(
      env({
        PORT: '4321',
        GOOGLE_CLIENT_ID: ' my-client-id ',
        CORS_ORIGINS: ' https://app.example,https://admin.example ',
        AUTH_RATE_LIMIT_WINDOW_MS: '60000',
        AUTH_RATE_LIMIT_MAX: '25',
        LIVEKIT_API_KEY: ' k ',
        LIVEKIT_API_SECRET: ' s ',
        LIVEKIT_URL: ' wss://x.example ',
      }),
    );
    assert.equal(result.port, 4321);
    assert.equal(result.jwtSecret, SECRET);
    assert.equal(result.googleClientId, 'my-client-id');
    assert.deepEqual([...result.corsOrigins!], ['https://app.example', 'https://admin.example']);
    assert.deepEqual(result.authRateLimit, { windowMs: 60000, max: 25, perAccountMax: 10 });
    assert.deepEqual(result.livekit, { apiKey: 'k', apiSecret: 's', url: 'wss://x.example' });
  });

  it('defaults and validates the log level and shutdown timeout', () => {
    const defaults = loadEnv(env());
    assert.equal(defaults.logLevel, 'info');
    assert.equal(defaults.shutdownTimeoutMs, 10_000);

    const configured = loadEnv(env({ LOG_LEVEL: ' WARN ', SHUTDOWN_TIMEOUT_MS: '2500' }));
    assert.equal(configured.logLevel, 'warn');
    assert.equal(configured.shutdownTimeoutMs, 2500);

    assert.throws(() => loadEnv(env({ LOG_LEVEL: 'verbose' })), /LOG_LEVEL must be one of/);
    assert.throws(() => loadEnv(env({ SHUTDOWN_TIMEOUT_MS: '0' })), /SHUTDOWN_TIMEOUT_MS/);
  });

  it('treats a missing or blank Google client id as Google sign-in disabled', () => {
    assert.equal(loadEnv(env({ GOOGLE_CLIENT_ID: undefined })).googleClientId, null);
    assert.equal(loadEnv(env({ GOOGLE_CLIENT_ID: '  ' })).googleClientId, null);
  });

  it('keeps the previous default port when PORT is missing or blank', () => {
    assert.equal(loadEnv(env({ PORT: undefined })).port, 5000);
    assert.equal(loadEnv(env({ PORT: '  ' })).port, 5000);
  });

  it('uses prototype-friendly defaults for CORS and rate limiting', () => {
    const result = loadEnv(env());
    assert.equal(result.corsOrigins, null);
    assert.deepEqual(result.authRateLimit, { windowMs: 900000, max: 100, perAccountMax: 10 });
  });
});

describe('HTTP security configuration', () => {
  it('treats blank CORS origins as permissive and parses comma-separated exact origins', () => {
    assert.equal(loadEnv(env({ CORS_ORIGINS: '  ' })).corsOrigins, null);
    assert.deepEqual(
      [
        ...(loadEnv(env({ CORS_ORIGINS: 'https://one.example, https://two.example' }))
          .corsOrigins ?? []),
      ],
      ['https://one.example', 'https://two.example'],
    );
  });

  it('rejects invalid rate-limit configuration', () => {
    for (const value of ['0', '-1', '1.5', 'NaN']) {
      assert.throws(
        () => loadEnv(env({ AUTH_RATE_LIMIT_WINDOW_MS: value })),
        /AUTH_RATE_LIMIT_WINDOW_MS must be a positive integer/,
      );
      assert.throws(
        () => loadEnv(env({ AUTH_RATE_LIMIT_MAX: value })),
        /AUTH_RATE_LIMIT_MAX must be a positive integer/,
      );
    }
  });
});

describe('DATABASE_URL', () => {
  it('requires a nonblank value', () => {
    assert.throws(() => loadEnv(env({ DATABASE_URL: undefined })), /DATABASE_URL is not set/);
    assert.throws(() => loadEnv(env({ DATABASE_URL: '   ' })), /DATABASE_URL is not set/);
  });

  it('accepts postgresql and postgres URLs', () => {
    assert.doesNotThrow(() => loadEnv(env({ DATABASE_URL: 'postgresql://localhost/ridezz' })));
    assert.doesNotThrow(() => loadEnv(env({ DATABASE_URL: ' postgres://localhost/ridezz ' })));
  });

  it('rejects a SQLite file URL', () => {
    assert.throws(() => loadEnv(env({ DATABASE_URL: 'file:./dev.db' })), /valid PostgreSQL URL/);
  });

  it('rejects malformed URLs and non-PostgreSQL schemes without exposing the value', () => {
    const privateValue = 'mysql://private-user:private-password@localhost/ridezz';
    assert.throws(
      () => loadEnv(env({ DATABASE_URL: privateValue })),
      error =>
        error instanceof Error &&
        /valid PostgreSQL URL/.test(error.message) &&
        !error.message.includes(privateValue),
    );
    assert.throws(() => loadEnv(env({ DATABASE_URL: 'postgresql://' })), /valid PostgreSQL URL/);
  });
});

describe('LiveKit configuration', () => {
  it('requires the API key, API secret and URL', () => {
    assert.throws(() => loadEnv(env({ LIVEKIT_API_KEY: undefined })), /LIVEKIT_API_KEY is not set/);
    assert.throws(() => loadEnv(env({ LIVEKIT_API_KEY: '  ' })), /LIVEKIT_API_KEY is not set/);
    assert.throws(
      () => loadEnv(env({ LIVEKIT_API_SECRET: undefined })),
      /LIVEKIT_API_SECRET is not set/,
    );
    assert.throws(
      () => loadEnv(env({ LIVEKIT_API_SECRET: '  ' })),
      /LIVEKIT_API_SECRET is not set/,
    );
    assert.throws(() => loadEnv(env({ LIVEKIT_URL: undefined })), /LIVEKIT_URL is not set/);
    assert.throws(() => loadEnv(env({ LIVEKIT_URL: '  ' })), /LIVEKIT_URL is not set/);
  });

  it('accepts ws and wss URLs', () => {
    assert.doesNotThrow(() => loadEnv(env({ LIVEKIT_URL: 'ws://127.0.0.1:7880' })));
    assert.doesNotThrow(() => loadEnv(env({ LIVEKIT_URL: 'wss://livekit.example' })));
  });

  it('rejects malformed URLs and non-WebSocket schemes without exposing the value', () => {
    const privateValue = 'https://private-livekit.example';
    assert.throws(
      () => loadEnv(env({ LIVEKIT_URL: privateValue })),
      error =>
        error instanceof Error &&
        /valid WebSocket URL/.test(error.message) &&
        !error.message.includes(privateValue),
    );
    assert.throws(() => loadEnv(env({ LIVEKIT_URL: 'not-a-url' })), /valid WebSocket URL/);
  });
});

describe('PORT', () => {
  it('accepts integers from 1 through 65535', () => {
    assert.equal(loadEnv(env({ PORT: '1' })).port, 1);
    assert.equal(loadEnv(env({ PORT: '65535' })).port, 65535);
  });

  it('rejects non-integers, non-numbers and values outside the valid range', () => {
    for (const port of ['0', '65536', '-1', '1.5', 'NaN', 'not-a-number']) {
      assert.throws(
        () => loadEnv(env({ PORT: port })),
        /PORT must be an integer between 1 and 65535/,
      );
    }
  });
});

describe('ALLOWED_EMAILS', () => {
  it('is open to everyone when unset or blank', () => {
    assert.equal(loadEnv(env({ ALLOWED_EMAILS: undefined })).allowedEmails, null);
    assert.equal(loadEnv(env({ ALLOWED_EMAILS: '' })).allowedEmails, null);
    assert.equal(loadEnv(env({ ALLOWED_EMAILS: ' , ; \n ' })).allowedEmails, null);
  });

  it('accepts commas, semicolons, spaces and newlines, in any case', () => {
    const result = loadEnv(
      env({ ALLOWED_EMAILS: ' A@gmail.com,b@gmail.com;\nC@GMAIL.com  d@gmail.com ' }),
    );
    assert.deepEqual([...(result.allowedEmails ?? [])].sort(), [
      'a@gmail.com',
      'b@gmail.com',
      'c@gmail.com',
      'd@gmail.com',
    ]);
  });
});

describe('ALLOWED_EMAILS (regression)', () => {
  it('does not split addresses on the letter "s" or other characters that are part of them', () => {
    const result = loadEnv(env({ ALLOWED_EMAILS: 'mike.smith@gmail.com, ross.stevens@gmail.com' }));
    assert.deepEqual([...(result.allowedEmails ?? [])].sort(), [
      'mike.smith@gmail.com',
      'ross.stevens@gmail.com',
    ]);
  });
});
