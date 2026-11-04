import { createRideMessage, type RideMessage, type RideMessagePriority } from './rideMessage';

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TTL_MS = 10_000;
export const HEARTBEAT_MAX_HOPS = 0;
export const HEARTBEAT_PRIORITY: RideMessagePriority = 'low';

export type HeartbeatPayload = Readonly<Record<string, never>>;

export type HeartbeatMessage = RideMessage<HeartbeatPayload, 'heartbeat'>;

export interface CreateHeartbeatInput {
  id: string;
  rideId: string;
  originId: string;
  createdAt: number;
}

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

export function isHeartbeatPayload(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
