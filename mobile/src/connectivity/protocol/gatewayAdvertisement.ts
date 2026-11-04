import { createRideMessage, type RideMessage, type RideMessagePriority } from './rideMessage';

export const GATEWAY_ADVERTISEMENT_INTERVAL_MS = 10_000;
export const GATEWAY_ADVERTISEMENT_TTL_MS = 30_000;
export const GATEWAY_ADVERTISEMENT_MAX_HOPS = 4;
export const GATEWAY_ADVERTISEMENT_PRIORITY: RideMessagePriority = 'normal';

export type GatewayAdvertisementPayload = Readonly<Record<string, never>>;

export type GatewayAdvertisementMessage = RideMessage<
  GatewayAdvertisementPayload,
  'gateway_advertisement'
>;

export interface CreateGatewayAdvertisementInput {
  id: string;
  rideId: string;
  originId: string;
  createdAt: number;
}

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

export function isGatewayAdvertisementPayload(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
