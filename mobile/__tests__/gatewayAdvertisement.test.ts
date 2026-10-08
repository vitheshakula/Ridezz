import {
  GATEWAY_ADVERTISEMENT_INTERVAL_MS,
  GATEWAY_ADVERTISEMENT_MAX_HOPS,
  GATEWAY_ADVERTISEMENT_PRIORITY,
  GATEWAY_ADVERTISEMENT_TTL_MS,
  createGatewayAdvertisementMessage,
  isGatewayAdvertisementPayload,
} from '../src/connectivity/protocol/gatewayAdvertisement';
import { GATEWAY_OBSERVATION_DEFAULT_FRESHNESS_MS } from '../src/connectivity/gatewayState';
import { decideRelay } from '../src/connectivity/relayPolicy';
import {
  RIDE_MESSAGE_MAX_HOP_LIMIT,
  RIDE_MESSAGE_MAX_TTL_MS,
  RIDE_MESSAGE_PRIORITIES,
  type RideMessage,
} from '../src/connectivity/protocol/rideMessage';
import { serializeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { HEARTBEAT_PRIORITY } from '../src/connectivity/protocol/heartbeat';

const WALL = 1_700_000_000_000;

function advert(overrides: Partial<Parameters<typeof createGatewayAdvertisementMessage>[0]> = {}) {
  return createGatewayAdvertisementMessage({
    id: 'gw-c-1',
    rideId: '12345',
    originId: 'rider-c',
    createdAt: WALL,
    ...overrides,
  });
}

describe('gateway advertisement: creation', () => {
  test('creates the exact envelope', () => {
    expect(advert()).toEqual({
      v: 1,
      id: 'gw-c-1',
      rideId: '12345',
      originId: 'rider-c',
      type: 'gateway_advertisement',
      priority: 'normal',
      createdAt: WALL,
      expiresAt: WALL + 30_000,
      hopCount: 0,
      maxHops: 4,
      payload: {},
    });
  });

  test('uses the named constants, within protocol limits', () => {
    const m = advert();
    expect(m.expiresAt - m.createdAt).toBe(GATEWAY_ADVERTISEMENT_TTL_MS);
    expect(m.maxHops).toBe(GATEWAY_ADVERTISEMENT_MAX_HOPS);
    expect(m.priority).toBe(GATEWAY_ADVERTISEMENT_PRIORITY);
    expect(GATEWAY_ADVERTISEMENT_TTL_MS).toBeLessThanOrEqual(RIDE_MESSAGE_MAX_TTL_MS);
    expect(GATEWAY_ADVERTISEMENT_MAX_HOPS).toBeLessThanOrEqual(RIDE_MESSAGE_MAX_HOP_LIMIT);
  });

  test('priority sits between emergency traffic and heartbeats', () => {
    const rank = (p: string) => RIDE_MESSAGE_PRIORITIES.indexOf(p as never);
    expect(rank(GATEWAY_ADVERTISEMENT_PRIORITY)).toBeGreaterThan(rank('high'));
    expect(rank(GATEWAY_ADVERTISEMENT_PRIORITY)).toBeLessThan(rank(HEARTBEAT_PRIORITY));
  });

  test('interval < local freshness < TTL: one or two lost adverts are tolerated', () => {
    expect(GATEWAY_ADVERTISEMENT_INTERVAL_MS).toBe(10_000);
    expect(2 * GATEWAY_ADVERTISEMENT_INTERVAL_MS).toBeLessThan(
      GATEWAY_OBSERVATION_DEFAULT_FRESHNESS_MS,
    );
    expect(GATEWAY_OBSERVATION_DEFAULT_FRESHNESS_MS).toBeLessThan(GATEWAY_ADVERTISEMENT_TTL_MS);
  });

  test('preserves caller-supplied id, ride, origin and time', () => {
    expect(advert({ id: 'x-1', rideId: '54321', originId: 'rider-z', createdAt: 7 })).toMatchObject(
      { id: 'x-1', rideId: '54321', originId: 'rider-z', createdAt: 7, expiresAt: 30_007 },
    );
  });

  test('minimal payload, deterministic output, no clock read', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      expect(advert().payload).toEqual({});
      expect(serializeRideMessage(advert())).toBe(serializeRideMessage(advert()));
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  test('rejects invalid input through createRideMessage', () => {
    expect(() => advert({ id: '' })).toThrow(TypeError);
    expect(() => advert({ originId: '' })).toThrow(TypeError);
    expect(() => advert({ createdAt: -1 })).toThrow(RangeError);
  });

  test('payload check accepts any JSON object only', () => {
    expect(isGatewayAdvertisementPayload({})).toBe(true);
    expect(isGatewayAdvertisementPayload({ future: 1 })).toBe(true);
    for (const bad of [null, [], 'x', 0, undefined]) {
      expect(isGatewayAdvertisementPayload(bad)).toBe(false);
    }
  });
});

describe('gateway advertisement: relay', () => {
  test('relays C → B → A … with origin unchanged until maxHops, then stops', () => {
    const atC = advert();
    const copies: RideMessage<unknown>[] = [atC];
    let current: RideMessage<unknown> = atC;
    for (let hop = 1; hop <= GATEWAY_ADVERTISEMENT_MAX_HOPS; hop++) {
      const decision = decideRelay(current, WALL + hop * 100);
      if (!decision.relay) {
        throw new Error(`relay refused at hop ${hop}: ${decision.reason}`);
      }
      current = decision.message;
      copies.push(current);
    }

    expect(copies.map(m => m.hopCount)).toEqual([0, 1, 2, 3, 4]);
    for (const m of copies) {
      expect(m).toMatchObject({ id: 'gw-c-1', originId: 'rider-c', expiresAt: atC.expiresAt });
    }
    expect(decideRelay(current, WALL + 1_000)).toEqual({ relay: false, reason: 'hop_limit' });
  });

  test('an expired advertisement is not relayed', () => {
    expect(decideRelay(advert(), WALL + GATEWAY_ADVERTISEMENT_TTL_MS)).toEqual({
      relay: false,
      reason: 'expired',
    });
  });
});
