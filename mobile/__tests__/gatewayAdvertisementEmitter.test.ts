import {
  createGatewayAdvertisementEmitter,
  createGatewayAdvertisementScheduler,
  type GatewayAdvertisementCycleResult,
  type GatewayAdvertisementEmitterOptions,
} from '../src/connectivity/gatewayAdvertisementEmitter';
import { OPERATIONAL_SEND_TIMEOUT_MS } from '../src/connectivity/boundedSend';
import type { CycleOutcome } from '../src/connectivity/cycleScheduler';
import {
  GATEWAY_ADVERTISEMENT_INTERVAL_MS,
  GATEWAY_ADVERTISEMENT_MAX_HOPS,
  GATEWAY_ADVERTISEMENT_TTL_MS,
} from '../src/connectivity/protocol/gatewayAdvertisement';
import { parseRideMessage } from '../src/connectivity/protocol/rideMessageCodec';

const WALL = 1_700_000_000_000;

function setup(overrides: Partial<GatewayAdvertisementEmitterOptions> = {}) {
  let n = 0;
  let reachable = true;
  const broadcast = jest.fn((_payload: string) => Promise.resolve());
  const generateMessageId = jest.fn(() => `gw-id-${++n}`);
  const wallClock = jest.fn(() => WALL);
  const emitter = createGatewayAdvertisementEmitter({
    rideId: '12345',
    localNodeId: 'rider-c',
    transport: { broadcast },
    generateMessageId,
    wallClock,
    isCloudReachable: () => reachable,
    ...overrides,
  });
  return {
    emitter,
    broadcast,
    generateMessageId,
    wallClock,
    setReachable: (value: boolean) => (reachable = value),
  };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('gateway advertisement emitter', () => {
  test('when reachable, broadcasts one advertisement with a fresh id', async () => {
    const { emitter, broadcast } = setup();

    expect(await emitter.emitAdvertisementCycle()).toEqual({
      status: 'sent',
      messageId: 'gw-id-1',
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(parseRideMessage(broadcast.mock.calls[0][0], WALL)).toEqual({
      v: 1,
      id: 'gw-id-1',
      rideId: '12345',
      originId: 'rider-c',
      type: 'gateway_advertisement',
      priority: 'normal',
      createdAt: WALL,
      expiresAt: WALL + GATEWAY_ADVERTISEMENT_TTL_MS,
      hopCount: 0,
      maxHops: GATEWAY_ADVERTISEMENT_MAX_HOPS,
      payload: {},
    });

    expect(await emitter.emitAdvertisementCycle()).toEqual({
      status: 'sent',
      messageId: 'gw-id-2',
    });
  });

  test('when not reachable: no id consumed, no clock read, nothing sent', async () => {
    const { emitter, broadcast, generateMessageId, wallClock, setReachable } = setup();
    setReachable(false);

    expect(await emitter.emitAdvertisementCycle()).toEqual({ status: 'not_reachable' });
    expect(generateMessageId).not.toHaveBeenCalled();
    expect(wallClock).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('a throwing reachability check fails closed', async () => {
    const { emitter, broadcast } = setup({
      isCloudReachable: () => {
        throw new Error('no signal');
      },
    });
    expect(await emitter.emitAdvertisementCycle()).toEqual({
      status: 'reachability_unavailable',
      error: 'no signal',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('id generation failure sends nothing (no fallback id)', async () => {
    const { emitter, broadcast } = setup({
      generateMessageId: () => {
        throw new Error('secure random unavailable');
      },
    });
    expect(await emitter.emitAdvertisementCycle()).toEqual({
      status: 'message_failed',
      error: 'secure random unavailable',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('an invalid wall clock sends nothing', async () => {
    const { emitter, broadcast, generateMessageId } = setup({ wallClock: () => NaN });
    expect(await emitter.emitAdvertisementCycle()).toEqual({ status: 'invalid_clock' });
    expect(generateMessageId).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('transport rejection and timeout are reported distinctly', async () => {
    const rejecting = setup({
      transport: { broadcast: () => Promise.reject(new Error('mesh_no_peers')) },
    });
    expect(await rejecting.emitter.emitAdvertisementCycle()).toEqual({
      status: 'transport_error',
      messageId: 'gw-id-1',
      error: 'mesh_no_peers',
    });

    jest.useFakeTimers();
    const hung = setup({ transport: { broadcast: () => new Promise<void>(() => {}) } });
    let result: GatewayAdvertisementCycleResult | undefined;
    hung.emitter.emitAdvertisementCycle().then(r => (result = r));
    await jest.advanceTimersByTimeAsync(OPERATIONAL_SEND_TIMEOUT_MS);
    expect(result).toEqual({ status: 'send_timeout', messageId: 'gw-id-1' });
  });
});

describe('gateway advertisement scheduler', () => {
  test('immediate first cycle, then every interval; reachability checked each cycle', async () => {
    jest.useFakeTimers();
    const { emitter, broadcast, setReachable } = setup();
    const outcomes: CycleOutcome<GatewayAdvertisementCycleResult>[] = [];
    const scheduler = createGatewayAdvertisementScheduler(emitter, {
      onCycleSettled: o => outcomes.push(o),
    });

    scheduler.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(broadcast).toHaveBeenCalledTimes(1);

    setReachable(false);
    await jest.advanceTimersByTimeAsync(GATEWAY_ADVERTISEMENT_INTERVAL_MS);
    expect(broadcast).toHaveBeenCalledTimes(1);

    setReachable(true);
    await jest.advanceTimersByTimeAsync(GATEWAY_ADVERTISEMENT_INTERVAL_MS);
    expect(broadcast).toHaveBeenCalledTimes(2);

    expect(outcomes.map(o => o.ok && o.value.status)).toEqual(['sent', 'not_reachable', 'sent']);
    scheduler.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a failed cycle does not stop later cycles', async () => {
    jest.useFakeTimers();
    const broadcast = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('radio busy'))
      .mockResolvedValue(undefined);
    const { emitter } = setup({ transport: { broadcast } });
    const scheduler = createGatewayAdvertisementScheduler(emitter);

    scheduler.start();
    await jest.advanceTimersByTimeAsync(GATEWAY_ADVERTISEMENT_INTERVAL_MS);
    expect(broadcast).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  test('rejects an invalid send timeout', () => {
    expect(() => setup({ sendTimeoutMs: 0 })).toThrow(RangeError);
  });
});
