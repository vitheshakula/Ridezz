import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_HOPS,
  HEARTBEAT_PRIORITY,
  HEARTBEAT_TTL_MS,
  createHeartbeatMessage,
  isHeartbeatPayload,
} from '../src/connectivity/protocol/heartbeat';
import { PEER_OBSERVATION_DEFAULT_FRESHNESS_MS } from '../src/connectivity/peerTable';
import { RIDE_MESSAGE_PRIORITIES } from '../src/connectivity/protocol/rideMessage';
import { serializeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';

const WALL = 1_700_000_000_000;

function heartbeat(overrides: Partial<Parameters<typeof createHeartbeatMessage>[0]> = {}) {
  return createHeartbeatMessage({
    id: 'hb-a-1',
    rideId: '12345',
    originId: 'rider-a',
    createdAt: WALL,
    ...overrides,
  });
}

describe('heartbeat creation', () => {
  test('creates the exact one-hop presence envelope', () => {
    expect(heartbeat()).toEqual({
      v: 1,
      id: 'hb-a-1',
      rideId: '12345',
      originId: 'rider-a',
      type: 'heartbeat',
      priority: 'low',
      createdAt: WALL,
      expiresAt: WALL + 10_000,
      hopCount: 0,
      maxHops: 0,
      payload: {},
    });
  });

  test('uses the named policy constants', () => {
    const m = heartbeat();
    expect(HEARTBEAT_TTL_MS).toBe(10_000);
    expect(HEARTBEAT_MAX_HOPS).toBe(0);
    expect(m.expiresAt - m.createdAt).toBe(HEARTBEAT_TTL_MS);
    expect(m.maxHops).toBe(HEARTBEAT_MAX_HOPS);
    expect(m.priority).toBe(HEARTBEAT_PRIORITY);
  });

  test('uses the lowest existing priority', () => {
    expect(HEARTBEAT_PRIORITY).toBe(RIDE_MESSAGE_PRIORITIES[RIDE_MESSAGE_PRIORITIES.length - 1]);
  });

  test('interval < message TTL < peer freshness', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(HEARTBEAT_TTL_MS);
    expect(HEARTBEAT_TTL_MS).toBeLessThan(PEER_OBSERVATION_DEFAULT_FRESHNESS_MS);
  });

  test('preserves the caller-supplied id, ride, origin and createdAt', () => {
    const m = heartbeat({ id: 'custom-id', rideId: '54321', originId: 'rider-z', createdAt: 42 });
    expect(m).toMatchObject({
      id: 'custom-id',
      rideId: '54321',
      originId: 'rider-z',
      createdAt: 42,
      expiresAt: 42 + HEARTBEAT_TTL_MS,
    });
  });

  test('payload does not duplicate envelope identity or timing', () => {
    const m = heartbeat();
    expect(m.payload).toEqual({});
    expect(serializeRideMessage(m)).toContain('"payload":{}');
  });

  test('deterministic inputs produce identical messages', () => {
    expect(heartbeat()).toEqual(heartbeat());
    expect(serializeRideMessage(heartbeat())).toBe(serializeRideMessage(heartbeat()));
  });

  test('rejects invalid input through createRideMessage', () => {
    expect(() => heartbeat({ id: '' })).toThrow(TypeError);
    expect(() => heartbeat({ originId: '' })).toThrow(TypeError);
    expect(() => heartbeat({ rideId: '' })).toThrow(TypeError);
    expect(() => heartbeat({ createdAt: NaN })).toThrow(RangeError);
  });

  test('reads no clock', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      heartbeat();
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});

describe('heartbeat payload check', () => {
  test('accepts any JSON object, ignoring its keys', () => {
    expect(isHeartbeatPayload({})).toBe(true);
    expect(isHeartbeatPayload({ futureField: 1 })).toBe(true);
  });

  test.each<unknown>([null, [], 'x', 0, false, undefined])('rejects %p', payload => {
    expect(isHeartbeatPayload(payload)).toBe(false);
  });
});
