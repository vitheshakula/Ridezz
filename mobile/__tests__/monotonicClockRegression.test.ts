import { createMonotonicClock } from '../src/connectivity/rideConnectivityLifecycle';
import {
  createRideConnectivityRuntime,
  type RideConnectivityEvent,
} from '../src/connectivity/rideConnectivityRuntime';
import { createPeerTable } from '../src/connectivity/peerTable';
import { createDirectLinkIdentityMap } from '../src/connectivity/directLinkIdentityMap';
import { createGatewayState } from '../src/connectivity/gatewayState';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import { createGatewayAdvertisementMessage } from '../src/connectivity/protocol/gatewayAdvertisement';
import { isValidRideMessageTimestamp } from '../src/connectivity/protocol/rideMessage';
import { serializeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import type { ConnectivityReceiveResult } from '../src/connectivity/connectivityReceiver';

/**
 * Regression for M7-B: on Android/Hermes performance.now() has sub-millisecond precision (devices
 * returned e.g. 19290243.959202), and the peer table, link map and gateway state accept only
 * safe-integer timestamps, so every received heartbeat was rejected as 'invalid'. The protocol
 * clock must report whole milliseconds; the stores must stay strict.
 */

/** A performance-like source that returns fractional milliseconds, like a device does. */
function fractionalPerformance(start = 19_290_243.959202, step = 0.731) {
  let value = start;
  return {
    performance: {
      now(): number {
        const current = value;
        value += step;
        return current;
      },
    },
    advance(ms: number) {
      value += ms;
    },
  };
}

describe('createMonotonicClock with a fractional performance.now', () => {
  test('returns integer milliseconds', () => {
    const source = fractionalPerformance();
    const clock = createMonotonicClock(source);
    for (let i = 0; i < 50; i++) {
      const now = clock();
      expect(Number.isSafeInteger(now)).toBe(true);
      expect(isValidRideMessageTimestamp(now)).toBe(true);
    }
    expect(createMonotonicClock(fractionalPerformance(19_290_243.959202, 0))()).toBe(19_290_243);
  });

  test('stays nondecreasing, including across sub-millisecond steps', () => {
    // Steps smaller than 1 ms produce repeats (never a decrease); larger steps advance.
    const source = fractionalPerformance(1000.999, 0.0004);
    const clock = createMonotonicClock(source);
    let previous = clock();
    for (let i = 0; i < 5000; i++) {
      if (i % 250 === 0) {
        source.advance(3.3);
      }
      const now = clock();
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    expect(previous).toBeGreaterThan(1000);
  });

  test('still fails closed without performance.now and never uses Date.now', () => {
    const dateNow = jest.spyOn(Date, 'now');
    try {
      expect(() => createMonotonicClock({})).toThrow('performance.now is unavailable');
      expect(dateNow).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe('timestamp validation stays strict', () => {
  const fractional = 19_290_243.959202;

  test('the shared validator still rejects non-integer, negative and non-number timestamps', () => {
    expect(isValidRideMessageTimestamp(fractional)).toBe(false);
    expect(isValidRideMessageTimestamp(-1)).toBe(false);
    expect(isValidRideMessageTimestamp(Number.NaN)).toBe(false);
    expect(isValidRideMessageTimestamp(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isValidRideMessageTimestamp('19290243')).toBe(false);
    expect(isValidRideMessageTimestamp(Math.floor(fractional))).toBe(true);
  });

  test('peer table, link map and gateway state still reject a fractional now', () => {
    expect(createPeerTable({ localNodeId: 'local' }).observe('remote', 'nearby', fractional)).toEqual({
      observed: false,
      reason: 'invalid',
    });
    expect(
      createDirectLinkIdentityMap({ localNodeId: 'local' }).observe('nearby', 'EP01', 'remote', fractional),
    ).toEqual(expect.objectContaining({ observed: false, reason: 'invalid' }));
    expect(
      createGatewayState({ localNodeId: 'local' }).observe('gw', 'nearby', 0, fractional, 'gw'),
    ).toEqual(expect.objectContaining({ observed: false, reason: 'invalid' }));
  });
});

describe('a real runtime on a fractional device clock', () => {
  const RIDE = '39216';
  const WALL = 1_791_620_000_000;
  const LOCAL = 'node-a-1f675499';
  const REMOTE = 'node-b-822ac170';
  const REMOTE_ENDPOINT = 'M3S0';
  const started: { stop(): void }[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Always stop the schedulers, even when an assertion failed mid-test.
    started.splice(0).forEach(runtime => runtime.stop());
    jest.useRealTimers();
  });

  function harness() {
    let deliver: ((source: { endpointId: string }, payload: string) => void) | null = null;
    const events: RideConnectivityEvent[] = [];
    let ids = 0;
    const source = fractionalPerformance();
    const runtime = createRideConnectivityRuntime({
      rideId: RIDE,
      localNodeId: LOCAL,
      transportId: 'nearby',
      transport: {
        broadcast: jest.fn(() => Promise.resolve()),
        sendTo: jest.fn(() => Promise.resolve()),
        onPayloadFrom: jest.fn(callback => {
          deliver = callback;
          return () => {
            deliver = null;
          };
        }),
      },
      generateMessageId: () => `local-message-${++ids}`,
      wallClock: () => WALL,
      // The production clock factory over a device-like fractional source.
      monotonicClock: createMonotonicClock(source),
      isCloudReachable: () => false,
      onEvent: event => events.push(event),
    });
    runtime.start();
    started.push(runtime);
    const receive = async (payload: string) => {
      deliver?.({ endpointId: REMOTE_ENDPOINT }, payload);
      // Let the async receive pipeline (and an advertisement's bounded relay) settle.
      await jest.advanceTimersByTimeAsync(0);
    };
    const results = () =>
      events.flatMap(e => (e.kind === 'receive' ? [e.result as ConnectivityReceiveResult] : []));
    return { runtime, receive, results };
  }

  test('a received heartbeat populates the peer table and the endpoint-to-node mapping', async () => {
    const h = harness();
    await h.receive(
      serializeRideMessage(
        createHeartbeatMessage({ id: 'hb-remote-1', rideId: RIDE, originId: REMOTE, createdAt: WALL }),
      ),
    );

    const heartbeat = h.results().find(r => r.stage === 'heartbeat');
    expect(heartbeat).toEqual({
      stage: 'heartbeat',
      result: expect.objectContaining({
        observed: true,
        nodeId: REMOTE,
        transportId: 'nearby',
        change: 'new_peer',
        link: expect.objectContaining({ observed: true, change: 'new_link' }),
      }),
    });

  });

  test('with the link learned, a gateway advertisement yields a route via that peer', async () => {
    const h = harness();
    await h.receive(
      serializeRideMessage(
        createHeartbeatMessage({ id: 'hb-remote-2', rideId: RIDE, originId: REMOTE, createdAt: WALL }),
      ),
    );
    await h.receive(
      serializeRideMessage(
        createGatewayAdvertisementMessage({
          id: 'adv-remote-1',
          rideId: RIDE,
          originId: REMOTE,
          createdAt: WALL,
        }),
      ),
    );

    const advertisement = h.results().find(r => r.stage === 'gateway_advertisement');
    expect(advertisement).toEqual(
      expect.objectContaining({
        stage: 'gateway_advertisement',
        result: expect.objectContaining({ observed: true, gatewayNodeId: REMOTE }),
      }),
    );
    expect(h.runtime.getGatewayRoute()).toEqual(
      expect.objectContaining({
        ok: true,
        route: expect.objectContaining({ gatewayNodeId: REMOTE, nextHopNodeId: REMOTE }),
      }),
    );

  });
});
