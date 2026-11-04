import { isJsonValue, type JsonValue } from './jsonValue';
import {
  RIDE_MESSAGE_MAX_ID_LENGTH,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  RIDE_MESSAGE_MAX_RIDE_ID_LENGTH,
  RIDE_PROTOCOL_VERSION,
  isGatewayRoutableMessageType,
  isRideMessageExpired,
  isRideMessagePriority,
  isRideMessageType,
  isValidGatewayRouting,
  isValidRideMessageIdentifier,
  isValidRideMessageMaxHops,
  isValidRideMessageTimestamp,
  isValidRideMessageTtl,
  type RideMessage,
  type RideMessageGatewayRouting,
  type RideMessageType,
} from './rideMessage';

export const RIDE_MESSAGE_MAX_WIRE_BYTES = 4096;

export const RIDE_MESSAGE_MAX_FUTURE_SKEW_MS = 30_000;

const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

function toWireMessage(value: unknown): RideMessage<JsonValue> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const m = value as Record<string, unknown>;

  if (
    m.v !== RIDE_PROTOCOL_VERSION ||
    !isValidRideMessageIdentifier(m.id, RIDE_MESSAGE_MAX_ID_LENGTH) ||
    !isValidRideMessageIdentifier(m.rideId, RIDE_MESSAGE_MAX_RIDE_ID_LENGTH) ||
    !isValidRideMessageIdentifier(m.originId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH) ||
    !isRideMessageType(m.type) ||
    !isRideMessagePriority(m.priority) ||
    !isValidRideMessageTimestamp(m.createdAt) ||
    !isValidRideMessageTimestamp(m.expiresAt) ||
    !isValidRideMessageTtl(m.expiresAt - m.createdAt) ||
    !isValidRideMessageMaxHops(m.maxHops) ||
    !Number.isSafeInteger(m.hopCount) ||
    (m.hopCount as number) < 0 ||
    (m.hopCount as number) > m.maxHops ||
    m.payload === null ||
    !isJsonValue(m.payload)
  ) {
    return null;
  }
  if (
    m.gatewayRouting !== undefined &&
    (!isGatewayRoutableMessageType(m.type) || !isValidGatewayRouting(m.gatewayRouting))
  ) {
    return null;
  }
  const routing = m.gatewayRouting as RideMessageGatewayRouting | undefined;

  return {
    v: RIDE_PROTOCOL_VERSION,
    id: m.id,
    rideId: m.rideId,
    originId: m.originId,
    type: m.type,
    priority: m.priority,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    hopCount: m.hopCount as number,
    maxHops: m.maxHops,
    ...(routing && {
      gatewayRouting: {
        targetGatewayId: routing.targetGatewayId,
        forwarderDistance: routing.forwarderDistance,
      },
    }),
    payload: m.payload as JsonValue,
  };
}

export function serializeRideMessage(message: RideMessage): string {
  const wire = toWireMessage(message);
  if (!wire) {
    throw new TypeError('Not a valid v1 RideMessage');
  }
  const text = JSON.stringify(wire);
  const bytes = utf8ByteLength(text);
  if (bytes > RIDE_MESSAGE_MAX_WIRE_BYTES) {
    throw new RangeError(
      `RideMessage encodes to ${bytes} bytes, above the ${RIDE_MESSAGE_MAX_WIRE_BYTES} limit`,
    );
  }
  return text;
}

export function encodeRideMessage(message: RideMessage): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(serializeRideMessage(message));
}

export function parseRideMessage(
  input: string | Uint8Array,
  now: number,
): RideMessage<JsonValue, RideMessageType> | null {
  try {
    if (!isValidRideMessageTimestamp(now)) {
      return null;
    }

    let text: string;
    if (typeof input === 'string') {
      if (input.length > RIDE_MESSAGE_MAX_WIRE_BYTES) {
        return null;
      }
      if (utf8ByteLength(input) > RIDE_MESSAGE_MAX_WIRE_BYTES) {
        return null;
      }
      text = input;
    } else if (ArrayBuffer.isView(input)) {
      if (input.byteLength > RIDE_MESSAGE_MAX_WIRE_BYTES) {
        return null;
      }
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } else {
      return null;
    }

    const message = toWireMessage(JSON.parse(text));
    if (!message) {
      return null;
    }
    if (message.createdAt - now > RIDE_MESSAGE_MAX_FUTURE_SKEW_MS) {
      return null;
    }
    if (isRideMessageExpired(message, now)) {
      return null;
    }
    return message;
  } catch {
    return null;
  }
}
