import {
  HAZARD_PACKET_MAX_AGE_MS,
  HAZARD_PACKET_MAX_FUTURE_MS,
  HAZARD_PROTOCOL_VERSION,
  HAZARD_TYPE_IDS,
  createHazardPacket,
  encodeHazardPacket,
  parseHazardPacket,
  serializeHazardPacket,
  type HazardPacket,
} from '../src/protocol/hazardProtocol';

const NOW = 1_700_000_000_000;

function packet(overrides: Partial<HazardPacket> = {}): HazardPacket {
  return {
    v: 1,
    id: `sender-1-${NOW}-pothole`,
    hazard: 'pothole',
    senderId: 'sender-1',
    senderName: 'Alex',
    timestamp: NOW,
    ...overrides,
  };
}

describe('hazard protocol v1', () => {
  test('creates the exact current packet shape, version and id', () => {
    expect(createHazardPacket('pothole', 'sender-1', 'Alex', NOW)).toEqual({
      v: 1,
      id: `sender-1-${NOW}-pothole`,
      hazard: 'pothole',
      senderId: 'sender-1',
      senderName: 'Alex',
      timestamp: NOW,
    });
    expect(HAZARD_PROTOCOL_VERSION).toBe(1);
  });

  test('preserves the exact golden v1 JSON representation', () => {
    const created = createHazardPacket('pothole', 'sender-1', 'Alex', NOW);

    expect(serializeHazardPacket(created)).toBe(
      `{"v":1,"id":"sender-1-${NOW}-pothole","hazard":"pothole","senderId":"sender-1","senderName":"Alex","timestamp":${NOW}}`,
    );
  });

  test('roundtrips serialized JSON', () => {
    const created = createHazardPacket('police', 'rider', 'Sam', NOW);
    expect(parseHazardPacket(serializeHazardPacket(created), NOW)).toEqual(created);
  });

  test('roundtrips encoded bytes', () => {
    const created = createHazardPacket('gravel', 'rider', 'Sam', NOW);
    expect(parseHazardPacket(encodeHazardPacket(created), NOW)).toEqual(created);
  });

  test('accepts every supported hazard type', () => {
    expect(HAZARD_TYPE_IDS).toHaveLength(13);
    for (const hazard of HAZARD_TYPE_IDS) {
      const created = createHazardPacket(hazard, 'rider', 'Sam', NOW);
      expect(parseHazardPacket(serializeHazardPacket(created), NOW)).toEqual(created);
    }
  });

  test('rejects the wrong version and unknown hazards', () => {
    expect(parseHazardPacket(JSON.stringify({ ...packet(), v: 2 }), NOW)).toBeNull();
    expect(parseHazardPacket(JSON.stringify({ ...packet(), hazard: 'meteor' }), NOW)).toBeNull();
  });

  test.each(['v', 'id', 'hazard', 'senderId', 'senderName', 'timestamp'])(
    'rejects a missing %s field',
    field => {
      const candidate: Record<string, unknown> = { ...packet() };
      delete candidate[field];
      expect(parseHazardPacket(JSON.stringify(candidate), NOW)).toBeNull();
    },
  );

  test.each([
    ['v', '1'],
    ['id', 1],
    ['hazard', 1],
    ['senderId', 1],
    ['senderName', 1],
    ['timestamp', String(NOW)],
  ])('rejects a mistyped %s field', (field, value) => {
    expect(parseHazardPacket(JSON.stringify({ ...packet(), [field]: value }), NOW)).toBeNull();
  });

  test('rejects non-finite timestamps', () => {
    const nonFiniteTimestamp = serializeHazardPacket(packet()).replace(
      `"timestamp":${NOW}`,
      '"timestamp":1e999',
    );
    expect(parseHazardPacket(nonFiniteTimestamp, NOW)).toBeNull();
  });

  test('preserves the exact 30-second age and future boundaries', () => {
    const atOldBoundary = packet({ timestamp: NOW - HAZARD_PACKET_MAX_AGE_MS });
    const pastOldBoundary = packet({ timestamp: NOW - HAZARD_PACKET_MAX_AGE_MS - 1 });
    const atFutureBoundary = packet({ timestamp: NOW + HAZARD_PACKET_MAX_FUTURE_MS });
    const pastFutureBoundary = packet({ timestamp: NOW + HAZARD_PACKET_MAX_FUTURE_MS + 1 });

    expect(parseHazardPacket(JSON.stringify(atOldBoundary), NOW)).toEqual(atOldBoundary);
    expect(parseHazardPacket(JSON.stringify(pastOldBoundary), NOW)).toBeNull();
    expect(parseHazardPacket(JSON.stringify(atFutureBoundary), NOW)).toEqual(atFutureBoundary);
    expect(parseHazardPacket(JSON.stringify(pastFutureBoundary), NOW)).toBeNull();
  });

  test('preserves sender-name creation truncation and receive-side field truncation', () => {
    const longName = 'n'.repeat(100);
    expect(createHazardPacket('stop', 'sender', longName, NOW).senderName).toBe('n'.repeat(24));

    const parsed = parseHazardPacket(
      JSON.stringify({
        ...packet(),
        id: 'i'.repeat(120),
        senderId: 's'.repeat(60),
        senderName: longName,
      }),
      NOW,
    );

    expect(parsed).toMatchObject({
      id: 'i'.repeat(96),
      senderId: 's'.repeat(32),
      senderName: 'n'.repeat(24),
    });
  });
});
