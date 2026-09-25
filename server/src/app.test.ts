import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import type { GoogleIdentity, GoogleVerifier } from './auth/google';
import { loadEnv } from './config/env';

const JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
const GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

let prisma: PrismaClient;
let server: Server;
let base: string;
let workDir: string;

// Google is the one thing we can't run for real here (no genuine token can be minted), so the
// verifier is faked: it "verifies" tokens registered in this map and rejects everything else.
const googleTokens = new Map<string, GoogleIdentity>();
const fakeVerifier: GoogleVerifier = async idToken => {
  const identity = googleTokens.get(idToken);
  if (!identity) {
    throw new Error('Invalid token signature');
  }
  return identity;
};

let counter = 0;
const nextEmail = () => `rider${Date.now().toString(36)}${counter++}@gmail.com`;

interface Reply {
  status: number;
  body: any;
}

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const post = (path: string, body?: unknown, token?: string) => call('POST', path, body, token);
const get = (path: string, token?: string) => call('GET', path, undefined, token);

/** Registers a fresh email + password account and returns its token and details. */
async function register(overrides: Record<string, unknown> = {}) {
  const email = nextEmail();
  const password = 'correct horse battery';
  const res = await post('/api/auth/register', { name: 'Alex', email, password, ...overrides });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { email, password, token: res.body.token as string, user: res.body.user };
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'ridezz-test-'));
  const dbUrl = `file:${join(workDir, 'test.db').replace(/\\/g, '/')}`;
  // A real database built from the real migrations, not a hand-rolled fake.
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' });

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const env = loadEnv({
    JWT_SECRET,
    GOOGLE_CLIENT_ID,
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'livekit-secret-'.padEnd(40, 'y'),
    LIVEKIT_URL: 'wss://livekit.test',
  });
  const app = createApp({ prisma, env, verifyGoogleIdToken: fakeVerifier });
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

describe('POST /api/auth/register', () => {
  it('creates an account and returns a token plus { id, email, name }', async () => {
    const email = nextEmail();
    const res = await post('/api/auth/register', { name: 'Alex', email, password: 'longenough1' });

    assert.equal(res.status, 201);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.user.email, email);
    assert.equal(res.body.user.name, 'Alex');
    assert.equal(typeof res.body.user.id, 'string');
  });

  it('stores only a bcrypt hash of the password, never the password', async () => {
    const { email, password } = await register();
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });

    assert.ok(row.password);
    assert.notEqual(row.password, password);
    assert.match(row.password, /^\$2[aby]\$10\$/);
    assert.equal(bcrypt.compareSync(password, row.password), true);
  });

  it('never returns the password or its hash', async () => {
    const email = nextEmail();
    const res = await post('/api/auth/register', { name: 'Alex', email, password: 'longenough1' });
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });

    assert.equal('password' in res.body.user, false);
    assert.equal(JSON.stringify(res.body).includes(row.password ?? 'never'), false);
  });

  it('creates the account unverified -- the address was typed, not proven', async () => {
    const { user } = await register();
    assert.equal(user.emailVerified, false);
  });

  it('normalizes the email so the same address cannot register twice in different case', async () => {
    const { email } = await register();
    const again = await post('/api/auth/register', {
      name: 'Alex',
      email: `  ${email.toUpperCase()} `,
      password: 'longenough1',
    });
    assert.equal(again.status, 409);
  });

  it('rejects a non-Gmail address', async () => {
    const res = await post('/api/auth/register', { name: 'Alex', email: 'alex@yahoo.com', password: 'longenough1' });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Invalid Gmail format');
  });

  it('rejects a short password', async () => {
    const res = await post('/api/auth/register', { name: 'Alex', email: nextEmail(), password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Password must be at least 8 characters');
  });

  it('rejects a bad name', async () => {
    const res = await post('/api/auth/register', { name: 'A', email: nextEmail(), password: 'longenough1' });
    assert.equal(res.status, 400);
  });

  it('rejects missing or non-string fields instead of crashing', async () => {
    assert.equal((await post('/api/auth/register', {})).status, 400);
    assert.equal((await post('/api/auth/register', { name: 'Alex', email: 5, password: 'longenough1' })).status, 400);
    assert.equal((await post('/api/auth/register', { name: 'Alex', email: nextEmail(), password: ['x'] })).status, 400);
    assert.equal((await post('/api/auth/register')).status, 400);
  });

  it('answers 409 for an address that already has an account', async () => {
    const { email } = await register();
    const res = await post('/api/auth/register', { name: 'Other', email, password: 'longenough1' });
    assert.equal(res.status, 409);
  });

  it('still answers on the legacy /signup path', async () => {
    const res = await post('/api/auth/signup', { name: 'Alex', email: nextEmail(), password: 'longenough1' });
    assert.equal(res.status, 201);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with the right password and returns { token, user }', async () => {
    const { email, password, user } = await register();
    const res = await post('/api/auth/login', { email, password });

    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.deepEqual(res.body.user, user);
  });

  it('is case-insensitive about the email', async () => {
    const { email, password } = await register();
    assert.equal((await post('/api/auth/login', { email: email.toUpperCase(), password })).status, 200);
  });

  it('rejects a wrong password', async () => {
    const { email } = await register();
    const res = await post('/api/auth/login', { email, password: 'wrong password' });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid credentials.');
  });

  it('gives an unknown email the same answer as a wrong password, so accounts cannot be probed', async () => {
    const { email } = await register();
    const wrongPassword = await post('/api/auth/login', { email, password: 'wrong password' });
    const unknownEmail = await post('/api/auth/login', { email: nextEmail(), password: 'wrong password' });

    assert.equal(unknownEmail.status, wrongPassword.status);
    assert.deepEqual(unknownEmail.body, wrongPassword.body);
  });

  it('rejects missing or non-string fields with 400, not a 500', async () => {
    assert.equal((await post('/api/auth/login', {})).status, 400);
    assert.equal((await post('/api/auth/login', { email: 1, password: 2 })).status, 400);
    assert.equal((await post('/api/auth/login')).status, 400);
  });

  it('does not accept the stored hash as a password', async () => {
    const { email } = await register();
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    const res = await post('/api/auth/login', { email, password: row.password });
    assert.equal(res.status, 401);
  });

  it('turns malformed JSON into a clean 400', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: 'Invalid request.' });
  });
});

describe('token protection (Passport JWT)', () => {
  it('lets a valid token through and identifies the rider', async () => {
    const { token, user } = await register();
    const res = await get('/api/auth/me', token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user, user);
  });

  it('rejects a request with no token', async () => {
    const res = await get('/api/auth/me');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: 'Authentication required.' });
  });

  it('rejects garbage, a wrong scheme, and an empty bearer', async () => {
    assert.equal((await get('/api/auth/me', 'not-a-jwt')).status, 401);
    const { token } = await register();
    const basic = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Basic ${token}` } });
    assert.equal(basic.status, 401);
    const empty = await fetch(`${base}/api/auth/me`, { headers: { authorization: 'Bearer ' } });
    assert.equal(empty.status, 401);
  });

  it('rejects a token signed with a different secret', async () => {
    const { user } = await register();
    const forged = jwt.sign({}, 'some-other-secret'.padEnd(40, 'z'), { subject: user.id, expiresIn: '1h' });
    assert.equal((await get('/api/auth/me', forged)).status, 401);
  });

  it('rejects an expired token', async () => {
    const { user } = await register();
    const expired = jwt.sign({}, JWT_SECRET, { subject: user.id, expiresIn: -60 });
    assert.equal((await get('/api/auth/me', expired)).status, 401);
  });

  it('rejects an unsigned token (alg: none)', async () => {
    const { user } = await register();
    const unsigned = jwt.sign({ sub: user.id }, '', { algorithm: 'none' });
    assert.equal((await get('/api/auth/me', unsigned)).status, 401);
  });

  it('rejects a token for an account that no longer exists', async () => {
    const { token, user } = await register();
    await prisma.user.delete({ where: { id: user.id } });
    assert.equal((await get('/api/auth/me', token)).status, 401);
  });

  it('still accepts a token issued before the `sub` claim (userId), until it expires', async () => {
    const { user } = await register();
    const legacy = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await get('/api/auth/me', legacy)).status, 200);
  });
});

describe('room routes require sign-in but otherwise behave as before', () => {
  it('rejects create and join without a token, and creates nothing', async () => {
    const before = await prisma.room.count();
    assert.equal((await post('/api/rooms/create', { riderName: 'Alex' })).status, 401);
    assert.equal((await post('/api/rooms/join', { roomCode: 'ABC234', riderName: 'Alex' })).status, 401);
    assert.equal(await prisma.room.count(), before);
  });

  it('creates a room hosted by the signed-in rider and returns a LiveKit token for it', async () => {
    const { token, user } = await register();
    const res = await post('/api/rooms/create', { riderName: 'Alex' }, token);

    assert.equal(res.status, 201);
    assert.match(res.body.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(res.body.serverUrl, 'wss://livekit.test');

    const room = await prisma.room.findUniqueOrThrow({ where: { code: res.body.roomCode } });
    assert.equal(room.hostId, user.id);

    const claims = jwt.decode(res.body.token) as any;
    assert.equal(claims.video.room, res.body.roomCode);
    assert.equal(claims.video.canPublish, true);
    assert.equal(claims.name, 'Alex');
  });

  it('hosts the room as the token holder, ignoring a userId sent in the body', async () => {
    const attacker = await register();
    const victim = await register();
    const res = await post('/api/rooms/create', { riderName: 'Alex', userId: victim.user.id }, attacker.token);

    const room = await prisma.room.findUniqueOrThrow({ where: { code: res.body.roomCode } });
    assert.equal(room.hostId, attacker.user.id);
  });

  it('falls back to the account name when no rider name is sent', async () => {
    const { token } = await register({ name: 'Casey' });
    const res = await post('/api/rooms/create', {}, token);
    assert.equal(res.status, 201);
    assert.equal((jwt.decode(res.body.token) as any).name, 'Casey');
  });

  it('lets a signed-in rider join an existing room by code, case-insensitively', async () => {
    const host = await register();
    const guest = await register();
    const created = await post('/api/rooms/create', { riderName: 'Host' }, host.token);

    const joined = await post(
      '/api/rooms/join',
      { roomCode: ` ${created.body.roomCode.toLowerCase()} `, riderName: 'Guest' },
      guest.token,
    );
    assert.equal(joined.status, 200);
    assert.equal(joined.body.roomCode, created.body.roomCode);
    assert.equal((jwt.decode(joined.body.token) as any).video.room, created.body.roomCode);
  });

  it('answers 404 for an unknown room and 400 for a missing code', async () => {
    const { token } = await register();
    assert.equal((await post('/api/rooms/join', { roomCode: 'ZZZZZZ' }, token)).status, 404);
    assert.equal((await post('/api/rooms/join', {}, token)).status, 400);
    assert.equal((await post('/api/rooms/join', { roomCode: 123456 }, token)).status, 400);
  });

  it('issues a different code for each room', async () => {
    const { token } = await register();
    const codes = new Set<string>();
    for (let i = 0; i < 15; i++) {
      codes.add((await post('/api/rooms/create', { riderName: 'Alex' }, token)).body.roomCode);
    }
    assert.equal(codes.size, 15);
  });
});

describe('Google sign-in', () => {
  const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
    googleId: `g-${counter++}-${Date.now()}`,
    email: nextEmail(),
    emailVerified: true,
    name: 'Google Rider',
    ...over,
  });
  const withToken = (id: GoogleIdentity, token = `tok-${id.googleId}`) => {
    googleTokens.set(token, id);
    return token;
  };

  it('publishes the public client id for the app to use', async () => {
    const res = await get('/api/auth/google/config');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { clientId: GOOGLE_CLIENT_ID });
  });

  it('creates a verified account for a first-time Google user', async () => {
    const id = identity();
    const res = await post('/api/auth/google', { idToken: withToken(id), mode: 'signup' });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, id.email);
    assert.equal(res.body.user.name, 'Google Rider');
    assert.equal(res.body.user.emailVerified, true);

    const row = await prisma.user.findUniqueOrThrow({ where: { email: id.email } });
    assert.equal(row.googleId, id.googleId);
    assert.equal(row.password, null);
    assert.equal(typeof (await get('/api/auth/me', res.body.token)).body.user.id, 'string');
  });

  it('signs the same Google account into the same rider each time', async () => {
    const id = identity();
    const first = await post('/api/auth/google', { idToken: withToken(id), mode: 'signup' });
    const second = await post('/api/auth/google', { idToken: withToken(id, 'second-token'), mode: 'login' });
    assert.equal(second.body.user.id, first.body.user.id);
    assert.equal(await prisma.user.count({ where: { googleId: id.googleId } }), 1);
  });

  it('rejects a token Google did not issue, with a generic message', async () => {
    const res = await post('/api/auth/google', { idToken: 'forged-token' });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Google sign-in failed. Please try again.');
    assert.equal(JSON.stringify(res.body).includes('signature'), false);
  });

  it('requires an idToken', async () => {
    assert.equal((await post('/api/auth/google', {})).status, 400);
    assert.equal((await post('/api/auth/google', { idToken: 42 })).status, 400);
  });

  it('refuses a Google account whose email Google has not verified', async () => {
    const id = identity({ emailVerified: false });
    const res = await post('/api/auth/google', { idToken: withToken(id), mode: 'signup' });
    assert.equal(res.status, 401);
    assert.equal(await prisma.user.count({ where: { email: id.email } }), 0);
  });

  it('refuses a non-Gmail Google account', async () => {
    const id = identity({ email: 'someone@company.com' });
    const res = await post('/api/auth/google', { idToken: withToken(id), mode: 'signup' });
    assert.equal(res.status, 403);
    assert.equal(await prisma.user.count({ where: { email: id.email } }), 0);
  });

  it('names an account from the email when Google supplies no name', async () => {
    const id = identity({ name: null, email: 'wanderer.one@gmail.com' });
    const res = await post('/api/auth/google', { idToken: withToken(id), mode: 'signup' });
    assert.equal(res.body.user.name, 'wandererone');
  });

  it('caps a long Google display name at 24 characters', async () => {
    const id = identity({ name: 'N'.repeat(60) });
    const res = await post('/api/auth/google', { idToken: withToken(id), mode: 'signup' });
    assert.equal(res.body.user.name.length, 24);
  });

  it('links to an existing email + password account, marks it verified, and deletes the password', async () => {
    const { email, password, user } = await register();
    const id = identity({ email });

    const res = await post('/api/auth/google', { idToken: withToken(id) });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, user.id, 'same account, not a duplicate');
    assert.equal(res.body.user.emailVerified, true);

    // Whoever typed that password in never proved they own the mailbox -- it must stop working.
    const stale = await post('/api/auth/login', { email, password });
    assert.equal(stale.status, 401);
    assert.match(stale.body.message, /Google/);
  });

  it('tells a Google-only account to use Google when it tries a password', async () => {
    const id = identity();
    await post('/api/auth/google', { idToken: withToken(id), mode: 'signup' });
    const res = await post('/api/auth/login', { email: id.email, password: 'anything at all' });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /Google/);
  });

  it('refuses to hand an address already linked to one Google account to a different one', async () => {
    const first = identity();
    await post('/api/auth/google', { idToken: withToken(first), mode: 'signup' });

    const impostor = identity({ email: first.email });
    const res = await post('/api/auth/google', { idToken: withToken(impostor) });
    assert.equal(res.status, 409);
  });

  describe('login versus sign-up', () => {
    const google = (id: GoogleIdentity, mode?: string) =>
      post('/api/auth/google', { idToken: withToken(id), ...(mode ? { mode } : {}) });

    it('login refuses a Google account that never registered, and creates nothing', async () => {
      const id = identity();
      const res = await google(id, 'login');

      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'ACCOUNT_NOT_FOUND');
      assert.match(res.body.message, /Create an account first/);
      assert.equal(res.body.token, undefined);
      assert.equal(await prisma.user.count({ where: { OR: [{ email: id.email }, { googleId: id.googleId }] } }), 0);
    });

    it('is just as strict when no mode is sent -- login is the safe default', async () => {
      const id = identity();
      assert.equal((await google(id)).status, 404);
      assert.equal(await prisma.user.count({ where: { email: id.email } }), 0);
    });

    it('sign-up creates the account, and a later login with that Google account signs into it', async () => {
      const id = identity();
      const created = await google(id, 'signup');
      assert.equal(created.status, 200);

      const later = await google(id, 'login');
      assert.equal(later.status, 200);
      assert.equal(later.body.user.id, created.body.user.id);
    });

    it('sign-up for an account that already exists signs into it instead of duplicating it', async () => {
      const id = identity();
      const first = await google(id, 'signup');
      const again = await google(id, 'signup');

      assert.equal(again.status, 200);
      assert.equal(again.body.user.id, first.body.user.id);
      assert.equal(await prisma.user.count({ where: { googleId: id.googleId } }), 1);
    });

    it('login signs into an account created earlier with email + password', async () => {
      const { email, user } = await register();
      const res = await google(identity({ email }), 'login');

      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, user.id);
    });

    it('rejects a mode it does not know', async () => {
      const res = await google(identity(), 'admin');
      assert.equal(res.status, 400);
    });
  });

  it('answers 503 (not a crash) when Google sign-in is not configured', async () => {
    const env = loadEnv({ JWT_SECRET });
    const bare = createApp({ prisma, env });
    const s = await new Promise<Server>(resolve => {
      const listener = bare.listen(0, () => resolve(listener));
    });
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/auth`;
      const config = await fetch(`${url}/google/config`);
      assert.equal(config.status, 503);
      const signIn = await fetch(`${url}/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'x' }),
      });
      assert.equal(signIn.status, 503);
    } finally {
      await new Promise(resolve => s.close(resolve));
    }
  });
});

describe('private testing allowlist (ALLOWED_EMAILS)', () => {
  const allowedOne = 'allowed.one@gmail.com';
  const allowedTwo = 'allowed.two@gmail.com';
  let restrictedBase: string;
  let restrictedServer: Server;

  before(async () => {
    // Deliberately messy: mixed case, stray spaces, and a mix of separators.
    const env = loadEnv({
      JWT_SECRET,
      GOOGLE_CLIENT_ID,
      ALLOWED_EMAILS: `  ${allowedOne.toUpperCase()} ;\n ${allowedTwo},  `,
    });
    const app = createApp({ prisma, env, verifyGoogleIdToken: fakeVerifier });
    restrictedServer = await new Promise<Server>(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    restrictedBase = `http://127.0.0.1:${(restrictedServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise(resolve => restrictedServer.close(resolve));
  });

  async function ask(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
    const res = await fetch(`${restrictedBase}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const googleToken = (email: string) => {
    const identity: GoogleIdentity = { googleId: `allow-${counter++}-${email}`, email, emailVerified: true, name: 'Tester' };
    const token = `tok-${identity.googleId}`;
    googleTokens.set(token, identity);
    return token;
  };

  it('lets a listed address register, ignoring case and separators in the setting', async () => {
    const res = await ask('POST', '/api/auth/register', { name: 'Alex', email: allowedOne, password: 'longenough1' });
    assert.equal(res.status, 201);
    assert.equal((await ask('GET', '/api/auth/me', undefined, res.body.token)).status, 200);
  });

  it('turns away an address that is not listed, and creates nothing', async () => {
    const email = nextEmail();
    const res = await ask('POST', '/api/auth/register', { name: 'Alex', email, password: 'longenough1' });

    assert.equal(res.status, 403);
    assert.match(res.body.message, /private testing/);
    assert.equal(await prisma.user.count({ where: { email } }), 0);
  });

  it('turns away an unlisted Google account in BOTH modes, and creates nothing', async () => {
    const email = nextEmail();
    for (const mode of ['login', 'signup']) {
      const res = await ask('POST', '/api/auth/google', { idToken: googleToken(email), mode });
      assert.equal(res.status, 403, `mode ${mode}`);
      assert.match(res.body.message, /private testing/);
    }
    assert.equal(await prisma.user.count({ where: { email } }), 0);
  });

  it('lets a listed Google account sign up and then sign in', async () => {
    const token = googleToken(allowedTwo);
    const created = await ask('POST', '/api/auth/google', { idToken: token, mode: 'signup' });
    assert.equal(created.status, 200);
    const back = await ask('POST', '/api/auth/google', { idToken: token, mode: 'login' });
    assert.equal(back.status, 200);
    assert.equal(back.body.user.id, created.body.user.id);
  });

  it('blocks password sign-in for an account that already exists but is not listed', async () => {
    const { email, password } = await register(); // created on the open server
    const res = await ask('POST', '/api/auth/login', { email, password });
    assert.equal(res.status, 403);
  });

  it('cuts off a token already issued to someone who is not listed', async () => {
    const { token } = await register();
    assert.equal((await get('/api/auth/me', token)).status, 200, 'still fine on the open server');
    assert.equal((await ask('GET', '/api/auth/me', undefined, token)).status, 401);
    assert.equal((await ask('POST', '/api/rooms/create', { riderName: 'Alex' }, token)).status, 401);
  });
});

describe('ride destination, host and LiveKit metadata', () => {
  const fort = { destinationName: 'Golconda Fort, Hyderabad', destinationLat: 17.3833, destinationLng: 78.4011 };
  const patch = (code: string, body: unknown, token?: string) => call('PATCH', `/api/rooms/${code}/destination`, body, token);
  const claims = (livekitToken: string) => jwt.decode(livekitToken) as any;

  describe('creating a room', () => {
    it('makes the creator the host and answers isHost: true', async () => {
      const { token } = await register();
      const res = await post('/api/rooms/create', {}, token);
      assert.equal(res.status, 201);
      assert.equal(res.body.isHost, true);
    });

    it('stores a valid destination and returns it', async () => {
      const { token } = await register();
      const res = await post('/api/rooms/create', fort, token);

      assert.equal(res.body.destinationName, fort.destinationName);
      assert.equal(res.body.destinationLat, fort.destinationLat);
      assert.equal(res.body.destinationLng, fort.destinationLng);

      const room = await prisma.room.findUniqueOrThrow({ where: { code: res.body.roomCode } });
      assert.equal(room.destinationName, fort.destinationName);
      assert.equal(room.destinationLat, fort.destinationLat);
      assert.equal(room.destinationLng, fort.destinationLng);
    });

    it('creates a room with no destination when none is given', async () => {
      const { token } = await register();
      const res = await post('/api/rooms/create', { riderName: 'Alex' }, token);
      assert.equal(res.body.destinationName, null);
      assert.equal(res.body.destinationLat, null);
      assert.equal(res.body.destinationLng, null);
    });

    it('still creates the room, without a destination, when the coordinates are unusable', async () => {
      const { token } = await register();
      for (const bad of [
        { destinationLat: 95, destinationLng: 10 },
        { destinationLat: 'north', destinationLng: 'east' },
        { destinationName: 'Nowhere' },
      ]) {
        const res = await post('/api/rooms/create', bad, token);
        assert.equal(res.status, 201);
        assert.equal(res.body.destinationLat, null);
        assert.equal(res.body.destinationName, null, 'a name without coordinates is not kept');
      }
    });

    it('sanitises the destination name it stores', async () => {
      const { token } = await register();
      const long = await post('/api/rooms/create', { ...fort, destinationName: `  ${'x'.repeat(500)}  ` }, token);
      assert.equal(long.body.destinationName.length, 200);

      const odd = await post('/api/rooms/create', { ...fort, destinationName: { nested: 1 } }, token);
      assert.equal(odd.status, 201);
      assert.equal(odd.body.destinationName, null);
      assert.equal(odd.body.destinationLat, fort.destinationLat, 'the valid coordinates are kept');
    });

    it('puts who the host is into the LiveKit token, under an identity based on the account', async () => {
      const { token, user } = await register();
      const res = await post('/api/rooms/create', {}, token);
      const lk = claims(res.body.token);

      assert.deepEqual(JSON.parse(lk.metadata), { userId: user.id, isHost: true });
      assert.match(lk.sub, new RegExp(`^${user.id}_\\d+$`));
    });
  });

  describe('joining a room', () => {
    it('tells the host they are the host and everyone else they are not', async () => {
      const host = await register();
      const guest = await register();
      const created = await post('/api/rooms/create', fort, host.token);

      const asHost = await post('/api/rooms/join', { roomCode: created.body.roomCode }, host.token);
      const asGuest = await post('/api/rooms/join', { roomCode: created.body.roomCode }, guest.token);

      assert.equal(asHost.body.isHost, true);
      assert.equal(asGuest.body.isHost, false);
      assert.deepEqual(JSON.parse(claims(asHost.body.token).metadata), { userId: host.user.id, isHost: true });
      assert.deepEqual(JSON.parse(claims(asGuest.body.token).metadata), { userId: guest.user.id, isHost: false });
    });

    it('hands the guest the ride destination', async () => {
      const host = await register();
      const guest = await register();
      const created = await post('/api/rooms/create', fort, host.token);

      const joined = await post('/api/rooms/join', { roomCode: created.body.roomCode }, guest.token);
      assert.equal(joined.body.destinationName, fort.destinationName);
      assert.equal(joined.body.destinationLat, fort.destinationLat);
      assert.equal(joined.body.destinationLng, fort.destinationLng);
    });

    it('gives one rider a different LiveKit identity on every join, so a rejoin never collides', async () => {
      const host = await register();
      const created = await post('/api/rooms/create', {}, host.token);
      const first = await post('/api/rooms/join', { roomCode: created.body.roomCode }, host.token);
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await post('/api/rooms/join', { roomCode: created.body.roomCode }, host.token);

      assert.notEqual(claims(first.body.token).sub, claims(second.body.token).sub);
    });

    it('does not let two riders with the same display name share an identity', async () => {
      const a = await register({ name: 'Sam' });
      const b = await register({ name: 'Sam' });
      const created = await post('/api/rooms/create', {}, a.token);
      const joined = await post('/api/rooms/join', { roomCode: created.body.roomCode }, b.token);

      assert.notEqual(claims(created.body.token).sub, claims(joined.body.token).sub);
    });
  });

  describe('PATCH /api/rooms/:code/destination', () => {
    it('lets the host change the destination', async () => {
      const host = await register();
      const created = await post('/api/rooms/create', fort, host.token);

      const res = await patch(
        created.body.roomCode,
        { destinationName: 'Charminar', destinationLat: 17.3616, destinationLng: 78.4747 },
        host.token,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { destinationName: 'Charminar', destinationLat: 17.3616, destinationLng: 78.4747 });

      const room = await prisma.room.findUniqueOrThrow({ where: { code: created.body.roomCode } });
      assert.equal(room.destinationName, 'Charminar');
    });

    it('lets the host set a destination on a room created without one', async () => {
      const host = await register();
      const created = await post('/api/rooms/create', {}, host.token);
      const res = await patch(created.body.roomCode, fort, host.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.destinationLat, fort.destinationLat);
    });

    it('refuses anyone but the host, and leaves the destination alone', async () => {
      const host = await register();
      const guest = await register();
      const created = await post('/api/rooms/create', fort, host.token);

      const res = await patch(
        created.body.roomCode,
        { destinationName: 'Hijack', destinationLat: 1, destinationLng: 1 },
        guest.token,
      );
      assert.equal(res.status, 403);
      assert.match(res.body.message, /Only the ride creator/);

      const room = await prisma.room.findUniqueOrThrow({ where: { code: created.body.roomCode } });
      assert.equal(room.destinationName, fort.destinationName);
      assert.equal(room.destinationLat, fort.destinationLat);
    });

    it('requires a signed-in rider', async () => {
      const host = await register();
      const created = await post('/api/rooms/create', fort, host.token);
      assert.equal((await patch(created.body.roomCode, fort)).status, 401);
      assert.equal((await patch(created.body.roomCode, fort, 'not-a-jwt')).status, 401);
    });

    it('answers 404 for a room that does not exist', async () => {
      const { token } = await register();
      assert.equal((await patch('ZZZZZZ', fort, token)).status, 404);
    });

    it('rejects an unusable destination with 400 and changes nothing', async () => {
      const host = await register();
      const created = await post('/api/rooms/create', fort, host.token);

      for (const bad of [
        {},
        { destinationName: 'x' },
        { destinationLat: 91, destinationLng: 0 },
        { destinationLat: 0, destinationLng: 181 },
        { destinationLat: '10', destinationLng: '10' },
      ]) {
        assert.equal((await patch(created.body.roomCode, bad, host.token)).status, 400, JSON.stringify(bad));
      }
      const room = await prisma.room.findUniqueOrThrow({ where: { code: created.body.roomCode } });
      assert.equal(room.destinationLat, fort.destinationLat);
    });

    it('finds the room whatever the case of the code', async () => {
      const host = await register();
      const created = await post('/api/rooms/create', {}, host.token);
      const res = await patch(created.body.roomCode.toLowerCase(), fort, host.token);
      assert.equal(res.status, 200);
    });

    it('sanitises the name, and stores none when it is blank or not text', async () => {
      const host = await register();
      const created = await post('/api/rooms/create', fort, host.token);

      const blank = await patch(created.body.roomCode, { ...fort, destinationName: '   ' }, host.token);
      assert.equal(blank.body.destinationName, null);
      const notText = await patch(created.body.roomCode, { ...fort, destinationName: 42 }, host.token);
      assert.equal(notText.body.destinationName, null);
      const long = await patch(created.body.roomCode, { ...fort, destinationName: 'y'.repeat(999) }, host.token);
      assert.equal(long.body.destinationName.length, 200);
    });
  });
});
