/**
 * link_auth v1: the pure wire codec and signed-data construction for authenticating ONE direct
 * Nearby link between two Rideaze nodes. It contains no state machine, clock, randomness or I/O;
 * hashing and signature verification are injected. The reducer that drives it is a later task.
 *
 * What this does and does not secure. A completed handshake authenticates a direct Phase 2 link:
 * the peer holds the ride key named in a credential the backend issued for this room code AND ride
 * session. It does NOT secure application traffic by itself. The existing Phase 1 Nearby SOS and
 * hazard path (HazardCoordinator, meshSyncManager) is still unauthenticated until it is migrated,
 * and message origins over several hops are not authenticated by link authentication alone.
 *
 * Messages (all carried in a RideMessage envelope; see the specification):
 *   HELLO    { v, stage:'hello',   credential, nonce, binding:{ kind } }
 *   PROOF    { v, stage:'proof',   nonce, peerNonce, transcript, sig }
 *   CONFIRM  { v, stage:'confirm', nonce, peerNonce, transcript, sig }
 * `nonce` is always the SENDER's nonce and `peerNonce` the receiver's.
 *
 * Why CONFIRM is signed. An unsigned echo of the transcript only shows that someone on the path
 * saw it; an on-path relay could forge it. A signed CONFIRM, made only after the signer has
 * verified the peer's PROOF, shows the peer holds its key AND accepted our proof, which is the
 * explicit mutual-authentication step. It must never be treated as authentication unless its
 * signature has been verified.
 *
 * Domain separation. The transcript, PROOF and CONFIRM each sign text beginning with their own
 * domain string, and PROOF/CONFIRM name both the signer and the peer. A PROOF signature therefore
 * never verifies as a CONFIRM (or the reverse), and a party's own signature reflected back to it
 * never verifies as the peer's.
 *
 * Channel binding. Three different things must not be confused:
 *   - LOCAL transport material: what our own Nearby stack observed for this connection. Only its
 *     digest (linkAuthBindingDigest) is ever used, and only locally.
 *   - PEER-ADVERTISED material: the peer's HELLO carries only the binding KIND. The digest is
 *     never on the wire, so a peer cannot choose or downgrade our security policy, and the digest
 *     cannot be replayed.
 *   - VERIFIED connection identity: established only when both parties' signatures verify over a
 *     transcript that contains the local digest. If the two ends observed different material
 *     (a relay), their transcripts differ and verification fails.
 * Whether Nearby actually exposes such material is unverified; that is a transport concern.
 *
 * Credentials. This module checks credentials STRUCTURALLY (parseRideCredential). The caller must
 * have fully verified the peer credential with a RideCredentialVerifier for this room code and
 * session before using it in a transcript or as a signer key. As a second, independent defence,
 * verifyLinkAuthSignature requires the public key to hash to the claimed `signer` node id
 * (node ids are SHA-256 of the key), so a valid signature by some other key can never be accepted
 * as the signature of a node it was not issued to. That check is necessary, not sufficient: it
 * does not show the key belongs to a credential the backend issued for this ride and session.
 *
 * Signatures. They are 64-byte IEEE P1363 (r || s) ECDSA P-256 / SHA-256 values. ECDSA signatures
 * are malleable (r, n - s) is also valid, so a signature must never be used as an identifier,
 * cache key or deduplication key; this module hashes credentials WITHOUT their `sig` for that
 * reason. Verification is SYNCHRONOUS and returns exactly `true` for success: a throw, a Promise or
 * any other value is a failed verification. Producing signatures is asynchronous (Android
 * Keystore) and belongs to the state machine, not to this module. The production verifier
 * (@noble/curves 2.4.0) must be called with { prehash: true, lowS: false }; its default rejects
 * roughly half of genuine Keystore and OpenSSL signatures.
 */

import { decodeBase64Url, encodeBase64Url, isUint8Array } from './base64url';
import {
  RIDE_CREDENTIAL_PUBLIC_KEY_BYTES,
  deriveRideNodeId,
  isCanonicalRideNodeId,
  isCanonicalRideSessionId,
  isValidRideCredentialRideId,
  parseRideCredential,
  rideCredentialSigningInput,
  type RideCredential,
} from './rideCredential';

export const LINK_AUTH_VERSION = 1 as const;
export const LINK_AUTH_NONCE_BYTES = 16;
export const LINK_AUTH_NONCE_CHARS = 22;
export const LINK_AUTH_TRANSCRIPT_HASH_CHARS = 43;
export const LINK_AUTH_SIGNATURE_BYTES = 64;
export const LINK_AUTH_SIGNATURE_CHARS = 86;

export const LINK_AUTH_TRANSCRIPT_DOMAIN = 'rideaze.link-auth.v1.transcript';
export const LINK_AUTH_PROOF_DOMAIN = 'rideaze.link-auth.v1.proof';
export const LINK_AUTH_CONFIRM_DOMAIN = 'rideaze.link-auth.v1.confirm';
export const LINK_AUTH_BINDING_DOMAIN = 'rideaze.nearby-binding.v1';

/**
 * Frozen at runtime: this list decides which binding kinds the parser and builders accept, so it
 * must not be possible for any importer to append to it.
 */
export const LINK_AUTH_BINDING_KINDS = Object.freeze([
  'nearby-auth-token-v1',
  'unavailable',
] as const);

export type LinkAuthBindingKind = (typeof LINK_AUTH_BINDING_KINDS)[number];

/**
 * The local node's view of the transport's connection-binding material. `digest` is
 * linkAuthBindingDigest of the material the local Nearby stack observed; it is never sent.
 */
export type LocalChannelBinding =
  | { readonly kind: 'nearby-auth-token-v1'; readonly digest: string }
  | { readonly kind: 'unavailable' };

export interface LinkAuthHello {
  readonly v: typeof LINK_AUTH_VERSION;
  readonly stage: 'hello';
  readonly credential: RideCredential;
  readonly nonce: string;
  readonly binding: { readonly kind: LinkAuthBindingKind };
}

interface LinkAuthSignedStage<TStage extends 'proof' | 'confirm'> {
  readonly v: typeof LINK_AUTH_VERSION;
  readonly stage: TStage;
  readonly nonce: string;
  readonly peerNonce: string;
  readonly transcript: string;
  readonly sig: string;
}

export type LinkAuthProof = LinkAuthSignedStage<'proof'>;
export type LinkAuthConfirm = LinkAuthSignedStage<'confirm'>;
export type LinkAuthPayload = LinkAuthHello | LinkAuthProof | LinkAuthConfirm;
export type LinkAuthSigningStage = 'proof' | 'confirm';

/** One side of the transcript: its node id, its handshake nonce and its credential. */
export interface LinkAuthParty {
  readonly nodeId: string;
  readonly nonce: string;
  readonly credential: RideCredential;
}

export interface LinkAuthTranscript {
  /** The exact text that is hashed. Pure ASCII. */
  readonly text: string;
  /** base64url(SHA-256(UTF-8(text))): the value PROOF and CONFIRM carry and sign over. */
  readonly hash: string;
}

const SHA256_BYTES = 32;
const UNCOMPRESSED_POINT_PREFIX = 0x04;

const utf8Encoder = new TextEncoder();

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

/** Canonical unpadded base64url text of exactly `bytes` bytes, in exactly `chars` characters. */
function isCanonicalBase64Url(
  value: unknown,
  chars: number,
  bytes: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length === chars &&
    decodeBase64Url(value)?.length === bytes
  );
}

/** A 16-byte handshake nonce: 22 canonical characters. */
export function isCanonicalLinkAuthNonce(value: unknown): value is string {
  return isCanonicalBase64Url(
    value,
    LINK_AUTH_NONCE_CHARS,
    LINK_AUTH_NONCE_BYTES,
  );
}

/** A 32-byte SHA-256 value (transcript hash, binding digest): 43 canonical characters. */
export function isCanonicalLinkAuthTranscriptHash(
  value: unknown,
): value is string {
  return isCanonicalBase64Url(
    value,
    LINK_AUTH_TRANSCRIPT_HASH_CHARS,
    SHA256_BYTES,
  );
}

/** A 64-byte P1363 signature: 86 canonical characters. */
export function isCanonicalLinkAuthSignature(value: unknown): value is string {
  return isCanonicalBase64Url(
    value,
    LINK_AUTH_SIGNATURE_CHARS,
    LINK_AUTH_SIGNATURE_BYTES,
  );
}

function isBindingKind(value: unknown): value is LinkAuthBindingKind {
  return (
    typeof value === 'string' &&
    (LINK_AUTH_BINDING_KINDS as readonly string[]).includes(value)
  );
}

// ---- parsing ---------------------------------------------------------------------------------

const HELLO_KEYS: readonly string[] = [
  'v',
  'stage',
  'credential',
  'nonce',
  'binding',
];
const SIGNED_STAGE_KEYS: readonly string[] = [
  'v',
  'stage',
  'nonce',
  'peerNonce',
  'transcript',
  'sig',
];
const BINDING_KEYS: readonly string[] = ['kind'];

function parseHello(value: Record<string, unknown>): LinkAuthHello | null {
  if (!hasExactKeys(value, HELLO_KEYS)) {
    return null;
  }
  const v = value.v;
  const credentialValue = value.credential;
  const nonce = value.nonce;
  const bindingValue = value.binding;
  if (v !== LINK_AUTH_VERSION || !isCanonicalLinkAuthNonce(nonce)) {
    return null;
  }
  if (
    !isPlainObject(bindingValue) ||
    !hasExactKeys(bindingValue, BINDING_KEYS)
  ) {
    return null;
  }
  const kind = bindingValue.kind;
  if (!isBindingKind(kind)) {
    return null;
  }
  const credential = parseRideCredential(credentialValue);
  if (!credential) {
    return null;
  }
  return Object.freeze({
    v: LINK_AUTH_VERSION,
    stage: 'hello' as const,
    credential,
    nonce,
    binding: Object.freeze({ kind }),
  });
}

function parseSignedStage(
  value: Record<string, unknown>,
  stage: 'proof' | 'confirm',
): LinkAuthProof | LinkAuthConfirm | null {
  if (!hasExactKeys(value, SIGNED_STAGE_KEYS)) {
    return null;
  }
  const v = value.v;
  const nonce = value.nonce;
  const peerNonce = value.peerNonce;
  const transcript = value.transcript;
  const sig = value.sig;
  if (
    v !== LINK_AUTH_VERSION ||
    !isCanonicalLinkAuthNonce(nonce) ||
    !isCanonicalLinkAuthNonce(peerNonce) ||
    !isCanonicalLinkAuthTranscriptHash(transcript) ||
    !isCanonicalLinkAuthSignature(sig)
  ) {
    return null;
  }
  return Object.freeze({
    v: LINK_AUTH_VERSION,
    stage,
    nonce,
    peerNonce,
    transcript,
    sig,
  });
}

/**
 * Strict, structural parse of an untrusted payload. Never throws. Returns a deeply frozen copy
 * holding only protocol fields, or null for anything malformed, non-canonical or unexpected.
 * Every field (including the nested binding and credential objects) is read exactly once, so a
 * getter or proxy that answers differently on a second read cannot alter what was validated.
 *
 * This is structure only. It does not verify the credential, check the ride or session, compare
 * nonces, or verify any signature.
 */
export function parseLinkAuthPayload(value: unknown): LinkAuthPayload | null {
  try {
    if (!isPlainObject(value)) {
      return null;
    }
    const stage = value.stage;
    if (stage === 'hello') {
      return parseHello(value);
    }
    if (stage === 'proof' || stage === 'confirm') {
      return parseSignedStage(value, stage);
    }
    return null;
  } catch {
    // A hostile getter or proxy must not escape the parser.
    return null;
  }
}

// ---- builders --------------------------------------------------------------------------------

export function buildLinkAuthHello({
  credential,
  nonce,
  bindingKind,
}: {
  readonly credential: RideCredential;
  readonly nonce: string;
  readonly bindingKind: LinkAuthBindingKind;
}): LinkAuthHello {
  const parsed = parseRideCredential(credential);
  if (!parsed) {
    throw new TypeError(
      'A link_auth HELLO needs a structurally valid RideCredential',
    );
  }
  if (!isCanonicalLinkAuthNonce(nonce)) {
    throw new TypeError(
      'A link_auth nonce must be 22 canonical base64url characters',
    );
  }
  if (!isBindingKind(bindingKind)) {
    throw new TypeError('Unknown link_auth binding kind');
  }
  return Object.freeze({
    v: LINK_AUTH_VERSION,
    stage: 'hello' as const,
    credential: parsed,
    nonce,
    binding: Object.freeze({ kind: bindingKind }),
  });
}

interface SignedStageInput {
  readonly nonce: string;
  readonly peerNonce: string;
  readonly transcript: string;
  readonly sig: string;
}

function buildSignedStage<TStage extends 'proof' | 'confirm'>(
  stage: TStage,
  { nonce, peerNonce, transcript, sig }: SignedStageInput,
): LinkAuthSignedStage<TStage> {
  if (
    !isCanonicalLinkAuthNonce(nonce) ||
    !isCanonicalLinkAuthNonce(peerNonce)
  ) {
    throw new TypeError(
      'A link_auth nonce must be 22 canonical base64url characters',
    );
  }
  if (!isCanonicalLinkAuthTranscriptHash(transcript)) {
    throw new TypeError(
      'A link_auth transcript hash must be 43 canonical base64url characters',
    );
  }
  if (!isCanonicalLinkAuthSignature(sig)) {
    throw new TypeError(
      'A link_auth signature must be 86 canonical base64url characters (64 bytes)',
    );
  }
  return Object.freeze({
    v: LINK_AUTH_VERSION,
    stage,
    nonce,
    peerNonce,
    transcript,
    sig,
  });
}

export function buildLinkAuthProof(input: SignedStageInput): LinkAuthProof {
  return buildSignedStage('proof', input);
}

export function buildLinkAuthConfirm(input: SignedStageInput): LinkAuthConfirm {
  return buildSignedStage('confirm', input);
}

// ---- hashing and the transcript --------------------------------------------------------------

function sha256Of(
  sha256: (data: Uint8Array) => Uint8Array,
  data: Uint8Array,
): string {
  if (typeof sha256 !== 'function') {
    throw new TypeError('link_auth hashing needs a sha256 function');
  }
  const digest = sha256(data);
  if (!isUint8Array(digest) || digest.length !== SHA256_BYTES) {
    discardPendingResult(digest);
    throw new TypeError('sha256 must return a 32-byte Uint8Array');
  }
  return encodeBase64Url(digest);
}

/**
 * base64url(SHA-256(UTF-8(rideCredentialSigningInput(credential)))). It covers exactly the signed
 * credential fields and NOT `sig`, so the malleated (high-S) form of a signature gives the same
 * hash. Throws TypeError unless the credential is structurally valid.
 */
export function linkAuthCredentialHash(
  credential: RideCredential,
  sha256: (data: Uint8Array) => Uint8Array,
): string {
  const parsed = parseRideCredential(credential);
  if (!parsed) {
    throw new TypeError(
      'linkAuthCredentialHash needs a structurally valid RideCredential',
    );
  }
  return sha256Of(
    sha256,
    utf8Encoder.encode(rideCredentialSigningInput(parsed)),
  );
}

/**
 * Digest of the local transport's connection-binding material:
 * base64url(SHA-256(UTF-8(LINK_AUTH_BINDING_DOMAIN) || 0x00 || material)). The domain prefix keeps
 * it from colliding with any other use of the same bytes. It is used locally only and is never
 * transmitted.
 */
export function linkAuthBindingDigest(
  material: Uint8Array,
  sha256: (data: Uint8Array) => Uint8Array,
): string {
  if (!isUint8Array(material) || material.length === 0) {
    throw new TypeError(
      'Channel-binding material must be a non-empty Uint8Array',
    );
  }
  const domain = utf8Encoder.encode(LINK_AUTH_BINDING_DOMAIN);
  const data = new Uint8Array(domain.length + 1 + material.length);
  data.set(domain, 0);
  data[domain.length] = 0;
  data.set(material, domain.length + 1);
  return sha256Of(sha256, data);
}

function readLocalBinding(binding: unknown): {
  kind: LinkAuthBindingKind;
  digest: string | null;
} {
  if (!isPlainObject(binding)) {
    throw new TypeError('The channel binding must be an object');
  }
  const kind = binding.kind;
  if (kind === 'nearby-auth-token-v1') {
    if (!hasExactKeys(binding, ['kind', 'digest'])) {
      throw new TypeError(
        'A nearby-auth-token-v1 binding needs exactly kind and digest',
      );
    }
    const digest = binding.digest;
    if (!isCanonicalLinkAuthTranscriptHash(digest)) {
      throw new TypeError(
        'The binding digest must be 43 canonical base64url characters',
      );
    }
    return { kind, digest };
  }
  if (kind === 'unavailable') {
    if (!hasExactKeys(binding, ['kind'])) {
      throw new TypeError('An unavailable binding carries no digest');
    }
    return { kind, digest: null };
  }
  throw new TypeError('Unknown link_auth binding kind');
}

function readParty(
  party: unknown,
  rideId: string,
  sessionId: string,
): { nodeId: string; nonce: string; credential: RideCredential } {
  if (!isPlainObject(party)) {
    throw new TypeError('A transcript party must be an object');
  }
  const nodeId = party.nodeId;
  const nonce = party.nonce;
  const credentialValue = party.credential;
  if (!isCanonicalRideNodeId(nodeId)) {
    throw new TypeError('A transcript party needs a canonical node id');
  }
  if (!isCanonicalLinkAuthNonce(nonce)) {
    throw new TypeError('A transcript party needs a canonical nonce');
  }
  const credential = parseRideCredential(credentialValue);
  if (!credential) {
    throw new TypeError(
      'A transcript party needs a structurally valid credential',
    );
  }
  if (credential.nodeId !== nodeId) {
    throw new TypeError("A party's credential belongs to a different node id");
  }
  if (credential.rideId !== rideId || credential.sessionId !== sessionId) {
    throw new TypeError(
      "A party's credential belongs to a different ride or session",
    );
  }
  return { nodeId, nonce, credential };
}

/**
 * Builds the transcript both parties sign over. The two parties are ordered by ordinal string
 * comparison of their node ids (a < b), so the text and hash are identical on both sides and in
 * either argument order, and no initiator role is needed. Exact text, key order fixed:
 *
 *   {"domain":"rideaze.link-auth.v1.transcript","v":1,"rideId":R,"sessionId":S,
 *    "binding":{"kind":K,"digest":D|null},
 *    "a":{"nodeId":..,"nonce":..,"credential":<credential hash>},
 *    "b":{"nodeId":..,"nonce":..,"credential":<credential hash>}}
 *
 * Throws TypeError for anything inconsistent: a ride id that is not a room code, a session id that
 * is not canonical, a malformed binding, equal node ids or nonces, or a credential that does not
 * belong to its party's node id or to this ride and session.
 */
export function linkAuthTranscript(
  {
    rideId,
    sessionId,
    binding,
    local,
    peer,
  }: {
    readonly rideId: string;
    readonly sessionId: string;
    readonly binding: LocalChannelBinding;
    readonly local: LinkAuthParty;
    readonly peer: LinkAuthParty;
  },
  sha256: (data: Uint8Array) => Uint8Array,
): LinkAuthTranscript {
  if (!isValidRideCredentialRideId(rideId)) {
    throw new TypeError(
      'A link_auth transcript needs a five-digit room code as rideId',
    );
  }
  if (!isCanonicalRideSessionId(sessionId)) {
    throw new TypeError(
      'A link_auth transcript needs a canonical ride session id',
    );
  }
  const boundTo = readLocalBinding(binding);
  const localParty = readParty(local, rideId, sessionId);
  const peerParty = readParty(peer, rideId, sessionId);
  if (localParty.nodeId === peerParty.nodeId) {
    throw new TypeError(
      'The two transcript parties must have different node ids',
    );
  }
  if (localParty.nonce === peerParty.nonce) {
    throw new TypeError(
      'The two transcript parties must have different nonces',
    );
  }

  const [a, b] =
    localParty.nodeId < peerParty.nodeId
      ? [localParty, peerParty]
      : [peerParty, localParty];
  const text = JSON.stringify({
    domain: LINK_AUTH_TRANSCRIPT_DOMAIN,
    v: LINK_AUTH_VERSION,
    rideId,
    sessionId,
    binding: { kind: boundTo.kind, digest: boundTo.digest },
    a: {
      nodeId: a.nodeId,
      nonce: a.nonce,
      credential: linkAuthCredentialHash(a.credential, sha256),
    },
    b: {
      nodeId: b.nodeId,
      nonce: b.nonce,
      credential: linkAuthCredentialHash(b.credential, sha256),
    },
  });
  return Object.freeze({
    text,
    hash: sha256Of(sha256, utf8Encoder.encode(text)),
  });
}

// ---- signing input and verification ----------------------------------------------------------

/**
 * The exact text a party signs for `stage`:
 *   {"domain":<proof or confirm domain>,"v":1,"signer":..,"peer":..,"transcript":..}
 * The signer and the peer are named, so a signature made for one direction does not verify for the
 * other. Throws TypeError for an unknown stage, non-canonical node ids, equal signer and peer, or a
 * non-canonical transcript hash.
 */
export function linkAuthSigningInput(
  stage: LinkAuthSigningStage,
  {
    signer,
    peer,
    transcript,
  }: {
    readonly signer: string;
    readonly peer: string;
    readonly transcript: string;
  },
): string {
  let domain: string;
  if (stage === 'proof') {
    domain = LINK_AUTH_PROOF_DOMAIN;
  } else if (stage === 'confirm') {
    domain = LINK_AUTH_CONFIRM_DOMAIN;
  } else {
    throw new TypeError('Unknown link_auth signing stage');
  }
  if (!isCanonicalRideNodeId(signer) || !isCanonicalRideNodeId(peer)) {
    throw new TypeError('The signer and the peer need canonical node ids');
  }
  if (signer === peer) {
    throw new TypeError('The signer and the peer must be different nodes');
  }
  if (!isCanonicalLinkAuthTranscriptHash(transcript)) {
    throw new TypeError(
      'The transcript must be 43 canonical base64url characters',
    );
  }
  return JSON.stringify({
    domain,
    v: LINK_AUTH_VERSION,
    signer,
    peer,
    transcript,
  });
}

/**
 * A callback that wrongly returned a Promise must not leave an unhandled rejection behind. The
 * Promise is never awaited or trusted: verification has already failed closed.
 */
function discardPendingResult(result: unknown): void {
  try {
    if (
      (typeof result === 'object' || typeof result === 'function') &&
      result !== null &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      Promise.resolve(result).then(undefined, () => undefined);
    }
  } catch {
    // Nothing to do: the verification outcome is already a rejection.
  }
}

/**
 * Verifies a PROOF or CONFIRM signature. `signerPublicKey` must be the 65-byte key from the
 * signer's VERIFIED credential (see the module comment); `verifySignature` is the injected,
 * synchronous P-256 / SHA-256 verifier and `sha256` the injected synchronous hash.
 *
 * Identity binding. Before any signature is checked, the node id derived from `signerPublicKey`
 * (deriveRideNodeId, i.e. base64url(SHA-256(key))) must equal `signer` exactly. A mismatch returns
 * false without calling `verifySignature`, so a valid signature by key E can never be accepted for
 * a statement that names node B.
 *
 * Never throws: invalid arguments, a throwing or Promise-returning callback, a hash that is not
 * 32 bytes, or any result other than exactly `true` all yield false. The callbacks receive fresh
 * copies of the key and signature, so they cannot alter the caller's buffers or each other's input.
 */
export function verifyLinkAuthSignature(
  input: {
    readonly stage: LinkAuthSigningStage;
    readonly signer: string;
    readonly peer: string;
    readonly transcript: string;
    readonly signerPublicKey: Uint8Array;
    readonly signature: Uint8Array;
  },
  verifySignature: (
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ) => boolean,
  sha256: (data: Uint8Array) => Uint8Array,
): boolean {
  try {
    const { stage, signer, peer, transcript, signerPublicKey, signature } =
      input;
    if (typeof verifySignature !== 'function' || typeof sha256 !== 'function') {
      return false;
    }
    if (
      !isUint8Array(signerPublicKey) ||
      signerPublicKey.length !== RIDE_CREDENTIAL_PUBLIC_KEY_BYTES ||
      signerPublicKey[0] !== UNCOMPRESSED_POINT_PREFIX
    ) {
      return false;
    }
    if (
      !isUint8Array(signature) ||
      signature.length !== LINK_AUTH_SIGNATURE_BYTES
    ) {
      return false;
    }
    // The key must belong to the node it is claimed for. The hash gets its own copy of the key so
    // that a misbehaving callback cannot alter the key that is verified below.
    const identityHash = (data: Uint8Array): Uint8Array => {
      const digest = sha256(data);
      if (!isUint8Array(digest)) {
        discardPendingResult(digest); // an async hash must not leave an unhandled rejection
      }
      return digest;
    };
    if (
      deriveRideNodeId(Uint8Array.from(signerPublicKey), identityHash) !==
      signer
    ) {
      return false;
    }
    const message = utf8Encoder.encode(
      linkAuthSigningInput(stage, { signer, peer, transcript }),
    );
    const outcome: unknown = verifySignature(
      Uint8Array.from(signerPublicKey),
      message,
      Uint8Array.from(signature),
    );
    // Strict equality: only an explicit `true` is success.
    if (outcome !== true) {
      discardPendingResult(outcome);
      return false;
    }
    return true;
  } catch {
    // A throwing injected function, or invalid arguments, must never turn into acceptance.
    return false;
  }
}
