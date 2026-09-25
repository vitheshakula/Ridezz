/** A ride's destination as stored on the room: a place name (optional) and where it is. */
export interface Destination {
  name: string | null;
  lat: number;
  lng: number;
}

const NAME_MAX_LENGTH = 200;

/** A display name for the destination, or null. Anything that isn't a non-blank string is dropped,
 * and a long one is cut, so the database never stores unbounded client-supplied text. */
export function cleanDestinationName(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, NAME_MAX_LENGTH) : null;
}

/**
 * Reads `{ destinationName, destinationLat, destinationLng }` from a request body. Returns null
 * unless the coordinates are real numbers within range -- callers decide whether a missing or bad
 * destination is an error (updating one) or simply "no destination" (creating a room without one).
 */
export function parseDestination(body: unknown): Destination | null {
  const { destinationName, destinationLat, destinationLng } = (body ?? {}) as Record<string, unknown>;
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
