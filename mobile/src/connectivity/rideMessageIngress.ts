/**
 * Ingress boundary for one active ride session: turns an untrusted packet received from any
 * transport into an accepted RideMessage, or a rejection reason. It decides acceptance only. It
 * never relays, routes or sends; that belongs to a later layer, which may use the returned source.
 *
 * Processing order:
 *   1. parseRideMessage (all wire validation, including expiry and future-skew) -> 'invalid'
 *   2. message.rideId === this session's rideId                                -> 'wrong_ride'
 *   3. message.originId !== this node's id                                      -> 'local_origin'
 *   4. claim message.id in the session's seen-message cache                     -> 'duplicate'
 * Only packets that pass 1-3 are claimed, so malformed, foreign-ride and bounced-back packets
 * never consume dedup capacity.
 */

import { type JsonValue } from './protocol/jsonValue';
import {
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  RIDE_MESSAGE_MAX_RIDE_ID_LENGTH,
  isValidRideMessageIdentifier,
  type RideMessage,
} from './protocol/rideMessage';
import { parseRideMessage } from './protocol/rideMessageCodec';
import type { SeenMessageCache } from './protocol/seenMessageCache';

/**
 * Where a packet was observed locally. Never part of the RideMessage and never serialized.
 * `transportId` is opaque to ingress. `peerId` is whatever the transport reports for the
 * immediate sender (the last hop, not the message origin) and is NOT authenticated: it must not
 * be treated as identity until peer authentication exists.
 */
export interface RideMessageIngressSource {
  readonly transportId: string;
  readonly peerId?: string;
}

/** 'invalid' covers everything parseRideMessage rejects: malformed, oversized, wrong version,
 * expired or implausibly future-dated. The codec does not distinguish these. */
export type RideMessageIngressRejection = 'invalid' | 'wrong_ride' | 'local_origin' | 'duplicate';

export type RideMessageIngressResult =
  | {
      accepted: true;
      message: RideMessage<JsonValue>;
      source: RideMessageIngressSource;
    }
  | {
      accepted: false;
      reason: RideMessageIngressRejection;
      source: RideMessageIngressSource;
    };

export interface RideMessageIngressOptions {
  rideId: string;
  localNodeId: string;
  /** Must belong to this session alone; a new ride gets a new cache. */
  seenMessages: SeenMessageCache;
  /** Read once per packet; the same instant is used for parsing and for the dedup claim. */
  clock: () => number;
  /** Sanitized observability after canonical parsing. Exceptions are isolated. */
  onRejectedMessage?: (
    reason: Exclude<RideMessageIngressRejection, 'invalid'>,
    message: RideMessage<JsonValue>,
  ) => void;
}

export interface RideMessageIngress {
  /** Never throws for packet content. Throws TypeError only for a malformed `source`, which is a
   * caller bug rather than untrusted input. */
  ingest(payload: string | Uint8Array, source: RideMessageIngressSource): RideMessageIngressResult;
}

function copySource(source: RideMessageIngressSource): RideMessageIngressSource {
  if (typeof source !== 'object' || source === null) {
    throw new TypeError('Ingress source must be an object');
  }
  const { transportId, peerId } = source;
  if (typeof transportId !== 'string' || transportId.length === 0) {
    throw new TypeError('Ingress source transportId must be a non-empty string');
  }
  if (peerId === undefined) {
    return { transportId };
  }
  if (typeof peerId !== 'string' || peerId.length === 0) {
    throw new TypeError('Ingress source peerId must be a non-empty string when present');
  }
  return { transportId, peerId };
}

export function createRideMessageIngress({
  rideId,
  localNodeId,
  seenMessages,
  clock,
  onRejectedMessage,
}: RideMessageIngressOptions): RideMessageIngress {
  if (!isValidRideMessageIdentifier(rideId, RIDE_MESSAGE_MAX_RIDE_ID_LENGTH)) {
    throw new TypeError('Ingress rideId must be a valid RideMessage rideId');
  }
  if (!isValidRideMessageIdentifier(localNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH)) {
    throw new TypeError('Ingress localNodeId must be a valid RideMessage originId');
  }

  return {
    ingest(payload, rawSource): RideMessageIngressResult {
      // Copied so later mutation by the caller cannot alter a returned result.
      const source = copySource(rawSource);
      const now = clock();

      const message = parseRideMessage(payload, now);
      if (!message) {
        return { accepted: false, reason: 'invalid', source };
      }
      if (message.rideId !== rideId) {
        try {
          onRejectedMessage?.('wrong_ride', message);
        } catch {
          // Observability must never alter ingress acceptance.
        }
        return { accepted: false, reason: 'wrong_ride', source };
      }
      if (message.originId === localNodeId) {
        try {
          onRejectedMessage?.('local_origin', message);
        } catch {
          // Observability must never alter ingress acceptance.
        }
        return { accepted: false, reason: 'local_origin', source };
      }

      switch (seenMessages.claim(message.id, message.expiresAt, now)) {
        case 'accepted':
          return { accepted: true, message, source };
        case 'duplicate':
          try {
            onRejectedMessage?.('duplicate', message);
          } catch {
            // Observability must never alter ingress acceptance.
          }
          return { accepted: false, reason: 'duplicate', source };
        default:
          // 'expired' / 'invalid' are unreachable after a successful parse at the same `now`
          // (parse enforces id bounds, now < expiresAt and the expiry horizon). Fail closed.
          return { accepted: false, reason: 'invalid', source };
      }
    },
  };
}
