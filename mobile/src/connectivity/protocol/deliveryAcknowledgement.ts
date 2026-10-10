import type { JsonValue } from './jsonValue';
import {
  RIDE_MESSAGE_MAX_ID_LENGTH,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
  type RideMessage,
} from './rideMessage';

export const DELIVERY_ACK_VERSION = 1 as const;
export const DELIVERY_ACK_MAX_KEY_ID_LENGTH = 128;
export const DELIVERY_ACK_MAX_NONCE_LENGTH = 128;
export const DELIVERY_ACK_MAX_SIGNATURE_LENGTH = 512;

export interface DeliveryAcknowledgementPayload extends Record<string, JsonValue> {
  readonly v: typeof DELIVERY_ACK_VERSION;
  readonly originalMessageId: string;
  readonly originalOriginId: string;
  readonly destinationNodeId: string;
  readonly acknowledgedAt: number;
  /** Backend-issued verification-key identifier. It is public metadata, never a secret. */
  readonly keyId: string;
  /** Unique signer nonce covered by the signature and used for replay rejection. */
  readonly nonce: string;
  /** Base64url signature produced by a backend-authorized ride member credential. */
  readonly signature: string;
}

export type DeliveryAcknowledgementMessage = RideMessage<
  DeliveryAcknowledgementPayload,
  'ack'
>;

export interface DeliveryAcknowledgementExpectation {
  readonly rideId: string;
  readonly originalMessageId: string;
  readonly originalOriginId: string;
  readonly destinationNodeId?: string;
  readonly expiresAt: number;
}

/**
 * Trust boundary for ACK verification. A production implementation must validate a backend-issued,
 * ride-scoped membership credential and an established signature scheme (for example Ed25519).
 * The connectivity layer deliberately has no backend signing secret and never treats the ride code
 * or a self-reported node id as authentication.
 */
export interface DeliveryAcknowledgementVerifier {
  verify(
    acknowledgement: DeliveryAcknowledgementMessage,
    expectation: DeliveryAcknowledgementExpectation,
  ): Promise<boolean>;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

function validBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function parseDeliveryAcknowledgementPayload(
  value: JsonValue,
): DeliveryAcknowledgementPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (
    !hasExactKeys(payload, [
      'v',
      'originalMessageId',
      'originalOriginId',
      'destinationNodeId',
      'acknowledgedAt',
      'keyId',
      'nonce',
      'signature',
    ]) ||
    payload.v !== DELIVERY_ACK_VERSION ||
    !isValidRideMessageIdentifier(payload.originalMessageId, RIDE_MESSAGE_MAX_ID_LENGTH) ||
    !isValidRideMessageIdentifier(payload.originalOriginId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH) ||
    !isValidRideMessageIdentifier(payload.destinationNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH) ||
    !isValidRideMessageTimestamp(payload.acknowledgedAt) ||
    !validBoundedText(payload.keyId, DELIVERY_ACK_MAX_KEY_ID_LENGTH) ||
    !validBoundedText(payload.nonce, DELIVERY_ACK_MAX_NONCE_LENGTH) ||
    !validBoundedText(payload.signature, DELIVERY_ACK_MAX_SIGNATURE_LENGTH)
  ) {
    return null;
  }
  return Object.freeze({
    v: DELIVERY_ACK_VERSION,
    originalMessageId: payload.originalMessageId,
    originalOriginId: payload.originalOriginId,
    destinationNodeId: payload.destinationNodeId,
    acknowledgedAt: payload.acknowledgedAt,
    keyId: payload.keyId,
    nonce: payload.nonce,
    signature: payload.signature,
  });
}

export function asDeliveryAcknowledgementMessage(
  message: RideMessage<JsonValue>,
): DeliveryAcknowledgementMessage | null {
  if (message.type !== 'ack') {
    return null;
  }
  const payload = parseDeliveryAcknowledgementPayload(message.payload);
  if (!payload || message.originId !== payload.destinationNodeId) {
    return null;
  }
  return Object.freeze({ ...message, type: 'ack' as const, payload });
}

/** Stable, mutable-routing-free input for an established signature primitive. */
export function deliveryAcknowledgementSigningInput(
  acknowledgement: Omit<DeliveryAcknowledgementPayload, 'signature'>,
  rideId: string,
): string {
  return JSON.stringify({
    domain: 'rideaze.delivery-ack.v1',
    rideId,
    v: acknowledgement.v,
    originalMessageId: acknowledgement.originalMessageId,
    originalOriginId: acknowledgement.originalOriginId,
    destinationNodeId: acknowledgement.destinationNodeId,
    acknowledgedAt: acknowledgement.acknowledgedAt,
    keyId: acknowledgement.keyId,
    nonce: acknowledgement.nonce,
  });
}
