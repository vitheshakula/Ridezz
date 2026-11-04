import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGoogleVerifier, GoogleUnavailableError, type GoogleCertsClient } from './google';

const options = { timeoutMs: 1000, retryAttempts: 3, sleep: async () => undefined };

function fakeClient(overrides: Partial<GoogleCertsClient> = {}): GoogleCertsClient & {
  certCalls: number;
} {
  const client = {
    certCalls: 0,
    async getFederatedSignonCertsAsync() {
      client.certCalls++;
      return {};
    },
    async verifyIdToken() {
      return {
        getPayload: () => ({
          sub: 'google-123',
          email: 'rider@gmail.com',
          email_verified: true,
          name: 'Rider',
        }),
      };
    },
    ...overrides,
  };
  return client;
}

describe('createGoogleVerifier', () => {
  it('returns the identity from a valid token', async () => {
    const verify = createGoogleVerifier('client-id', options, fakeClient());
    assert.deepEqual(await verify('token'), {
      googleId: 'google-123',
      email: 'rider@gmail.com',
      emailVerified: true,
      name: 'Rider',
    });
  });

  it('retries a transient certificate fetch failure', async () => {
    let failures = 1;
    const client = fakeClient({
      async getFederatedSignonCertsAsync() {
        if (failures-- > 0) {
          throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        }
        return {};
      },
    });
    const verify = createGoogleVerifier('client-id', options, client);
    assert.equal((await verify('token')).googleId, 'google-123');
  });

  it('reports Google as unavailable once retries are exhausted', async () => {
    let calls = 0;
    const client = fakeClient({
      async getFederatedSignonCertsAsync() {
        calls++;
        throw Object.assign(new Error('bad gateway'), { response: { status: 502 } });
      },
    });
    const verify = createGoogleVerifier('client-id', options, client);
    await assert.rejects(verify('token'), GoogleUnavailableError);
    assert.equal(calls, 3);
  });

  it('does not retry or mask an invalid token', async () => {
    const client = fakeClient({
      async verifyIdToken() {
        throw new Error('Invalid token signature');
      },
    });
    const verify = createGoogleVerifier('client-id', options, client);
    await assert.rejects(verify('token'), /Invalid token signature/);
    assert.equal(client.certCalls, 1);
  });

  it('rejects a token without an account id or email', async () => {
    const client = fakeClient({
      async verifyIdToken() {
        return { getPayload: () => ({ sub: 'google-123' }) };
      },
    });
    const verify = createGoogleVerifier('client-id', options, client);
    await assert.rejects(verify('token'), /missing the account id or email/);
  });
});
