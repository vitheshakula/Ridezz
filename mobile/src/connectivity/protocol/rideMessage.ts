/**
 * Transport-neutral Ride Connectivity Protocol envelope.
 *
 * Every message exchanged between ride nodes (endpoints, relays, cloud gateways) is wrapped in a
 * RideMessage. This module is pure: no React Native, no transports, no wall-clock reads. Callers
 * pass `now` explicitly so every decision is deterministic.
 */

export const RIDE_PROTOCOL_VERSION = 1 as const;

export const RIDE_MESSAGE_TYPES = [
  'hazard',
  'sos',
  'ack',
  'heartbeat',
  'gateway_advertisement',
  'location',
  'ride_state',
] as const;

export type RideMessageType = (typeof RIDE_MESSAGE_TYPES)[number];

/** Ordered from most to least urgent. */
export const RIDE_MESSAGE_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;

export type RideMessagePriority = (typeof RIDE_MESSAGE_PRIORITIES)[number];

/** Upper TTL bound; anything longer is almost certainly a units mistake. */
export const RIDE_MESSAGE_MAX_TTL_MS = 60 * 60 * 1000;

/** Upper bound on relays a single message may take across the ride mesh. */
export const RIDE_MESSAGE_MAX_HOP_LIMIT = 16;

/** Identifier length bounds, in UTF-16 code units. Oversized identifiers are rejected, never
 * truncated: truncation could make distinct messages collide during deduplication. */
export const RIDE_MESSAGE_MAX_ID_LENGTH = 128;
export const RIDE_MESSAGE_MAX_RIDE_ID_LENGTH = 64;
export const RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH = 64;

const MESSAGE_TYPES: ReadonlySet<unknown> = new Set(RIDE_MESSAGE_TYPES);
const MESSAGE_PRIORITIES: ReadonlySet<unknown> = new Set(RIDE_MESSAGE_PRIORITIES);

export function isRideMessageType(value: unknown): value is RideMessageType {
  return MESSAGE_TYPES.has(value);
}

export function isRideMessagePriority(value: unknown): value is RideMessagePriority {
  return MESSAGE_PRIORITIES.has(value);
}

export function isValidRideMessageIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** Epoch ms timestamps are non-negative safe integers. */
export function isValidRideMessageTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** TTL is an integer in (0, RIDE_MESSAGE_MAX_TTL_MS]. */
export function isValidRideMessageTtl(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= RIDE_MESSAGE_MAX_TTL_MS
  );
}

/** maxHops is an integer in [0, RIDE_MESSAGE_MAX_HOP_LIMIT]. */
export function isValidRideMessageMaxHops(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= RIDE_MESSAGE_MAX_HOP_LIMIT
  );
}

export interface RideMessage<TPayload = unknown, TType extends RideMessageType = RideMessageType> {
  readonly v: typeof RIDE_PROTOCOL_VERSION;
  /** Globally unique; preserved unchanged across relays so receivers can deduplicate. */
  readonly id: string;
  readonly rideId: string;
  /** Node that originated the message, never the relaying node. */
  readonly originId: string;
  readonly type: TType;
  readonly priority: RideMessagePriority;
  /** Epoch ms on the origin's clock. */
  readonly createdAt: number;
  /** Epoch ms after which the message is dead. End-to-end: relays never extend it. */
  readonly expiresAt: number;
  /** Relays already performed. The origin sends 0. */
  readonly hopCount: number;
  /** Maximum relays permitted. 0 means deliver to direct neighbours only. */
  readonly maxHops: number;
  /** Present only on a message being routed toward a cloud gateway. */
  readonly gatewayRouting?: RideMessageGatewayRouting;
  readonly payload: TPayload;
}

/**
 * Metadata for a message routed toward one cloud gateway, kept apart from hopCount/maxHops:
 *   targetGatewayId    the gateway chosen by the node that began routed forwarding. Constant for
 *                      the life of the routed message: forwarders never switch it.
 *   forwarderDistance  the distance (links) to targetGatewayId claimed by the node that most
 *                      recently forwarded it. Each forwarder must choose a strictly smaller
 *                      distance and hands that on, so an honest chain is D0 > D1 > ... > 0 and an
 *                      infinite routing loop is impossible.
 * hopCount counts relays up while forwarderDistance counts down; they are independent.
 *
 * Signing boundary (signing not designed yet): targetGatewayId states the packet's intent and
 * should eventually be integrity-protected along with the origin's content. forwarderDistance is
 * rewritten at every hop, like hopCount, so it cannot be covered by an immutable origin signature
 * in the same way.
 */
export interface RideMessageGatewayRouting {
  readonly targetGatewayId: string;
  readonly forwarderDistance: number;
}

/** Control-plane messages are never gateway-routed: heartbeats are one-hop presence and gateway
 * advertisements are flooded. */
export const GATEWAY_ROUTABLE_MESSAGE_TYPES: readonly RideMessageType[] = Object.freeze([
  'sos',
  'hazard',
  'ack',
  'location',
  'ride_state',
]);

/** A route via a candidate learned at hopCount h has distance h + 1, and h <= the hop limit. */
export const RIDE_MESSAGE_MAX_GATEWAY_DISTANCE = RIDE_MESSAGE_MAX_HOP_LIMIT + 1;

export function isGatewayRoutableMessageType(type: unknown): boolean {
  return (GATEWAY_ROUTABLE_MESSAGE_TYPES as readonly unknown[]).includes(type);
}

/** A positive safe integer no larger than RIDE_MESSAGE_MAX_GATEWAY_DISTANCE. */
export function isValidGatewayDistance(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= RIDE_MESSAGE_MAX_GATEWAY_DISTANCE
  );
}

/** Strict: a plain object with exactly targetGatewayId and forwarderDistance, both valid. */
export function isValidGatewayRouting(value: unknown): value is RideMessageGatewayRouting {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const r = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    keys.includes('targetGatewayId') &&
    keys.includes('forwarderDistance') &&
    isValidRideMessageIdentifier(r.targetGatewayId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH) &&
    isValidGatewayDistance(r.forwarderDistance)
  );
}

/**
 * Returns an immutable copy carrying `routing` (replacing any existing routing). Never mutates the
 * input. Throws for invalid routing or a type that is never gateway-routed: programmer errors.
 */
export function withGatewayRouting<TPayload, TType extends RideMessageType>(
  message: RideMessage<TPayload, TType>,
  routing: RideMessageGatewayRouting,
): RideMessage<TPayload, TType> {
  if (!isGatewayRoutableMessageType(message.type)) {
    throw new TypeError(`RideMessage type ${message.type} is never gateway-routed`);
  }
  const copy = {
    targetGatewayId: routing?.targetGatewayId,
    forwarderDistance: routing?.forwarderDistance,
  };
  if (!isValidGatewayRouting(copy)) {
    throw new RangeError('Invalid RideMessage gateway routing');
  }
  return { ...message, gatewayRouting: Object.freeze(copy) };
}

export interface CreateRideMessageInput<TPayload, TType extends RideMessageType> {
  id: string;
  rideId: string;
  originId: string;
  type: TType;
  priority: RideMessagePriority;
  payload: TPayload;
  /** Lifetime in ms from `now`. Integer in (0, RIDE_MESSAGE_MAX_TTL_MS]. */
  ttlMs: number;
  /** Integer in [0, RIDE_MESSAGE_MAX_HOP_LIMIT]. */
  maxHops: number;
  now: number;
}

function assertIdentifier(value: string, field: string, maxLength: number): void {
  if (!isValidRideMessageIdentifier(value, maxLength)) {
    throw new TypeError(`RideMessage ${field} must be a non-empty string of at most ${maxLength}`);
  }
}

/** Builds an origin message (hopCount 0). Throws on invalid input: these are programmer errors,
 * not untrusted wire data. */
export function createRideMessage<TPayload, TType extends RideMessageType>(
  input: CreateRideMessageInput<TPayload, TType>,
): RideMessage<TPayload, TType> {
  const { id, rideId, originId, type, priority, payload, ttlMs, maxHops, now } = input;

  assertIdentifier(id, 'id', RIDE_MESSAGE_MAX_ID_LENGTH);
  assertIdentifier(rideId, 'rideId', RIDE_MESSAGE_MAX_RIDE_ID_LENGTH);
  assertIdentifier(originId, 'originId', RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH);
  if (!isValidRideMessageTimestamp(now)) {
    throw new RangeError('RideMessage now must be a non-negative safe integer');
  }
  if (!isValidRideMessageTtl(ttlMs)) {
    throw new RangeError(
      `RideMessage ttlMs must be an integer in (0, ${RIDE_MESSAGE_MAX_TTL_MS}]`,
    );
  }
  if (!isValidRideMessageMaxHops(maxHops)) {
    throw new RangeError(
      `RideMessage maxHops must be an integer in [0, ${RIDE_MESSAGE_MAX_HOP_LIMIT}]`,
    );
  }

  return {
    v: RIDE_PROTOCOL_VERSION,
    id,
    rideId,
    originId,
    type,
    priority,
    createdAt: now,
    expiresAt: now + ttlMs,
    hopCount: 0,
    maxHops,
    payload,
  };
}

/** Lifetime is the half-open interval [createdAt, expiresAt): expired exactly at expiresAt. */
export function isRideMessageExpired(message: RideMessage, now: number): boolean {
  return now >= message.expiresAt;
}

/** True when the message is still alive and has relay budget left. */
export function canRelayRideMessage(message: RideMessage, now: number): boolean {
  return !isRideMessageExpired(message, now) && message.hopCount < message.maxHops;
}

/** Returns a new message with hopCount + 1, or null when it must not be relayed. Never mutates
 * the input; every other field, including id and expiresAt, is carried over unchanged. */
export function relayRideMessage<TPayload, TType extends RideMessageType>(
  message: RideMessage<TPayload, TType>,
  now: number,
): RideMessage<TPayload, TType> | null {
  if (!canRelayRideMessage(message, now)) {
    return null;
  }
  return { ...message, hopCount: message.hopCount + 1 };
}
