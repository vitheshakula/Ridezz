/// <reference types="node" />
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'crypto';
import {
  createLinkAuthenticator,
  linkAuthLevel,
  linkAuthRoutable,
  linkAuthStatus,
  type LinkAuthDeps,
  type LinkAuthEffect,
  type LinkAuthEvent,
  type LinkAuthLimits,
  type LinkAuthState,
} from '../src/connectivity/linkAuthenticator';
import { encodeBase64Url } from '../src/connectivity/protocol/base64url';
import {
  buildLinkAuthConfirm,
  buildLinkAuthHello,
  buildLinkAuthProof,
  linkAuthBindingDigest,
  linkAuthSigningInput,
  linkAuthTranscript,
  type LinkAuthPayload,
  type LocalChannelBinding,
} from '../src/connectivity/protocol/linkAuth';
import {
  createRideCredentialVerifier,
  deriveRideNodeId,
  rideCredentialSigningInput,
  type RideCredential,
  type RideCredentialVerifier,
  type UnsignedRideCredential,
} from '../src/connectivity/protocol/rideCredential';

// =================================================================================================
// Fixtures
// =================================================================================================

const RIDE = '54321';
const SESSION = 'AAECAwQFBgcICQoLDA0ODw';
const OTHER_SESSION = '__79_Pv6-fj39vX08_Lx8A';
const KID = 'srv-2026-11a';
const T0 = 1_700_000_000_000; // credential issuedAt
const DAY = 24 * 60 * 60 * 1000;
const EXPIRES = T0 + 3 * DAY;
const WALL0 = T0 + 60_000;
const MONO0 = 1_000;

interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: Uint8Array;
}

function newKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(Buffer.from(jwk.x as string, 'base64url'), 1);
  point.set(Buffer.from(jwk.y as string, 'base64url'), 33);
  return { privateKey, publicKey: point };
}

function publicKeyObject(point: Uint8Array): KeyObject {
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(point.subarray(1, 33)).toString('base64url'),
      y: Buffer.from(point.subarray(33, 65)).toString('base64url'),
    },
    format: 'jwk',
  });
}

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

const nodeVerifySignature = (
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean =>
  nodeVerify(
    'sha256',
    message,
    { key: publicKeyObject(publicKey), dsaEncoding: 'ieee-p1363' },
    signature,
  );

const signText = (text: string, privateKey: KeyObject): Uint8Array =>
  new Uint8Array(
    nodeSign('sha256', Buffer.from(text, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }),
  );

const server = newKeyPair();
const untrustedServer = newKeyPair();
const devA = newKeyPair();
const devB = newKeyPair();
const devC = newKeyPair(); // the attacker "E"

const nodeIdOf = (key: KeyPair) => deriveRideNodeId(key.publicKey, sha256);

function credentialFor(
  device: KeyPair,
  overrides: Partial<UnsignedRideCredential> = {},
  signer: KeyPair = server,
): RideCredential {
  const body: UnsignedRideCredential = {
    v: 1,
    kid: KID,
    rideId: RIDE,
    sessionId: SESSION,
    nodeId: nodeIdOf(device),
    pub: encodeBase64Url(device.publicKey),
    issuedAt: T0,
    expiresAt: EXPIRES,
    ...overrides,
  };
  return {
    ...body,
    sig: encodeBase64Url(
      signText(rideCredentialSigningInput(body), signer.privateKey),
    ),
  };
}

function trustedVerifier(
  sessionId = SESSION,
  rideId = RIDE,
): RideCredentialVerifier {
  return createRideCredentialVerifier({
    rideId,
    sessionId,
    keys: new Map([
      [
        KID,
        {
          publicKey: server.publicKey,
          notBefore: T0 - 30 * DAY,
          notAfter: Number.MAX_SAFE_INTEGER,
        },
      ],
    ]),
    verifySignature: nodeVerifySignature,
    sha256,
  });
}

/** Deterministic "CSPRNG": SHA-256 of seed and a counter. */
function seededBytes(seed: string): (length: number) => Uint8Array {
  let counter = 0;
  return length => {
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const block = createHash('sha256')
        .update(`${seed}:${counter++}`)
        .digest();
      const take = Math.min(block.length, length - filled);
      out.set(block.subarray(0, take), filled);
      filled += take;
    }
    return out;
  };
}

const MATERIAL = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const TOKEN_BINDING: LocalChannelBinding = {
  kind: 'nearby-auth-token-v1',
  digest: linkAuthBindingDigest(MATERIAL, sha256),
};
const OTHER_TOKEN_BINDING: LocalChannelBinding = {
  kind: 'nearby-auth-token-v1',
  digest: linkAuthBindingDigest(
    Uint8Array.from({ length: 32 }, () => 9),
    sha256,
  ),
};
const UNBOUND: LocalChannelBinding = { kind: 'unavailable' };

function deepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

const snapshot = (value: unknown): string => JSON.stringify(value);

const EFFECT_RANK: Record<LinkAuthEffect['kind'], number> = {
  deauthenticated: 0,
  failed: 1,
  send: 2,
  sign: 3,
  authenticated: 4,
  rejected: 5,
};

// =================================================================================================
// Harness: rigs, a two-node simulation and a scriptable remote
// =================================================================================================

interface Clock {
  mono: number;
  wall: number;
}
type SignEffect = Extract<LinkAuthEffect, { kind: 'sign' }>;
type SendEffect = Extract<LinkAuthEffect, { kind: 'send' }>;
type SignerMode =
  | 'auto' // answers at once, correctly
  | 'manual' // the test completes requests
  | 'fail' // answers signature_failed
  | 'silent' // never answers
  | 'wrong_key' // signs with another device's key
  | 'der' // DER-encoded signature
  | 'short' // 63 bytes
  | 'long'; // 65 bytes

class Bus {
  private queue: Array<() => void> = [];
  private running = false;
  push(task: () => void): void {
    this.queue.push(task);
  }
  run(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      let guard = 0;
      while (this.queue.length > 0) {
        if (++guard > 100_000) {
          throw new Error('bus did not settle');
        }
        (this.queue.shift() as () => void)();
      }
    } finally {
      this.running = false;
    }
  }
}

interface RigOptions {
  name: string;
  device: KeyPair;
  clock: Clock;
  bus?: Bus;
  seed?: string;
  connectionId?: string;
  policy?: 'required' | 'preferred';
  limits?: Partial<LinkAuthLimits>;
  credential?: RideCredential;
  credentialOverrides?: Partial<UnsignedRideCredential>;
  verifier?: RideCredentialVerifier;
  randomBytes?: (length: number) => Uint8Array;
  signer?: SignerMode;
  binding?: LocalChannelBinding;
  rideId?: string;
  sessionId?: string;
}

class Rig {
  readonly name: string;
  readonly device: KeyPair;
  readonly credential: RideCredential;
  readonly nodeId: string;
  readonly connectionId: string;
  readonly clock: Clock;
  readonly bus: Bus;
  readonly binding: LocalChannelBinding;
  readonly verifySpy: jest.Mock;
  readonly credentialSpy: jest.Mock;
  readonly randomSpy: jest.Mock;
  readonly shaSpy: jest.Mock;
  readonly auth: ReturnType<typeof createLinkAuthenticator>;
  readonly deps: LinkAuthDeps;
  state: LinkAuthState;
  signerMode: SignerMode;
  readonly log: LinkAuthEffect[] = [];
  readonly sent: LinkAuthPayload[] = [];
  readonly pendingSigns: SignEffect[] = [];
  readonly nonces: string[] = [];
  onSend: ((payload: LinkAuthPayload) => void) | null = null;
  /** Called after every reduce with the state before and after (for invariant checks). */
  onStep:
    | ((
        before: LinkAuthState,
        after: LinkAuthState,
        effects: readonly LinkAuthEffect[],
      ) => void)
    | null = null;

  constructor(o: RigOptions) {
    this.name = o.name;
    this.device = o.device;
    this.clock = o.clock;
    this.bus = o.bus ?? new Bus();
    this.connectionId = o.connectionId ?? `conn-${o.name}`;
    this.signerMode = o.signer ?? 'auto';
    this.binding = o.binding ?? TOKEN_BINDING;
    this.credential =
      o.credential ?? credentialFor(o.device, o.credentialOverrides ?? {});
    this.nodeId = this.credential.nodeId;
    const verifier =
      o.verifier ?? trustedVerifier(o.sessionId ?? SESSION, o.rideId ?? RIDE);
    this.credentialSpy = jest.fn((c: unknown, now: number) =>
      verifier.verify(c, now),
    );
    this.verifySpy = jest.fn(nodeVerifySignature);
    this.shaSpy = jest.fn(sha256);
    const random = o.randomBytes ?? seededBytes(o.seed ?? o.name);
    this.randomSpy = jest.fn((length: number) => {
      const bytes = random(length);
      if (bytes instanceof Uint8Array) {
        this.nonces.push(encodeBase64Url(bytes));
      }
      return bytes;
    });
    this.deps = {
      rideId: o.rideId ?? RIDE,
      sessionId: o.sessionId ?? SESSION,
      local: { credential: this.credential, publicKey: o.device.publicKey },
      credentialVerifier: {
        verify: this.credentialSpy,
      } as unknown as RideCredentialVerifier,
      verifySignature: this.verifySpy,
      sha256: this.shaSpy,
      randomBytes: this.randomSpy,
      policy: { channelBinding: o.policy ?? 'preferred' },
      ...(o.limits ? { limits: o.limits } : {}),
    };
    this.auth = createLinkAuthenticator(this.deps);
    this.state = this.auth.initialState(this.connectionId);
  }

  clocks() {
    return { monoNow: this.clock.mono, wallNow: this.clock.wall };
  }

  get status() {
    return linkAuthStatus(this.state);
  }
  get attempt() {
    return this.state.attempt;
  }

  /** Reduces one event, records and routes its effects, then lets the bus settle. */
  apply(
    event: LinkAuthEvent | Record<string, unknown>,
  ): readonly LinkAuthEffect[] {
    const effects = this.applyNow(event);
    this.bus.run();
    return effects;
  }

  private applyNow(
    event: LinkAuthEvent | Record<string, unknown>,
  ): readonly LinkAuthEffect[] {
    const before = this.state;
    const beforeJson = snapshot(before);
    const result = this.auth.reduce(before, event as LinkAuthEvent);
    // The input state must never be mutated (sloppy mode hides frozen writes, so compare).
    expect(snapshot(before)).toBe(beforeJson);
    expect(deepFrozen(result.state)).toBe(true);
    expect(deepFrozen(result.effects)).toBe(true);
    // Effects follow the contract's deterministic order.
    const ranks = result.effects.map(e => EFFECT_RANK[e.kind]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    this.state = result.state;
    this.onStep?.(before, result.state, result.effects);
    for (const effect of result.effects) {
      this.log.push(effect);
      if (effect.kind === 'send') {
        this.sent.push(effect.payload);
        this.onSend?.(effect.payload);
      } else if (effect.kind === 'sign') {
        this.handleSign(effect);
      }
    }
    return result.effects;
  }

  private handleSign(effect: SignEffect): void {
    const mode = this.signerMode;
    if (mode === 'manual') {
      this.pendingSigns.push(effect);
    } else if (mode === 'silent') {
      // never answered
    } else if (mode === 'fail') {
      this.bus.push(() =>
        this.applyNow({
          kind: 'signature_failed',
          connectionId: this.connectionId,
          requestId: effect.requestId,
          ...this.clocks(),
        }),
      );
    } else {
      this.bus.push(() => this.completeSign(effect, mode));
    }
  }

  /** The scripted signer's answer for a request. */
  signatureFor(effect: SignEffect, mode: SignerMode = 'auto'): Uint8Array {
    const key = mode === 'wrong_key' ? devC : this.device;
    if (mode === 'der') {
      return new Uint8Array(
        nodeSign('sha256', Buffer.from(effect.input, 'utf8'), {
          key: key.privateKey,
        }),
      );
    }
    const good = signText(effect.input, key.privateKey);
    if (mode === 'short') {
      return good.subarray(0, 63);
    }
    if (mode === 'long') {
      return Uint8Array.from([...good, 0]);
    }
    return good;
  }

  completeSign(effect: SignEffect, mode: SignerMode = 'auto'): void {
    this.applyNow({
      kind: 'signature_ready',
      connectionId: this.connectionId,
      requestId: effect.requestId,
      signature: this.signatureFor(effect, mode),
      ...this.clocks(),
    });
  }

  /** Completes the oldest pending signing request (manual mode). */
  answer(mode: SignerMode = 'auto', index = 0): SignEffect {
    const effect = this.pendingSigns.splice(index, 1)[0];
    expect(effect).toBeDefined();
    this.completeSign(effect, mode);
    this.bus.run();
    return effect;
  }

  start(binding: LocalChannelBinding = this.binding) {
    return this.apply({
      kind: 'start',
      connectionId: this.connectionId,
      binding,
      ...this.clocks(),
    });
  }
  tick() {
    return this.apply({
      kind: 'tick',
      connectionId: this.connectionId,
      ...this.clocks(),
    });
  }
  restart() {
    return this.apply({
      kind: 'restart',
      connectionId: this.connectionId,
      ...this.clocks(),
    });
  }
  disconnect() {
    return this.apply({
      kind: 'disconnected',
      connectionId: this.connectionId,
    });
  }
  recv(
    payload: unknown,
    envelope: Partial<{
      originId: string;
      hopCount: number;
      rideId: string;
    }> = {},
    connectionId: string = this.connectionId,
  ) {
    let defaultOrigin = 'unknown-origin';
    try {
      defaultOrigin =
        (payload as { credential?: { nodeId?: string } })?.credential?.nodeId ??
        defaultOrigin;
    } catch {
      // a hostile payload object: the harness falls back to an arbitrary origin
    }
    return this.apply({
      kind: 'received',
      connectionId,
      envelope: {
        originId: defaultOrigin,
        hopCount: 0,
        rideId: RIDE,
        ...envelope,
      },
      payload,
      ...this.clocks(),
    });
  }

  effectsOf(kind: LinkAuthEffect['kind']): LinkAuthEffect[] {
    return this.log.filter(e => e.kind === kind);
  }
  count(kind: LinkAuthEffect['kind']): number {
    return this.effectsOf(kind).length;
  }
  sentStages(): string[] {
    return this.sent.map(p => p.stage);
  }
}

/** Two rigs on a shared virtual clock, joined by a controllable channel. */
interface Wire {
  readonly seq: number;
  readonly from: Rig;
  readonly to: Rig;
  readonly payload: LinkAuthPayload;
  readonly stage: string;
  readonly sentAt: number;
}

class Sim {
  readonly clock: Clock = { mono: MONO0, wall: WALL0 };
  readonly bus = new Bus();
  readonly A: Rig;
  readonly B: Rig;
  /** Delays (ms) at which copies of a message are delivered: [] drops, [0, 0] duplicates. */
  channel: (m: Wire) => number[] = () => [0];
  readonly wires: Wire[] = [];
  private inflight: Array<{ at: number; seq: number; wire: Wire }> = [];
  private seq = 0;
  private lastTick = -Infinity;

  constructor(a: Partial<RigOptions> = {}, b: Partial<RigOptions> = {}) {
    this.A = new Rig({
      name: 'A',
      device: devA,
      clock: this.clock,
      bus: this.bus,
      ...a,
    });
    this.B = new Rig({
      name: 'B',
      device: devB,
      clock: this.clock,
      bus: this.bus,
      ...b,
    });
    this.A.onSend = p => this.post(this.A, this.B, p);
    this.B.onSend = p => this.post(this.B, this.A, p);
  }

  private post(from: Rig, to: Rig, payload: LinkAuthPayload): void {
    const wire: Wire = {
      seq: this.seq++,
      from,
      to,
      payload,
      stage: payload.stage,
      sentAt: this.clock.mono,
    };
    this.wires.push(wire);
    for (const delay of this.channel(wire)) {
      this.inflight.push({ at: this.clock.mono + delay, seq: wire.seq, wire });
    }
  }

  /** Delivers every message that is due, in (time, send order). */
  deliverDue(): void {
    for (;;) {
      this.inflight.sort((x, y) => x.at - y.at || x.seq - y.seq);
      const next = this.inflight[0];
      if (!next || next.at > this.clock.mono) {
        return;
      }
      this.inflight.shift();
      // The wire is a JSON boundary: deliver a re-parsed copy.
      const payload = JSON.parse(JSON.stringify(next.wire.payload));
      next.wire.to.recv(payload, { originId: next.wire.from.nodeId });
    }
  }

  step(ms: number, tickEveryMs = 500): void {
    this.clock.mono += ms;
    this.clock.wall += ms;
    this.deliverDue();
    if (this.clock.mono - this.lastTick >= tickEveryMs) {
      this.lastTick = this.clock.mono;
      this.A.tick();
      this.B.tick();
      this.deliverDue();
    }
  }

  advance(totalMs: number, stepMs = 100): void {
    for (let t = 0; t < totalMs; t += stepMs) {
      this.step(stepMs);
    }
  }

  startBoth(): void {
    this.A.start();
    this.B.start();
    this.deliverDue();
  }

  bothMutual(): boolean {
    return this.A.status === 'mutual' && this.B.status === 'mutual';
  }
  get all(): Rig[] {
    return [this.A, this.B];
  }
}

/** A scriptable remote party: honest by default, hostile through overrides. */
class Remote {
  readonly device: KeyPair;
  readonly credential: RideCredential;
  readonly nodeId: string;
  nonce: string;
  binding: LocalChannelBinding;

  constructor(
    device: KeyPair = devB,
    o: {
      nonce?: string;
      binding?: LocalChannelBinding;
      credential?: RideCredential;
    } = {},
  ) {
    this.device = device;
    this.credential = o.credential ?? credentialFor(device);
    this.nodeId = this.credential.nodeId;
    this.nonce =
      o.nonce ??
      encodeBase64Url(
        sha256(Buffer.from(`remote:${this.credential.nodeId}`)).subarray(0, 16),
      );
    this.binding = o.binding ?? TOKEN_BINDING;
  }

  hello(
    over: {
      credential?: RideCredential;
      nonce?: string;
      kind?: 'nearby-auth-token-v1' | 'unavailable';
    } = {},
  ) {
    return buildLinkAuthHello({
      credential: over.credential ?? this.credential,
      nonce: over.nonce ?? this.nonce,
      bindingKind: over.kind ?? this.binding.kind,
    });
  }

  /** The transcript the (honest) local rig computes for this remote. */
  transcript(rig: Rig, binding: LocalChannelBinding = this.binding): string {
    const attempt = rig.state.attempt;
    expect(attempt).not.toBeNull();
    return linkAuthTranscript(
      {
        rideId: RIDE,
        sessionId: SESSION,
        binding,
        local: {
          nodeId: rig.nodeId,
          nonce: (attempt as NonNullable<typeof attempt>).localNonce,
          credential: rig.credential,
        },
        peer: {
          nodeId: this.nodeId,
          nonce: this.nonce,
          credential: this.credential,
        },
      },
      sha256,
    ).hash;
  }

  signature(
    stage: 'proof' | 'confirm',
    rig: Rig,
    transcript: string,
    over: { key?: KeyPair; signer?: string; peer?: string } = {},
  ): string {
    const input = linkAuthSigningInput(stage, {
      signer: over.signer ?? this.nodeId,
      peer: over.peer ?? rig.nodeId,
      transcript,
    });
    return encodeBase64Url(
      signText(input, (over.key ?? this.device).privateKey),
    );
  }

  proof(
    rig: Rig,
    over: {
      transcript?: string;
      sig?: string;
      nonce?: string;
      peerNonce?: string;
      key?: KeyPair;
      signer?: string;
    } = {},
  ) {
    const transcript = over.transcript ?? this.transcript(rig);
    return buildLinkAuthProof({
      nonce: over.nonce ?? this.nonce,
      peerNonce:
        over.peerNonce ??
        (rig.state.attempt as NonNullable<typeof rig.state.attempt>).localNonce,
      transcript,
      sig:
        over.sig ??
        this.signature('proof', rig, transcript, {
          key: over.key,
          signer: over.signer,
        }),
    });
  }

  confirm(
    rig: Rig,
    over: {
      transcript?: string;
      sig?: string;
      nonce?: string;
      peerNonce?: string;
      key?: KeyPair;
      signer?: string;
    } = {},
  ) {
    const transcript = over.transcript ?? this.transcript(rig);
    return buildLinkAuthConfirm({
      nonce: over.nonce ?? this.nonce,
      peerNonce:
        over.peerNonce ??
        (rig.state.attempt as NonNullable<typeof rig.state.attempt>).localNonce,
      transcript,
      sig:
        over.sig ??
        this.signature('confirm', rig, transcript, {
          key: over.key,
          signer: over.signer,
        }),
    });
  }

  /** Message envelope sender for this remote. */
  get origin() {
    return { originId: this.nodeId };
  }
}

const reasonsOf = (
  effects: readonly LinkAuthEffect[],
  kind: 'rejected' | 'failed',
) =>
  effects
    .filter(e => e.kind === kind)
    .map(e => (e as { reason: string }).reason);

/** Runs a handshake to `mutual` on both sides of a fresh Sim. */
function mutualSim(
  a: Partial<RigOptions> = {},
  b: Partial<RigOptions> = {},
): Sim {
  const sim = new Sim(a, b);
  sim.startBoth();
  sim.advance(2_000);
  expect(sim.bothMutual()).toBe(true);
  return sim;
}

// =================================================================================================
// Configuration
// =================================================================================================

describe('createLinkAuthenticator configuration', () => {
  const clock = { mono: MONO0, wall: WALL0 };
  const validDeps = (): LinkAuthDeps =>
    new Rig({ name: 'A', device: devA, clock }).deps;

  it('accepts valid dependencies and returns a frozen API', () => {
    const auth = createLinkAuthenticator(validDeps());
    expect(Object.isFrozen(auth)).toBe(true);
    expect(typeof auth.reduce).toBe('function');
    expect(typeof auth.initialState).toBe('function');
  });

  it('builds an idle, frozen, serialisable initial state', () => {
    const state = createLinkAuthenticator(validDeps()).initialState('conn-1');
    expect(state).toEqual({
      connectionId: 'conn-1',
      phase: 'idle',
      binding: null,
      lastMonoNow: 0,
      attemptCount: 0,
      attempt: null,
      restartTimes: [],
      recentPeerNonces: [],
      failure: null,
      authenticated: null,
    });
    expect(deepFrozen(state)).toBe(true);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(linkAuthStatus(state)).toBe('idle');
    expect(linkAuthLevel(state)).toBe('none');
  });

  it.each([
    ['empty', ''],
    ['containing #', 'a#b'],
    ['too long', 'x'.repeat(129)],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
  ])('initialState rejects a connection id that is %s', (_label, id) => {
    expect(() =>
      createLinkAuthenticator(validDeps()).initialState(id as never),
    ).toThrow(TypeError);
  });

  describe('rejects invalid dependencies with a TypeError', () => {
    const cases: [string, (d: LinkAuthDeps) => unknown][] = [
      ['a non-object', () => null],
      ['a ride id that is not a room code', d => ({ ...d, rideId: 'RIDE1' })],
      [
        'a UUID as the ride id',
        d => ({ ...d, rideId: '3f2b8c1e-9d4a-4b6f-8e21-5a7c9d0e1f23' }),
      ],
      [
        'a non-canonical session id',
        d => ({ ...d, sessionId: 'AAECAwQFBgcICQoLDA0ODx' }),
      ],
      ['a room code as the session id', d => ({ ...d, sessionId: RIDE })],
      [
        'a local credential for another ride',
        d => ({
          ...d,
          local: {
            ...d.local,
            credential: credentialFor(devA, { rideId: '99999' }),
          },
        }),
      ],
      [
        'a local credential for another session',
        d => ({
          ...d,
          local: {
            ...d.local,
            credential: credentialFor(devA, { sessionId: OTHER_SESSION }),
          },
        }),
      ],
      [
        'a local credential that is malformed',
        d => ({
          ...d,
          local: {
            ...d.local,
            credential: { ...d.local.credential, sig: 'x' },
          },
        }),
      ],
      [
        'a local public key that is not the credential key',
        d => ({ ...d, local: { ...d.local, publicKey: devB.publicKey } }),
      ],
      [
        'a local credential whose node id is not the key hash',
        d => ({
          ...d,
          local: {
            ...d.local,
            credential: credentialFor(devA, { nodeId: 'A'.repeat(43) }),
          },
        }),
      ],
      [
        'a 64-byte local public key',
        d => ({
          ...d,
          local: { ...d.local, publicKey: devA.publicKey.subarray(0, 64) },
        }),
      ],
      ['a missing local object', d => ({ ...d, local: undefined })],
      [
        'a missing credential verifier',
        d => ({ ...d, credentialVerifier: undefined }),
      ],
      [
        'a credential verifier without verify',
        d => ({ ...d, credentialVerifier: {} }),
      ],
      [
        'a missing verifySignature',
        d => ({ ...d, verifySignature: undefined }),
      ],
      ['a missing sha256', d => ({ ...d, sha256: 'sha' })],
      ['a missing randomBytes', d => ({ ...d, randomBytes: undefined })],
      [
        'an unknown policy',
        d => ({ ...d, policy: { channelBinding: 'maybe' } }),
      ],
      ['a missing policy', d => ({ ...d, policy: undefined })],
      ['limits that are not an object', d => ({ ...d, limits: 5 })],
      ['an unknown limit', d => ({ ...d, limits: { nope: 1 } })],
      ['a fractional limit', d => ({ ...d, limits: { maxHelloSends: 2.5 } })],
      ['a zero limit', d => ({ ...d, limits: { maxHelloSends: 0 } })],
      [
        'a limit above its bound',
        d => ({ ...d, limits: { maxRestartsPerWindow: 17 } }),
      ],
      [
        'a retransmit interval below its bound',
        d => ({ ...d, limits: { retransmitIntervalMs: 10 } }),
      ],
    ];
    it.each(cases)('%s', (_label, mutate) => {
      expect(() =>
        createLinkAuthenticator(mutate(validDeps()) as LinkAuthDeps),
      ).toThrow(TypeError);
    });
  });

  it('accepts partial limits and keeps the defaults for the rest', () => {
    const rig = new Rig({
      name: 'A',
      device: devA,
      clock,
      limits: { maxHelloSends: 2 },
    });
    expect(rig.auth).toBeDefined();
  });

  it('copies the local public key: later changes to the caller buffer do not matter', () => {
    const key = Uint8Array.from(devA.publicKey);
    const sim = new Sim({
      device: { privateKey: devA.privateKey, publicKey: key },
    });
    key.fill(0);
    sim.startBoth();
    sim.advance(1_000);
    expect(sim.bothMutual()).toBe(true);
  });
});

// =================================================================================================
// Happy path (contract section F, item 1)
// =================================================================================================

describe('happy path', () => {
  it('A starts first', () => {
    const sim = new Sim();
    sim.A.start();
    sim.advance(1_500);
    expect(sim.A.status).toBe('awaiting_peer_hello');
    sim.B.start();
    sim.deliverDue();
    sim.advance(1_000);
    expect(sim.bothMutual()).toBe(true);
  });

  it('B starts first', () => {
    const sim = new Sim();
    sim.B.start();
    sim.advance(1_500);
    sim.A.start();
    sim.deliverDue();
    sim.advance(1_000);
    expect(sim.bothMutual()).toBe(true);
  });

  it('both start in the same step', () => {
    const sim = mutualSim();
    expect(sim.A.status).toBe('mutual');
  });

  it('each side emits exactly one authenticated effect naming the other node', () => {
    const sim = mutualSim();
    for (const [me, other] of [
      [sim.A, sim.B],
      [sim.B, sim.A],
    ] as const) {
      const effects = me.effectsOf('authenticated');
      expect(effects).toHaveLength(1);
      expect(effects[0]).toEqual({
        kind: 'authenticated',
        nodeId: other.nodeId,
        credential: other.credential,
        bound: true,
        expiresAt: Math.min(
          me.credential.expiresAt,
          other.credential.expiresAt,
        ),
        attemptId: 1,
      });
    }
  });

  it('both sides computed the identical transcript, equal to an independent computation', () => {
    const sim = mutualSim();
    const expected = linkAuthTranscript(
      {
        rideId: RIDE,
        sessionId: SESSION,
        binding: TOKEN_BINDING,
        local: {
          nodeId: sim.A.nodeId,
          nonce: sim.A.attempt!.localNonce,
          credential: sim.A.credential,
        },
        peer: {
          nodeId: sim.B.nodeId,
          nonce: sim.B.attempt!.localNonce,
          credential: sim.B.credential,
        },
      },
      sha256,
    ).hash;
    expect(sim.A.attempt!.transcript).toBe(expected);
    expect(sim.B.attempt!.transcript).toBe(expected);
  });

  it('records all four evidence flags and the verified peer', () => {
    const sim = mutualSim();
    for (const [me, other] of [
      [sim.A, sim.B],
      [sim.B, sim.A],
    ] as const) {
      const a = me.attempt!;
      expect(a.localProof.state).toBe('sent');
      expect(a.localConfirm.state).toBe('sent');
      expect(a.peerProof).toBe('verified');
      expect(a.peerConfirm).toBe('verified');
      expect(a.peer).toMatchObject({
        nodeId: other.nodeId,
        nonce: other.attempt!.localNonce,
        expiresAt: other.credential.expiresAt,
      });
      expect(me.state.authenticated).toEqual({
        nodeId: other.nodeId,
        expiresAt: Math.min(
          me.credential.expiresAt,
          other.credential.expiresAt,
        ),
        bound: true,
        attemptId: 1,
      });
      expect(me.state.failure).toBeNull();
    }
  });

  it('walks the status ladder in order, with the matching authentication levels', () => {
    const sim = new Sim();
    const seen: string[] = [];
    const levels: string[] = [];
    sim.A.onStep = (_b, after) => {
      const status = linkAuthStatus(after);
      if (seen[seen.length - 1] !== status) {
        seen.push(status);
        levels.push(linkAuthLevel(after));
      }
    };
    sim.startBoth();
    sim.advance(1_000);
    expect(seen).toEqual([
      'awaiting_peer_hello',
      'identified',
      'peer_proven',
      'mutual',
    ]);
    expect(levels).toEqual(['none', 'identified', 'peer_proven', 'mutual']);
  });

  it('requests exactly two signatures per side, proof first, with exact signing inputs', () => {
    const sim = mutualSim();
    for (const [me, other] of [
      [sim.A, sim.B],
      [sim.B, sim.A],
    ] as const) {
      const signs = me.effectsOf('sign') as SignEffect[];
      expect(signs.map(s => s.stage)).toEqual(['proof', 'confirm']);
      expect(signs.map(s => s.requestId)).toEqual([
        `${me.connectionId}#1#proof`,
        `${me.connectionId}#1#confirm`,
      ]);
      const transcript = me.attempt!.transcript as string;
      for (const s of signs) {
        expect(s.input).toBe(
          linkAuthSigningInput(s.stage, {
            signer: me.nodeId,
            peer: other.nodeId,
            transcript,
          }),
        );
      }
      expect(
        signs[0].input.startsWith('{"domain":"rideaze.link-auth.v1.proof"'),
      ).toBe(true);
      expect(
        signs[1].input.startsWith('{"domain":"rideaze.link-auth.v1.confirm"'),
      ).toBe(true);
    }
  });

  it('sends HELLO, PROOF and CONFIRM in that order', () => {
    const sim = mutualSim();
    expect(sim.A.sentStages()).toEqual(['hello', 'proof', 'confirm']);
    expect(sim.B.sentStages()).toEqual(['hello', 'proof', 'confirm']);
  });

  it('never puts the binding digest on the wire', () => {
    const sim = mutualSim();
    for (const wire of sim.wires) {
      expect(JSON.stringify(wire.payload)).not.toContain(
        TOKEN_BINDING.digest as string,
      );
    }
    const hello = sim.A.sent[0] as { binding: unknown };
    expect(hello.binding).toEqual({ kind: 'nearby-auth-token-v1' });
  });

  it('uses the expected amount of cryptography per side', () => {
    const sim = mutualSim();
    for (const rig of sim.all) {
      // two self-verifications and two peer verifications
      expect(rig.verifySpy).toHaveBeenCalledTimes(4);
      // the local credential at start and the peer credential from HELLO
      expect(rig.credentialSpy).toHaveBeenCalledTimes(2);
      expect(rig.randomSpy).toHaveBeenCalledTimes(1);
      expect(rig.randomSpy).toHaveBeenCalledWith(16);
    }
  });

  it('produces frozen, serialisable states', () => {
    const sim = mutualSim();
    for (const rig of sim.all) {
      expect(deepFrozen(rig.state)).toBe(true);
      expect(JSON.parse(JSON.stringify(rig.state))).toEqual(rig.state);
    }
  });

  it('uses independent nonces on each side and across attempts', () => {
    const sim = mutualSim();
    expect(sim.A.attempt!.localNonce).not.toBe(sim.B.attempt!.localNonce);
    sim.A.restart();
    sim.advance(1_000);
    expect(sim.bothMutual()).toBe(true);
    expect(new Set([...sim.A.nonces, ...sim.B.nonces]).size).toBe(4);
  });
});

// =================================================================================================
// Routing helper
// =================================================================================================

describe('linkAuthRoutable', () => {
  const required = { channelBinding: 'required' } as const;
  const preferred = { channelBinding: 'preferred' } as const;

  it('is true only for a mutual link with unexpired credentials', () => {
    const sim = mutualSim();
    const { state, clock } = { state: sim.A.state, clock: sim.clock };
    expect(linkAuthRoutable(state, clock.wall, required)).toBe(true);
    expect(linkAuthRoutable(state, clock.wall, preferred)).toBe(true);
    const expiresAt = state.authenticated!.expiresAt;
    expect(linkAuthRoutable(state, expiresAt - 1, required)).toBe(true);
    expect(linkAuthRoutable(state, expiresAt, required)).toBe(false);
    expect(linkAuthRoutable(state, expiresAt + 1, preferred)).toBe(false);
  });

  it('is false in every other status', () => {
    const sim = new Sim();
    expect(linkAuthRoutable(sim.A.state, WALL0, preferred)).toBe(false); // idle
    sim.A.start();
    expect(sim.A.status).toBe('awaiting_peer_hello');
    expect(linkAuthRoutable(sim.A.state, WALL0, preferred)).toBe(false);
    sim.advance(25_000);
    expect(sim.A.status).toBe('failed');
    expect(linkAuthRoutable(sim.A.state, WALL0, preferred)).toBe(false);
    sim.A.disconnect();
    expect(sim.A.status).toBe('closed');
    expect(linkAuthRoutable(sim.A.state, WALL0, preferred)).toBe(false);
  });

  it('is false at the identified and peer_proven levels', () => {
    const rig = new Rig({
      name: 'A',
      device: devA,
      clock: { mono: MONO0, wall: WALL0 },
      signer: 'manual',
    });
    const remote = new Remote(devB);
    rig.start();
    rig.recv(remote.hello());
    expect(rig.status).toBe('identified');
    expect(linkAuthRoutable(rig.state, WALL0, preferred)).toBe(false);
    rig.recv(remote.proof(rig), remote.origin);
    expect(rig.status).toBe('peer_proven');
    expect(linkAuthRoutable(rig.state, WALL0, preferred)).toBe(false);
  });

  it('under the required policy needs a bound link', () => {
    const unbound = mutualSim({ binding: UNBOUND }, { binding: UNBOUND });
    expect(unbound.A.state.authenticated!.bound).toBe(false);
    expect(
      linkAuthRoutable(unbound.A.state, unbound.clock.wall, required),
    ).toBe(false);
    expect(
      linkAuthRoutable(unbound.A.state, unbound.clock.wall, preferred),
    ).toBe(true);
  });

  it('fails closed on garbage', () => {
    const bad: unknown[] = [
      null,
      undefined,
      5,
      'state',
      {},
      { phase: 'active' },
      { phase: 'active', authenticated: {} },
    ];
    for (const state of bad) {
      expect(() =>
        linkAuthRoutable(state as never, WALL0, preferred),
      ).not.toThrow();
      expect(linkAuthRoutable(state as never, WALL0, preferred)).toBe(false);
      expect(() => linkAuthStatus(state as never)).not.toThrow();
      expect(() => linkAuthLevel(state as never)).not.toThrow();
    }
    const sim = mutualSim();
    for (const wall of [Number.NaN, -1, 1.5, '5', null, undefined, Infinity]) {
      expect(linkAuthRoutable(sim.A.state, wall as never, preferred)).toBe(
        false,
      );
    }
    for (const policy of [
      null,
      undefined,
      {},
      { channelBinding: 'whatever' },
      'required',
    ]) {
      expect(
        linkAuthRoutable(sim.A.state, sim.clock.wall, policy as never),
      ).toBe(false);
    }
  });
});

// =================================================================================================
// Single-node scenarios
// =================================================================================================

function solo(
  o: Partial<RigOptions> = {},
  remoteOptions: { nonce?: string; credential?: RideCredential } = {},
) {
  const clock = { mono: MONO0, wall: WALL0 };
  const rig = new Rig({
    name: 'A',
    device: devA,
    clock,
    signer: 'manual',
    ...o,
  });
  const remote = new Remote(devB, { binding: rig.binding, ...remoteOptions });
  const advance = (ms: number) => {
    clock.mono += ms;
    clock.wall += ms;
  };
  return { rig, remote, clock, advance };
}

/** A rejection changes nothing: the very same state object comes back. */
function expectRejected(
  rig: Rig,
  run: () => readonly LinkAuthEffect[],
  reason: string,
) {
  const before = rig.state;
  const effects = run();
  expect(reasonsOf(effects, 'rejected')).toEqual([reason]);
  expect(effects.every(e => e.kind === 'rejected')).toBe(true);
  expect(rig.state).toBe(before);
}

function expectFailed(
  rig: Rig,
  effects: readonly LinkAuthEffect[],
  reason: string,
) {
  expect(reasonsOf(effects, 'failed')).toEqual([reason]);
  expect(rig.status).toBe('failed');
  expect(rig.state.failure).toBe(reason);
  expect(rig.state.authenticated).toBeNull();
  expect(effects.some(e => e.kind === 'authenticated')).toBe(false);
  expect(rig.count('authenticated')).toBe(0);
  expect(
    linkAuthRoutable(rig.state, rig.clock.wall, {
      channelBinding: 'preferred',
    }),
  ).toBe(false);
}

// =================================================================================================
// Message ordering (section F, item 2)
// =================================================================================================

describe('message ordering', () => {
  it('rule 10: a PROOF that arrives before the HELLO is buffered, then verified', () => {
    const { rig, remote } = solo({ signer: 'auto' });
    rig.start();
    const effects = rig.recv(remote.proof(rig), remote.origin);
    expect(effects).toEqual([]);
    expect(rig.attempt!.earlyProof).not.toBeNull();
    expect(rig.attempt!.earlyProofOriginId).toBe(remote.nodeId);
    expect(rig.status).toBe('awaiting_peer_hello');

    rig.recv(remote.hello());
    expect(rig.status).toBe('peer_proven');
    expect(rig.attempt!.earlyProof).toBeNull();
    expect(rig.attempt!.peerProof).toBe('verified');

    rig.recv(remote.confirm(rig), remote.origin);
    expect(rig.status).toBe('mutual');
    expect(rig.count('authenticated')).toBe(1);
  });

  it('rule 16a: a CONFIRM that arrives before the PROOF is buffered and completed later', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    expect(rig.pendingSigns).toHaveLength(1);
    rig.recv(remote.confirm(rig), remote.origin);
    expect(rig.attempt!.earlyConfirm).not.toBeNull();
    expect(rig.attempt!.peerConfirm).toBe('none');
    rig.recv(remote.proof(rig), remote.origin);
    expect(rig.attempt!.peerProof).toBe('verified');
    // our own PROOF is still being signed: the buffered CONFIRM is not accepted yet
    expect(rig.attempt!.peerConfirm).toBe('none');
    expect(rig.attempt!.earlyConfirm).not.toBeNull();
    expect(rig.status).toBe('peer_proven');

    rig.answer(); // our PROOF is signed and sent: the buffered CONFIRM is now processed
    expect(rig.attempt!.localProof.state).toBe('sent');
    expect(rig.attempt!.peerConfirm).toBe('verified');
    expect(rig.attempt!.earlyConfirm).toBeNull();
    expect(rig.status).toBe('peer_proven'); // still needs our own CONFIRM
    expect(rig.count('authenticated')).toBe(0);

    rig.answer();
    expect(rig.status).toBe('mutual');
    expect(rig.count('authenticated')).toBe(1);
  });

  it('a CONFIRM is never accepted before our own PROOF was sent', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    rig.recv(remote.proof(rig), remote.origin);
    rig.recv(remote.confirm(rig), remote.origin);
    expect(rig.attempt!.localProof.state).toBe('signing');
    expect(rig.attempt!.peerConfirm).toBe('none');
    expect(rig.status).not.toBe('mutual');
    expect(rig.state.authenticated).toBeNull();
  });

  it('our own CONFIRM signature may complete after the peer CONFIRM arrived', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    rig.answer(); // PROOF sent
    rig.recv(remote.proof(rig), remote.origin); // peer PROOF verified -> sign(confirm)
    expect(rig.pendingSigns).toHaveLength(1);
    expect(rig.pendingSigns[0].stage).toBe('confirm');
    rig.recv(remote.confirm(rig), remote.origin);
    expect(rig.attempt!.peerConfirm).toBe('verified');
    expect(rig.status).toBe('peer_proven');
    expect(rig.count('authenticated')).toBe(0);
    rig.answer();
    expect(rig.status).toBe('mutual');
    expect(rig.count('authenticated')).toBe(1);
  });

  it('keeps at most one early PROOF and one early CONFIRM, however many arrive', () => {
    const { rig, remote } = solo();
    rig.start();
    const before = snapshot(rig.state).length;
    for (let i = 0; i < 60; i++) {
      remote.nonce = encodeBase64Url(
        sha256(Buffer.from(`n${i}`)).subarray(0, 16),
      );
      rig.recv(remote.proof(rig), remote.origin);
      rig.recv(remote.confirm(rig), remote.origin);
    }
    expect(rig.attempt!.earlyProof).not.toBeNull();
    expect(rig.attempt!.earlyConfirm).not.toBeNull();
    expect(snapshot(rig.state).length).toBeLessThan(before + 1_500);
  });

  it('applies the sender check to a buffered PROOF when it is finally processed', () => {
    const { rig, remote } = solo({ signer: 'auto' });
    rig.start();
    rig.recv(remote.proof(rig), { originId: 'X'.repeat(43) });
    expect(rig.attempt!.earlyProofOriginId).toBe('X'.repeat(43));
    const effects = rig.recv(remote.hello());
    expect(reasonsOf(effects, 'rejected')).toEqual(['sender_mismatch']);
    expect(rig.attempt!.peerProof).toBe('none');
    expect(rig.attempt!.earlyProof).toBeNull();
    rig.recv(remote.proof(rig), remote.origin);
    expect(rig.attempt!.peerProof).toBe('verified');
  });

  it('applies the sender check to a buffered CONFIRM when it is finally processed', () => {
    const { rig, remote } = solo({ signer: 'auto' });
    rig.start();
    rig.recv(remote.confirm(rig), { originId: 'X'.repeat(43) }); // buffered: no peer yet
    expect(rig.attempt!.earlyConfirmOriginId).toBe('X'.repeat(43));
    rig.recv(remote.hello());
    expect(rig.attempt!.earlyConfirm).not.toBeNull();
    const effects = rig.recv(remote.proof(rig), remote.origin);
    expect(reasonsOf(effects, 'rejected')).toEqual(['sender_mismatch']);
    expect(rig.attempt!.earlyConfirm).toBeNull();
    expect(rig.attempt!.peerConfirm).toBe('none');
    expect(rig.attempt!.peerProof).toBe('verified');
    // the genuine CONFIRM still completes the handshake
    rig.recv(remote.confirm(rig), remote.origin);
    expect(rig.status).toBe('mutual');
  });

  it('drops a buffered CONFIRM that turns out not to come from the peer that said HELLO', () => {
    const { rig, remote } = solo({ signer: 'auto' });
    rig.start();
    const stranger = encodeBase64Url(
      sha256(Buffer.from('stranger')).subarray(0, 16),
    );
    rig.recv(remote.confirm(rig, { nonce: stranger }), remote.origin);
    rig.recv(remote.hello());
    const effects = rig.recv(remote.proof(rig), remote.origin);
    expect(reasonsOf(effects, 'rejected')).toEqual(['stale']);
    expect(rig.attempt!.earlyConfirm).toBeNull();
    expect(rig.attempt!.peerConfirm).toBe('none');
  });

  it('drops a buffered message that turns out not to be from the peer that said HELLO', () => {
    const { rig, remote } = solo({ signer: 'auto' });
    rig.start();
    rig.recv(
      remote.proof(rig, {
        nonce: encodeBase64Url(sha256(Buffer.from('other')).subarray(0, 16)),
      }),
      remote.origin,
    );
    const effects = rig.recv(remote.hello());
    expect(reasonsOf(effects, 'rejected')).toEqual(['stale']);
    expect(rig.attempt!.peerProof).toBe('none');
  });

  it('rule 11: a PROOF or CONFIRM not addressed to our nonce is stale at once and never buffered', () => {
    const { rig, remote } = solo();
    rig.start();
    const foreign = encodeBase64Url(
      sha256(Buffer.from('not-ours')).subarray(0, 16),
    );
    expectRejected(
      rig,
      () => rig.recv(remote.proof(rig, { peerNonce: foreign }), remote.origin),
      'stale',
    );
    expectRejected(
      rig,
      () =>
        rig.recv(remote.confirm(rig, { peerNonce: foreign }), remote.origin),
      'stale',
    );
    rig.recv(remote.hello());
    expectRejected(
      rig,
      () => rig.recv(remote.proof(rig, { peerNonce: foreign }), remote.origin),
      'stale',
    );
    expectRejected(
      rig,
      () =>
        rig.recv(remote.confirm(rig, { peerNonce: foreign }), remote.origin),
      'stale',
    );
  });

  it('rule 11: addressed to us but from another peer nonce is stale', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    const other = encodeBase64Url(
      sha256(Buffer.from('other-peer-nonce')).subarray(0, 16),
    );
    expectRejected(
      rig,
      () => rig.recv(remote.proof(rig, { nonce: other }), remote.origin),
      'stale',
    );
    expectRejected(
      rig,
      () => rig.recv(remote.confirm(rig, { nonce: other }), remote.origin),
      'stale',
    );
  });

  it('a failed attempt never asks for signatures (a bad early PROOF fails the HELLO)', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.proof(rig, { key: devC }), remote.origin); // buffered, signed by the wrong key
    const effects = rig.recv(remote.hello());
    expectFailed(rig, effects, 'bad_proof');
    expect(effects.map(e => e.kind)).toEqual(['failed']);
    expect(rig.pendingSigns).toHaveLength(0); // the sign effect is removed when the attempt fails
    expect(rig.state.attempt!.localProof.state).toBe('none');
  });
});

// =================================================================================================
// Asynchronous signing (section F, item 9)
// =================================================================================================

describe('asynchronous signing', () => {
  function toSign() {
    const ctx = solo();
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    return ctx;
  }

  it('correlates the request with connection, attempt and stage', () => {
    const { rig, remote } = toSign();
    expect(rig.pendingSigns).toHaveLength(1);
    const [request] = rig.pendingSigns;
    expect(request.requestId).toBe('conn-A#1#proof');
    expect(request.stage).toBe('proof');
    expect(request.input).toBe(
      linkAuthSigningInput('proof', {
        signer: rig.nodeId,
        peer: remote.nodeId,
        transcript: remote.transcript(rig),
      }),
    );
    expect(
      request.input.startsWith('{"domain":"rideaze.link-auth.v1.proof"'),
    ).toBe(true);
    expect(rig.attempt!.localProof).toEqual({
      state: 'signing',
      requestId: 'conn-A#1#proof',
      requestedAt: rig.clock.mono,
    });
  });

  it('requests the CONFIRM signature only after our PROOF was sent and the peer PROOF verified', () => {
    const { rig, remote } = toSign();
    rig.recv(remote.proof(rig), remote.origin);
    expect(rig.pendingSigns).toHaveLength(1); // still only the PROOF: nothing else is asked yet
    rig.answer();
    expect(rig.pendingSigns).toHaveLength(1);
    expect(rig.pendingSigns[0].stage).toBe('confirm');
    expect(rig.pendingSigns[0].requestId).toBe('conn-A#1#confirm');
    expect(
      rig.pendingSigns[0].input.startsWith(
        '{"domain":"rideaze.link-auth.v1.confirm"',
      ),
    ).toBe(true);
  });

  it('never has more than one request outstanding', () => {
    const { rig, remote } = toSign();
    const outstanding = () =>
      [rig.attempt!.localProof, rig.attempt!.localConfirm].filter(
        s => s.state === 'signing',
      ).length;
    expect(outstanding()).toBe(1);
    rig.recv(remote.proof(rig), remote.origin);
    expect(outstanding()).toBe(1);
    rig.answer();
    expect(outstanding()).toBe(1);
    rig.answer();
    expect(outstanding()).toBe(0);
  });

  it('transmits nothing until the signature has been self-verified', () => {
    const { rig } = toSign();
    expect(rig.sentStages()).toEqual(['hello']);
    rig.answer();
    expect(rig.sentStages()).toEqual(['hello', 'proof']);
  });

  it('stores a canonical signature and sends exactly that signature', () => {
    const { rig } = toSign();
    rig.answer();
    const sent = rig.attempt!.localProof as { state: 'sent'; sig: string };
    expect(sent.sig).toHaveLength(86);
    expect((rig.sent[1] as { sig: string }).sig).toBe(sent.sig);
  });

  describe('rule 14/15: an invalid signature never leaves the node', () => {
    it.each(['wrong_key', 'der', 'short', 'long'] as const)(
      'a %s answer for the PROOF',
      mode => {
        const { rig } = toSign();
        const calls = rig.verifySpy.mock.calls.length;
        rig.answer(mode);
        expect(rig.verifySpy.mock.calls.length).toBeLessThanOrEqual(calls + 1);
        expectFailed(rig, rig.log.slice(-1), 'signer_invalid_signature');
        expect(rig.sentStages()).toEqual(['hello']);
      },
    );

    it.each(['wrong_key', 'der', 'short', 'long'] as const)(
      'a %s answer for the CONFIRM',
      mode => {
        const { rig, remote } = toSign();
        rig.answer();
        rig.recv(remote.proof(rig), remote.origin);
        rig.answer(mode);
        expectFailed(rig, rig.log.slice(-1), 'signer_invalid_signature');
        expect(rig.sentStages()).toEqual(['hello', 'proof']);
        expect(rig.count('authenticated')).toBe(0);
      },
    );

    it.each([
      ['a string', 'abc'],
      ['an ordinary array', Array.from({ length: 64 }, () => 1)],
      ['undefined', undefined],
      ['null', null],
      ['a Uint16Array', new Uint16Array(32)],
      ['a number', 64],
    ])('%s instead of bytes', (_label, signature) => {
      const { rig, remote } = toSign();
      const effects = rig.apply({
        kind: 'signature_ready',
        connectionId: rig.connectionId,
        requestId: rig.pendingSigns[0].requestId,
        signature,
        ...rig.clocks(),
      });
      expectFailed(rig, effects, 'signer_invalid_signature');
      expect(remote).toBeDefined();
    });

    it('a verification callback that throws', () => {
      const { rig } = toSign();
      rig.verifySpy.mockImplementation(() => {
        throw new Error('native verifier crashed');
      });
      rig.answer();
      expectFailed(rig, rig.log.slice(-1), 'signer_invalid_signature');
    });

    it('a verification callback that returns a Promise', () => {
      const { rig } = toSign();
      rig.verifySpy.mockImplementation((async () => true) as never);
      rig.answer();
      expectFailed(rig, rig.log.slice(-1), 'signer_invalid_signature');
    });

    it('a verification callback that returns a truthy non-true value', () => {
      const { rig } = toSign();
      rig.verifySpy.mockImplementation((() => 'yes') as never);
      rig.answer();
      expectFailed(rig, rig.log.slice(-1), 'signer_invalid_signature');
    });
  });

  it('rule 18: a stale request id after a restart is ignored', () => {
    const { rig } = toSign();
    const old = rig.pendingSigns[0];
    rig.restart();
    expect(rig.state.attempt!.id).toBe(2);
    const verifies = rig.verifySpy.mock.calls.length;
    const before = rig.state;
    const effects = rig.apply({
      kind: 'signature_ready',
      connectionId: rig.connectionId,
      requestId: old.requestId,
      signature: rig.signatureFor(old),
      ...rig.clocks(),
    });
    expect(reasonsOf(effects, 'rejected')).toEqual([
      'unknown_signature_request',
    ]);
    expect(rig.state).toBe(before);
    expect(rig.verifySpy.mock.calls.length).toBe(verifies);
  });

  it('rule 18: a duplicate completion is ignored', () => {
    const { rig } = toSign();
    const request = rig.pendingSigns[0];
    rig.answer();
    const sent = rig.sent.length;
    const before = rig.state;
    const effects = rig.apply({
      kind: 'signature_ready',
      connectionId: rig.connectionId,
      requestId: request.requestId,
      signature: rig.signatureFor(request),
      ...rig.clocks(),
    });
    expect(reasonsOf(effects, 'rejected')).toEqual([
      'unknown_signature_request',
    ]);
    expect(rig.state).toBe(before);
    expect(rig.sent).toHaveLength(sent);
  });

  it('rule 18: an unknown request id, and a request id for the other stage, are ignored', () => {
    const { rig } = toSign();
    const request = rig.pendingSigns[0];
    for (const requestId of [
      'nope',
      'conn-A#1#confirm',
      'conn-A#2#proof',
      'conn-B#1#proof',
      '',
    ]) {
      expectRejected(
        rig,
        () =>
          rig.apply({
            kind: 'signature_ready',
            connectionId: rig.connectionId,
            requestId,
            signature: rig.signatureFor(request),
            ...rig.clocks(),
          }),
        'unknown_signature_request',
      );
    }
    expect(rig.attempt!.localProof.state).toBe('signing');
  });

  it('a completion for another connection is rejected as stale', () => {
    const { rig } = toSign();
    const request = rig.pendingSigns[0];
    expectRejected(
      rig,
      () =>
        rig.apply({
          kind: 'signature_ready',
          connectionId: 'conn-other',
          requestId: request.requestId,
          signature: rig.signatureFor(request),
          ...rig.clocks(),
        }),
      'stale_connection',
    );
  });

  it('a completion with a non-string request id is malformed', () => {
    const { rig } = toSign();
    for (const requestId of [undefined, null, 5, {}, ['conn-A#1#proof']]) {
      expectRejected(
        rig,
        () =>
          rig.apply({
            kind: 'signature_ready',
            connectionId: rig.connectionId,
            requestId,
            signature: new Uint8Array(64),
            ...rig.clocks(),
          }),
        'malformed',
      );
    }
  });

  it('rule 19: a signing failure for the matching request fails the attempt', () => {
    const { rig } = toSign();
    const effects = rig.apply({
      kind: 'signature_failed',
      connectionId: rig.connectionId,
      requestId: rig.pendingSigns[0].requestId,
      ...rig.clocks(),
    });
    expectFailed(rig, effects, 'signer_unavailable');
    expect(rig.attempt!.localProof.state).toBe('none');
  });

  it('rule 18: a signing failure for an unknown request is ignored', () => {
    const { rig } = toSign();
    expectRejected(
      rig,
      () =>
        rig.apply({
          kind: 'signature_failed',
          connectionId: rig.connectionId,
          requestId: 'conn-A#9#proof',
          ...rig.clocks(),
        }),
      'unknown_signature_request',
    );
  });

  it('a completion that arrives after a failure is ignored', () => {
    const { rig } = toSign();
    const request = rig.pendingSigns[0];
    rig.tick(); // nothing due
    rig.clock.mono += 25_000;
    rig.clock.wall += 25_000;
    rig.tick();
    expect(rig.status).toBe('failed');
    const before = rig.state;
    const effects = rig.apply({
      kind: 'signature_ready',
      connectionId: rig.connectionId,
      requestId: request.requestId,
      signature: rig.signatureFor(request),
      ...rig.clocks(),
    });
    expect(reasonsOf(effects, 'rejected')).toEqual([
      'unknown_signature_request',
    ]);
    expect(rig.state).toBe(before);
    expect(rig.count('authenticated')).toBe(0);
  });

  it('rule 20: a request that never completes fails after exactly the signer timeout', () => {
    const { rig, clock } = solo({ signer: 'silent' });
    rig.start();
    rig.recv(new Remote(devB).hello());
    expect(rig.attempt!.localProof.state).toBe('signing');
    clock.mono += 4_999;
    clock.wall += 4_999;
    expect(reasonsOf(rig.tick(), 'failed')).toEqual([]);
    expect(rig.status).toBe('identified');
    clock.mono += 1;
    clock.wall += 1;
    expectFailed(rig, rig.tick(), 'signer_timeout');
  });

  it('a signing failure on the CONFIRM stage also fails the attempt', () => {
    const { rig, remote } = toSign();
    rig.answer();
    rig.recv(remote.proof(rig), remote.origin);
    const effects = rig.apply({
      kind: 'signature_failed',
      connectionId: rig.connectionId,
      requestId: rig.pendingSigns[0].requestId,
      ...rig.clocks(),
    });
    expectFailed(rig, effects, 'signer_unavailable');
    expect(rig.attempt!.localConfirm.state).toBe('none');
  });
});

// =================================================================================================
// Channel-binding policy (section F, item 8)
// =================================================================================================

describe('channel-binding policy', () => {
  it('required + unavailable fails at start and sends nothing', () => {
    const { rig } = solo({ policy: 'required', binding: UNBOUND });
    const effects = rig.start();
    expectFailed(rig, effects, 'binding_unavailable');
    expect(effects.some(e => e.kind === 'send')).toBe(false);
    expect(rig.sent).toHaveLength(0);
    expect(rig.randomSpy).not.toHaveBeenCalled();
    expect(rig.credentialSpy).not.toHaveBeenCalled();
    expect(rig.state.attempt).toBeNull();
  });

  it('a restart under required + unavailable fails again without sending', () => {
    const { rig } = solo({ policy: 'required', binding: UNBOUND });
    rig.start();
    const effects = rig.restart();
    expectFailed(rig, effects, 'binding_unavailable');
    expect(rig.sent).toHaveLength(0);
  });

  it('required + a token binding starts normally', () => {
    const { rig } = solo({ policy: 'required', binding: TOKEN_BINDING });
    rig.start();
    expect(rig.status).toBe('awaiting_peer_hello');
    expect(rig.sentStages()).toEqual(['hello']);
  });

  it('a peer that advertises no binding while we have material is a mismatch, whatever the policy', () => {
    for (const policy of ['required', 'preferred'] as const) {
      const { rig, remote } = solo({ policy, binding: TOKEN_BINDING });
      rig.start();
      const effects = rig.recv(
        remote.hello({ kind: 'unavailable' }),
        remote.origin,
      );
      expectFailed(rig, effects, 'binding_mismatch');
    }
  });

  it('a peer that advertises material while we have none is a mismatch', () => {
    const { rig, remote } = solo({ policy: 'preferred', binding: UNBOUND });
    rig.start();
    const effects = rig.recv(
      remote.hello({ kind: 'nearby-auth-token-v1' }),
      remote.origin,
    );
    expectFailed(rig, effects, 'binding_mismatch');
  });

  it('the peer cannot change our binding or our policy', () => {
    const { rig, remote } = solo({
      policy: 'required',
      binding: TOKEN_BINDING,
    });
    rig.start();
    const before = rig.state.binding;
    rig.recv(remote.hello({ kind: 'unavailable' }), remote.origin);
    expect(rig.state.binding).toBe(before);
    expect(rig.state.binding).toEqual(TOKEN_BINDING);
  });

  it('preferred + unavailable on both sides is mutual but reports bound: false', () => {
    const sim = mutualSim({ binding: UNBOUND }, { binding: UNBOUND });
    for (const rig of sim.all) {
      expect(
        (rig.effectsOf('authenticated')[0] as { bound: boolean }).bound,
      ).toBe(false);
      expect(rig.state.authenticated!.bound).toBe(false);
      expect(JSON.parse(rig.attempt!.transcript ? '{}' : '{}')).toEqual({});
    }
  });

  it('required + token on both sides is mutual, bound and routable under the required policy', () => {
    const sim = mutualSim({ policy: 'required' }, { policy: 'required' });
    expect(sim.A.state.authenticated!.bound).toBe(true);
    expect(
      linkAuthRoutable(sim.A.state, sim.clock.wall, {
        channelBinding: 'required',
      }),
    ).toBe(true);
  });

  it('start copies and freezes the binding', () => {
    const { rig } = solo();
    const binding = { ...TOKEN_BINDING };
    rig.start(binding as LocalChannelBinding);
    (binding as { digest: string }).digest =
      OTHER_TOKEN_BINDING.digest as string;
    expect(rig.state.binding).toEqual(TOKEN_BINDING);
    expect(Object.isFrozen(rig.state.binding)).toBe(true);
  });

  it.each([
    ['a missing digest', { kind: 'nearby-auth-token-v1' }],
    [
      'a non-canonical digest',
      { kind: 'nearby-auth-token-v1', digest: 'short' },
    ],
    [
      'an extra key',
      { kind: 'nearby-auth-token-v1', digest: TOKEN_BINDING.digest, extra: 1 },
    ],
    [
      'an unavailable binding with a digest',
      { kind: 'unavailable', digest: TOKEN_BINDING.digest },
    ],
    ['an unknown kind', { kind: 'tls' }],
    ['a string', 'unavailable'],
    ['null', null],
    ['undefined', undefined],
    ['an array', ['unavailable']],
  ])('start rejects %s as malformed and stays idle', (_label, binding) => {
    const { rig } = solo();
    const before = rig.state;
    const effects = rig.apply({
      kind: 'start',
      connectionId: rig.connectionId,
      binding,
      ...rig.clocks(),
    });
    expect(reasonsOf(effects, 'rejected')).toEqual(['malformed']);
    expect(rig.state).toBe(before);
    expect(rig.status).toBe('idle');
    expect(rig.randomSpy).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// Identity (section F, item 6)
// =================================================================================================

describe('peer identity', () => {
  const expiredCredential = () =>
    credentialFor(devB, { issuedAt: T0 - DAY, expiresAt: T0 + 1_000 });
  const prematureCredential = () =>
    credentialFor(devB, {
      issuedAt: WALL0 + 600_000,
      expiresAt: WALL0 + 600_000 + 3_600_000,
    });

  const hostile: [string, () => RideCredential, string][] = [
    [
      'a credential for another session',
      () => credentialFor(devB, { sessionId: OTHER_SESSION }),
      'credential_wrong_session',
    ],
    [
      'a credential for another ride',
      () => credentialFor(devB, { rideId: '99999' }),
      'credential_wrong_ride',
    ],
    [
      'a credential signed by an untrusted server key',
      () => credentialFor(devB, {}, untrustedServer),
      'credential_bad_signature',
    ],
    [
      'a credential from an unknown key id',
      () => credentialFor(devB, { kid: 'srv-unknown' }),
      'credential_unknown_key',
    ],
    ['an expired credential', expiredCredential, 'credential_expired'],
    ['a premature credential', prematureCredential, 'credential_not_yet_valid'],
    [
      'a credential whose node id is not the hash of its key',
      () => credentialFor(devB, { nodeId: 'A'.repeat(43) }),
      'credential_node_id_mismatch',
    ],
    [
      'a credential claiming the local node id with the attacker key',
      () => credentialFor(devC, { nodeId: nodeIdOf(devA) }),
      'credential_node_id_mismatch',
    ],
  ];

  it.each(hostile)('rejects %s (%s)', (_label, make, reason) => {
    const { rig } = solo();
    rig.start();
    const remote = new Remote(devB, { credential: make() });
    const effects = rig.recv(remote.hello(), remote.origin);
    expectFailed(rig, effects, reason);
    expect(rig.pendingSigns).toHaveLength(0);
    expect(rig.sentStages()).toEqual(['hello']);
    expect(rig.state.attempt!.peer).toBeNull();
  });

  it('verifies the credential before anything about the peer is stored', () => {
    const { rig } = solo();
    rig.start();
    const remote = new Remote(devB, {
      credential: credentialFor(devB, {}, untrustedServer),
    });
    rig.recv(remote.hello(), remote.origin);
    expect(rig.state.attempt!.peer).toBeNull();
    expect(rig.state.attempt!.transcript).toBeNull();
    expect(rig.state.recentPeerNonces).toEqual([]);
  });

  it('the local node id claimed by the peer is an identity clash', () => {
    const { rig } = solo();
    rig.start();
    const echo = buildLinkAuthHello({
      credential: rig.credential,
      nonce: new Remote(devB).nonce,
      bindingKind: 'nearby-auth-token-v1',
    });
    const effects = rig.recv(echo, { originId: rig.nodeId });
    expectFailed(rig, effects, 'identity_clash');
  });

  it('rule 6: a HELLO whose sender is not its credential node changes nothing', () => {
    const { rig, remote } = solo();
    rig.start();
    expectRejected(
      rig,
      () => rig.recv(remote.hello(), { originId: 'X'.repeat(43) }),
      'sender_mismatch',
    );
    expect(rig.status).toBe('awaiting_peer_hello');
  });

  it('rule 12/16: a PROOF or CONFIRM from a sender other than the verified peer changes nothing', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    expectRejected(
      rig,
      () => rig.recv(remote.proof(rig), { originId: nodeIdOf(devC) }),
      'sender_mismatch',
    );
    rig.recv(remote.proof(rig), remote.origin);
    rig.answer();
    expectRejected(
      rig,
      () => rig.recv(remote.confirm(rig), { originId: nodeIdOf(devC) }),
      'sender_mismatch',
    );
    expect(rig.attempt!.peerConfirm).toBe('none');
  });

  it('a valid signature by attacker key E on a statement naming the peer is a bad proof', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    const effects = rig.recv(remote.proof(rig, { key: devC }), remote.origin);
    expectFailed(rig, effects, 'bad_proof');
  });

  it('a CONFIRM signed by the attacker key is a bad confirm', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    rig.answer();
    rig.recv(remote.proof(rig), remote.origin);
    const effects = rig.recv(remote.confirm(rig, { key: devC }), remote.origin);
    expectFailed(rig, effects, 'bad_confirm');
  });

  it('a PROOF signature presented as a CONFIRM, and the reverse, are rejected', () => {
    const asConfirm = solo();
    asConfirm.rig.start();
    asConfirm.rig.recv(asConfirm.remote.hello());
    asConfirm.rig.answer();
    asConfirm.rig.recv(
      asConfirm.remote.proof(asConfirm.rig),
      asConfirm.remote.origin,
    );
    const t = asConfirm.remote.transcript(asConfirm.rig);
    const effects1 = asConfirm.rig.recv(
      asConfirm.remote.confirm(asConfirm.rig, {
        sig: asConfirm.remote.signature('proof', asConfirm.rig, t),
      }),
      asConfirm.remote.origin,
    );
    expectFailed(asConfirm.rig, effects1, 'bad_confirm');

    const asProof = solo();
    asProof.rig.start();
    asProof.rig.recv(asProof.remote.hello());
    const t2 = asProof.remote.transcript(asProof.rig);
    const effects2 = asProof.rig.recv(
      asProof.remote.proof(asProof.rig, {
        sig: asProof.remote.signature('confirm', asProof.rig, t2),
      }),
      asProof.remote.origin,
    );
    expectFailed(asProof.rig, effects2, 'bad_proof');
  });

  it('a signature for the reversed direction (signer and peer swapped) is rejected', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    const t = remote.transcript(rig);
    const swapped = remote.signature('proof', rig, t, {
      signer: rig.nodeId,
      peer: remote.nodeId,
    });
    const effects = rig.recv(
      remote.proof(rig, { sig: swapped }),
      remote.origin,
    );
    expectFailed(rig, effects, 'bad_proof');
  });

  it('rule 5: a message that is not direct, or not for this ride, changes nothing', () => {
    const { rig, remote } = solo();
    rig.start();
    expectRejected(
      rig,
      () => rig.recv(remote.hello(), { hopCount: 1 }),
      'not_direct',
    );
    expectRejected(
      rig,
      () => rig.recv(remote.hello(), { hopCount: 3 }),
      'not_direct',
    );
    expectRejected(
      rig,
      () => rig.recv(remote.hello(), { rideId: '99999' }),
      'wrong_ride',
    );
    expectRejected(
      rig,
      () => rig.recv(remote.hello(), { rideId: RIDE.slice(1) }),
      'wrong_ride',
    );
    rig.recv(remote.hello());
    expectRejected(
      rig,
      () => rig.recv(remote.proof(rig), { ...remote.origin, hopCount: 1 }),
      'not_direct',
    );
    expectRejected(
      rig,
      () =>
        rig.recv(remote.confirm(rig), { ...remote.origin, rideId: '99999' }),
      'wrong_ride',
    );
    expect(rig.status).toBe('identified');
  });

  it('rejects envelopes with malformed fields', () => {
    const { rig, remote } = solo();
    rig.start();
    const payload = remote.hello();
    const bad: unknown[] = [
      undefined,
      null,
      'envelope',
      {},
      { originId: '', hopCount: 0, rideId: RIDE },
      { originId: 5, hopCount: 0, rideId: RIDE },
      { originId: remote.nodeId, hopCount: -1, rideId: RIDE },
      { originId: remote.nodeId, hopCount: 0.5, rideId: RIDE },
      { originId: remote.nodeId, hopCount: '0', rideId: RIDE },
      { originId: remote.nodeId, hopCount: 0, rideId: 54321 },
    ];
    for (const envelope of bad) {
      expectRejected(
        rig,
        () =>
          rig.apply({
            kind: 'received',
            connectionId: rig.connectionId,
            envelope,
            payload,
            ...rig.clocks(),
          }),
        'malformed',
      );
    }
  });
});

// =================================================================================================
// Transcript (section F, item 7)
// =================================================================================================

describe('transcript', () => {
  it('rule 12: compares the peer transcript with the locally computed one and never trusts it', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    const calls = rig.verifySpy.mock.calls.length;
    const relayView = remote.transcript(rig, OTHER_TOKEN_BINDING); // self-consistent for a relay's view
    const effects = rig.recv(
      remote.proof(rig, { transcript: relayView }),
      remote.origin,
    );
    expectFailed(rig, effects, 'transcript_mismatch');
    expect(rig.verifySpy.mock.calls.length).toBe(calls); // no signature was even evaluated
  });

  it('a CONFIRM carrying a different transcript is a mismatch', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    rig.answer();
    rig.recv(remote.proof(rig), remote.origin);
    const relayView = remote.transcript(rig, OTHER_TOKEN_BINDING);
    const effects = rig.recv(
      remote.confirm(rig, { transcript: relayView }),
      remote.origin,
    );
    expectFailed(rig, effects, 'transcript_mismatch');
  });

  it('a correct transcript with a signature over another transcript is a bad proof', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    const t = remote.transcript(rig);
    const other = remote.transcript(rig, OTHER_TOKEN_BINDING);
    const effects = rig.recv(
      remote.proof(rig, {
        transcript: t,
        sig: remote.signature('proof', rig, other),
      }),
      remote.origin,
    );
    expectFailed(rig, effects, 'bad_proof');
  });

  it('different binding digests on the two sides make the handshake fail, never succeed', () => {
    const sim = new Sim(
      { binding: TOKEN_BINDING },
      { binding: OTHER_TOKEN_BINDING },
    );
    sim.startBoth();
    sim.advance(5_000);
    expect(sim.A.state.failure).toBe('transcript_mismatch');
    expect(sim.B.state.failure).toBe('transcript_mismatch');
    expect(sim.A.count('authenticated')).toBe(0);
    expect(sim.B.count('authenticated')).toBe(0);
    expect(sim.A.attempt!.transcript).not.toBe(sim.B.attempt!.transcript);
  });

  it('the transcript is computed from verified credentials and our own nonce', () => {
    const { rig, remote } = solo();
    rig.start();
    rig.recv(remote.hello());
    expect(rig.attempt!.transcript).toBe(remote.transcript(rig));
  });
});

// =================================================================================================
// Shared helpers for the remaining groups
// =================================================================================================

const nonceN = (label: string): string =>
  encodeBase64Url(sha256(Buffer.from(`nonce:${label}`)).subarray(0, 16));

/** Drives a solo rig (auto signer) to `mutual` with an honest remote. */
function mutualSolo(
  o: Partial<RigOptions> = {},
  remoteOptions: { nonce?: string; credential?: RideCredential } = {},
) {
  const ctx = solo({ signer: 'auto', ...o }, remoteOptions);
  const { rig, remote } = ctx;
  rig.start();
  rig.recv(remote.hello());
  rig.recv(remote.proof(rig), remote.origin);
  rig.recv(remote.confirm(rig), remote.origin);
  expect(rig.status).toBe('mutual');
  expect(rig.count('authenticated')).toBe(1);
  return ctx;
}

const helloCount = (rig: Rig) =>
  rig.sentStages().filter(s => s === 'hello').length;
const proofCount = (rig: Rig) =>
  rig.sentStages().filter(s => s === 'proof').length;
const confirmCount = (rig: Rig) =>
  rig.sentStages().filter(s => s === 'confirm').length;

// =================================================================================================
// Timers (section F, item 10)
// =================================================================================================

describe('timers', () => {
  it('rule 22: sends HELLO at start and then every 2 s, eight in all, never more', () => {
    const ctx = solo();
    const times: number[] = [];
    ctx.rig.onSend = () => times.push(ctx.clock.mono);
    ctx.rig.start();
    for (let t = 0; t < 19_900; t += 100) {
      ctx.advance(100);
      ctx.rig.tick();
    }
    expect(times.map(t => t - MONO0)).toEqual([
      0, 2000, 4000, 6000, 8000, 10000, 12000, 14000,
    ]);
    expect(helloCount(ctx.rig)).toBe(8);
    expect(ctx.rig.status).toBe('awaiting_peer_hello');
  });

  it('keeps retransmitting HELLO after the peer HELLO arrives, until the peer PROOF is verified', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.advance(2_000);
    ctx.rig.tick();
    expect(helloCount(ctx.rig)).toBe(2);
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.advance(10_000);
    ctx.rig.tick();
    expect(helloCount(ctx.rig)).toBe(2); // no longer needed
  });

  it('rule 23: retransmits PROOF every 2 s until the CONFIRM arrives, eight in all', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    expect(proofCount(ctx.rig)).toBe(1);
    expect(confirmCount(ctx.rig)).toBe(1);
    for (let t = 0; t < 19_900; t += 100) {
      ctx.advance(100);
      ctx.rig.tick();
    }
    expect(proofCount(ctx.rig)).toBe(8);
    expect(confirmCount(ctx.rig)).toBe(1); // a CONFIRM is only ever resent on a peer PROOF
  });

  it('stops PROOF retransmission once the peer CONFIRM is verified', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    expect(ctx.rig.status).toBe('mutual');
    const sent = ctx.rig.sent.length;
    for (let t = 0; t < 60_000; t += 500) {
      ctx.advance(500);
      ctx.rig.tick();
    }
    expect(ctx.rig.sent).toHaveLength(sent);
    expect(ctx.rig.status).toBe('mutual');
  });

  it('retransmission limits and intervals can be tuned within bounds', () => {
    const ctx = solo({
      limits: { retransmitIntervalMs: 500, maxHelloSends: 3 },
    });
    ctx.rig.start();
    for (let t = 0; t < 10_000; t += 100) {
      ctx.advance(100);
      ctx.rig.tick();
    }
    expect(helloCount(ctx.rig)).toBe(3);
  });

  it('rule 21: fails with timeout exactly at the attempt deadline', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.advance(19_999);
    expect(reasonsOf(ctx.rig.tick(), 'failed')).toEqual([]);
    expect(ctx.rig.status).toBe('awaiting_peer_hello');
    ctx.advance(1);
    expectFailed(ctx.rig, ctx.rig.tick(), 'timeout');
  });

  it('the deadline can be tuned and is counted from the attempt start', () => {
    const ctx = solo({ limits: { attemptDeadlineMs: 3_000 } });
    ctx.rig.start();
    ctx.advance(2_999);
    expect(reasonsOf(ctx.rig.tick(), 'failed')).toEqual([]);
    ctx.advance(1);
    expectFailed(ctx.rig, ctx.rig.tick(), 'timeout');
  });

  it('a new attempt gets a new deadline', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.advance(15_000);
    ctx.rig.restart();
    ctx.advance(15_000);
    expect(reasonsOf(ctx.rig.tick(), 'failed')).toEqual([]);
    ctx.advance(5_000);
    expectFailed(ctx.rig, ctx.rig.tick(), 'timeout');
  });

  it('the deadline does not apply once the link is mutual', () => {
    const ctx = mutualSolo();
    ctx.advance(10 * 60_000);
    expect(reasonsOf(ctx.rig.tick(), 'failed')).toEqual([]);
    expect(ctx.rig.status).toBe('mutual');
    expect(ctx.rig.count('authenticated')).toBe(1);
  });

  it('a tick with nothing due changes no attempt state and sends nothing', () => {
    const ctx = solo();
    ctx.rig.start();
    const before = ctx.rig.state;
    ctx.advance(10);
    const effects = ctx.rig.tick();
    expect(effects).toEqual([]);
    expect({ ...ctx.rig.state, lastMonoNow: 0 }).toEqual({
      ...before,
      lastMonoNow: 0,
    });
  });

  it('a late tick sends one retransmission, not a burst', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.advance(15_000);
    const effects = ctx.rig.tick();
    expect(effects.filter(e => e.kind === 'send')).toHaveLength(1);
  });

  it('the monotonic clock is clamped: it never goes backwards', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.advance(5_000);
    ctx.rig.tick();
    const high = ctx.rig.state.lastMonoNow;
    expect(high).toBe(ctx.clock.mono);
    const effects = ctx.rig.apply({
      kind: 'tick',
      connectionId: ctx.rig.connectionId,
      monoNow: MONO0,
      wallNow: ctx.clock.wall,
    });
    expect(effects).toEqual([]);
    expect(ctx.rig.state.lastMonoNow).toBe(high);
  });

  it('a clock that jumps backwards cannot delay or advance a deadline', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.advance(19_000);
    ctx.rig.tick();
    // The platform clock is reset to the start: the clamped clock keeps the old reading, so
    // nothing becomes "younger".
    ctx.rig.apply({
      kind: 'tick',
      connectionId: ctx.rig.connectionId,
      monoNow: MONO0,
      wallNow: ctx.clock.wall,
    });
    ctx.advance(1_000);
    expectFailed(ctx.rig, ctx.rig.tick(), 'timeout');
  });

  const badClocks: [string, unknown][] = [
    ['NaN', NaN],
    ['negative', -1],
    ['fractional', 1.5],
    ['Infinity', Infinity],
    ['a string', '5'],
    ['null', null],
    ['undefined', undefined],
    ['beyond the safe integers', 2 ** 53],
  ];

  describe.each([
    'tick',
    'start',
    'restart',
    'received',
    'signature_ready',
    'signature_failed',
  ])('invalid clocks on %s', kind => {
    it.each(badClocks)('monoNow %s is malformed', (_label, value) => {
      const ctx = solo();
      if (kind !== 'start') {
        ctx.rig.start();
      }
      const before = ctx.rig.state;
      const effects = ctx.rig.apply({
        kind,
        connectionId: ctx.rig.connectionId,
        binding: TOKEN_BINDING,
        envelope: { originId: ctx.remote.nodeId, hopCount: 0, rideId: RIDE },
        payload: ctx.remote.hello(),
        requestId: 'conn-A#1#proof',
        signature: new Uint8Array(64),
        monoNow: value,
        wallNow: ctx.clock.wall,
      });
      expect(reasonsOf(effects, 'rejected')).toEqual(['malformed']);
      expect(ctx.rig.state).toBe(before);
    });

    it.each(badClocks)('wallNow %s is malformed', (_label, value) => {
      const ctx = solo();
      if (kind !== 'start') {
        ctx.rig.start();
      }
      const before = ctx.rig.state;
      const effects = ctx.rig.apply({
        kind,
        connectionId: ctx.rig.connectionId,
        binding: TOKEN_BINDING,
        envelope: { originId: ctx.remote.nodeId, hopCount: 0, rideId: RIDE },
        payload: ctx.remote.hello(),
        requestId: 'conn-A#1#proof',
        signature: new Uint8Array(64),
        monoNow: ctx.clock.mono,
        wallNow: value,
      });
      expect(reasonsOf(effects, 'rejected')).toEqual(['malformed']);
      expect(ctx.rig.state).toBe(before);
    });
  });

  it('disconnected needs no clocks', () => {
    const ctx = solo();
    ctx.rig.start();
    const effects = ctx.rig.apply({
      kind: 'disconnected',
      connectionId: ctx.rig.connectionId,
    });
    expect(effects).toEqual([]);
    expect(ctx.rig.status).toBe('closed');
  });
});

// =================================================================================================
// Credential expiry (section F, item 11)
// =================================================================================================

describe('credential expiry', () => {
  const SOON = WALL0 + 10_000;

  it('rule 24: a peer credential that expires before the link is mutual fails the attempt', () => {
    const ctx = solo(
      { signer: 'auto' },
      { credential: credentialFor(devB, { expiresAt: SOON }) },
    );
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.advance(9_999);
    expect(reasonsOf(ctx.rig.tick(), 'failed')).toEqual([]);
    ctx.advance(1);
    expectFailed(ctx.rig, ctx.rig.tick(), 'peer_credential_expired');
  });

  it('a peer credential that expires exactly when the CONFIRM arrives never authenticates', () => {
    const ctx = solo(
      { signer: 'auto' },
      { credential: credentialFor(devB, { expiresAt: SOON }) },
    );
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.advance(10_000);
    const effects = ctx.rig.recv(
      ctx.remote.confirm(ctx.rig),
      ctx.remote.origin,
    );
    expectFailed(ctx.rig, effects, 'peer_credential_expired');
    expect(ctx.rig.attempt!.peerConfirm).toBe('verified');
  });

  it('a peer credential that expires one millisecond after the CONFIRM does authenticate', () => {
    const ctx = solo(
      { signer: 'auto' },
      { credential: credentialFor(devB, { expiresAt: SOON }) },
    );
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.advance(9_999);
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    expect(ctx.rig.status).toBe('mutual');
    expect(ctx.rig.state.authenticated!.expiresAt).toBe(SOON);
    expect(
      (ctx.rig.effectsOf('authenticated')[0] as { expiresAt: number })
        .expiresAt,
    ).toBe(SOON);
  });

  it('rule 25: an established link ends when the peer credential expires, in the contract order', () => {
    const ctx = mutualSolo(
      {},
      { credential: credentialFor(devB, { expiresAt: SOON }) },
    );
    expect(
      linkAuthRoutable(ctx.rig.state, SOON - 1, { channelBinding: 'required' }),
    ).toBe(true);
    // routable is false at the expiry instant even before any tick reaches the reducer
    expect(
      linkAuthRoutable(ctx.rig.state, SOON, { channelBinding: 'required' }),
    ).toBe(false);
    ctx.advance(10_000);
    const effects = ctx.rig.tick();
    expect(effects.map(e => e.kind)).toEqual(['deauthenticated', 'failed']);
    expect(effects[0]).toEqual({
      kind: 'deauthenticated',
      nodeId: ctx.remote.nodeId,
      reason: 'credential_expired',
    });
    expect(reasonsOf(effects, 'failed')).toEqual(['peer_credential_expired']);
    expect(ctx.rig.status).toBe('failed');
    expect(
      linkAuthRoutable(ctx.rig.state, ctx.clock.wall, {
        channelBinding: 'preferred',
      }),
    ).toBe(false);
  });

  it('an established link ends when the local credential expires', () => {
    const ctx = mutualSolo({ credentialOverrides: { expiresAt: SOON } });
    ctx.advance(10_000);
    const effects = ctx.rig.tick();
    expect(effects.map(e => e.kind)).toEqual(['deauthenticated', 'failed']);
    expect(reasonsOf(effects, 'failed')).toEqual(['local_credential_expired']);
    expect(ctx.rig.status).toBe('failed');
  });

  it('the earlier of the two expiries governs the link', () => {
    const ctx = mutualSolo(
      { credentialOverrides: { expiresAt: SOON + 5_000 } },
      { credential: credentialFor(devB, { expiresAt: SOON }) },
    );
    expect(ctx.rig.state.authenticated!.expiresAt).toBe(SOON);
    const other = mutualSolo(
      { credentialOverrides: { expiresAt: SOON } },
      { credential: credentialFor(devB, { expiresAt: SOON + 5_000 }) },
    );
    expect(other.rig.state.authenticated!.expiresAt).toBe(SOON);
  });

  it('a local credential that expired before start fails without sending or drawing randomness', () => {
    const ctx = solo({
      credentialOverrides: { issuedAt: T0 - DAY, expiresAt: T0 + 1_000 },
    });
    const effects = ctx.rig.start();
    expectFailed(ctx.rig, effects, 'local_credential_expired');
    expect(ctx.rig.sent).toHaveLength(0);
    expect(ctx.rig.randomSpy).not.toHaveBeenCalled();
  });

  it('a local credential that is not yet valid fails at start as invalid', () => {
    const ctx = solo({
      credentialOverrides: {
        issuedAt: WALL0 + 600_000,
        expiresAt: WALL0 + 4_200_000,
      },
    });
    const effects = ctx.rig.start();
    expectFailed(ctx.rig, effects, 'local_credential_invalid');
    expect(ctx.rig.sent).toHaveLength(0);
  });

  it('a restart re-checks the local credential', () => {
    const ctx = solo({
      signer: 'auto',
      credentialOverrides: { expiresAt: SOON },
    });
    ctx.rig.start();
    ctx.advance(10_000);
    // the tick would fail it as well; restart explicitly instead
    const effects = ctx.rig.restart();
    expectFailed(ctx.rig, effects, 'local_credential_expired');
  });

  it('a link that is not expired and is mutual stays routable until the instant of expiry', () => {
    const ctx = mutualSolo();
    const expiresAt = ctx.rig.state.authenticated!.expiresAt;
    expect(expiresAt).toBe(EXPIRES);
    expect(
      linkAuthRoutable(ctx.rig.state, expiresAt - 1, {
        channelBinding: 'preferred',
      }),
    ).toBe(true);
    expect(
      linkAuthRoutable(ctx.rig.state, expiresAt, {
        channelBinding: 'preferred',
      }),
    ).toBe(false);
    expect(
      linkAuthRoutable(ctx.rig.state, expiresAt + 1, {
        channelBinding: 'preferred',
      }),
    ).toBe(false);
  });
});

// =================================================================================================
// Restarts, floods and the failed phase (section F, items 12 and 13)
// =================================================================================================

describe('restarts and floods', () => {
  it('a local restart while mutual withdraws authentication at once', () => {
    const ctx = mutualSolo();
    const oldNonce = ctx.rig.attempt!.localNonce;
    const effects = ctx.rig.restart();
    expect(effects.map(e => e.kind)).toEqual(['deauthenticated', 'send']);
    expect(effects[0]).toEqual({
      kind: 'deauthenticated',
      nodeId: ctx.remote.nodeId,
      reason: 'restart',
    });
    expect(ctx.rig.attempt!.id).toBe(2);
    expect(ctx.rig.attempt!.localNonce).not.toBe(oldNonce);
    expect(ctx.rig.attempt!.peer).toBeNull();
    expect(ctx.rig.status).toBe('awaiting_peer_hello');
    expect(
      linkAuthRoutable(ctx.rig.state, ctx.clock.wall, {
        channelBinding: 'preferred',
      }),
    ).toBe(false);
  });

  it('rule 8: a new HELLO from the peer while mutual restarts, and the link re-authenticates', () => {
    const ctx = mutualSolo();
    const second = nonceN('peer-restart');
    ctx.remote.nonce = second;
    const effects = ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    expect(effects.map(e => e.kind).slice(0, 2)).toEqual([
      'deauthenticated',
      'send',
    ]);
    expect(reasonsOf(effects, 'rejected')).toEqual([]);
    expect(ctx.rig.attempt!.id).toBe(2);
    expect(ctx.rig.attempt!.peer!.nonce).toBe(second);
    expect(ctx.rig.status).toBe('identified');
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    expect(ctx.rig.status).toBe('mutual');
    expect(
      ctx.rig
        .effectsOf('authenticated')
        .map(e => (e as { attemptId: number }).attemptId),
    ).toEqual([1, 2]);
  });

  it('a repeated HELLO with the same nonce is a duplicate and changes nothing', () => {
    const ctx = mutualSolo();
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin),
      'duplicate',
    );
    expect(ctx.rig.status).toBe('mutual');
  });

  it('a replayed HELLO of an earlier attempt is stale and costs no credential verification', () => {
    const ctx = mutualSolo();
    const first = ctx.remote.hello();
    ctx.remote.nonce = nonceN('second');
    ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    const credentialCalls = ctx.rig.credentialSpy.mock.calls.length;
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(first, ctx.remote.origin),
      'stale',
    );
    expect(ctx.rig.credentialSpy.mock.calls.length).toBe(credentialCalls);
    expect(ctx.rig.attempt!.id).toBe(2);
  });

  it('a HELLO whose sender is not its credential node never restarts a mutual link', () => {
    const ctx = mutualSolo();
    for (let i = 0; i < 500; i++) {
      ctx.remote.nonce = nonceN(`spoof-${i}`);
      const before = ctx.rig.state;
      const effects = ctx.rig.recv(ctx.remote.hello(), {
        originId: nodeIdOf(devC),
      });
      expect(reasonsOf(effects, 'rejected')).toEqual(['sender_mismatch']);
      expect(ctx.rig.state).toBe(before);
    }
    expect(ctx.rig.status).toBe('mutual');
    expect(ctx.rig.state.restartTimes).toEqual([]);
    expect(ctx.rig.count('deauthenticated')).toBe(0);
  });

  it('rule 9: three restarts per minute are allowed and the fourth fails with restart_flood', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    for (let i = 0; i < 3; i++) {
      ctx.advance(1_000);
      ctx.rig.restart();
      expect(ctx.rig.status).toBe('awaiting_peer_hello');
    }
    ctx.advance(1_000);
    expectFailed(ctx.rig, ctx.rig.restart(), 'restart_flood');
    expect(ctx.rig.sent.filter(p => p.stage === 'hello')).toHaveLength(4); // start + 3 restarts
  });

  it('a restart flood from HELLOs of a peer fails the link and bounds the work done', () => {
    const ctx = mutualSolo();
    const credentialCalls = ctx.rig.credentialSpy.mock.calls.length;
    let failed = false;
    for (let i = 0; i < 300; i++) {
      ctx.remote.nonce = nonceN(`flood-${i}`);
      const effects = ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
      failed = failed || reasonsOf(effects, 'failed').includes('restart_flood');
    }
    expect(failed).toBe(true);
    expect(ctx.rig.status).toBe('failed');
    expect(ctx.rig.state.failure).toBe('restart_flood');
    expect(ctx.rig.state.authenticated).toBeNull();
    expect(ctx.rig.count('authenticated')).toBe(1); // only the original one
    // at most three restarts (each: local credential + peer credential) plus the failing one
    expect(
      ctx.rig.credentialSpy.mock.calls.length - credentialCalls,
    ).toBeLessThanOrEqual(8);
  });

  it('the restart budget recovers once the window has passed', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    for (let i = 0; i < 3; i++) {
      ctx.advance(1_000);
      ctx.rig.restart();
    }
    ctx.advance(1_000);
    expectFailed(ctx.rig, ctx.rig.restart(), 'restart_flood');
    ctx.advance(30_000);
    expectFailed(ctx.rig, ctx.rig.restart(), 'restart_flood');
    ctx.advance(60_000);
    ctx.rig.restart();
    expect(ctx.rig.status).toBe('awaiting_peer_hello');
    expect(ctx.rig.state.failure).toBeNull();
  });

  it('a restart budget can be tuned', () => {
    const ctx = solo({ limits: { maxRestartsPerWindow: 1 } });
    ctx.rig.start();
    ctx.advance(100);
    ctx.rig.restart();
    ctx.advance(100);
    expectFailed(ctx.rig, ctx.rig.restart(), 'restart_flood');
  });

  describe('malformed messages', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      'hello',
      42,
      [],
      {},
      { stage: 'hello' },
      { v: 1, stage: 'nonsense' },
      { v: 2, stage: 'proof' },
    ];

    it('the ninth malformed message of an attempt fails it', () => {
      const ctx = solo();
      ctx.rig.start();
      for (let i = 0; i < 8; i++) {
        const effects = ctx.rig.recv(
          garbage[i % garbage.length],
          ctx.remote.origin,
        );
        expect(reasonsOf(effects, 'rejected')).toEqual(['malformed']);
        expect(ctx.rig.status).toBe('awaiting_peer_hello');
      }
      expectFailed(
        ctx.rig,
        ctx.rig.recv(garbage[0], ctx.remote.origin),
        'malformed_flood',
      );
    });

    it('does not fail an established link, and the counter stays bounded', () => {
      const ctx = mutualSolo();
      for (let i = 0; i < 400; i++) {
        const before = ctx.rig.state;
        const effects = ctx.rig.recv(
          garbage[i % garbage.length],
          ctx.remote.origin,
        );
        expect(reasonsOf(effects, 'rejected')).toEqual(['malformed']);
        if (i > 20) {
          expect(ctx.rig.state).toBe(before); // saturated: no further state change at all
        }
      }
      expect(ctx.rig.status).toBe('mutual');
      expect(ctx.rig.attempt!.malformed).toBeLessThanOrEqual(9);
      expect(ctx.rig.count('deauthenticated')).toBe(0);
    });

    it('a new attempt starts with a clean counter', () => {
      const ctx = solo();
      ctx.rig.start();
      for (let i = 0; i < 7; i++) {
        ctx.rig.recv(garbage[0], ctx.remote.origin);
      }
      ctx.rig.restart();
      expect(ctx.rig.attempt!.malformed).toBe(0);
    });
  });

  describe('the failed phase', () => {
    function failedCtx() {
      const ctx = solo({ signer: 'auto' });
      ctx.rig.start();
      ctx.rig.recv(ctx.remote.hello());
      ctx.rig.recv(ctx.remote.proof(ctx.rig, { key: devC }), ctx.remote.origin);
      expect(ctx.rig.status).toBe('failed');
      return ctx;
    }

    it('a tick does nothing', () => {
      const ctx = failedCtx();
      ctx.advance(30_000);
      expect(ctx.rig.tick()).toEqual([]);
      expect(ctx.rig.status).toBe('failed');
    });

    it('PROOF, CONFIRM and garbage are rejected as belonging to a failed attempt', () => {
      const ctx = failedCtx();
      for (const payload of [
        ctx.remote.proof(ctx.rig),
        ctx.remote.confirm(ctx.rig),
        'junk',
        null,
        {},
      ]) {
        expectRejected(
          ctx.rig,
          () => ctx.rig.recv(payload, ctx.remote.origin),
          'failed_attempt',
        );
      }
    });

    it('the HELLO the failure came from is a failed-attempt replay', () => {
      const ctx = failedCtx();
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin),
        'failed_attempt',
      );
    });

    it('a signing completion is ignored', () => {
      const ctx = failedCtx();
      expectRejected(
        ctx.rig,
        () =>
          ctx.rig.apply({
            kind: 'signature_ready',
            connectionId: ctx.rig.connectionId,
            requestId: 'conn-A#1#proof',
            signature: new Uint8Array(64),
            ...ctx.rig.clocks(),
          }),
        'unknown_signature_request',
      );
    });

    it('a HELLO with a new nonce starts a new attempt that can succeed', () => {
      const ctx = failedCtx();
      ctx.remote.nonce = nonceN('after-failure');
      ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
      expect(ctx.rig.status).toBe('identified');
      expect(ctx.rig.state.failure).toBeNull();
      expect(ctx.rig.attempt!.id).toBe(2);
      ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
      ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
      expect(ctx.rig.status).toBe('mutual');
      expect(ctx.rig.count('authenticated')).toBe(1);
    });

    it('a local restart also leaves the failed phase', () => {
      const ctx = failedCtx();
      ctx.rig.restart();
      expect(ctx.rig.status).toBe('awaiting_peer_hello');
      expect(ctx.rig.state.failure).toBeNull();
    });

    it('a HELLO flood in the failed phase stays bounded by the restart budget', () => {
      const ctx = failedCtx();
      for (let i = 0; i < 100; i++) {
        ctx.remote.nonce = nonceN(`failed-flood-${i}`);
        ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
      }
      expect(ctx.rig.state.restartTimes.length).toBeLessThanOrEqual(3);
      expect(ctx.rig.status).toBe('failed');
      expect(ctx.rig.count('authenticated')).toBe(0);
    });

    it('a HELLO from an unrelated sender never leaves the failed phase', () => {
      const ctx = failedCtx();
      ctx.remote.nonce = nonceN('spoof');
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(ctx.remote.hello(), { originId: nodeIdOf(devC) }),
        'sender_mismatch',
      );
    });
  });
});

// =================================================================================================
// Connection hygiene (section F, item 14)
// =================================================================================================

describe('connection hygiene', () => {
  const EVENT_KINDS = [
    'start',
    'restart',
    'tick',
    'received',
    'signature_ready',
    'signature_failed',
    'disconnected',
  ];

  it.each(EVENT_KINDS)(
    'an %s event for another connection is stale and changes nothing',
    kind => {
      const ctx = mutualSolo();
      const before = ctx.rig.state;
      const effects = ctx.rig.apply({
        kind,
        connectionId: 'conn-elsewhere',
        binding: TOKEN_BINDING,
        envelope: { originId: ctx.remote.nodeId, hopCount: 0, rideId: RIDE },
        payload: ctx.remote.hello(),
        requestId: 'x',
        signature: new Uint8Array(64),
        ...ctx.rig.clocks(),
      });
      expect(reasonsOf(effects, 'rejected')).toEqual(['stale_connection']);
      expect(ctx.rig.state).toBe(before);
      expect(ctx.rig.status).toBe('mutual');
    },
  );

  it('a message received for another connection id never reaches this connection', () => {
    const ctx = solo();
    ctx.rig.start();
    const before = ctx.rig.state;
    const effects = ctx.rig.recv(
      ctx.remote.hello(),
      ctx.remote.origin,
      'conn-B',
    );
    expect(reasonsOf(effects, 'rejected')).toEqual(['stale_connection']);
    expect(ctx.rig.state).toBe(before);
    expect(ctx.rig.attempt!.peer).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'tick'],
    ['a number', 7],
    ['an array', []],
    ['an object without kind', {}],
    ['an unknown kind', { kind: 'explode', connectionId: 'conn-A' }],
    ['a numeric kind', { kind: 3, connectionId: 'conn-A' }],
    [
      'a prototype-polluting kind',
      { kind: '__proto__', connectionId: 'conn-A' },
    ],
    ['constructor as kind', { kind: 'constructor', connectionId: 'conn-A' }],
  ])('an event that is %s is malformed', (_label, event) => {
    const ctx = mutualSolo();
    const before = ctx.rig.state;
    const effects = ctx.rig.apply(event as never);
    expect(reasonsOf(effects, 'rejected')).toEqual(['malformed']);
    expect(ctx.rig.state).toBe(before);
    expect(ctx.rig.status).toBe('mutual');
  });

  it('start twice is rejected', () => {
    const ctx = solo();
    ctx.rig.start();
    expectRejected(ctx.rig, () => ctx.rig.start(), 'already_started');
  });

  it.each([
    'restart',
    'tick',
    'received',
    'signature_ready',
    'signature_failed',
  ])('%s before start is rejected as not_started', kind => {
    const ctx = solo();
    const before = ctx.rig.state;
    const effects = ctx.rig.apply({
      kind,
      connectionId: ctx.rig.connectionId,
      envelope: { originId: ctx.remote.nodeId, hopCount: 0, rideId: RIDE },
      payload: ctx.remote.hello(),
      requestId: 'conn-A#1#proof',
      signature: new Uint8Array(64),
      ...ctx.rig.clocks(),
    });
    expect(reasonsOf(effects, 'rejected')).toEqual(['not_started']);
    expect(ctx.rig.state).toBe(before);
    expect(ctx.rig.sent).toHaveLength(0);
  });

  it('disconnect withdraws authentication and closes the state for good', () => {
    const ctx = mutualSolo();
    const effects = ctx.rig.disconnect();
    expect(effects).toEqual([
      {
        kind: 'deauthenticated',
        nodeId: ctx.remote.nodeId,
        reason: 'disconnected',
      },
    ]);
    expect(ctx.rig.status).toBe('closed');
    expect(ctx.rig.state.authenticated).toBeNull();
    expect(ctx.rig.state.attempt).toBeNull();
    expect(
      linkAuthRoutable(ctx.rig.state, ctx.clock.wall, {
        channelBinding: 'preferred',
      }),
    ).toBe(false);
    expect(linkAuthLevel(ctx.rig.state)).toBe('none');
  });

  it('a closed state rejects everything, even a valid handshake', () => {
    const ctx = mutualSolo();
    const hello = ctx.remote.hello();
    const proof = ctx.remote.proof(ctx.rig);
    ctx.rig.disconnect();
    const before = ctx.rig.state;
    const effectsList = [
      ctx.rig.start(),
      ctx.rig.restart(),
      ctx.rig.tick(),
      ctx.rig.recv(hello, ctx.remote.origin),
      ctx.rig.recv(proof, ctx.remote.origin),
      ctx.rig.disconnect(),
    ];
    for (const effects of effectsList) {
      expect(reasonsOf(effects, 'rejected')).toEqual(['closed']);
    }
    expect(ctx.rig.state).toBe(before);
    expect(ctx.rig.count('authenticated')).toBe(1);
  });

  it('a reconnect gets a fresh state and inherits nothing', () => {
    const ctx = mutualSolo();
    ctx.rig.disconnect();
    const fresh = ctx.rig.auth.initialState('conn-A2');
    expect(linkAuthStatus(fresh)).toBe('idle');
    expect(fresh.authenticated).toBeNull();
    expect(fresh.recentPeerNonces).toEqual([]);
    expect(
      linkAuthRoutable(fresh, ctx.clock.wall, { channelBinding: 'preferred' }),
    ).toBe(false);
    // a message from the old connection id is stale for the new state
    const result = ctx.rig.auth.reduce(fresh, {
      kind: 'received',
      connectionId: 'conn-A',
      envelope: { originId: ctx.remote.nodeId, hopCount: 0, rideId: RIDE },
      payload: ctx.remote.hello(),
      ...ctx.rig.clocks(),
    } as never);
    expect(reasonsOf(result.effects, 'rejected')).toEqual(['stale_connection']);
    expect(result.state).toBe(fresh);
  });

  it('a reconnect can complete a brand new handshake with the same peer nonce material', () => {
    const first = mutualSolo();
    first.rig.disconnect();
    const second = mutualSolo();
    expect(second.rig.count('authenticated')).toBe(1);
  });

  it('a disconnect in the idle phase closes it', () => {
    const ctx = solo();
    expect(ctx.rig.disconnect()).toEqual([]);
    expect(ctx.rig.status).toBe('closed');
  });
});

// =================================================================================================
// Nonces and randomness (section F, item 15)
// =================================================================================================

describe('nonces', () => {
  it('rule 6: a peer nonce equal to ours fails the attempt', () => {
    const ctx = solo();
    ctx.rig.start();
    const effects = ctx.rig.recv(
      ctx.remote.hello({ nonce: ctx.rig.attempt!.localNonce }),
      ctx.remote.origin,
    );
    expectFailed(ctx.rig, effects, 'nonce_reuse');
  });

  it('keeps only the most recent peer nonces, as configured', () => {
    const ctx = solo({
      signer: 'auto',
      limits: { maxRestartsPerWindow: 16, recentPeerNonces: 4 },
    });
    ctx.rig.start();
    const used: string[] = [];
    for (let i = 0; i < 10; i++) {
      ctx.remote.nonce = nonceN(`ring-${i}`);
      used.push(ctx.remote.nonce);
      ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    }
    expect(ctx.rig.state.recentPeerNonces).toEqual(used.slice(-4));
    // the oldest are no longer remembered, so they would be treated as new
    ctx.remote.nonce = used[0];
    expect(
      reasonsOf(
        ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin),
        'rejected',
      ),
    ).toEqual([]);
  });

  it('a replayed nonce of a remembered attempt costs no credential verification', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    const replay = ctx.remote.hello();
    ctx.rig.recv(replay, ctx.remote.origin);
    ctx.remote.nonce = nonceN('next');
    ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    const calls = ctx.rig.credentialSpy.mock.calls.length;
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(replay, ctx.remote.origin),
      'stale',
    );
    expect(ctx.rig.credentialSpy.mock.calls.length).toBe(calls);
  });

  it('draws sixteen bytes of fresh randomness per attempt, once', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    expect(ctx.rig.randomSpy.mock.calls).toEqual([[16]]);
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    ctx.rig.tick();
    expect(ctx.rig.randomSpy.mock.calls).toEqual([[16]]);
    ctx.rig.restart();
    expect(ctx.rig.randomSpy.mock.calls).toEqual([[16], [16]]);
    expect(new Set(ctx.rig.nonces).size).toBe(2);
  });

  it('a stuck random source is detected on restart', () => {
    const ctx = solo({ randomBytes: () => new Uint8Array(16).fill(7) });
    ctx.rig.start();
    expectFailed(ctx.rig, ctx.rig.restart(), 'random_unavailable');
  });

  const badRandom: [string, () => unknown][] = [
    [
      'throws',
      () => {
        throw new Error('no entropy');
      },
    ],
    ['returns 15 bytes', () => new Uint8Array(15)],
    ['returns 17 bytes', () => new Uint8Array(17)],
    ['returns undefined', () => undefined],
    ['returns an array', () => Array.from({ length: 16 }, () => 3)],
    ['returns a string', () => 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['returns a Promise', () => Promise.resolve(new Uint8Array(16))],
    [
      'returns a rejected Promise',
      () => Promise.reject(new Error('late failure')),
    ],
  ];

  it.each(badRandom)(
    'a random source that %s fails the attempt without sending',
    (_label, random) => {
      const ctx = solo({ randomBytes: random as never });
      const effects = ctx.rig.start();
      expectFailed(ctx.rig, effects, 'random_unavailable');
      expect(ctx.rig.sent).toHaveLength(0);
      expect(ctx.rig.state.attempt).toBeNull();
    },
  );
});

// =================================================================================================
// Faults in the injected credential verifier
// =================================================================================================

describe('credential verifier faults', () => {
  const real = trustedVerifier();

  function withVerifier(
    behave: (credential: RideCredential, now: number) => unknown,
  ) {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.credentialSpy.mockImplementation(
      (credential: RideCredential, now: number) =>
        credential.nodeId === ctx.rig.nodeId
          ? real.verify(credential, now)
          : behave(credential, now),
    );
    ctx.rig.start();
    return ctx;
  }

  const faults: [string, (c: RideCredential) => unknown][] = [
    [
      'throws',
      () => {
        throw new Error('verifier crashed');
      },
    ],
    ['returns a Promise', c => Promise.resolve({ ok: true, credential: c })],
    ['returns null', () => null],
    ['returns undefined', () => undefined],
    ['returns ok without a credential', () => ({ ok: true })],
    ['returns a truthy non-true ok', c => ({ ok: 'yes', credential: c })],
    [
      'returns a different credential',
      () => ({ ok: true, credential: credentialFor(devC) }),
    ],
    [
      'returns the credential with a changed expiry',
      c => ({ ok: true, credential: { ...c, expiresAt: c.expiresAt + 1 } }),
    ],
  ];

  it.each(faults)(
    'a verifier that %s never trusts the peer',
    (_label, behave) => {
      const ctx = withVerifier(behave);
      const effects = ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
      expectFailed(ctx.rig, effects, 'credential_invalid');
      expect(ctx.rig.state.attempt!.peer).toBeNull();
      expect(ctx.rig.pendingSigns).toHaveLength(0);
    },
  );

  it('a verifier that returns an unknown rejection string maps to a failure that is still a failure', () => {
    const ctx = withVerifier(() => ({ ok: false, reason: 'bad_signature' }));
    const effects = ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    expectFailed(ctx.rig, effects, 'credential_bad_signature');
  });

  it('a verified credential equal to the presented one is accepted', () => {
    const ctx = withVerifier(c => ({ ok: true, credential: c }));
    ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    expect(ctx.rig.status).toBe('identified');
  });

  it('passes the injected wall clock to the verifier', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    const nows = ctx.rig.credentialSpy.mock.calls.map(call => call[1]);
    expect(new Set(nows)).toEqual(new Set([WALL0]));
  });
});

// =================================================================================================
// Invariant watching (used by the two-node, fuzz and randomised tests)
// =================================================================================================

function invariant(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`invariant violated: ${message}`);
  }
}

/** Installs a per-step check of the contract's global invariants on a rig. */
function watch(rig: Rig): void {
  const seen = new Set<number>();
  rig.onStep = (before, after, effects) => {
    const a = after.attempt;
    if (after.authenticated !== null) {
      invariant(
        after.phase === 'active' && a !== null,
        'mutual implies an active attempt',
      );
      const attempt = a as NonNullable<typeof a>;
      invariant(
        attempt.peer !== null,
        'mutual implies a verified peer credential',
      );
      invariant(
        attempt.peerProof === 'verified',
        'mutual implies the peer PROOF verified',
      );
      invariant(
        attempt.peerConfirm === 'verified',
        'mutual implies the peer CONFIRM verified',
      );
      invariant(
        attempt.localProof.state === 'sent',
        'mutual implies our PROOF sent',
      );
      invariant(
        attempt.localConfirm.state === 'sent',
        'mutual implies our CONFIRM sent',
      );
      invariant(
        after.authenticated.nodeId === attempt.peer?.nodeId,
        'authenticated names the peer',
      );
      invariant(
        after.authenticated.attemptId === attempt.id,
        'authenticated names the attempt',
      );
      invariant(
        after.authenticated.nodeId !== rig.nodeId,
        'never authenticated as ourselves',
      );
    }
    if (after.phase === 'failed') {
      invariant(after.authenticated === null, 'failed is never authenticated');
      invariant(after.failure !== null, 'failed has a reason');
    }
    if (a) {
      const signing = [a.localProof, a.localConfirm].filter(
        s => s.state === 'signing',
      ).length;
      invariant(signing <= 1, 'at most one signing request outstanding');
      invariant(a.malformed <= 9, 'malformed counter is bounded');
    }
    invariant(after.recentPeerNonces.length <= 4, 'nonce ring is bounded');
    invariant(after.restartTimes.length <= 3, 'restart history is bounded');
    invariant(JSON.stringify(after).length < 20_000, 'state size is bounded');
    const routable = (policy: 'required' | 'preferred') =>
      linkAuthRoutable(after, rig.clock.wall, { channelBinding: policy });
    if (linkAuthStatus(after) !== 'mutual') {
      invariant(
        !routable('preferred') && !routable('required'),
        'only mutual links are routable',
      );
    }
    const authenticatedEffects = effects.filter(
      e => e.kind === 'authenticated',
    );
    const deauthenticatedEffects = effects.filter(
      e => e.kind === 'deauthenticated',
    );
    for (const e of authenticatedEffects) {
      const id = (e as { attemptId: number }).attemptId;
      invariant(!seen.has(id), 'authenticated at most once per attempt');
      seen.add(id);
      invariant(
        before.authenticated === null && after.authenticated !== null,
        'authenticated only on the transition',
      );
    }
    invariant(
      authenticatedEffects.length <= 1,
      'one authenticated effect per step',
    );
    if (before.authenticated !== null && after.authenticated === null) {
      invariant(
        deauthenticatedEffects.length === 1,
        'leaving mutual always says so, once',
      );
    } else {
      invariant(
        deauthenticatedEffects.length === 0,
        'deauthenticated only when leaving mutual',
      );
    }
    for (const e of effects) {
      if (e.kind === 'send' && e.payload.stage === 'proof') {
        invariant(
          a !== null && a.peer !== null,
          'PROOF is only sent once the peer is verified',
        );
      }
      if (e.kind === 'send' && e.payload.stage === 'confirm') {
        invariant(
          a !== null &&
            a.peerProof === 'verified' &&
            a.localProof.state === 'sent',
          'CONFIRM is only sent after both PROOFs',
        );
      }
    }
    invariant(effects.length <= 6, 'effects per step are bounded');
  };
}

/** A small deterministic generator (Park-Miller), so a seed always reproduces its schedule. */
function mulberry32(seed: number): () => number {
  let state =
    (((Math.abs(Math.trunc(seed)) + 1) * 1_103_515_245 + 12_345) %
      2_147_483_646) +
    1;
  const next = () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
  for (let i = 0; i < 8; i++) {
    next(); // warm-up: neighbouring seeds start far apart
  }
  return next;
}

// =================================================================================================
// Loss and repair (section F, item 3)
// =================================================================================================

describe('loss and repair', () => {
  it('the clean handshake is six messages', () => {
    const sim = new Sim();
    sim.startBoth();
    sim.advance(100);
    expect(sim.wires).toHaveLength(6);
  });

  it.each(Array.from({ length: 6 }, (_, k) => k))(
    'dropping message #%i once still converges',
    k => {
      const sim = new Sim();
      watch(sim.A);
      watch(sim.B);
      sim.channel = w => (w.seq === k ? [] : [0]);
      sim.startBoth();
      sim.advance(15_000);
      expect(sim.bothMutual()).toBe(true);
      expect(sim.A.count('authenticated')).toBe(1);
      expect(sim.B.count('authenticated')).toBe(1);
      expect(sim.A.attempt!.transcript).toBe(sim.B.attempt!.transcript);
    },
  );

  it.each(['hello', 'proof', 'confirm'])(
    'dropping the first two %s messages of each side still converges',
    stage => {
      const sim = new Sim();
      const counts = new Map<string, number>();
      sim.channel = w => {
        const key = `${w.from.name}:${w.stage}`;
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return w.stage === stage && n <= 2 ? [] : [0];
      };
      sim.startBoth();
      sim.advance(19_000);
      expect(sim.bothMutual()).toBe(true);
      expect(sim.A.count('authenticated')).toBe(1);
      expect(sim.B.count('authenticated')).toBe(1);
    },
  );

  it('a lost CONFIRM is repaired by the rate-limited resend', () => {
    const sim = new Sim();
    let dropped = false;
    sim.channel = w => {
      if (!dropped && w.stage === 'confirm' && w.from === sim.A) {
        dropped = true;
        return [];
      }
      return [0];
    };
    sim.startBoth();
    expect(sim.A.status).toBe('mutual');
    expect(sim.B.status).not.toBe('mutual');
    sim.advance(2_500);
    expect(sim.B.status).toBe('mutual');
    expect(sim.A.sent.filter(p => p.stage === 'confirm')).toHaveLength(2);
  });

  it('asymmetric completion is safe: the side without the CONFIRM never trusts, then times out', () => {
    const sim = new Sim();
    let heal = false;
    sim.channel = w =>
      w.from === sim.A && w.stage === 'confirm' && !heal ? [] : [0];
    watch(sim.A);
    watch(sim.B);
    sim.startBoth();
    sim.advance(19_000);
    expect(sim.A.status).toBe('mutual');
    expect(sim.B.status).toBe('peer_proven');
    expect(sim.B.count('authenticated')).toBe(0);
    expect(
      linkAuthRoutable(sim.B.state, sim.clock.wall, {
        channelBinding: 'preferred',
      }),
    ).toBe(false);
    // A re-sent its CONFIRM at most eight times
    expect(
      sim.A.sent.filter(p => p.stage === 'confirm').length,
    ).toBeLessThanOrEqual(9);
    sim.advance(2_000);
    expect(sim.B.status).toBe('failed');
    expect(sim.B.state.failure).toBe('timeout');
    expect(sim.A.status).toBe('mutual'); // A has no way to know

    // the local restart re-converges both sides
    heal = true;
    sim.B.restart();
    sim.deliverDue();
    sim.advance(3_000);
    expect(sim.bothMutual()).toBe(true);
    expect(
      sim.A.effectsOf('authenticated').map(
        e => (e as { attemptId: number }).attemptId,
      ),
    ).toEqual([1, 2]);
    expect(sim.A.effectsOf('deauthenticated')).toEqual([
      { kind: 'deauthenticated', nodeId: sim.B.nodeId, reason: 'restart' },
    ]);
    expect(
      sim.B.effectsOf('authenticated').map(
        e => (e as { attemptId: number }).attemptId,
      ),
    ).toEqual([2]);
  });

  it('a permanently dead channel fails both sides after the deadline and nothing authenticates', () => {
    const sim = new Sim();
    sim.channel = () => [];
    watch(sim.A);
    watch(sim.B);
    sim.startBoth();
    sim.advance(25_000);
    for (const rig of sim.all) {
      expect(rig.state.failure).toBe('timeout');
      expect(rig.count('authenticated')).toBe(0);
      expect(helloCount(rig)).toBe(8);
    }
  });

  describe('rule 13: duplicate PROOFs trigger rate-limited CONFIRM resends', () => {
    it('resends at most once per interval and at most eight times, never re-verifying', () => {
      const ctx = mutualSolo();
      const proof = ctx.remote.proof(ctx.rig);
      const verifies = ctx.rig.verifySpy.mock.calls.length;
      expect(verifies).toBe(4);
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(proof, ctx.remote.origin),
        'duplicate',
      );
      ctx.advance(1_999);
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(proof, ctx.remote.origin),
        'duplicate',
      );
      ctx.advance(1);
      const effects = ctx.rig.recv(proof, ctx.remote.origin);
      expect(effects.map(e => e.kind)).toEqual(['send']);
      expect((effects[0] as SendEffect).payload.stage).toBe('confirm');
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(proof, ctx.remote.origin),
        'duplicate',
      );
      for (let i = 0; i < 30; i++) {
        ctx.advance(2_000);
        ctx.rig.recv(proof, ctx.remote.origin);
      }
      expect(confirmCount(ctx.rig)).toBe(9); // the original and eight resends
      expect(ctx.rig.verifySpy.mock.calls.length).toBe(verifies);
      expect(ctx.rig.status).toBe('mutual');
      expect(ctx.rig.count('authenticated')).toBe(1);
    });

    it('resends the stored CONFIRM, byte for byte', () => {
      const ctx = mutualSolo();
      const proof = ctx.remote.proof(ctx.rig);
      ctx.advance(2_000);
      ctx.rig.recv(proof, ctx.remote.origin);
      const confirms = ctx.rig.sent.filter(p => p.stage === 'confirm');
      expect(confirms).toHaveLength(2);
      expect(confirms[1]).toEqual(confirms[0]);
    });

    it('the interval and the cap can be tuned', () => {
      const ctx = mutualSolo({
        limits: { confirmResendMinIntervalMs: 500, maxConfirmResends: 2 },
      });
      const proof = ctx.remote.proof(ctx.rig);
      for (let i = 0; i < 10; i++) {
        ctx.advance(500);
        ctx.rig.recv(proof, ctx.remote.origin);
      }
      expect(confirmCount(ctx.rig)).toBe(3);
    });

    it('a duplicate PROOF before our CONFIRM is sent does not send one', () => {
      const ctx = solo();
      ctx.rig.start();
      ctx.rig.recv(ctx.remote.hello());
      ctx.rig.answer(); // PROOF sent
      const proof = ctx.remote.proof(ctx.rig);
      ctx.rig.recv(proof, ctx.remote.origin); // verified; sign(confirm) pending
      ctx.advance(5_000);
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(proof, ctx.remote.origin),
        'duplicate',
      );
      expect(confirmCount(ctx.rig)).toBe(0);
    });
  });
});

// =================================================================================================
// Duplicates (section F, item 4)
// =================================================================================================

describe('duplicates', () => {
  function counts(rig: Rig) {
    return {
      verify: rig.verifySpy.mock.calls.length,
      credential: rig.credentialSpy.mock.calls.length,
      random: rig.randomSpy.mock.calls.length,
      authenticated: rig.count('authenticated'),
    };
  }

  let cleanMemo: {
    A: ReturnType<typeof counts>;
    B: ReturnType<typeof counts>;
  } | null = null;
  const clean = () => {
    if (cleanMemo === null) {
      const sim = mutualSim();
      cleanMemo = { A: counts(sim.A), B: counts(sim.B) };
    }
    return cleanMemo;
  };

  it('a clean handshake performs exactly four signature checks, two credential checks and one draw', () => {
    for (const side of [clean().A, clean().B]) {
      expect(side).toEqual({
        verify: 4,
        credential: 2,
        random: 1,
        authenticated: 1,
      });
    }
  });

  it.each([
    ['every message twice, immediately', [0, 0]],
    ['every message three times', [0, 0, 0]],
    ['every message again after 1.5 s', [0, 1_500]],
    ['every message again after 3 s and 9 s', [0, 3_000, 9_000]],
  ])(
    '%s: no extra verification and a single authenticated',
    (_label, delays) => {
      const sim = new Sim();
      watch(sim.A);
      watch(sim.B);
      sim.channel = () => delays;
      sim.startBoth();
      sim.advance(15_000);
      expect(sim.bothMutual()).toBe(true);
      expect(counts(sim.A)).toEqual(clean().A);
      expect(counts(sim.B)).toEqual(clean().B);
    },
  );

  it('a duplicated HELLO is a duplicate and costs no credential verification', () => {
    const ctx = solo();
    ctx.rig.start();
    const hello = ctx.remote.hello();
    ctx.rig.recv(hello, ctx.remote.origin);
    const calls = ctx.rig.credentialSpy.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(hello, ctx.remote.origin),
        'duplicate',
      );
    }
    expect(ctx.rig.credentialSpy.mock.calls.length).toBe(calls);
  });

  it('a duplicated CONFIRM is a duplicate and is not verified again', () => {
    const ctx = mutualSolo();
    const confirm = ctx.remote.confirm(ctx.rig);
    const calls = ctx.rig.verifySpy.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(confirm, ctx.remote.origin),
        'duplicate',
      );
    }
    expect(ctx.rig.verifySpy.mock.calls.length).toBe(calls);
    expect(ctx.rig.count('authenticated')).toBe(1);
  });

  it('a duplicate completion of the signer cannot send a second PROOF', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    const request = ctx.rig.pendingSigns[0];
    ctx.rig.answer();
    ctx.rig.completeSign(request);
    ctx.rig.completeSign(request);
    expect(proofCount(ctx.rig)).toBe(1);
  });
});

// =================================================================================================
// Replay and reflection (section F, item 5)
// =================================================================================================

describe('replay and reflection', () => {
  it('a PROOF or CONFIRM replayed from an earlier attempt is stale, before and after the new HELLO', () => {
    const ctx = mutualSolo();
    const oldProof = ctx.remote.proof(ctx.rig);
    const oldConfirm = ctx.remote.confirm(ctx.rig);
    ctx.rig.restart();
    expect(ctx.rig.status).toBe('awaiting_peer_hello');
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(oldProof, ctx.remote.origin),
      'stale',
    );
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(oldConfirm, ctx.remote.origin),
      'stale',
    );
    expect(ctx.rig.attempt!.earlyProof).toBeNull();
    expect(ctx.rig.attempt!.earlyConfirm).toBeNull();
    ctx.remote.nonce = nonceN('second-attempt');
    ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(oldProof, ctx.remote.origin),
      'stale',
    );
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(oldConfirm, ctx.remote.origin),
      'stale',
    );
    expect(ctx.rig.status).toBe('identified');
    expect(ctx.rig.count('authenticated')).toBe(1);
  });

  it('a full handshake recorded on one connection is useless on another connection', () => {
    const first = mutualSolo();
    const proof = first.remote.proof(first.rig);
    const confirm = first.remote.confirm(first.rig);
    const second = solo({
      signer: 'auto',
      seed: 'second-connection',
      connectionId: 'conn-A2',
    });
    second.rig.start();
    second.rig.recv(second.remote.hello(), second.remote.origin);
    expectRejected(
      second.rig,
      () => second.rig.recv(proof, second.remote.origin),
      'stale',
    );
    expectRejected(
      second.rig,
      () => second.rig.recv(confirm, second.remote.origin),
      'stale',
    );
    expect(second.rig.status).toBe('identified');
    expect(second.rig.count('authenticated')).toBe(0);
  });

  it('a PROOF addressed to our nonce but replayed by a third party with the wrong sender is refused', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    expectRejected(
      ctx.rig,
      () =>
        ctx.rig.recv(ctx.remote.proof(ctx.rig), { originId: nodeIdOf(devC) }),
      'sender_mismatch',
    );
  });

  it('our own PROOF and CONFIRM echoed back are stale and change nothing', () => {
    const ctx = mutualSolo();
    const own = ctx.rig.sent.filter(p => p.stage !== 'hello');
    expect(own.map(p => p.stage)).toEqual(['proof', 'confirm']);
    for (const payload of own) {
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(payload, { originId: ctx.rig.nodeId }),
        'stale',
      );
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(payload, ctx.remote.origin),
        'stale',
      );
    }
    expect(ctx.rig.status).toBe('mutual');
  });

  it('a self-addressed PROOF is buffered but can never be accepted', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    const nonce = ctx.rig.attempt!.localNonce;
    const selfProof = buildLinkAuthProof({
      nonce,
      peerNonce: nonce,
      transcript: 'A'.repeat(43),
      sig: 'A'.repeat(86),
    });
    ctx.rig.recv(selfProof, { originId: ctx.rig.nodeId });
    const effects = ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin);
    expect(reasonsOf(effects, 'rejected')).toEqual(['stale']);
    expect(ctx.rig.attempt!.peerProof).toBe('none');
    expect(ctx.rig.attempt!.earlyProof).toBeNull();
  });

  it('our own HELLO echoed back before any peer is known is an identity clash', () => {
    const ctx = solo();
    ctx.rig.start();
    const ownHello = ctx.rig.sent[0];
    const effects = ctx.rig.recv(ownHello, { originId: ctx.rig.nodeId });
    expectFailed(ctx.rig, effects, 'identity_clash');
  });

  it('our own HELLO echoed back while mutual is refused and changes nothing', () => {
    const ctx = mutualSolo();
    const ownHello = ctx.rig.sent[0];
    const sent = ctx.rig.sent.length;
    for (let i = 0; i < 20; i++) {
      expectRejected(
        ctx.rig,
        () => ctx.rig.recv(ownHello, { originId: ctx.rig.nodeId }),
        'self_hello',
      );
    }
    expect(ctx.rig.status).toBe('mutual');
    expect(ctx.rig.sent).toHaveLength(sent);
    expect(ctx.rig.state.restartTimes).toEqual([]);
    expect(ctx.rig.count('deauthenticated')).toBe(0);
    expect(
      linkAuthRoutable(ctx.rig.state, ctx.clock.wall, {
        channelBinding: 'preferred',
      }),
    ).toBe(true);
  });

  it('a PROOF signature placed in a CONFIRM, and vice versa, never completes the handshake', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    const transcript = ctx.remote.transcript(ctx.rig);
    const proofSig = ctx.remote.signature('proof', ctx.rig, transcript);
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    const effects = ctx.rig.recv(
      ctx.remote.confirm(ctx.rig, { sig: proofSig }),
      ctx.remote.origin,
    );
    expectFailed(ctx.rig, effects, 'bad_confirm');
  });
});

// =================================================================================================
// Purity, fuzzing and determinism (section F, item 17)
// =================================================================================================

describe('purity and robustness', () => {
  it('status, level and routability treat garbage as closed / none / false', () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter');
        },
        has() {
          throw new Error('hostile has');
        },
        ownKeys() {
          throw new Error('hostile keys');
        },
      },
    );
    const garbage: unknown[] = [
      null,
      undefined,
      5,
      'mutual',
      [],
      {},
      { phase: 'active' },
      { phase: 'mutual' },
      { phase: 'active', authenticated: { expiresAt: 'x', bound: true } },
      { phase: 'active', authenticated: {}, attempt: throwing },
      throwing,
    ];
    for (const state of garbage) {
      expect(() => linkAuthStatus(state as never)).not.toThrow();
      expect(() => linkAuthLevel(state as never)).not.toThrow();
      expect(() =>
        linkAuthRoutable(state as never, WALL0, {
          channelBinding: 'preferred',
        }),
      ).not.toThrow();
      expect(
        linkAuthRoutable(state as never, WALL0, {
          channelBinding: 'preferred',
        }),
      ).toBe(false);
      expect(
        linkAuthRoutable(state as never, WALL0, { channelBinding: 'required' }),
      ).toBe(false);
    }
    expect(linkAuthStatus(undefined as never)).toBe('closed');
    expect(linkAuthLevel(null as never)).toBe('none');
  });

  it('routability rejects bad clocks and bad policies', () => {
    const ctx = mutualSolo();
    for (const wall of [NaN, -1, 1.5, '5', undefined, null, Infinity]) {
      expect(
        linkAuthRoutable(ctx.rig.state, wall as never, {
          channelBinding: 'preferred',
        }),
      ).toBe(false);
    }
    for (const policy of [
      undefined,
      null,
      {},
      { channelBinding: 'none' },
      'required',
      { channelBinding: 1 },
    ]) {
      expect(
        linkAuthRoutable(ctx.rig.state, ctx.clock.wall, policy as never),
      ).toBe(false);
    }
    expect(
      linkAuthRoutable(ctx.rig.state, ctx.clock.wall, {
        channelBinding: 'preferred',
      }),
    ).toBe(true);
  });

  it('every status below mutual is non-routable and has the matching level', () => {
    const expected: Record<string, string> = {
      idle: 'none',
      awaiting_peer_hello: 'none',
      identified: 'identified',
      peer_proven: 'peer_proven',
      mutual: 'mutual',
      failed: 'none',
      closed: 'none',
    };
    const ctx = solo();
    const seenStatuses = new Set<string>();
    const check = () => {
      seenStatuses.add(ctx.rig.status);
      expect(linkAuthLevel(ctx.rig.state)).toBe(expected[ctx.rig.status]);
      const routable = linkAuthRoutable(ctx.rig.state, ctx.clock.wall, {
        channelBinding: 'preferred',
      });
      expect(routable).toBe(ctx.rig.status === 'mutual');
    };
    check();
    ctx.rig.start();
    check();
    ctx.rig.recv(ctx.remote.hello());
    check();
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    check();
    ctx.rig.answer();
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    ctx.rig.answer();
    check();
    ctx.rig.restart();
    ctx.advance(25_000);
    ctx.rig.tick();
    check();
    ctx.rig.disconnect();
    check();
    expect([...seenStatuses].sort()).toEqual(
      [
        'awaiting_peer_hello',
        'closed',
        'failed',
        'identified',
        'idle',
        'mutual',
        'peer_proven',
      ].sort(),
    );
  });

  it('never mutates its input state, whatever the event', () => {
    const ctx = mutualSolo();
    const frozen = ctx.rig.state;
    const json = snapshot(frozen);
    const hostile = [
      ctx.remote.hello(),
      ctx.remote.proof(ctx.rig),
      ctx.remote.confirm(ctx.rig),
      null,
      {},
    ];
    for (const payload of hostile) {
      ctx.rig.auth.reduce(frozen, {
        kind: 'received',
        connectionId: ctx.rig.connectionId,
        envelope: { originId: ctx.remote.nodeId, hopCount: 0, rideId: RIDE },
        payload,
        ...ctx.rig.clocks(),
      } as never);
    }
    expect(snapshot(frozen)).toBe(json);
  });

  it('is deterministic: the same state and event always give the same result', () => {
    const ctx = mutualSolo();
    const events = [
      { kind: 'tick', connectionId: 'conn-A', ...ctx.rig.clocks() },
      { kind: 'restart', connectionId: 'conn-A', ...ctx.rig.clocks() },
      {
        kind: 'received',
        connectionId: 'conn-A',
        envelope: { originId: ctx.remote.nodeId, hopCount: 0, rideId: RIDE },
        payload: ctx.remote.hello({ nonce: nonceN('x') }),
        ...ctx.rig.clocks(),
      },
      { kind: 'disconnected', connectionId: 'conn-A' },
    ];
    for (const event of events) {
      const draws = (): (() => Uint8Array) => {
        let n = 0;
        return () => new Uint8Array(16).fill(++n);
      };
      const a = createLinkAuthenticator({
        ...ctx.rig.deps,
        randomBytes: draws(),
      });
      const b = createLinkAuthenticator({
        ...ctx.rig.deps,
        randomBytes: draws(),
      });
      const ra = a.reduce(ctx.rig.state, event as never);
      const rb = b.reduce(ctx.rig.state, event as never);
      expect(snapshot(ra)).toBe(snapshot(rb));
    }
  });

  it('replaying a recorded event log reproduces every state and effect exactly', () => {
    const ctx = solo({ signer: 'auto' });
    const log: Array<{ state: LinkAuthState; event: unknown; out: string }> =
      [];
    const original = ctx.rig.auth;
    (ctx.rig as unknown as { auth: unknown }).auth = {
      initialState: original.initialState,
      reduce: (state: LinkAuthState, event: LinkAuthEvent) => {
        const result = original.reduce(state, event);
        log.push({ state, event, out: snapshot(result) });
        return result;
      },
    };
    const { rig, remote } = ctx;
    rig.start();
    rig.recv(remote.hello());
    rig.recv(remote.proof(rig), remote.origin);
    rig.recv(remote.confirm(rig), remote.origin);
    ctx.advance(3_000);
    rig.tick();
    remote.nonce = nonceN('replay-2');
    rig.recv(remote.hello(), remote.origin);
    rig.recv(remote.proof(rig, { key: devC }), remote.origin);
    ctx.advance(1_000);
    rig.tick();
    rig.restart();
    rig.recv('garbage');
    rig.disconnect();
    expect(log.length).toBeGreaterThan(10);

    const nonces = [...rig.nonces];
    const replay = createLinkAuthenticator({
      ...rig.deps,
      randomBytes: () =>
        new Uint8Array(Buffer.from(nonces.shift() as string, 'base64url')),
    });
    for (const entry of log) {
      expect(snapshot(replay.reduce(entry.state, entry.event as never))).toBe(
        entry.out,
      );
    }
    expect(nonces).toEqual([]);
  });

  it('no direct I/O: the module needs no clock, timer, network or random of its own', () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    const realSetTimeout = global.setTimeout;
    const realPerf = global.performance.now.bind(global.performance);
    let touched = 0;
    Date.now = () => {
      touched++;
      return realNow();
    };
    Math.random = () => {
      touched++;
      return realRandom();
    };
    global.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      touched++;
      return realSetTimeout(...args);
    }) as typeof setTimeout;
    global.performance.now = () => {
      touched++;
      return realPerf();
    };
    try {
      mutualSim();
      const ctx = mutualSolo();
      ctx.rig.restart();
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
      global.setTimeout = realSetTimeout;
      global.performance.now = realPerf;
    }
    // the test harness itself never touches them either, so any use would come from the module
    expect(touched).toBe(0);
  });

  describe('hostile event fuzzing', () => {
    const throwingGetter = {
      get kind(): string {
        throw new Error('hostile kind');
      },
    };
    const circular: Record<string, unknown> = { kind: 'received' };
    circular.self = circular;
    const polluted = JSON.parse(
      '{"__proto__": {"polluted": true}, "stage": "hello"}',
    );
    const junkValues: unknown[] = [
      undefined,
      null,
      NaN,
      -1,
      0,
      1e308,
      '',
      'x'.repeat(10_000),
      {},
      [],
      [[[[]]]],
      polluted,
      throwingGetter,
      circular,
      Object.create(null),
      () => 1,
      new Date(0),
      new Uint8Array(64),
      true,
      false,
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('hostile proxy');
          },
        },
      ),
    ];

    function fuzzRun(seed: number, steps: number): void {
      const rng = mulberry32(seed);
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(rng() * items.length)];
      const ctx = solo({
        signer: rng() < 0.5 ? 'auto' : 'manual',
        seed: `fuzz-${seed}`,
      });
      const { rig, remote } = ctx;
      watch(rig);
      const nonces = [0, 1, 2].map(i => nonceN(`fuzz-${seed}-${i}`));
      const hostileCredentials = [
        credentialFor(devB, { sessionId: OTHER_SESSION }),
        credentialFor(devB, {}, untrustedServer),
        credentialFor(devC),
        credentialFor(devB, { issuedAt: T0 - DAY, expiresAt: T0 + 1_000 }),
      ];
      const envelopes = (): Record<string, unknown> => {
        const roll = rng();
        if (roll < 0.7) return remote.origin;
        if (roll < 0.8) return { originId: nodeIdOf(devC) };
        if (roll < 0.9) return { hopCount: 1 };
        return { rideId: '99999' };
      };
      const safe = <T>(make: () => T, fallback: T): T => {
        try {
          return make();
        } catch {
          return fallback;
        }
      };
      if (rng() < 0.9) {
        rig.start();
      }
      for (let i = 0; i < steps; i++) {
        ctx.advance(Math.floor(rng() * 1_500));
        remote.nonce = pick(nonces);
        const roll = rng();
        if (roll < 0.12) {
          rig.apply({
            kind: pick([
              'start',
              'restart',
              'tick',
              'received',
              'signature_ready',
              'signature_failed',
              'disconnected',
              'nope',
            ]),
            connectionId: pick([rig.connectionId, 'other', ...junkValues]),
            binding: pick(junkValues),
            envelope: pick(junkValues),
            payload: pick(junkValues),
            requestId: pick(junkValues),
            signature: pick(junkValues),
            ...(rng() < 0.7
              ? rig.clocks()
              : { monoNow: pick(junkValues), wallNow: pick(junkValues) }),
          } as never);
        } else if (roll < 0.17) {
          rig.apply(pick(junkValues) as never);
        } else if (roll < 0.35) {
          const credential =
            rng() < 0.7 ? remote.credential : pick(hostileCredentials);
          rig.recv(
            remote.hello({
              credential,
              kind: pick(['nearby-auth-token-v1', 'unavailable'] as const),
            }),
            envelopes(),
          );
        } else if (roll < 0.5) {
          const over = pick([
            {},
            {},
            { key: devC },
            { transcript: 'A'.repeat(43) },
            { peerNonce: nonces[1] },
            { nonce: nonces[2] },
            { sig: 'A'.repeat(86) },
          ]);
          rig.recv(
            safe(() => remote.proof(rig, over), pick(junkValues)),
            envelopes(),
          );
        } else if (roll < 0.65) {
          const over = pick([
            {},
            {},
            { key: devC },
            { transcript: 'A'.repeat(43) },
            { peerNonce: nonces[1] },
            { nonce: nonces[2] },
          ]);
          rig.recv(
            safe(() => remote.confirm(rig, over), pick(junkValues)),
            envelopes(),
          );
        } else if (roll < 0.75) {
          rig.recv(pick(junkValues), envelopes());
        } else if (roll < 0.85) {
          rig.tick();
        } else if (roll < 0.88) {
          rig.restart();
        } else if (roll < 0.96) {
          const request = rig.pendingSigns.splice(0, 1)[0];
          if (request) {
            rig.apply({
              kind: rng() < 0.85 ? 'signature_ready' : 'signature_failed',
              connectionId: rig.connectionId,
              requestId: rng() < 0.9 ? request.requestId : pick(junkValues),
              signature:
                rng() < 0.8 ? rig.signatureFor(request) : pick(junkValues),
              ...rig.clocks(),
            });
          }
        } else {
          rig.apply({
            kind: 'signature_ready',
            connectionId: rig.connectionId,
            requestId: pick(junkValues),
            signature: pick(junkValues),
            ...rig.clocks(),
          });
        }
      }
      rig.disconnect();
      expect(rig.status).toBe('closed');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }

    it.each(Array.from({ length: 10 }, (_, i) => i))(
      'survives 300 hostile events (batch %i)',
      batch => {
        for (let s = 0; s < 5; s++) {
          fuzzRun(batch * 100 + s, 60);
        }
      },
    );
  });
});

// =================================================================================================
// Randomised two-node schedules (section F, item 16)
// =================================================================================================

describe('randomised schedules', () => {
  interface Schedule {
    drop: number;
    dup: number;
    maxDelay: number;
    restarts: boolean;
  }

  function runSchedule(seed: number, o: Schedule): Sim {
    const rng = mulberry32(seed);
    const sim = new Sim({ seed: `a${seed}` }, { seed: `b${seed}` });
    watch(sim.A);
    watch(sim.B);
    sim.channel = () => {
      if (rng() < o.drop) {
        return [];
      }
      const copies = rng() < o.dup ? 2 : 1;
      return Array.from({ length: copies }, () =>
        Math.floor(rng() * o.maxDelay),
      );
    };
    sim.startBoth();
    for (let t = 0; t < 40_000; t += 200) {
      sim.step(200);
      if (o.restarts && rng() < 0.01) {
        (rng() < 0.5 ? sim.A : sim.B).restart();
        sim.deliverDue();
      }
    }
    return sim;
  }

  function expectConsistent(sim: Sim): void {
    if (sim.bothMutual()) {
      expect(sim.A.attempt!.transcript).toBe(sim.B.attempt!.transcript);
      expect(sim.A.state.authenticated!.nodeId).toBe(sim.B.nodeId);
      expect(sim.B.state.authenticated!.nodeId).toBe(sim.A.nodeId);
    }
    for (const rig of sim.all) {
      const ids = rig
        .effectsOf('authenticated')
        .map(e => (e as { attemptId: number }).attemptId);
      expect(new Set(ids).size).toBe(ids.length);
      if (rig.status === 'failed') {
        expect(rig.state.authenticated).toBeNull();
      }
    }
  }

  const batches = Array.from({ length: 6 }, (_, i) => i);

  it.each(batches)(
    'without loss every schedule converges (batch %i of reordering and duplicates)',
    batch => {
      for (let s = 0; s < 25; s++) {
        const sim = runSchedule(batch * 1_000 + s, {
          drop: 0,
          dup: 0.3,
          maxDelay: 3_000,
          restarts: false,
        });
        expect(sim.bothMutual()).toBe(true);
        expect(sim.A.count('authenticated')).toBe(1);
        expect(sim.B.count('authenticated')).toBe(1);
        expectConsistent(sim);
      }
    },
    60_000,
  );

  it.each(batches)(
    'with loss, duplication, reordering and restarts the invariants hold (batch %i)',
    batch => {
      for (let s = 0; s < 25; s++) {
        const seed = 50_000 + batch * 1_000 + s;
        const sim = runSchedule(seed, {
          drop: 0.25,
          dup: 0.2,
          maxDelay: 2_500,
          restarts: seed % 2 === 1,
        });
        expectConsistent(sim);
      }
    },
    120_000,
  );

  it('moderate loss usually converges (a sanity check on the retransmission design)', () => {
    let converged = 0;
    for (let s = 0; s < 40; s++) {
      const sim = runSchedule(90_000 + s, {
        drop: 0.15,
        dup: 0,
        maxDelay: 500,
        restarts: false,
      });
      expectConsistent(sim);
      if (sim.bothMutual()) {
        converged++;
      }
    }
    expect(converged).toBeGreaterThanOrEqual(30);
  }, 60_000);

  it('is reproducible: the same seed gives the same message sequence', () => {
    const shape = (sim: Sim) =>
      sim.wires.map(w => `${w.from.name}:${w.stage}:${w.sentAt}`);
    const a = runSchedule(777, {
      drop: 0.2,
      dup: 0.2,
      maxDelay: 2_000,
      restarts: true,
    });
    const b = runSchedule(777, {
      drop: 0.2,
      dup: 0.2,
      maxDelay: 2_000,
      restarts: true,
    });
    expect(shape(a)).toEqual(shape(b));
    expect(a.A.status).toBe(b.A.status);
    expect(a.B.status).toBe(b.B.status);
  });
});

// =================================================================================================
// Further edge cases
// =================================================================================================

describe('further edge cases', () => {
  it('an undefined limit keeps its default', () => {
    const ctx = solo({
      limits: { retransmitIntervalMs: undefined, maxHelloSends: 2 },
    });
    ctx.rig.start();
    for (let t = 0; t < 10_000; t += 100) {
      ctx.advance(100);
      ctx.rig.tick();
    }
    expect(helloCount(ctx.rig)).toBe(2);
    expect(ctx.rig.sent).toHaveLength(2);
  });

  it('a local credential that expires before any peer is known fails on the tick', () => {
    const ctx = solo({ credentialOverrides: { expiresAt: WALL0 + 10_000 } });
    ctx.rig.start();
    ctx.advance(9_999);
    expect(reasonsOf(ctx.rig.tick(), 'failed')).toEqual([]);
    ctx.advance(1);
    expectFailed(ctx.rig, ctx.rig.tick(), 'local_credential_expired');
  });

  it('a local credential that expires exactly when the CONFIRM arrives never authenticates', () => {
    const ctx = solo({
      signer: 'auto',
      credentialOverrides: { expiresAt: WALL0 + 10_000 },
    });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.advance(10_000);
    const effects = ctx.rig.recv(
      ctx.remote.confirm(ctx.rig),
      ctx.remote.origin,
    );
    expectFailed(ctx.rig, effects, 'local_credential_expired');
  });

  it('a local credential that expires one millisecond later still authenticates', () => {
    const ctx = solo({
      signer: 'auto',
      credentialOverrides: { expiresAt: WALL0 + 10_000 },
    });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.advance(9_999);
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    expect(ctx.rig.status).toBe('mutual');
    expect(ctx.rig.state.authenticated!.expiresAt).toBe(WALL0 + 10_000);
  });

  it('a local credential that expires while our own CONFIRM is still being signed never authenticates', () => {
    const ctx = solo({ credentialOverrides: { expiresAt: WALL0 + 10_000 } });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.answer(); // PROOF sent
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    ctx.advance(10_000);
    ctx.rig.answer(); // our CONFIRM signature arrives after the credential expired
    expect(ctx.rig.status).toBe('failed');
    expect(ctx.rig.state.failure).toBe('local_credential_expired');
    expect(ctx.rig.count('authenticated')).toBe(0);
  });

  it('a signature completion that arrives after the peer credential expired never authenticates', () => {
    const ctx = solo(
      { signer: 'manual' },
      { credential: credentialFor(devB, { expiresAt: WALL0 + 10_000 }) },
    );
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.answer();
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    ctx.advance(10_000);
    ctx.rig.answer();
    expect(ctx.rig.state.failure).toBe('peer_credential_expired');
    expect(ctx.rig.count('authenticated')).toBe(0);
    expect(ctx.rig.sentStages()).toEqual(['hello', 'proof']); // a failing step sends nothing
  });

  it('a clock reading that goes backwards is clamped for every decision', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.advance(10_000);
    ctx.rig.tick();
    const high = ctx.clock.mono;
    expect(ctx.rig.state.lastMonoNow).toBe(high);
    // an event whose monotonic reading regressed all the way back to the start
    ctx.rig.apply({
      kind: 'received',
      connectionId: ctx.rig.connectionId,
      envelope: { ...ctx.remote.origin, hopCount: 0, rideId: RIDE },
      payload: ctx.remote.hello(),
      monoNow: MONO0,
      wallNow: ctx.clock.wall,
    });
    expect(ctx.rig.attempt!.localProof).toEqual({
      state: 'signing',
      requestId: 'conn-A#1#proof',
      requestedAt: high,
    });
    expect(ctx.rig.state.lastMonoNow).toBe(high);
    ctx.advance(4_999);
    expect(reasonsOf(ctx.rig.tick(), 'failed')).toEqual([]);
    ctx.advance(1);
    expectFailed(ctx.rig, ctx.rig.tick(), 'signer_timeout');
  });

  it('an unknown event kind with valid clocks is malformed and never behaves like a tick', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.advance(25_000); // far past the attempt deadline: only a real tick may fire it
    const before = ctx.rig.state;
    for (const kind of [
      'explode',
      'TICK',
      'Tick',
      '',
      ' tick',
      'toString',
      '__proto__',
      'constructor',
    ]) {
      const effects = ctx.rig.apply({
        kind,
        connectionId: ctx.rig.connectionId,
        ...ctx.rig.clocks(),
      });
      expect(reasonsOf(effects, 'rejected')).toEqual(['malformed']);
      expect(ctx.rig.state).toBe(before);
    }
    expect(ctx.rig.status).toBe('awaiting_peer_hello');
  });

  it('a HELLO replayed after a local restart is stale and costs no credential verification', () => {
    const ctx = mutualSolo();
    const old = ctx.remote.hello();
    ctx.rig.restart();
    expect(ctx.rig.attempt!.peer).toBeNull();
    const calls = ctx.rig.credentialSpy.mock.calls.length;
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(old, ctx.remote.origin),
      'stale',
    );
    expect(ctx.rig.credentialSpy.mock.calls.length).toBe(calls);
    expect(ctx.rig.status).toBe('awaiting_peer_hello');
  });

  it('in the failed phase a PROOF or CONFIRM with a fresh nonce is a failed-attempt message', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig, { key: devC }), ctx.remote.origin);
    expect(ctx.rig.status).toBe('failed');
    const fresh = nonceN('fresh-in-failed');
    expectRejected(
      ctx.rig,
      () =>
        ctx.rig.recv(
          ctx.remote.proof(ctx.rig, { nonce: fresh }),
          ctx.remote.origin,
        ),
      'failed_attempt',
    );
    expectRejected(
      ctx.rig,
      () =>
        ctx.rig.recv(
          ctx.remote.confirm(ctx.rig, { nonce: fresh }),
          ctx.remote.origin,
        ),
      'failed_attempt',
    );
    expect(ctx.rig.state.restartTimes).toEqual([]);
  });

  it('the restart window is exactly restartWindowMs long', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    ctx.advance(1_000);
    ctx.rig.restart();
    const first = ctx.clock.mono;
    ctx.advance(1_000);
    ctx.rig.restart();
    ctx.advance(1_000);
    ctx.rig.restart();
    ctx.advance(first + 59_999 - ctx.clock.mono);
    expectFailed(ctx.rig, ctx.rig.restart(), 'restart_flood');
    ctx.advance(1); // the oldest restart is now exactly one window old
    ctx.rig.restart();
    expect(ctx.rig.status).toBe('awaiting_peer_hello');
    expect(ctx.rig.state.failure).toBeNull();
  });

  it('a restart that fails to open leaves no attempt and no authentication behind', () => {
    const ctx = mutualSolo({
      credentialOverrides: { expiresAt: WALL0 + 10_000 },
    });
    ctx.advance(10_000);
    const effects = ctx.rig.restart();
    expect(effects.map(e => e.kind)).toEqual(['deauthenticated', 'failed']);
    expect(reasonsOf(effects, 'failed')).toEqual(['local_credential_expired']);
    expect(ctx.rig.state.attempt).toBeNull();
    expect(ctx.rig.state.authenticated).toBeNull();
    expect(ctx.rig.status).toBe('failed');
  });

  it('a duplicate PROOF or CONFIRM from the wrong sender is a sender mismatch, not a duplicate or a resend', () => {
    const ctx = mutualSolo();
    ctx.advance(5_000);
    const sent = ctx.rig.sent.length;
    expectRejected(
      ctx.rig,
      () =>
        ctx.rig.recv(ctx.remote.proof(ctx.rig), { originId: nodeIdOf(devC) }),
      'sender_mismatch',
    );
    expectRejected(
      ctx.rig,
      () =>
        ctx.rig.recv(ctx.remote.confirm(ctx.rig), { originId: nodeIdOf(devC) }),
      'sender_mismatch',
    );
    expect(ctx.rig.sent).toHaveLength(sent);
    expect(ctx.rig.status).toBe('mutual');
  });

  it('a CONFIRM that arrives after our PROOF but before the peer PROOF is buffered, not verified', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.answer(); // our PROOF is sent
    const verifies = ctx.rig.verifySpy.mock.calls.length;
    const effects = ctx.rig.recv(
      ctx.remote.confirm(ctx.rig),
      ctx.remote.origin,
    );
    expect(effects).toEqual([]);
    expect(ctx.rig.attempt!.earlyConfirm).not.toBeNull();
    expect(ctx.rig.attempt!.peerConfirm).toBe('none');
    expect(ctx.rig.verifySpy.mock.calls.length).toBe(verifies);
    // the PROOF then releases it
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    expect(ctx.rig.attempt!.peerConfirm).toBe('verified');
  });

  it('only the outstanding CONFIRM request completes the CONFIRM slot', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.answer();
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    const request = ctx.rig.pendingSigns[0];
    expect(request.stage).toBe('confirm');
    for (const requestId of [
      'nope',
      'conn-A#1#proof',
      'conn-A#2#confirm',
      'conn-B#1#confirm',
      '',
    ]) {
      for (const kind of ['signature_ready', 'signature_failed']) {
        expectRejected(
          ctx.rig,
          () =>
            ctx.rig.apply({
              kind,
              connectionId: ctx.rig.connectionId,
              requestId,
              signature: ctx.rig.signatureFor(request),
              ...ctx.rig.clocks(),
            }),
          'unknown_signature_request',
        );
      }
    }
    expect(ctx.rig.attempt!.localConfirm.state).toBe('signing');
    ctx.rig.answer();
    expect(ctx.rig.status).toBe('peer_proven');
  });

  it('disconnect leaves a closed state that holds no evidence of the connection', () => {
    const ctx = mutualSolo();
    ctx.rig.restart();
    expect(ctx.rig.state.restartTimes).toHaveLength(1);
    ctx.rig.disconnect();
    expect(ctx.rig.state).toMatchObject({
      phase: 'closed',
      binding: null,
      attempt: null,
      attemptCount: 0,
      failure: null,
      authenticated: null,
    });
    expect(ctx.rig.state.recentPeerNonces).toEqual([]);
    expect(ctx.rig.state.restartTimes).toEqual([]);
  });

  it('a Promise returned by randomBytes is neutralised', () => {
    const promise = Promise.resolve(new Uint8Array(16));
    const then = jest.spyOn(promise, 'then');
    const ctx = solo({ randomBytes: () => promise as never });
    expectFailed(ctx.rig, ctx.rig.start(), 'random_unavailable');
    expect(then).toHaveBeenCalled();
  });

  it('a Promise returned by the credential verifier is neutralised', () => {
    const real = trustedVerifier();
    const promise = Promise.resolve({ ok: true });
    const then = jest.spyOn(promise, 'then');
    const ctx = solo({ signer: 'auto' });
    ctx.rig.credentialSpy.mockImplementation(
      (credential: RideCredential, now: number) =>
        credential.nodeId === ctx.rig.nodeId
          ? real.verify(credential, now)
          : promise,
    );
    ctx.rig.start();
    expectFailed(
      ctx.rig,
      ctx.rig.recv(ctx.remote.hello(), ctx.remote.origin),
      'credential_invalid',
    );
    expect(then).toHaveBeenCalled();
  });

  it('rejects a local credential whose key is not the local key even when its node id is', () => {
    const clock = { mono: MONO0, wall: WALL0 };
    const forged = credentialFor(devA, {
      pub: encodeBase64Url(devC.publicKey),
    });
    expect(forged.nodeId).toBe(nodeIdOf(devA));
    expect(
      () => new Rig({ name: 'A', device: devA, clock, credential: forged }),
    ).toThrow(TypeError);
  });

  it('rejects a local public key that is not a Uint8Array', () => {
    const ctx = solo();
    const asArray = Array.from(devA.publicKey);
    expect(() =>
      createLinkAuthenticator({
        ...ctx.rig.deps,
        local: { credential: ctx.rig.credential, publicKey: asArray as never },
      }),
    ).toThrow(TypeError);
  });

  it('retransmission bookkeeping is disarmed as soon as it is no longer needed', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    expect(ctx.rig.attempt!.helloNextAt).not.toBeNull();
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin);
    expect(ctx.rig.attempt!.helloNextAt).toBeNull(); // the peer PROOF proves the peer has our HELLO
    expect(ctx.rig.attempt!.proofNextAt).not.toBeNull();
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    expect(ctx.rig.attempt!.proofNextAt).toBeNull(); // the peer CONFIRM proves the peer has our PROOF
    expect(ctx.rig.status).toBe('mutual');
  });

  it('stops retransmitting the PROOF once the peer CONFIRM is verified, even before our CONFIRM is signed', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.answer(); // PROOF sent, retransmission armed
    ctx.rig.recv(ctx.remote.proof(ctx.rig), ctx.remote.origin); // sign(confirm) pending
    ctx.rig.recv(ctx.remote.confirm(ctx.rig), ctx.remote.origin);
    expect(ctx.rig.attempt!.peerConfirm).toBe('verified');
    expect(ctx.rig.status).toBe('peer_proven'); // our own CONFIRM is still being signed
    const proofs = proofCount(ctx.rig);
    for (let t = 0; t < 4_500; t += 500) {
      ctx.advance(500);
      ctx.rig.tick();
    }
    expect(proofCount(ctx.rig)).toBe(proofs);
    ctx.rig.answer();
    expect(ctx.rig.status).toBe('mutual');
  });
});

// =================================================================================================
// Task 2.3.1 regression tests
// =================================================================================================

describe('hardening regressions', () => {
  it('a reflected own HELLO in the failed phase is refused without a restart', () => {
    const ctx = solo({ signer: 'auto' });
    ctx.rig.start();
    const ownHello = ctx.rig.sent[0];
    ctx.rig.recv(ctx.remote.hello());
    ctx.rig.recv(ctx.remote.proof(ctx.rig, { key: devC }), ctx.remote.origin);
    expect(ctx.rig.status).toBe('failed');
    expectRejected(
      ctx.rig,
      () => ctx.rig.recv(ownHello, { originId: ctx.rig.nodeId }),
      'self_hello',
    );
    expect(ctx.rig.state.restartTimes).toEqual([]);
  });

  it('a restart that fails on the new HELLO puts nothing on the wire', () => {
    const ctx = mutualSolo();
    const sent = ctx.rig.sent.length;
    const bad = new Remote(devB, {
      credential: credentialFor(devB, {}, untrustedServer),
      nonce: nonceN('bad-hello'),
    });
    const effects = ctx.rig.recv(bad.hello(), bad.origin);
    expect(effects.map(e => e.kind)).toEqual(['deauthenticated', 'failed']);
    expect(reasonsOf(effects, 'failed')).toEqual(['credential_bad_signature']);
    expect(ctx.rig.sent).toHaveLength(sent);
    expect(ctx.rig.status).toBe('failed');
  });

  it('a restart flood and a failed local restart also send nothing', () => {
    const ctx = solo({ signer: 'auto', limits: { maxRestartsPerWindow: 1 } });
    ctx.rig.start();
    ctx.advance(10);
    ctx.rig.restart();
    const sent = ctx.rig.sent.length;
    ctx.advance(10);
    const effects = ctx.rig.restart();
    expectFailed(ctx.rig, effects, 'restart_flood');
    expect(effects.some(e => e.kind === 'send' || e.kind === 'sign')).toBe(
      false,
    );
    expect(ctx.rig.sent).toHaveLength(sent);
  });

  it('no failure, anywhere, comes with a send or a sign effect', () => {
    const ctx = solo({ signer: 'auto' });
    watch(ctx.rig);
    ctx.rig.start();
    const origins = [ctx.remote.origin, { originId: nodeIdOf(devC) }];
    for (let i = 0; i < 30; i++) {
      ctx.advance(700);
      ctx.remote.nonce = nonceN(`nofail-${i}`);
      const credential =
        i % 3 === 0
          ? credentialFor(devB, { sessionId: OTHER_SESSION })
          : ctx.remote.credential;
      const effects = ctx.rig.recv(
        ctx.remote.hello({ credential }),
        origins[i % 2],
      );
      if (effects.some(e => e.kind === 'failed')) {
        expect(effects.some(e => e.kind === 'send' || e.kind === 'sign')).toBe(
          false,
        );
      }
      ctx.rig.tick();
    }
  });

  it('a verifier built for another session cannot start an attempt', () => {
    const ctx = solo({ verifier: trustedVerifier(OTHER_SESSION) });
    expectFailed(ctx.rig, ctx.rig.start(), 'local_credential_invalid');
    expect(ctx.rig.sent).toHaveLength(0);
    expect(ctx.rig.randomSpy).not.toHaveBeenCalled();
  });

  it('a verifier built for another ride cannot start an attempt', () => {
    const ctx = solo({ verifier: trustedVerifier(SESSION, '99999') });
    expectFailed(ctx.rig, ctx.rig.start(), 'local_credential_invalid');
    expect(ctx.rig.sent).toHaveLength(0);
  });

  it('after expiry and before the next tick the status lags but the link is not routable', () => {
    const ctx = mutualSolo({
      credentialOverrides: { expiresAt: WALL0 + 10_000 },
    });
    ctx.advance(10_000);
    expect(ctx.rig.status).toBe('mutual'); // nothing has reduced the clock yet
    for (const channelBinding of ['preferred', 'required'] as const) {
      expect(
        linkAuthRoutable(ctx.rig.state, ctx.clock.wall, { channelBinding }),
      ).toBe(false);
    }
    ctx.rig.tick();
    expect(ctx.rig.status).toBe('failed');
    expect(
      linkAuthRoutable(ctx.rig.state, ctx.clock.wall, {
        channelBinding: 'preferred',
      }),
    ).toBe(false);
  });

  it('routability requires an authenticated record, whatever the phase says', () => {
    const ctx = mutualSolo();
    const forged = { ...ctx.rig.state, authenticated: null } as LinkAuthState;
    expect(
      linkAuthRoutable(forged, ctx.clock.wall, { channelBinding: 'preferred' }),
    ).toBe(false);
    for (const expiresAt of ['never', Infinity, NaN]) {
      const badExpiry = {
        ...ctx.rig.state,
        authenticated: { ...ctx.rig.state.authenticated!, expiresAt },
      } as unknown as LinkAuthState;
      expect(
        linkAuthRoutable(badExpiry, ctx.clock.wall, {
          channelBinding: 'preferred',
        }),
      ).toBe(false);
    }
  });

  it('a late signature from a previous connection with the same id cannot authenticate the new one', () => {
    const old = solo({ connectionId: 'conn-X' });
    old.rig.start();
    old.rig.recv(old.remote.hello());
    const stale = old.rig.pendingSigns[0];
    const staleSignature = old.rig.signatureFor(stale);
    old.rig.disconnect();

    const fresh = solo({ connectionId: 'conn-X', seed: 'reconnect' });
    fresh.rig.start();
    fresh.remote.nonce = nonceN('reconnect-peer');
    fresh.rig.recv(fresh.remote.hello());
    const request = fresh.rig.pendingSigns[0];
    expect(request.requestId).toBe(stale.requestId); // the identifier collides
    expect(request.input).not.toBe(stale.input);
    const effects = fresh.rig.apply({
      kind: 'signature_ready',
      connectionId: 'conn-X',
      requestId: stale.requestId,
      signature: staleSignature,
      ...fresh.rig.clocks(),
    });
    expectFailed(fresh.rig, effects, 'signer_invalid_signature');
    expect(fresh.rig.sentStages()).toEqual(['hello']);
    expect(fresh.rig.count('authenticated')).toBe(0);
    // the closed old state ignores the same completion
    expectRejected(
      old.rig,
      () =>
        old.rig.apply({
          kind: 'signature_ready',
          connectionId: 'conn-X',
          requestId: stale.requestId,
          signature: staleSignature,
          ...old.rig.clocks(),
        }),
      'closed',
    );
  });

  it('a signature for an earlier attempt cannot complete a later attempt', () => {
    const ctx = solo();
    ctx.rig.start();
    ctx.rig.recv(ctx.remote.hello());
    const first = ctx.rig.pendingSigns.splice(0, 1)[0];
    const firstSignature = ctx.rig.signatureFor(first);
    ctx.advance(10);
    ctx.rig.restart();
    ctx.remote.nonce = nonceN('attempt-two');
    ctx.rig.recv(ctx.remote.hello());
    const second = ctx.rig.pendingSigns[0];
    expect(second.requestId).not.toBe(first.requestId);
    const effects = ctx.rig.apply({
      kind: 'signature_ready',
      connectionId: ctx.rig.connectionId,
      requestId: second.requestId,
      signature: firstSignature,
      ...ctx.rig.clocks(),
    });
    expectFailed(ctx.rig, effects, 'signer_invalid_signature');
    expect(ctx.rig.count('authenticated')).toBe(0);
    expect(ctx.rig.sentStages().filter(x => x === 'proof')).toHaveLength(0);
  });
});
