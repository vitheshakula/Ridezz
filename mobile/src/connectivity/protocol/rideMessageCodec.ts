/**
 * Wire codec and ingress boundary for RideMessage.
 *
 * Wire format (protocol v1): one UTF-8 JSON object with the RideMessage fields in a fixed order.
 * Outbound encoding is strict and throws on programmer error. Inbound parsing treats every byte
 * as untrusted, never throws, and returns null for anything it will not accept.
 *
 * Clock semantics at ingress (all times are epoch ms; `now` is the receiver's clock):
 *   - Future skew: accept iff createdAt - now <= RIDE_MESSAGE_MAX_FUTURE_SKEW_MS. A sender whose
 *     clock runs slightly ahead is tolerated; a timestamp further ahead is implausible.
 *   - Expiry: reject iff now >= expiresAt, the same rule as isRideMessageExpired. No grace is
 *     applied and expiresAt is never rewritten.
 * Together with TTL <= RIDE_MESSAGE_MAX_TTL_MS, an accepted message satisfies
 * expiresAt <= now + RIDE_MESSAGE_MAX_FUTURE_SKEW_MS + RIDE_MESSAGE_MAX_TTL_MS, so skew can never
 * keep a message alive indefinitely. Because expiresAt is absolute and immutable across relays,
 * that bound is evaluated afresh against each node's own clock and does not compound per hop.
 * A sender whose clock lags the receiver by at least the message's TTL is indistinguishable from
 * a stale message and is dropped; TTLs must be chosen comfortably above expected clock error.
 */

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

/** Largest accepted encoded packet, in UTF-8 bytes. Checked before decoding or JSON parsing. */
export const RIDE_MESSAGE_MAX_WIRE_BYTES = 4096;

/** How far a message's createdAt may be ahead of the receiver's clock. Matches the Phase 1
 * hazard parser's future tolerance. */
export const RIDE_MESSAGE_MAX_FUTURE_SKEW_MS = 30_000;

const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

/** Structural, clock-independent validation shared by both directions. Returns a fresh object
 * containing only protocol fields in wire order, or null. */
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
  // Optional gateway routing: when present it must be exactly valid, on a routable type.
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

/** Serializes a message to its v1 JSON wire form. Throws TypeError when the message is not a
 * valid v1 envelope (including a non-JSON or null payload) and RangeError when the encoded form
 * exceeds RIDE_MESSAGE_MAX_WIRE_BYTES, so nothing is sent that a peer would reject. */
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

/** UTF-8 bytes of serializeRideMessage. Throws under the same conditions. */
export function encodeRideMessage(message: RideMessage): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(serializeRideMessage(message));
}

/**
 * Decodes and validates an untrusted packet from any transport. Never throws. Returns null for
 * oversized, non-UTF-8, malformed, structurally invalid, expired or implausibly future-dated
 * input, or when `now` itself is not a valid timestamp. Unknown extra fields are dropped.
 */
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
      // UTF-8 never uses fewer bytes than UTF-16 code units, so this rejects huge strings
      // before paying to encode them.
      if (input.length > RIDE_MESSAGE_MAX_WIRE_BYTES) {
        return null;
      }
      if (utf8ByteLength(input) > RIDE_MESSAGE_MAX_WIRE_BYTES) {
        return null;
      }
      text = input;
    } else if (ArrayBuffer.isView(input)) {
      // isView rather than instanceof: byte arrays may come from another realm.
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
