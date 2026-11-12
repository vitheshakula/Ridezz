/**
 * The offline link authenticator: a pure, deterministic state machine that authenticates ONE direct
 * Nearby link between two Rideaze nodes using the HELLO -> signed PROOF -> signed CONFIRM handshake
 * of protocol/linkAuth.ts. It is a reducer (`reduce(state, event) -> { state, effects }`) because
 * signing is asynchronous (Android Keystore behind the React Native bridge): the reducer emits a
 * `sign` effect and later receives the signature as an event. It performs no I/O and starts no
 * timers. All time (`monoNow` for timers, `wallNow` for credential validity) comes in on events,
 * all randomness through `deps.randomBytes`, all cryptography through injected functions.
 *
 * What this does and does not secure. A link reaches `mutual` only with complete cryptographic
 * evidence (see below). That authenticates the direct link. It does NOT authenticate application
 * traffic or the origin of multi-hop messages, and the existing Phase 1 Nearby SOS/hazard path is
 * still unauthenticated until it is migrated. Routing decisions also need the integration's link
 * registry (a later task), which this module only informs through its effects.
 *
 * Evidence required before `mutual` (and so before `authenticated` is emitted, once per attempt):
 *   - the peer's backend-issued credential verified for this room code AND session, valid now;
 *   - the peer's PROOF and CONFIRM verified against a transcript computed LOCALLY from verified
 *     credentials and locally observed binding (the peer's own transcript hash is only ever
 *     compared, never trusted), with the correct stage, against the key of the verified credential
 *     (whose node id is SHA-256 of that key);
 *   - the local PROOF and CONFIRM signed, SELF-VERIFIED and sent;
 *   - the peer's CONFIRM accepted only after the local PROOF was sent;
 *   - both credentials unexpired, and the connection and attempt current.
 *
 * Asymmetric completion. If the peer's CONFIRM is lost, this side can be `mutual` while the other is
 * not. That is safe: the `mutual` side holds full cryptographic evidence (the peer's signed CONFIRM
 * proves the peer verified us), and the other side stays non-routable. It repairs itself: the side
 * missing the CONFIRM retransmits its PROOF, and the `mutual` side answers each duplicate with its
 * stored CONFIRM (rate limited, never re-signed). If the repair does not arrive, the waiting side
 * times out into `failed` and may be restarted, which restarts both sides from fresh nonces.
 * Nothing in retransmission or acknowledgement can move a link to `mutual` without the evidence.
 *
 * Purity. `reduce` never throws and never mutates its input. Equal inputs and equal `randomBytes`
 * outputs give deep-equal results. States and effects are frozen and serialisable. NOTE: this
 * project's Babel preset compiles modules in sloppy mode (strictMode: false), so a write to a frozen
 * object is silently ignored rather than throwing; tests must detect mutation by comparing
 * snapshots. State size is bounded by constants (one attempt, at most two buffered messages, small
 * rings).
 *
 * Deliberate refinements of the contract (each reported with the implementation):
 *   - buffered early PROOF/CONFIRM records carry the envelope sender, so the sender check
 *     (invariant D.3) is still applied when they are processed;
 *   - a HELLO whose nonce is a recent stale nonce is rejected BEFORE credential verification, so
 *     replays cannot burn CPU (section E); outcomes are identical for any HELLO that would verify;
 *   - a HELLO whose envelope sender does not match its credential never triggers a restart;
 *   - while `mutual`, malformed messages are counted (saturating) but do not fail the link;
 *   - a new nonce equal to the previous attempt's nonce is `random_unavailable` (a stuck RNG).
 */

import {
  decodeBase64Url,
  encodeBase64Url,
  isUint8Array,
} from './protocol/base64url';
import {
  LINK_AUTH_NONCE_BYTES,
  LINK_AUTH_SIGNATURE_BYTES,
  buildLinkAuthConfirm,
  buildLinkAuthHello,
  buildLinkAuthProof,
  isCanonicalLinkAuthNonce,
  isCanonicalLinkAuthTranscriptHash,
  linkAuthSigningInput,
  linkAuthTranscript,
  parseLinkAuthPayload,
  verifyLinkAuthSignature,
  type LinkAuthConfirm,
  type LinkAuthHello,
  type LinkAuthPayload,
  type LinkAuthProof,
  type LocalChannelBinding,
} from './protocol/linkAuth';
import {
  RIDE_CREDENTIAL_PUBLIC_KEY_BYTES,
  deriveRideNodeId,
  isCanonicalRideSessionId,
  isValidRideCredentialRideId,
  parseRideCredential,
  rideCredentialSigningInput,
  type RideCredential,
  type RideCredentialRejection,
  type RideCredentialVerifier,
} from './protocol/rideCredential';

// ---- public types ----------------------------------------------------------------------------

export type LinkAuthStatus =
  | 'idle'
  | 'awaiting_peer_hello'
  | 'identified'
  | 'peer_proven'
  | 'mutual'
  | 'failed'
  | 'closed';
export type LinkAuthLevel = 'none' | 'identified' | 'peer_proven' | 'mutual';

export type LinkAuthSignSlot =
  | { readonly state: 'none' }
  | {
      readonly state: 'signing';
      readonly requestId: string;
      readonly requestedAt: number;
    }
  | { readonly state: 'sent'; readonly sig: string };

export interface LinkAuthPeer {
  readonly nodeId: string;
  readonly nonce: string;
  /** VERIFIED by `deps.credentialVerifier`. */
  readonly credential: RideCredential;
  readonly expiresAt: number;
}

export interface LinkAuthAttempt {
  /** 1, 2, 3 ... per connection. */
  readonly id: number;
  /** Monotonic. */
  readonly startedAt: number;
  readonly localNonce: string;
  readonly peer: LinkAuthPeer | null;
  /** LOCALLY computed transcript hash; set together with `peer`. */
  readonly transcript: string | null;
  readonly localProof: LinkAuthSignSlot;
  readonly peerProof: 'none' | 'verified';
  readonly localConfirm: LinkAuthSignSlot;
  readonly peerConfirm: 'none' | 'verified';
  /** At most one, addressed to `localNonce`. */
  readonly earlyProof: LinkAuthProof | null;
  /** The envelope sender of `earlyProof`, checked when it is processed. */
  readonly earlyProofOriginId: string | null;
  /** At most one, addressed to `localNonce`. */
  readonly earlyConfirm: LinkAuthConfirm | null;
  /** The envelope sender of `earlyConfirm`, checked when it is processed. */
  readonly earlyConfirmOriginId: string | null;
  readonly helloSends: number;
  readonly helloNextAt: number | null;
  readonly proofSends: number;
  readonly proofNextAt: number | null;
  readonly confirmResends: number;
  readonly confirmLastSentAt: number | null;
  readonly malformed: number;
}

export type LinkAuthDeauthReason =
  | 'restart'
  | 'credential_expired'
  | 'disconnected';

export type LinkAuthFailureReason =
  | 'binding_unavailable'
  | 'binding_mismatch'
  | 'local_credential_invalid'
  | 'local_credential_expired'
  | 'random_unavailable'
  | `credential_${RideCredentialRejection}`
  | 'identity_clash'
  | 'nonce_reuse'
  | 'transcript_mismatch'
  | 'bad_proof'
  | 'bad_confirm'
  | 'signer_unavailable'
  | 'signer_timeout'
  | 'signer_invalid_signature'
  | 'timeout'
  | 'peer_credential_expired'
  | 'restart_flood'
  | 'malformed_flood';

export type LinkAuthRejectReason =
  | 'malformed'
  | 'stale_connection'
  | 'not_started'
  | 'already_started'
  | 'closed'
  | 'not_direct'
  | 'wrong_ride'
  | 'sender_mismatch'
  | 'self_hello'
  | 'duplicate'
  | 'stale'
  | 'failed_attempt'
  | 'unexpected_stage'
  | 'unknown_signature_request';

export interface LinkAuthState {
  readonly connectionId: string;
  readonly phase: 'idle' | 'active' | 'failed' | 'closed';
  /** Set by `start`; never changes afterwards. */
  readonly binding: LocalChannelBinding | null;
  /** Monotonic times are clamped to be non-decreasing. */
  readonly lastMonoNow: number;
  readonly attemptCount: number;
  /** Present while 'active'; kept (read-only) after a failure that happens mid-attempt. */
  readonly attempt: LinkAuthAttempt | null;
  readonly restartTimes: readonly number[];
  readonly recentPeerNonces: readonly string[];
  readonly failure: LinkAuthFailureReason | null;
  readonly authenticated: {
    readonly nodeId: string;
    readonly expiresAt: number;
    readonly bound: boolean;
    readonly attemptId: number;
  } | null;
}

interface Clocks {
  readonly monoNow: number;
  readonly wallNow: number;
}

export type LinkAuthEvent =
  | ({
      kind: 'start';
      connectionId: string;
      binding: LocalChannelBinding;
    } & Clocks)
  | ({
      kind: 'received';
      connectionId: string;
      envelope: {
        readonly originId: string;
        readonly hopCount: number;
        readonly rideId: string;
      };
      payload: unknown;
    } & Clocks)
  | ({
      kind: 'signature_ready';
      connectionId: string;
      requestId: string;
      signature: Uint8Array;
    } & Clocks)
  | ({
      kind: 'signature_failed';
      connectionId: string;
      requestId: string;
    } & Clocks)
  | ({ kind: 'tick'; connectionId: string } & Clocks)
  | ({ kind: 'restart'; connectionId: string } & Clocks)
  | { kind: 'disconnected'; connectionId: string };

export type LinkAuthEffect =
  | { readonly kind: 'send'; readonly payload: LinkAuthPayload }
  | {
      readonly kind: 'sign';
      readonly requestId: string;
      readonly stage: 'proof' | 'confirm';
      readonly input: string;
    }
  | {
      readonly kind: 'authenticated';
      readonly nodeId: string;
      readonly credential: RideCredential;
      readonly bound: boolean;
      readonly expiresAt: number;
      readonly attemptId: number;
    }
  | {
      readonly kind: 'deauthenticated';
      readonly nodeId: string;
      readonly reason: LinkAuthDeauthReason;
    }
  | { readonly kind: 'failed'; readonly reason: LinkAuthFailureReason }
  | { readonly kind: 'rejected'; readonly reason: LinkAuthRejectReason };

export interface LinkAuthLimits {
  retransmitIntervalMs: number;
  maxHelloSends: number;
  maxProofSends: number;
  confirmResendMinIntervalMs: number;
  maxConfirmResends: number;
  attemptDeadlineMs: number;
  signerTimeoutMs: number;
  restartWindowMs: number;
  maxRestartsPerWindow: number;
  maxMalformedPerAttempt: number;
  recentPeerNonces: number;
}

export interface LinkAuthDeps {
  /** The room code. */
  readonly rideId: string;
  readonly sessionId: string;
  readonly local: {
    readonly credential: RideCredential;
    readonly publicKey: Uint8Array;
  };
  /** Built for (rideId, sessionId). */
  readonly credentialVerifier: RideCredentialVerifier;
  readonly verifySignature: (
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ) => boolean;
  readonly sha256: (data: Uint8Array) => Uint8Array;
  /** A CSPRNG; the reducer's only impure dependency. */
  readonly randomBytes: (length: number) => Uint8Array;
  readonly policy: { readonly channelBinding: 'required' | 'preferred' };
  readonly limits?: Partial<LinkAuthLimits>;
}

export interface LinkAuthenticator {
  initialState(connectionId: string): LinkAuthState;
  reduce(
    state: LinkAuthState,
    event: LinkAuthEvent,
  ): { state: LinkAuthState; effects: readonly LinkAuthEffect[] };
}

// ---- limits ----------------------------------------------------------------------------------

const DEFAULT_LIMITS: Readonly<LinkAuthLimits> = Object.freeze({
  retransmitIntervalMs: 2_000,
  maxHelloSends: 8,
  maxProofSends: 8,
  confirmResendMinIntervalMs: 2_000,
  maxConfirmResends: 8,
  attemptDeadlineMs: 20_000,
  signerTimeoutMs: 5_000,
  restartWindowMs: 60_000,
  maxRestartsPerWindow: 3,
  maxMalformedPerAttempt: 8,
  recentPeerNonces: 4,
});

const LIMIT_BOUNDS: Readonly<
  Record<keyof LinkAuthLimits, readonly [number, number]>
> = Object.freeze({
  retransmitIntervalMs: [100, 60_000],
  maxHelloSends: [1, 64],
  maxProofSends: [1, 64],
  confirmResendMinIntervalMs: [100, 60_000],
  maxConfirmResends: [1, 64],
  attemptDeadlineMs: [1_000, 600_000],
  signerTimeoutMs: [100, 120_000],
  restartWindowMs: [1_000, 3_600_000],
  maxRestartsPerWindow: [1, 16],
  maxMalformedPerAttempt: [1, 64],
  recentPeerNonces: [1, 16],
});

const CONNECTION_ID_MAX_LENGTH = 128;
const EVENT_KINDS: readonly string[] = [
  'start',
  'received',
  'signature_ready',
  'signature_failed',
  'tick',
  'restart',
  'disconnected',
];
const EFFECT_ORDER: readonly LinkAuthEffect['kind'][] = [
  'deauthenticated',
  'failed',
  'send',
  'sign',
  'authenticated',
  'rejected',
];

// ---- small helpers ---------------------------------------------------------------------------

const isTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every(key => keys.includes(key))
  );
}

/** A Promise returned by an injected function by mistake must not become an unhandled rejection. */
function discardPending(result: unknown): void {
  try {
    if (
      (typeof result === 'object' || typeof result === 'function') &&
      result !== null &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      Promise.resolve(result).then(undefined, () => undefined);
    }
  } catch {
    // Nothing to do: the caller already treats the value as a failure.
  }
}

function isValidConnectionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CONNECTION_ID_MAX_LENGTH &&
    !value.includes('#')
  );
}

function readBinding(raw: unknown): LocalChannelBinding | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const kind = raw.kind;
  if (kind === 'nearby-auth-token-v1') {
    if (!hasExactKeys(raw, ['kind', 'digest'])) {
      return null;
    }
    const digest = raw.digest;
    return isCanonicalLinkAuthTranscriptHash(digest)
      ? Object.freeze({ kind, digest })
      : null;
  }
  if (kind === 'unavailable') {
    return hasExactKeys(raw, ['kind']) ? Object.freeze({ kind }) : null;
  }
  return null;
}

// ---- resolved configuration ------------------------------------------------------------------

interface Resolved {
  readonly rideId: string;
  readonly sessionId: string;
  readonly local: {
    readonly credential: RideCredential;
    readonly publicKey: Uint8Array;
    readonly nodeId: string;
    readonly expiresAt: number;
  };
  readonly credentialVerifier: RideCredentialVerifier;
  readonly verifySignature: LinkAuthDeps['verifySignature'];
  readonly sha256: LinkAuthDeps['sha256'];
  readonly randomBytes: LinkAuthDeps['randomBytes'];
  readonly policy: LinkAuthDeps['policy'];
  readonly limits: Readonly<LinkAuthLimits>;
}

function resolveLimits(raw: unknown): Readonly<LinkAuthLimits> {
  if (raw === undefined) {
    return DEFAULT_LIMITS;
  }
  if (!isPlainObject(raw)) {
    throw new TypeError('LinkAuthenticator limits must be an object');
  }
  const merged: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(raw)) {
    const bounds = (LIMIT_BOUNDS as Record<string, readonly [number, number]>)[
      key
    ];
    if (!bounds) {
      throw new TypeError(`Unknown LinkAuthenticator limit: ${key}`);
    }
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < bounds[0] ||
      (value as number) > bounds[1]
    ) {
      throw new TypeError(
        `LinkAuthenticator limit ${key} must be an integer in [${bounds[0]}, ${bounds[1]}]`,
      );
    }
    merged[key] = value as number;
  }
  return Object.freeze(merged as unknown as LinkAuthLimits);
}

function resolveDeps(deps: LinkAuthDeps): Resolved {
  if (!isPlainObject(deps)) {
    throw new TypeError('createLinkAuthenticator needs a dependencies object');
  }
  const {
    rideId,
    sessionId,
    local,
    credentialVerifier,
    verifySignature,
    sha256,
    randomBytes,
    policy,
    limits,
  } = deps;
  if (!isValidRideCredentialRideId(rideId)) {
    throw new TypeError(
      'LinkAuthenticator rideId must be a five-digit room code',
    );
  }
  if (!isCanonicalRideSessionId(sessionId)) {
    throw new TypeError(
      'LinkAuthenticator sessionId must be a canonical ride session id',
    );
  }
  if (
    typeof verifySignature !== 'function' ||
    typeof sha256 !== 'function' ||
    typeof randomBytes !== 'function'
  ) {
    throw new TypeError(
      'LinkAuthenticator needs verifySignature, sha256 and randomBytes functions',
    );
  }
  if (
    !isPlainObject(credentialVerifier) ||
    typeof (credentialVerifier as { verify?: unknown }).verify !== 'function'
  ) {
    throw new TypeError('LinkAuthenticator needs a credential verifier');
  }
  if (
    !isPlainObject(policy) ||
    (policy.channelBinding !== 'required' &&
      policy.channelBinding !== 'preferred')
  ) {
    throw new TypeError(
      "LinkAuthenticator policy.channelBinding must be 'required' or 'preferred'",
    );
  }
  if (!isPlainObject(local)) {
    throw new TypeError(
      'LinkAuthenticator needs a local credential and public key',
    );
  }
  const localCredentialValue = local.credential;
  const localKey = local.publicKey;
  const credential = parseRideCredential(localCredentialValue);
  if (!credential) {
    throw new TypeError(
      'The local credential is not a structurally valid RideCredential',
    );
  }
  if (credential.rideId !== rideId || credential.sessionId !== sessionId) {
    throw new TypeError(
      'The local credential belongs to a different ride or session',
    );
  }
  if (
    !isUint8Array(localKey) ||
    localKey.length !== RIDE_CREDENTIAL_PUBLIC_KEY_BYTES ||
    localKey[0] !== 0x04
  ) {
    throw new TypeError(
      'The local public key must be a 65-byte uncompressed P-256 point',
    );
  }
  const publicKey = Uint8Array.from(localKey);
  if (encodeBase64Url(publicKey) !== credential.pub) {
    throw new TypeError(
      'The local public key does not match the local credential',
    );
  }
  if (
    deriveRideNodeId(Uint8Array.from(publicKey), sha256) !== credential.nodeId
  ) {
    throw new TypeError(
      'The local credential node id is not derived from the local public key',
    );
  }
  return {
    rideId,
    sessionId,
    local: Object.freeze({
      credential,
      publicKey,
      nodeId: credential.nodeId,
      expiresAt: credential.expiresAt,
    }),
    credentialVerifier,
    verifySignature,
    sha256,
    randomBytes,
    policy: Object.freeze({ channelBinding: policy.channelBinding }),
    limits: resolveLimits(limits),
  };
}

// ---- derived views ---------------------------------------------------------------------------

function isStateLike(state: unknown): state is LinkAuthState {
  return isPlainObject(state) && typeof state.phase === 'string';
}

export function linkAuthStatus(state: LinkAuthState): LinkAuthStatus {
  try {
    if (!isStateLike(state)) {
      return 'closed';
    }
    switch (state.phase) {
      case 'idle':
        return 'idle';
      case 'failed':
        return 'failed';
      case 'active': {
        if (state.authenticated !== null) {
          return 'mutual';
        }
        const peer = state.attempt?.peer ?? null;
        if (peer === null) {
          return 'awaiting_peer_hello';
        }
        return state.attempt?.peerProof === 'verified'
          ? 'peer_proven'
          : 'identified';
      }
      default:
        return 'closed';
    }
  } catch {
    return 'closed';
  }
}

export function linkAuthLevel(state: LinkAuthState): LinkAuthLevel {
  switch (linkAuthStatus(state)) {
    case 'identified':
      return 'identified';
    case 'peer_proven':
      return 'peer_proven';
    case 'mutual':
      return 'mutual';
    default:
      return 'none';
  }
}

/**
 * True only for a `mutual` link whose evidence still holds: unexpired credentials and, under the
 * `required` policy, a link that was established with channel binding. Routing additionally needs
 * the integration's registry to confirm the connection has not been superseded. No other state is
 * ever routable.
 */
export function linkAuthRoutable(
  state: LinkAuthState,
  wallNow: number,
  policy: { channelBinding: 'required' | 'preferred' },
): boolean {
  try {
    if (!isTimestamp(wallNow) || !isPlainObject(policy)) {
      return false;
    }
    // Explicitly require an authenticated record, whatever the phase says.
    const authenticated = state.authenticated;
    if (
      !isPlainObject(authenticated) ||
      linkAuthStatus(state) !== 'mutual' ||
      !isTimestamp(authenticated.expiresAt)
    ) {
      return false;
    }
    if (policy.channelBinding === 'required') {
      if (authenticated.bound !== true) {
        return false;
      }
    } else if (policy.channelBinding !== 'preferred') {
      return false;
    }
    return wallNow < authenticated.expiresAt;
  } catch {
    return false;
  }
}

// ---- the reducer's working context -----------------------------------------------------------

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type AttemptDraft = Writable<LinkAuthAttempt>;

interface Draft {
  phase: LinkAuthState['phase'];
  binding: LocalChannelBinding | null;
  attemptCount: number;
  attempt: AttemptDraft | null;
  restartTimes: number[];
  recentPeerNonces: string[];
  failure: LinkAuthFailureReason | null;
  authenticated: LinkAuthState['authenticated'];
}

interface Ctx {
  readonly r: Resolved;
  readonly d: Draft;
  readonly connectionId: string;
  readonly mono: number;
  readonly wall: number;
  readonly effects: LinkAuthEffect[];
  /** True once the draft has been changed. */
  dirty: boolean;
}

const NO_SLOT: LinkAuthSignSlot = Object.freeze({ state: 'none' });

function draftOf(state: LinkAuthState): Draft {
  const attempt = state.attempt;
  return {
    phase: state.phase,
    binding: state.binding,
    attemptCount: state.attemptCount,
    attempt: attempt ? { ...attempt } : null,
    restartTimes: [...state.restartTimes],
    recentPeerNonces: [...state.recentPeerNonces],
    failure: state.failure,
    authenticated: state.authenticated,
  };
}

function freezeAttempt(a: AttemptDraft): LinkAuthAttempt {
  return Object.freeze({ ...a });
}

function freezeDraft(
  connectionId: string,
  lastMonoNow: number,
  d: Draft,
): LinkAuthState {
  return Object.freeze({
    connectionId,
    phase: d.phase,
    binding: d.binding,
    lastMonoNow,
    attemptCount: d.attemptCount,
    attempt: d.attempt ? freezeAttempt(d.attempt) : null,
    restartTimes: Object.freeze([...d.restartTimes]),
    recentPeerNonces: Object.freeze([...d.recentPeerNonces]),
    failure: d.failure,
    authenticated: d.authenticated
      ? Object.freeze({ ...d.authenticated })
      : null,
  });
}

function finishEffects(
  effects: readonly LinkAuthEffect[],
): readonly LinkAuthEffect[] {
  const ordered: LinkAuthEffect[] = [];
  for (const kind of EFFECT_ORDER) {
    for (const effect of effects) {
      if (effect.kind === kind) {
        ordered.push(Object.freeze(effect));
      }
    }
  }
  return Object.freeze(ordered);
}

const reject = (c: Ctx, reason: LinkAuthRejectReason): void => {
  c.effects.push({ kind: 'rejected', reason });
};

function deauthIfMutual(c: Ctx, reason: LinkAuthDeauthReason): void {
  const authenticated = c.d.authenticated;
  if (authenticated) {
    c.effects.push({
      kind: 'deauthenticated',
      nodeId: authenticated.nodeId,
      reason,
    });
    c.d.authenticated = null;
    c.dirty = true;
  }
}

/** Ends the attempt unrecoverably. No failed attempt is ever routable. */
function failNow(c: Ctx, reason: LinkAuthFailureReason): void {
  const { d } = c;
  deauthIfMutual(
    c,
    reason === 'peer_credential_expired' ||
      reason === 'local_credential_expired'
      ? 'credential_expired'
      : 'restart',
  );
  d.phase = 'failed';
  d.failure = reason;
  d.authenticated = null;
  const a = d.attempt;
  if (a) {
    if (a.localProof.state === 'signing') {
      a.localProof = NO_SLOT;
    }
    if (a.localConfirm.state === 'signing') {
      a.localConfirm = NO_SLOT;
    }
    a.helloNextAt = null;
    a.proofNextAt = null;
  }
  // A failed attempt must neither ask for signatures nor put new handshake messages on the wire.
  for (let i = c.effects.length - 1; i >= 0; i--) {
    if (c.effects[i].kind === 'sign' || c.effects[i].kind === 'send') {
      c.effects.splice(i, 1);
    }
  }
  c.effects.push({ kind: 'failed', reason });
  c.dirty = true;
}

// ---- credential, nonce and signature helpers -------------------------------------------------

type CredentialCheck =
  | { readonly ok: true; readonly credential: RideCredential }
  | { readonly ok: false; readonly reason: RideCredentialRejection };

function verifyCredential(c: Ctx, credential: RideCredential): CredentialCheck {
  try {
    const result = c.r.credentialVerifier.verify(credential, c.wall) as unknown;
    // The verifier is synchronous: a Promise returned by mistake is never trusted or awaited.
    discardPending(result);
    if (!isPlainObject(result)) {
      return { ok: false, reason: 'invalid' };
    }
    if (result.ok !== true) {
      const reason = result.reason;
      return {
        ok: false,
        reason:
          typeof reason === 'string'
            ? (reason as RideCredentialRejection)
            : 'invalid',
      };
    }
    // The verified credential must be the very one that was presented.
    const verified = parseRideCredential(result.credential);
    if (
      !verified ||
      rideCredentialSigningInput(verified) !==
        rideCredentialSigningInput(credential)
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, credential: verified };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

function freshNonce(r: Resolved, previous: string | null): string | null {
  try {
    const bytes = r.randomBytes(LINK_AUTH_NONCE_BYTES) as unknown;
    if (!isUint8Array(bytes) || bytes.length !== LINK_AUTH_NONCE_BYTES) {
      discardPending(bytes);
      return null;
    }
    const nonce = encodeBase64Url(bytes);
    // Never reused: a nonce equal to the previous attempt's means the random source is stuck.
    if (!isCanonicalLinkAuthNonce(nonce) || nonce === previous) {
      return null;
    }
    return nonce;
  } catch {
    return null;
  }
}

function peerPublicKey(peer: LinkAuthPeer): Uint8Array | null {
  return decodeBase64Url(peer.credential.pub);
}

function verifyPeerSignature(
  c: Ctx,
  a: AttemptDraft,
  stage: 'proof' | 'confirm',
  sig: string,
): boolean {
  const peer = a.peer;
  const transcript = a.transcript;
  const key = peer ? peerPublicKey(peer) : null;
  const signature = decodeBase64Url(sig);
  if (!peer || transcript === null || !key || !signature) {
    return false;
  }
  return verifyLinkAuthSignature(
    {
      stage,
      signer: peer.nodeId,
      peer: c.r.local.nodeId,
      transcript,
      signerPublicKey: key,
      signature,
    },
    c.r.verifySignature,
    c.r.sha256,
  );
}

function verifyOwnSignature(
  c: Ctx,
  a: AttemptDraft,
  stage: 'proof' | 'confirm',
  signature: unknown,
): string | null {
  const peer = a.peer;
  const transcript = a.transcript;
  if (
    !peer ||
    transcript === null ||
    !isUint8Array(signature) ||
    signature.length !== LINK_AUTH_SIGNATURE_BYTES
  ) {
    return null;
  }
  const accepted = verifyLinkAuthSignature(
    {
      stage,
      signer: c.r.local.nodeId,
      peer: peer.nodeId,
      transcript,
      signerPublicKey: c.r.local.publicKey,
      signature,
    },
    c.r.verifySignature,
    c.r.sha256,
  );
  return accepted ? encodeBase64Url(signature) : null;
}

const requestIdFor = (
  c: Ctx,
  a: AttemptDraft,
  stage: 'proof' | 'confirm',
): string => `${c.connectionId}#${a.id}#${stage}`;

/** Emits a signing request for the given stage (at most one is ever outstanding). */
function requestSign(
  c: Ctx,
  a: AttemptDraft,
  stage: 'proof' | 'confirm',
): boolean {
  const peer = a.peer;
  if (!peer || a.transcript === null) {
    return false;
  }
  let input: string;
  try {
    input = linkAuthSigningInput(stage, {
      signer: c.r.local.nodeId,
      peer: peer.nodeId,
      transcript: a.transcript,
    });
  } catch {
    failNow(c, 'signer_unavailable');
    return false;
  }
  const requestId = requestIdFor(c, a, stage);
  const slot: LinkAuthSignSlot = Object.freeze({
    state: 'signing',
    requestId,
    requestedAt: c.mono,
  });
  if (stage === 'proof') {
    a.localProof = slot;
  } else {
    a.localConfirm = slot;
  }
  c.effects.push({ kind: 'sign', requestId, stage, input });
  c.dirty = true;
  return true;
}

// ---- attempts --------------------------------------------------------------------------------

function helloPayload(c: Ctx, a: AttemptDraft): LinkAuthPayload {
  const binding = c.d.binding as LocalChannelBinding;
  return buildLinkAuthHello({
    credential: c.r.local.credential,
    nonce: a.localNonce,
    bindingKind: binding.kind,
  });
}

function proofPayload(a: AttemptDraft): LinkAuthPayload {
  const sent = a.localProof as { sig: string };
  return buildLinkAuthProof({
    nonce: a.localNonce,
    peerNonce: (a.peer as LinkAuthPeer).nonce,
    transcript: a.transcript as string,
    sig: sent.sig,
  });
}

function confirmPayload(a: AttemptDraft): LinkAuthPayload {
  const sent = a.localConfirm as { sig: string };
  return buildLinkAuthConfirm({
    nonce: a.localNonce,
    peerNonce: (a.peer as LinkAuthPeer).nonce,
    transcript: a.transcript as string,
    sig: sent.sig,
  });
}

/**
 * Opens a fresh attempt (a new nonce, a HELLO on the wire). On any precondition failure the
 * connection moves to `failed` and nothing is sent. Returns whether the attempt was opened.
 */
function openAttempt(c: Ctx, previousNonce: string | null): boolean {
  const { r, d } = c;
  const binding = d.binding;
  if (!binding) {
    failNow(c, 'binding_unavailable');
    return false;
  }
  if (
    r.policy.channelBinding === 'required' &&
    binding.kind === 'unavailable'
  ) {
    failNow(c, 'binding_unavailable');
    return false;
  }
  const local = verifyCredential(c, r.local.credential);
  if (!local.ok) {
    failNow(
      c,
      local.reason === 'expired'
        ? 'local_credential_expired'
        : 'local_credential_invalid',
    );
    return false;
  }
  const nonce = freshNonce(r, previousNonce);
  if (nonce === null) {
    failNow(c, 'random_unavailable');
    return false;
  }
  d.attemptCount += 1;
  const attempt: AttemptDraft = {
    id: d.attemptCount,
    startedAt: c.mono,
    localNonce: nonce,
    peer: null,
    transcript: null,
    localProof: NO_SLOT,
    peerProof: 'none',
    localConfirm: NO_SLOT,
    peerConfirm: 'none',
    earlyProof: null,
    earlyProofOriginId: null,
    earlyConfirm: null,
    earlyConfirmOriginId: null,
    helloSends: 1,
    helloNextAt: c.mono + r.limits.retransmitIntervalMs,
    proofSends: 0,
    proofNextAt: null,
    confirmResends: 0,
    confirmLastSentAt: null,
    malformed: 0,
  };
  d.attempt = attempt;
  d.phase = 'active';
  d.failure = null;
  d.authenticated = null;
  c.effects.push({ kind: 'send', payload: helloPayload(c, attempt) });
  c.dirty = true;
  return true;
}

/**
 * A restart (requested locally or by a peer HELLO with a new nonce) within the rolling budget:
 * the current attempt is discarded and a new one is opened. Returns whether it was opened.
 */
function restartAttempt(c: Ctx): boolean {
  const { r, d } = c;
  d.restartTimes = d.restartTimes.filter(
    t => c.mono - t < r.limits.restartWindowMs,
  );
  if (d.restartTimes.length >= r.limits.maxRestartsPerWindow) {
    failNow(c, 'restart_flood');
    return false;
  }
  d.restartTimes.push(c.mono);
  deauthIfMutual(c, 'restart');
  const previousNonce = d.attempt ? d.attempt.localNonce : null;
  d.attempt = null;
  c.dirty = true;
  return openAttempt(c, previousNonce);
}

// ---- handshake rules -------------------------------------------------------------------------

const isAddressed = (a: AttemptDraft, p: { peerNonce: string }): boolean =>
  p.peerNonce === a.localNonce;

const isCurrent = (
  a: AttemptDraft,
  p: { nonce: string; peerNonce: string },
): boolean =>
  a.peer !== null && p.nonce === a.peer.nonce && p.peerNonce === a.localNonce;

/** Rule 17: the single place where a link becomes `mutual`. */
function maybeAuthenticate(c: Ctx, a: AttemptDraft): void {
  const peer = a.peer;
  if (
    c.d.authenticated !== null ||
    !peer ||
    a.localProof.state !== 'sent' ||
    a.peerProof !== 'verified' ||
    a.localConfirm.state !== 'sent' ||
    a.peerConfirm !== 'verified'
  ) {
    return;
  }
  if (c.wall >= peer.expiresAt) {
    failNow(c, 'peer_credential_expired');
    return;
  }
  if (c.wall >= c.r.local.expiresAt) {
    failNow(c, 'local_credential_expired');
    return;
  }
  const binding = c.d.binding as LocalChannelBinding;
  const bound = binding.kind === 'nearby-auth-token-v1';
  const expiresAt = Math.min(peer.expiresAt, c.r.local.expiresAt);
  c.d.authenticated = {
    nodeId: peer.nodeId,
    expiresAt,
    bound,
    attemptId: a.id,
  };
  c.effects.push({
    kind: 'authenticated',
    nodeId: peer.nodeId,
    credential: peer.credential,
    bound,
    expiresAt,
    attemptId: a.id,
  });
  c.dirty = true;
}

/** Rule 12: the peer's PROOF (current, not yet verified). */
function processProof(
  c: Ctx,
  a: AttemptDraft,
  p: LinkAuthProof,
  originId: string | null,
): void {
  const peer = a.peer as LinkAuthPeer;
  if (originId !== peer.nodeId) {
    reject(c, 'sender_mismatch');
    return;
  }
  if (p.transcript !== a.transcript) {
    failNow(c, 'transcript_mismatch');
    return;
  }
  if (!verifyPeerSignature(c, a, 'proof', p.sig)) {
    failNow(c, 'bad_proof');
    return;
  }
  a.peerProof = 'verified';
  a.helloNextAt = null;
  c.dirty = true;
  if (a.localProof.state === 'sent' && a.localConfirm.state === 'none') {
    if (!requestSign(c, a, 'confirm')) {
      return;
    }
  }
  drainEarly(c, a);
}

/** Rule 16: the peer's CONFIRM (current; our PROOF was sent and the peer's PROOF verified). */
function processConfirm(
  c: Ctx,
  a: AttemptDraft,
  p: LinkAuthConfirm,
  originId: string | null,
): void {
  const peer = a.peer as LinkAuthPeer;
  if (originId !== peer.nodeId) {
    reject(c, 'sender_mismatch');
    return;
  }
  if (p.transcript !== a.transcript) {
    failNow(c, 'transcript_mismatch');
    return;
  }
  if (!verifyPeerSignature(c, a, 'confirm', p.sig)) {
    failNow(c, 'bad_confirm');
    return;
  }
  a.peerConfirm = 'verified';
  a.proofNextAt = null;
  c.dirty = true;
  maybeAuthenticate(c, a);
}

/** Processes the buffered early PROOF/CONFIRM once the state allows it. */
function drainEarly(c: Ctx, a: AttemptDraft): void {
  if (c.d.phase !== 'active' || !a.peer) {
    return;
  }
  if (a.earlyProof !== null && a.peerProof === 'none') {
    const p = a.earlyProof;
    const originId = a.earlyProofOriginId;
    a.earlyProof = null;
    a.earlyProofOriginId = null;
    if (isCurrent(a, p)) {
      processProof(c, a, p, originId);
    } else {
      reject(c, 'stale');
    }
    if (c.d.phase !== 'active') {
      return;
    }
  }
  if (
    a.earlyConfirm !== null &&
    a.peerProof === 'verified' &&
    a.localProof.state === 'sent' &&
    a.peerConfirm === 'none'
  ) {
    const p = a.earlyConfirm;
    const originId = a.earlyConfirmOriginId;
    a.earlyConfirm = null;
    a.earlyConfirmOriginId = null;
    if (isCurrent(a, p)) {
      processConfirm(c, a, p, originId);
    } else {
      reject(c, 'stale');
    }
  }
}

/** Rule 6: the first acceptable HELLO of an attempt. */
function acceptHello(
  c: Ctx,
  a: AttemptDraft,
  hello: LinkAuthHello,
  originId: string,
): void {
  const { r, d } = c;
  if (originId !== hello.credential.nodeId) {
    reject(c, 'sender_mismatch');
    return;
  }
  // Cheap replay check first: a replayed HELLO must not cost a credential verification.
  if (d.recentPeerNonces.includes(hello.nonce)) {
    reject(c, 'stale');
    return;
  }
  const check = verifyCredential(c, hello.credential);
  if (!check.ok) {
    failNow(c, `credential_${check.reason}`);
    return;
  }
  const credential = check.credential;
  if (credential.nodeId === r.local.nodeId) {
    failNow(c, 'identity_clash');
    return;
  }
  const binding = d.binding as LocalChannelBinding;
  if (hello.binding.kind !== binding.kind) {
    failNow(c, 'binding_mismatch');
    return;
  }
  if (hello.nonce === a.localNonce) {
    failNow(c, 'nonce_reuse');
    return;
  }
  const peer: LinkAuthPeer = Object.freeze({
    nodeId: credential.nodeId,
    nonce: hello.nonce,
    credential,
    expiresAt: credential.expiresAt,
  });
  let transcript: string;
  try {
    transcript = linkAuthTranscript(
      {
        rideId: r.rideId,
        sessionId: r.sessionId,
        binding,
        local: {
          nodeId: r.local.nodeId,
          nonce: a.localNonce,
          credential: r.local.credential,
        },
        peer: { nodeId: peer.nodeId, nonce: peer.nonce, credential },
      },
      r.sha256,
    ).hash;
  } catch {
    failNow(c, 'credential_invalid');
    return;
  }
  d.recentPeerNonces = [...d.recentPeerNonces, hello.nonce].slice(
    -r.limits.recentPeerNonces,
  );
  a.peer = peer;
  a.transcript = transcript;
  c.dirty = true;
  if (!requestSign(c, a, 'proof')) {
    return;
  }
  drainEarly(c, a);
}

/** Rule 8: a HELLO with a new nonce from a peer that is already known (or after a failure). */
function restartOnPeerHello(
  c: Ctx,
  hello: LinkAuthHello,
  originId: string,
): void {
  // A HELLO whose sender does not match its own credential must never tear anything down.
  if (originId !== hello.credential.nodeId) {
    reject(c, 'sender_mismatch');
    return;
  }
  // A reflected copy of our own HELLO must never tear down an attempt or a mutual link.
  if (hello.credential.nodeId === c.r.local.nodeId) {
    reject(c, 'self_hello');
    return;
  }
  if (!restartAttempt(c)) {
    return;
  }
  acceptHello(c, c.d.attempt as AttemptDraft, hello, originId);
}

function onMalformed(c: Ctx, a: AttemptDraft): void {
  const max = c.r.limits.maxMalformedPerAttempt;
  // Saturating, so the counter stays bounded however much garbage arrives (and a saturated
  // counter changes nothing, so the state object itself is returned unchanged).
  const next = Math.min(a.malformed + 1, max + 1);
  if (next !== a.malformed) {
    a.malformed = next;
    c.dirty = true;
  }
  if (c.d.authenticated === null && a.malformed > max) {
    failNow(c, 'malformed_flood');
    return;
  }
  reject(c, 'malformed');
}

function onHello(c: Ctx, hello: LinkAuthHello, originId: string): void {
  const { d } = c;
  const a = d.attempt;
  if (d.phase === 'failed') {
    if (d.recentPeerNonces.includes(hello.nonce)) {
      reject(c, 'failed_attempt');
      return;
    }
    restartOnPeerHello(c, hello, originId);
    return;
  }
  if (!a) {
    reject(c, 'failed_attempt');
    return;
  }
  if (a.peer === null) {
    acceptHello(c, a, hello, originId);
    return;
  }
  if (hello.nonce === a.peer.nonce) {
    reject(c, 'duplicate');
    return;
  }
  if (d.recentPeerNonces.includes(hello.nonce)) {
    reject(c, 'stale');
    return;
  }
  restartOnPeerHello(c, hello, originId);
}

function onProof(
  c: Ctx,
  a: AttemptDraft,
  p: LinkAuthProof,
  originId: string,
): void {
  if (a.peer === null) {
    if (!isAddressed(a, p)) {
      reject(c, 'stale');
      return;
    }
    a.earlyProof = p;
    a.earlyProofOriginId = originId;
    c.dirty = true;
    return;
  }
  if (!isCurrent(a, p)) {
    reject(c, 'stale');
    return;
  }
  if (originId !== a.peer.nodeId) {
    reject(c, 'sender_mismatch');
    return;
  }
  if (a.peerProof === 'verified') {
    // Rule 13: never re-verified. Answer with the stored CONFIRM, rate limited.
    const lastSentAt = a.confirmLastSentAt;
    if (
      a.localConfirm.state === 'sent' &&
      a.confirmResends < c.r.limits.maxConfirmResends &&
      lastSentAt !== null &&
      c.mono - lastSentAt >= c.r.limits.confirmResendMinIntervalMs
    ) {
      a.confirmResends += 1;
      a.confirmLastSentAt = c.mono;
      c.dirty = true;
      c.effects.push({ kind: 'send', payload: confirmPayload(a) });
    } else {
      reject(c, 'duplicate');
    }
    return;
  }
  processProof(c, a, p, originId);
}

function onConfirm(
  c: Ctx,
  a: AttemptDraft,
  p: LinkAuthConfirm,
  originId: string,
): void {
  if (a.peer === null) {
    if (!isAddressed(a, p)) {
      reject(c, 'stale');
      return;
    }
    a.earlyConfirm = p;
    a.earlyConfirmOriginId = originId;
    c.dirty = true;
    return;
  }
  if (!isCurrent(a, p)) {
    reject(c, 'stale');
    return;
  }
  if (originId !== a.peer.nodeId) {
    reject(c, 'sender_mismatch');
    return;
  }
  if (a.peerConfirm === 'verified') {
    reject(c, 'duplicate');
    return;
  }
  if (a.peerProof === 'verified' && a.localProof.state === 'sent') {
    processConfirm(c, a, p, originId);
    return;
  }
  // Rule 16a: not yet acceptable. Buffer it; it is verified later.
  a.earlyConfirm = p;
  a.earlyConfirmOriginId = originId;
  c.dirty = true;
}

// ---- events ----------------------------------------------------------------------------------

function onStart(c: Ctx, ev: Record<string, unknown>): void {
  const binding = readBinding(ev.binding);
  if (!binding) {
    reject(c, 'malformed');
    return;
  }
  c.d.binding = binding;
  c.dirty = true;
  openAttempt(c, null);
}

function onRestart(c: Ctx): void {
  restartAttempt(c);
}

function onReceived(c: Ctx, ev: Record<string, unknown>): void {
  const envelope = ev.envelope;
  const payload = ev.payload;
  if (!isPlainObject(envelope)) {
    reject(c, 'malformed');
    return;
  }
  const originId = envelope.originId;
  const hopCount = envelope.hopCount;
  const rideId = envelope.rideId;
  if (
    typeof originId !== 'string' ||
    originId.length === 0 ||
    !Number.isSafeInteger(hopCount) ||
    (hopCount as number) < 0 ||
    typeof rideId !== 'string'
  ) {
    reject(c, 'malformed');
    return;
  }
  if (hopCount !== 0) {
    reject(c, 'not_direct');
    return;
  }
  if (rideId !== c.r.rideId) {
    reject(c, 'wrong_ride');
    return;
  }
  const parsed = parseLinkAuthPayload(payload);
  if (c.d.phase === 'failed') {
    if (parsed && parsed.stage === 'hello') {
      onHello(c, parsed, originId);
    } else {
      reject(c, 'failed_attempt');
    }
    return;
  }
  const a = c.d.attempt as AttemptDraft;
  if (!parsed) {
    onMalformed(c, a);
    return;
  }
  if (parsed.stage === 'hello') {
    onHello(c, parsed, originId);
  } else if (parsed.stage === 'proof') {
    onProof(c, a, parsed, originId);
  } else {
    onConfirm(c, a, parsed, originId);
  }
}

/** Which of our two signing slots (if any) is waiting for this request id. */
function pendingStage(
  a: AttemptDraft,
  requestId: string,
): 'proof' | 'confirm' | null {
  if (
    a.localProof.state === 'signing' &&
    a.localProof.requestId === requestId
  ) {
    return 'proof';
  }
  if (
    a.localConfirm.state === 'signing' &&
    a.localConfirm.requestId === requestId
  ) {
    return 'confirm';
  }
  return null;
}

function onSignatureReady(c: Ctx, ev: Record<string, unknown>): void {
  const requestId = ev.requestId;
  const signature = ev.signature;
  const a = c.d.attempt;
  if (typeof requestId !== 'string') {
    reject(c, 'malformed');
    return;
  }
  const stage = c.d.phase === 'active' && a ? pendingStage(a, requestId) : null;
  if (!a || stage === null) {
    reject(c, 'unknown_signature_request');
    return;
  }
  // Self-verify before anything is transmitted (catches DER/P1363 bugs and a mismatching key).
  const sig = verifyOwnSignature(c, a, stage, signature);
  if (sig === null) {
    failNow(c, 'signer_invalid_signature');
    return;
  }
  c.dirty = true;
  if (stage === 'proof') {
    a.localProof = Object.freeze({ state: 'sent', sig });
    a.proofSends = 1;
    a.proofNextAt =
      a.peerConfirm === 'none'
        ? c.mono + c.r.limits.retransmitIntervalMs
        : null;
    c.effects.push({ kind: 'send', payload: proofPayload(a) });
    if (a.peerProof === 'verified' && a.localConfirm.state === 'none') {
      if (!requestSign(c, a, 'confirm')) {
        return;
      }
    }
    drainEarly(c, a);
    return;
  }
  a.localConfirm = Object.freeze({ state: 'sent', sig });
  a.confirmLastSentAt = c.mono;
  c.effects.push({ kind: 'send', payload: confirmPayload(a) });
  maybeAuthenticate(c, a);
}

function onSignatureFailed(c: Ctx, ev: Record<string, unknown>): void {
  const requestId = ev.requestId;
  const a = c.d.attempt;
  if (typeof requestId !== 'string') {
    reject(c, 'malformed');
    return;
  }
  const stage = c.d.phase === 'active' && a ? pendingStage(a, requestId) : null;
  if (stage === null) {
    reject(c, 'unknown_signature_request');
    return;
  }
  failNow(c, 'signer_unavailable');
}

function onTick(c: Ctx): void {
  const { r, d } = c;
  if (d.phase !== 'active') {
    return;
  }
  const a = d.attempt as AttemptDraft;
  const authenticated = d.authenticated;
  if (authenticated !== null) {
    // Rule 25: an established link ends when either credential does.
    if (c.wall >= authenticated.expiresAt) {
      const peerExpired = a.peer !== null && c.wall >= a.peer.expiresAt;
      failNow(
        c,
        peerExpired ? 'peer_credential_expired' : 'local_credential_expired',
      );
    }
    return;
  }
  // Rule 24 (and the local credential, checked on tick as the contract requires).
  if (a.peer !== null && c.wall >= a.peer.expiresAt) {
    failNow(c, 'peer_credential_expired');
    return;
  }
  if (c.wall >= r.local.expiresAt) {
    failNow(c, 'local_credential_expired');
    return;
  }
  // Rule 20: a signing request that never completes.
  for (const slot of [a.localProof, a.localConfirm]) {
    if (
      slot.state === 'signing' &&
      c.mono - slot.requestedAt >= r.limits.signerTimeoutMs
    ) {
      failNow(c, 'signer_timeout');
      return;
    }
  }
  // Rule 21: the attempt deadline (not applied once mutual, which returned above).
  if (c.mono - a.startedAt >= r.limits.attemptDeadlineMs) {
    failNow(c, 'timeout');
    return;
  }
  // Rule 22: HELLO retransmission, until the peer's PROOF is verified.
  if (
    a.peerProof !== 'verified' &&
    a.helloNextAt !== null &&
    c.mono >= a.helloNextAt &&
    a.helloSends < r.limits.maxHelloSends
  ) {
    a.helloSends += 1;
    a.helloNextAt =
      a.helloSends < r.limits.maxHelloSends
        ? c.mono + r.limits.retransmitIntervalMs
        : null;
    c.effects.push({ kind: 'send', payload: helloPayload(c, a) });
    c.dirty = true;
  }
  // Rule 23: PROOF retransmission, until the peer's CONFIRM is verified.
  if (
    a.localProof.state === 'sent' &&
    a.peerConfirm === 'none' &&
    a.proofNextAt !== null &&
    c.mono >= a.proofNextAt &&
    a.proofSends < r.limits.maxProofSends
  ) {
    a.proofSends += 1;
    a.proofNextAt =
      a.proofSends < r.limits.maxProofSends
        ? c.mono + r.limits.retransmitIntervalMs
        : null;
    c.effects.push({ kind: 'send', payload: proofPayload(a) });
    c.dirty = true;
  }
}

function onDisconnected(c: Ctx): void {
  deauthIfMutual(c, 'disconnected');
  const { d } = c;
  d.phase = 'closed';
  d.binding = null;
  d.attemptCount = 0;
  d.attempt = null;
  d.restartTimes = [];
  d.recentPeerNonces = [];
  d.failure = null;
  d.authenticated = null;
  c.dirty = true;
}

// ---- the reducer -----------------------------------------------------------------------------

function rejectedOnly(
  state: LinkAuthState,
  reason: LinkAuthRejectReason,
): { state: LinkAuthState; effects: readonly LinkAuthEffect[] } {
  return { state, effects: finishEffects([{ kind: 'rejected', reason }]) };
}

function reduceInner(
  r: Resolved,
  state: LinkAuthState,
  rawEvent: unknown,
): { state: LinkAuthState; effects: readonly LinkAuthEffect[] } {
  if (!isPlainObject(rawEvent)) {
    return rejectedOnly(state, 'malformed');
  }
  const ev = rawEvent;
  const kind = ev.kind;
  if (typeof kind !== 'string' || !EVENT_KINDS.includes(kind)) {
    return rejectedOnly(state, 'malformed');
  }
  if (ev.connectionId !== state.connectionId) {
    return rejectedOnly(state, 'stale_connection');
  }
  if (state.phase === 'closed') {
    return rejectedOnly(state, 'closed');
  }
  let mono = state.lastMonoNow;
  let wall = 0;
  if (kind !== 'disconnected') {
    const eventMono = ev.monoNow;
    const eventWall = ev.wallNow;
    if (!isTimestamp(eventMono) || !isTimestamp(eventWall)) {
      return rejectedOnly(state, 'malformed');
    }
    // Monotonic time never goes backwards.
    mono = Math.max(state.lastMonoNow, eventMono);
    wall = eventWall;
  }

  const c: Ctx = {
    r,
    d: draftOf(state),
    connectionId: state.connectionId,
    mono,
    wall,
    effects: [],
    dirty: false,
  };

  if (state.phase === 'idle') {
    if (kind === 'start') {
      onStart(c, ev);
    } else if (kind === 'disconnected') {
      onDisconnected(c);
    } else {
      reject(c, 'not_started');
    }
  } else if (kind === 'start') {
    reject(c, 'already_started');
  } else if (kind === 'disconnected') {
    onDisconnected(c);
  } else if (kind === 'restart') {
    onRestart(c);
  } else if (kind === 'received') {
    onReceived(c, ev);
  } else if (kind === 'signature_ready') {
    onSignatureReady(c, ev);
  } else if (kind === 'signature_failed') {
    onSignatureFailed(c, ev);
  } else {
    onTick(c);
  }

  const effects = finishEffects(c.effects);
  if (!c.dirty) {
    // Nothing changed. A pure rejection leaves the state untouched; an accepted no-op (for
    // example a tick with nothing due) only advances the clamped clock.
    const onlyRejections =
      effects.length > 0 && effects.every(e => e.kind === 'rejected');
    if (onlyRejections || mono <= state.lastMonoNow) {
      return { state, effects };
    }
    return { state: freezeDraft(state.connectionId, mono, c.d), effects };
  }
  return {
    state: freezeDraft(
      state.connectionId,
      kind === 'disconnected' ? 0 : mono,
      c.d,
    ),
    effects,
  };
}

export function createLinkAuthenticator(deps: LinkAuthDeps): LinkAuthenticator {
  const r = resolveDeps(deps);
  return Object.freeze({
    initialState(connectionId: string): LinkAuthState {
      if (!isValidConnectionId(connectionId)) {
        throw new TypeError(
          'A connection id must be a non-empty string of at most 128 characters without "#"',
        );
      }
      return Object.freeze({
        connectionId,
        phase: 'idle',
        binding: null,
        lastMonoNow: 0,
        attemptCount: 0,
        attempt: null,
        restartTimes: Object.freeze([]),
        recentPeerNonces: Object.freeze([]),
        failure: null,
        authenticated: null,
      });
    },
    reduce(state: LinkAuthState, event: LinkAuthEvent) {
      try {
        return reduceInner(r, state, event);
      } catch {
        // Last resort: an unexpected fault leaves the (valid) previous state untouched, so it can
        // never turn into an authenticated link.
        return rejectedOnly(state, 'malformed');
      }
    },
  });
}
