import {
  asDeliveryAcknowledgementMessage,
  type DeliveryAcknowledgementExpectation,
  type DeliveryAcknowledgementVerifier,
} from './protocol/deliveryAcknowledgement';
import type { JsonValue } from './protocol/jsonValue';
import type { RideMessage } from './protocol/rideMessage';

export type DeliveryAcknowledgementResult =
  | { readonly accepted: true; readonly originalMessageId: string; readonly acknowledgementId: string }
  | {
      readonly accepted: false;
      readonly reason:
        | 'invalid_ack'
        | 'unknown_ack'
        | 'duplicate_ack'
        | 'late_ack'
        | 'wrong_ride'
        | 'wrong_origin'
        | 'wrong_destination'
        | 'unauthenticated_ack';
    };

export interface DeliveryAcknowledgementTracker {
  track(expectation: DeliveryAcknowledgementExpectation): void;
  bindDestination(originalMessageId: string, destinationNodeId: string): void;
  reject(originalMessageId: string): void;
  handle(
    message: RideMessage<JsonValue>,
    verifier: DeliveryAcknowledgementVerifier | undefined,
  ): Promise<DeliveryAcknowledgementResult>;
  clear(): void;
}

export function createDeliveryAcknowledgementTracker({
  rideId,
  localNodeId,
  clock,
}: {
  readonly rideId: string;
  readonly localNodeId: string;
  readonly clock: () => number;
}): DeliveryAcknowledgementTracker {
  const pending = new Map<string, DeliveryAcknowledgementExpectation>();
  const seenAcknowledgements = new Set<string>();

  return {
    track(expectation): void {
      if (expectation.rideId === rideId && expectation.originalOriginId === localNodeId) {
        pending.set(expectation.originalMessageId, Object.freeze({ ...expectation }));
      }
    },

    bindDestination(originalMessageId, destinationNodeId): void {
      const current = pending.get(originalMessageId);
      if (current) {
        pending.set(originalMessageId, Object.freeze({ ...current, destinationNodeId }));
      }
    },

    reject(originalMessageId): void {
      pending.delete(originalMessageId);
    },

    async handle(message, verifier): Promise<DeliveryAcknowledgementResult> {
      const acknowledgement = asDeliveryAcknowledgementMessage(message);
      if (!acknowledgement) {
        return { accepted: false, reason: 'invalid_ack' };
      }
      if (seenAcknowledgements.has(acknowledgement.id)) {
        return { accepted: false, reason: 'duplicate_ack' };
      }
      const { payload } = acknowledgement;
      const expectation = pending.get(payload.originalMessageId);
      if (!expectation) {
        return { accepted: false, reason: 'unknown_ack' };
      }
      if (acknowledgement.rideId !== expectation.rideId || acknowledgement.rideId !== rideId) {
        return { accepted: false, reason: 'wrong_ride' };
      }
      if (payload.originalOriginId !== expectation.originalOriginId || payload.originalOriginId !== localNodeId) {
        return { accepted: false, reason: 'wrong_origin' };
      }
      if (
        expectation.destinationNodeId !== undefined &&
        payload.destinationNodeId !== expectation.destinationNodeId
      ) {
        return { accepted: false, reason: 'wrong_destination' };
      }
      if (clock() >= expectation.expiresAt) {
        pending.delete(payload.originalMessageId);
        return { accepted: false, reason: 'late_ack' };
      }
      if (!verifier || !(await verifier.verify(acknowledgement, expectation))) {
        return { accepted: false, reason: 'unauthenticated_ack' };
      }
      seenAcknowledgements.add(acknowledgement.id);
      pending.delete(payload.originalMessageId);
      return {
        accepted: true,
        originalMessageId: payload.originalMessageId,
        acknowledgementId: acknowledgement.id,
      };
    },

    clear(): void {
      pending.clear();
      seenAcknowledgements.clear();
    },
  };
}
