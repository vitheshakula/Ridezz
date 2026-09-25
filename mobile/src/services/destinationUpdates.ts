import type { RideDestination } from '../components/RiderMap';

export const DESTINATION_TOPIC = 'ridezz.destination';

interface DestinationUpdatePacket {
  v: 1;
  destination: RideDestination;
  timestamp: number;
}

export function encodeDestinationUpdate(
  destination: RideDestination,
  timestamp: number = Date.now(),
): Uint8Array<ArrayBuffer> {
  const packet: DestinationUpdatePacket = { v: 1, destination, timestamp };
  return new TextEncoder().encode(JSON.stringify(packet));
}

export function decodeDestinationUpdate(
  bytes: Uint8Array,
  now: number = Date.now(),
): RideDestination | null {
  try {
    const packet = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const destination = packet.destination as Record<string, unknown> | undefined;
    if (
      packet.v !== 1 ||
      typeof packet.timestamp !== 'number' ||
      Math.abs(now - packet.timestamp) > 5 * 60 * 1000 ||
      !destination ||
      typeof destination.latitude !== 'number' ||
      !Number.isFinite(destination.latitude) ||
      destination.latitude < -90 ||
      destination.latitude > 90 ||
      typeof destination.longitude !== 'number' ||
      !Number.isFinite(destination.longitude) ||
      destination.longitude < -180 ||
      destination.longitude > 180 ||
      !(typeof destination.name === 'string' || destination.name === null)
    ) {
      return null;
    }
    return {
      name: destination.name,
      latitude: destination.latitude,
      longitude: destination.longitude,
    };
  } catch {
    return null;
  }
}

export function participantMetadataIsHost(metadata?: string): boolean {
  if (!metadata) {
    return false;
  }
  try {
    return JSON.parse(metadata)?.isHost === true;
  } catch {
    return false;
  }
}
