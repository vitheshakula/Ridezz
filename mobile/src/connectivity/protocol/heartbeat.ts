/**
 * Heartbeat: a one-hop presence message meaning only "I, Rideaze node `originId`, am directly
 * present". Identity, ride and timing live in the envelope, so the payload carries nothing.
 *
 * Timing progression, deliberately uncoupled:
 *   HEARTBEAT_INTERVAL_MS (5 s)  how often a node will send one (scheduler not implemented)
 *   HEARTBEAT_TTL_MS     (10 s)  how long one packet stays valid on the wire
 *   peer freshness       (15 s)  how long a receiver treats the sender as a direct peer
 *                                (PEER_OBSERVATION_DEFAULT_FRESHNESS_MS, peerTable.ts)
 *
 * The origin transmits a heartbeat exactly as created (hopCount 0). It is never passed through
 * decideRelay, and relay policy refuses to forward heartbeats anyway.
 */

import { createRideMessage, type RideMessage, type RideMessagePriority } from './rideMessage';

/** Intended send interval for the future heartbeat scheduler. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TTL_MS = 10_000;
/** Direct neighbours only. */
export const HEARTBEAT_MAX_HOPS = 0;
/** Frequent, loss-tolerant control traffic: a missed heartbeat is covered by the next one and by
 * peer freshness, so it must never delay SOS, hazards or ACKs. */
export const HEARTBEAT_PRIORITY: RideMessagePriority = 'low';

/** Empty by design. Receivers accept any JSON object and ignore its keys, so fields can be added
 * later without old nodes losing presence. */
export type HeartbeatPayload = Readonly<Record<string, never>>;

export type HeartbeatMessage = RideMessage<HeartbeatPayload, 'heartbeat'>;

export interface CreateHeartbeatInput {
  id: string;
  rideId: string;
  originId: string;
  /** Wall-clock epoch ms: heartbeat expiry is evaluated on other devices. */
  createdAt: number;
}

/** Builds a heartbeat ready to send as-is. Pure: no id generation, no clock, no transport.
 * Throws for invalid input via createRideMessage. */
export function createHeartbeatMessage({
  id,
  rideId,
  originId,
  createdAt,
}: CreateHeartbeatInput): HeartbeatMessage {
  return createRideMessage<HeartbeatPayload, 'heartbeat'>({
    id,
    rideId,
    originId,
    type: 'heartbeat',
    priority: HEARTBEAT_PRIORITY,
    payload: {},
    ttlMs: HEARTBEAT_TTL_MS,
    maxHops: HEARTBEAT_MAX_HOPS,
    now: createdAt,
  });
}

/** Heartbeat payload check for received messages: any JSON object (not an array or null). */
export function isHeartbeatPayload(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
