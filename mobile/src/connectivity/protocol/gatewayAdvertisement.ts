/**
 * Gateway advertisement: "I, Rideaze node `originId`, currently believe I can reach the Rideaze
 * cloud." Application-level reachability, independent of how (Wi-Fi, cellular, ...). Identity,
 * ride, timing and hop information live in the envelope, so the payload carries nothing.
 *
 * Unlike heartbeats, advertisements are relayed (relay policy allows gateway_advertisement), so
 * reachability spreads beyond direct neighbours, bounded by TTL and maxHops. The origin sends the
 * advertisement as created (hopCount 0); relays use the normal relay path.
 *
 * Timing, deliberately uncoupled:
 *   GATEWAY_ADVERTISEMENT_INTERVAL_MS (10 s)  how often a gateway will advertise (no scheduler yet)
 *   GATEWAY_ADVERTISEMENT_TTL_MS      (30 s)  wire validity: long enough to cross several relay
 *                                             hops with clock skew, short enough that a gateway
 *                                             that stops advertising is forgotten quickly
 *   gateway freshness                 (25 s)  local observation age (gatewayState.ts)
 */

import { createRideMessage, type RideMessage, type RideMessagePriority } from './rideMessage';

/** Intended advertisement interval for the future gateway scheduler. */
export const GATEWAY_ADVERTISEMENT_INTERVAL_MS = 10_000;
export const GATEWAY_ADVERTISEMENT_TTL_MS = 30_000;
/** Enough to cross a strung-out convoy; well under RIDE_MESSAGE_MAX_HOP_LIMIT. */
export const GATEWAY_ADVERTISEMENT_MAX_HOPS = 4;
/** Periodic, refreshed control-plane traffic: below SOS/hazards, above heartbeats. */
export const GATEWAY_ADVERTISEMENT_PRIORITY: RideMessagePriority = 'normal';

/** Empty by design; receivers accept any JSON object and ignore its keys. */
export type GatewayAdvertisementPayload = Readonly<Record<string, never>>;

export type GatewayAdvertisementMessage = RideMessage<
  GatewayAdvertisementPayload,
  'gateway_advertisement'
>;

export interface CreateGatewayAdvertisementInput {
  id: string;
  rideId: string;
  originId: string;
  /** Wall-clock epoch ms: expiry is evaluated on other devices. */
  createdAt: number;
}

/** Builds a gateway advertisement ready to send as-is. Pure: no id generation, clock or
 * transport. Throws for invalid input via createRideMessage. */
export function createGatewayAdvertisementMessage({
  id,
  rideId,
  originId,
  createdAt,
}: CreateGatewayAdvertisementInput): GatewayAdvertisementMessage {
  return createRideMessage<GatewayAdvertisementPayload, 'gateway_advertisement'>({
    id,
    rideId,
    originId,
    type: 'gateway_advertisement',
    priority: GATEWAY_ADVERTISEMENT_PRIORITY,
    payload: {},
    ttlMs: GATEWAY_ADVERTISEMENT_TTL_MS,
    maxHops: GATEWAY_ADVERTISEMENT_MAX_HOPS,
    now: createdAt,
  });
}

/** Payload check for received advertisements: any JSON object (not an array or null). */
export function isGatewayAdvertisementPayload(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
