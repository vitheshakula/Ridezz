export interface Destination {
  name: string | null;
  lat: number;
  lng: number;
}

const NAME_MAX_LENGTH = 200;

export function cleanDestinationName(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, NAME_MAX_LENGTH) : null;
}

export function parseDestination(body: unknown): Destination | null {
  const { destinationName, destinationLat, destinationLng } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof destinationLat !== 'number' ||
    typeof destinationLng !== 'number' ||
    !Number.isFinite(destinationLat) ||
    !Number.isFinite(destinationLng) ||
    destinationLat < -90 ||
    destinationLat > 90 ||
    destinationLng < -180 ||
    destinationLng > 180
  ) {
    return null;
  }
  return { name: cleanDestinationName(destinationName), lat: destinationLat, lng: destinationLng };
}
