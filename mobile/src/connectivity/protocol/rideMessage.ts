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

export const RIDE_MESSAGE_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;

export type RideMessagePriority = (typeof RIDE_MESSAGE_PRIORITIES)[number];

export const RIDE_MESSAGE_MAX_TTL_MS = 60 * 60 * 1000;

export const RIDE_MESSAGE_MAX_HOP_LIMIT = 16;

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

export function isValidRideMessageTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isValidRideMessageTtl(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= RIDE_MESSAGE_MAX_TTL_MS
  );
}

export function isValidRideMessageMaxHops(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= RIDE_MESSAGE_MAX_HOP_LIMIT
  );
}

export interface RideMessage<TPayload = unknown, TType extends RideMessageType = RideMessageType> {
  readonly v: typeof RIDE_PROTOCOL_VERSION;
  readonly id: string;
  readonly rideId: string;
  readonly originId: string;
  readonly type: TType;
  readonly priority: RideMessagePriority;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly hopCount: number;
  readonly maxHops: number;
  readonly gatewayRouting?: RideMessageGatewayRouting;
  readonly payload: TPayload;
}

export interface RideMessageGatewayRouting {
  readonly targetGatewayId: string;
  readonly forwarderDistance: number;
}

export const GATEWAY_ROUTABLE_MESSAGE_TYPES: readonly RideMessageType[] = Object.freeze([
  'sos',
  'hazard',
  'ack',
  'location',
  'ride_state',
]);

export const RIDE_MESSAGE_MAX_GATEWAY_DISTANCE = RIDE_MESSAGE_MAX_HOP_LIMIT + 1;

export function isGatewayRoutableMessageType(type: unknown): boolean {
  return (GATEWAY_ROUTABLE_MESSAGE_TYPES as readonly unknown[]).includes(type);
}

export function isValidGatewayDistance(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= RIDE_MESSAGE_MAX_GATEWAY_DISTANCE
  );
}

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
  ttlMs: number;
  maxHops: number;
  now: number;
}

function assertIdentifier(value: string, field: string, maxLength: number): void {
  if (!isValidRideMessageIdentifier(value, maxLength)) {
    throw new TypeError(`RideMessage ${field} must be a non-empty string of at most ${maxLength}`);
  }
}

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
    throw new RangeError(`RideMessage ttlMs must be an integer in (0, ${RIDE_MESSAGE_MAX_TTL_MS}]`);
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

export function isRideMessageExpired(message: RideMessage, now: number): boolean {
  return now >= message.expiresAt;
}

export function canRelayRideMessage(message: RideMessage, now: number): boolean {
  return !isRideMessageExpired(message, now) && message.hopCount < message.maxHops;
}

export function relayRideMessage<TPayload, TType extends RideMessageType>(
  message: RideMessage<TPayload, TType>,
  now: number,
): RideMessage<TPayload, TType> | null {
  if (!canRelayRideMessage(message, now)) {
    return null;
  }
  return { ...message, hopCount: message.hopCount + 1 };
}
