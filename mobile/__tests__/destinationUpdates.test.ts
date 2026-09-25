import {
  decodeDestinationUpdate,
  encodeDestinationUpdate,
  participantMetadataIsHost,
} from '../src/services/destinationUpdates';

describe('destination updates', () => {
  test('round-trips a valid destination', () => {
    const destination = { name: 'Golconda Fort', latitude: 17.3833, longitude: 78.4011 };
    expect(decodeDestinationUpdate(encodeDestinationUpdate(destination, 1000), 1000)).toEqual(
      destination,
    );
  });

  test('rejects stale and invalid destination packets', () => {
    const stale = encodeDestinationUpdate(
      { name: 'Old destination', latitude: 17.3, longitude: 78.4 },
      1000,
    );
    expect(decodeDestinationUpdate(stale, 1_000_000)).toBeNull();
    expect(decodeDestinationUpdate(new TextEncoder().encode('{"v":1}'), 1000)).toBeNull();
  });

  test('accepts only host participant metadata', () => {
    expect(participantMetadataIsHost('{"isHost":true}')).toBe(true);
    expect(participantMetadataIsHost('{"isHost":false}')).toBe(false);
    expect(participantMetadataIsHost('broken')).toBe(false);
  });
});
