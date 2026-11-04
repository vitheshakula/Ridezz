import {
  GATEWAY_ROUTABLE_MESSAGE_TYPES,
  RIDE_MESSAGE_MAX_GATEWAY_DISTANCE,
  RIDE_MESSAGE_MAX_HOP_LIMIT,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  createRideMessage,
  isValidGatewayRouting,
  relayRideMessage,
  withGatewayRouting,
  type RideMessageType,
} from '../src/connectivity/protocol/rideMessage';
import {
  encodeRideMessage,
  parseRideMessage,
  serializeRideMessage,
} from '../src/connectivity/protocol/rideMessageCodec';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import { createGatewayAdvertisementMessage } from '../src/connectivity/protocol/gatewayAdvertisement';

const WALL = 1_700_000_000_000;

function message(type: RideMessageType = 'ride_state') {
  return createRideMessage({
    id: 'msg-1',
    rideId: '12345',
    originId: 'rider-x',
    type,
    priority: 'normal',
    payload: { note: 'cloud-bound' },
    ttlMs: 30_000,
    maxHops: 8,
    now: WALL,
  });
}

function routed(targetGatewayId = 'rider-c', forwarderDistance = 3) {
  return withGatewayRouting(message(), { targetGatewayId, forwarderDistance });
}

function rawWithRouting(gatewayRouting: unknown, type: RideMessageType = 'ride_state'): string {
  const wire = JSON.parse(serializeRideMessage(message(type)));
  return JSON.stringify({ ...wire, gatewayRouting });
}

describe('gateway routing metadata: representation', () => {
  test('a routed message carries targetGatewayId and forwarderDistance on the envelope', () => {
    expect(routed().gatewayRouting).toEqual({ targetGatewayId: 'rider-c', forwarderDistance: 3 });
    expect(Object.isFrozen(routed().gatewayRouting)).toBe(true);
  });

  test('non-routed messages carry no routing metadata and keep the exact v1 wire form', () => {
    expect(message()).not.toHaveProperty('gatewayRouting');
    expect(serializeRideMessage(message())).not.toContain('gatewayRouting');
    expect(parseRideMessage(serializeRideMessage(message()), WALL)).toEqual(message());
  });

  test('routing is serialized in fixed order before the payload', () => {
    expect(serializeRideMessage(routed())).toContain(
      '"maxHops":8,"gatewayRouting":{"targetGatewayId":"rider-c","forwarderDistance":3},"payload"',
    );
  });

  test('round-trips through string and bytes', () => {
    const m = routed('rider-c', 17);
    expect(parseRideMessage(serializeRideMessage(m), WALL)).toEqual(m);
    expect(parseRideMessage(encodeRideMessage(m), WALL)).toEqual(m);
  });

  test('the only routable types are application messages', () => {
    expect([...GATEWAY_ROUTABLE_MESSAGE_TYPES].sort()).toEqual(
      ['ack', 'hazard', 'location', 'ride_state', 'sos'].sort(),
    );
    for (const type of GATEWAY_ROUTABLE_MESSAGE_TYPES) {
      const m = withGatewayRouting(message(type), { targetGatewayId: 'g', forwarderDistance: 1 });
      expect(parseRideMessage(serializeRideMessage(m), WALL)?.gatewayRouting).toEqual({
        targetGatewayId: 'g',
        forwarderDistance: 1,
      });
    }
  });

  test('the distance bound follows the protocol hop limit', () => {
    expect(RIDE_MESSAGE_MAX_GATEWAY_DISTANCE).toBe(RIDE_MESSAGE_MAX_HOP_LIMIT + 1);
  });
});

describe('gateway routing metadata: strict validation', () => {
  test.each<[string, unknown]>([
    ['empty target', { targetGatewayId: '', forwarderDistance: 2 }],
    [
      'oversized target',
      { targetGatewayId: 'x'.repeat(RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH + 1), forwarderDistance: 2 },
    ],
    ['numeric target', { targetGatewayId: 7, forwarderDistance: 2 }],
    ['missing target', { forwarderDistance: 2 }],
    ['zero distance', { targetGatewayId: 'rider-c', forwarderDistance: 0 }],
    ['negative distance', { targetGatewayId: 'rider-c', forwarderDistance: -1 }],
    ['fractional distance', { targetGatewayId: 'rider-c', forwarderDistance: 1.5 }],
    ['string distance', { targetGatewayId: 'rider-c', forwarderDistance: '2' }],
    ['null distance', { targetGatewayId: 'rider-c', forwarderDistance: null }],
    [
      'distance above bound',
      { targetGatewayId: 'rider-c', forwarderDistance: RIDE_MESSAGE_MAX_GATEWAY_DISTANCE + 1 },
    ],
    ['missing distance', { targetGatewayId: 'rider-c' }],
    ['extra key', { targetGatewayId: 'rider-c', forwarderDistance: 2, via: 'rider-b' }],
    ['null', null],
    ['array', ['rider-c', 2]],
    ['string', 'rider-c'],
  ])('rejects %s on the wire', (_label, gatewayRouting) => {
    expect(parseRideMessage(rawWithRouting(gatewayRouting), WALL)).toBeNull();
    expect(isValidGatewayRouting(gatewayRouting)).toBe(false);
  });

  test('rejects a distance that overflows to Infinity on the wire', () => {
    const text = rawWithRouting({ targetGatewayId: 'rider-c', forwarderDistance: 'X' }).replace(
      '"X"',
      '1e999',
    );
    expect(text).toContain('"forwarderDistance":1e999');
    expect(parseRideMessage(text, WALL)).toBeNull();
  });

  test('rejects routing on control-plane messages', () => {
    const valid = { targetGatewayId: 'rider-c', forwarderDistance: 2 };
    expect(parseRideMessage(rawWithRouting(valid, 'heartbeat'), WALL)).toBeNull();
    expect(parseRideMessage(rawWithRouting(valid, 'gateway_advertisement'), WALL)).toBeNull();

    const hb = createHeartbeatMessage({
      id: 'hb',
      rideId: '12345',
      originId: 'x',
      createdAt: WALL,
    });
    const ad = createGatewayAdvertisementMessage({
      id: 'gw',
      rideId: '12345',
      originId: 'x',
      createdAt: WALL,
    });
    expect(() => withGatewayRouting(hb, valid)).toThrow(TypeError);
    expect(() => withGatewayRouting(ad, valid)).toThrow(TypeError);
  });

  test('withGatewayRouting and the serializer refuse invalid routing', () => {
    expect(() =>
      withGatewayRouting(message(), { targetGatewayId: '', forwarderDistance: 2 }),
    ).toThrow(RangeError);
    expect(() =>
      withGatewayRouting(message(), { targetGatewayId: 'rider-c', forwarderDistance: 0 }),
    ).toThrow(RangeError);
    const forged = { ...message(), gatewayRouting: { targetGatewayId: 'c', forwarderDistance: 0 } };
    expect(() => serializeRideMessage(forged)).toThrow(TypeError);
  });

  test('withGatewayRouting never mutates and copies only the two fields', () => {
    const original = message();
    const routing = { targetGatewayId: 'rider-c', forwarderDistance: 3, extra: 'ignored' };
    const result = withGatewayRouting(original, routing);

    expect(original).not.toHaveProperty('gatewayRouting');
    expect(result.gatewayRouting).toEqual({ targetGatewayId: 'rider-c', forwarderDistance: 3 });
    routing.forwarderDistance = 1;
    expect(result.gatewayRouting?.forwarderDistance).toBe(3);
  });

  test('a plain relay copy preserves routing unchanged', () => {
    expect(relayRideMessage(routed(), WALL)?.gatewayRouting).toEqual(routed().gatewayRouting);
  });
});
