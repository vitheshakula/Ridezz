import React from 'react';
import { DeviceEventEmitter } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {
  BRAKE_PACKET_BYTES,
  base64ToBytes,
  bytesToBase64,
  decodeBrakePacket,
  encodeBrakePacket,
  type BrakeAlert,
} from '../src/braking/brakePacket';
import { createBrakeCoordinator } from '../src/braking/brakeCoordinator';
import {
  decodeHardBraking,
  describeBrakingDecision,
  emitPeerBrakingAlert,
} from '../src/braking/brakingEvents';
import { useHardBraking, usePeerBraking } from '../src/braking/useHardBraking';
import { extractHazards } from '../src/services/SpeechHazardService';

const NOW = 1_800_000_000_000;

const alertOf = (over: Partial<BrakeAlert> = {}): BrakeAlert => ({
  senderId: 'abc123xy',
  seq: 7,
  timestamp: NOW,
  speedKmh: 62.4,
  peakDecelG: 0.82,
  headingDeg: 271,
  ...over,
});

describe('brake packet', () => {
  test('is 24 bytes and round-trips every field', () => {
    const bytes = encodeBrakePacket(alertOf(), 3);
    expect(bytes.length).toBe(BRAKE_PACKET_BYTES);
    expect(decodeBrakePacket(bytes)).toEqual({ ...alertOf(), hops: 3 });
  });

  test('base64 form is 32 characters and round-trips', () => {
    const bytes = encodeBrakePacket(alertOf());
    const text = bytesToBase64(bytes);
    expect(text).toHaveLength(32);
    expect(Array.from(base64ToBytes(text) ?? [])).toEqual(Array.from(bytes));
  });

  test('quantises speed to 0.1 km/h and deceleration to 0.02 g, and keeps an unknown heading', () => {
    const d = decodeBrakePacket(
      encodeBrakePacket(alertOf({ speedKmh: 62.44, peakDecelG: 0.811, headingDeg: null })),
    );
    expect(d?.speedKmh).toBeCloseTo(62.4, 5);
    expect(d?.peakDecelG).toBeCloseTo(0.82, 5);
    expect(d?.headingDeg).toBeNull();
  });

  test('keeps a full-size epoch timestamp and wraps the sequence at 16 bits', () => {
    const d = decodeBrakePacket(encodeBrakePacket(alertOf({ timestamp: NOW + 123, seq: 65_538 })));
    expect(d?.timestamp).toBe(NOW + 123);
    expect(d?.seq).toBe(2);
  });

  test('rejects wrong length, magic, version, checksum and empty sender', () => {
    const good = encodeBrakePacket(alertOf());
    expect(decodeBrakePacket(good.slice(0, 23))).toBeNull();
    for (const [index, value] of [
      [0, 0x00],
      [1, 0x20],
      [10, (good[10] + 1) % 256],
    ] as const) {
      const bad = good.slice();
      bad[index] = value;
      expect(decodeBrakePacket(bad)).toBeNull();
    }
    expect(decodeBrakePacket(encodeBrakePacket(alertOf({ senderId: '' })))).toBeNull();
  });

  test('base64 parsing is strict', () => {
    expect(base64ToBytes('')).toBeNull();
    expect(base64ToBytes('abc')).toBeNull();
    expect(base64ToBytes('ab!d')).toBeNull();
    expect(base64ToBytes('{"v":1}')).toBeNull();
  });
});

describe('brake coordinator', () => {
  function setup(opts: { online?: boolean; senderId?: string; now?: () => number } = {}) {
    let nearbyHandler: ((p: string) => void) | null = null;
    let liveKitHandler: ((p: Uint8Array<ArrayBuffer>) => void) | null = null;
    const nearby = {
      capabilities: {} as never,
      broadcast: jest.fn(() => Promise.resolve()),
      onPayload: jest.fn((cb: (p: string) => void) => {
        nearbyHandler = cb;
        return () => {
          nearbyHandler = null;
        };
      }),
    };
    const liveKit = {
      capabilities: {} as never,
      broadcast: jest.fn(() => Promise.resolve()),
      onPayload: jest.fn((cb: (p: Uint8Array<ArrayBuffer>) => void) => {
        liveKitHandler = cb;
        return () => {
          liveKitHandler = null;
        };
      }),
    };
    const onPeerBraking = jest.fn();
    const coordinator = createBrakeCoordinator({
      senderId: opts.senderId ?? 'me000001',
      nearbyTransport: nearby,
      liveKitTransport: liveKit,
      isOnline: () => opts.online ?? false,
      onPeerBraking,
      clock: opts.now ?? (() => NOW),
    });
    const off = coordinator.subscribe();
    return {
      coordinator,
      nearby,
      liveKit,
      onPeerBraking,
      off,
      hearNearby: (a: BrakeAlert, hops = 3) =>
        nearbyHandler?.(bytesToBase64(encodeBrakePacket(a, hops))),
      hearLiveKit: (a: BrakeAlert, hops = 3) => liveKitHandler?.(encodeBrakePacket(a, hops)),
      hasHandlers: () => nearbyHandler !== null || liveKitHandler !== null,
    };
  }

  const local: Omit<BrakeAlert, 'senderId'> = {
    seq: 7,
    timestamp: NOW,
    speedKmh: 62.4,
    peakDecelG: 0.82,
    headingDeg: 271,
  };

  test('a local alert goes to the mesh at once, and to the cloud only when online', async () => {
    const offline = setup({ online: false });
    await offline.coordinator.submitLocal(local);
    expect(offline.nearby.broadcast).toHaveBeenCalledTimes(1);
    expect(offline.liveKit.broadcast).not.toHaveBeenCalled();
    const sent = (offline.nearby.broadcast.mock.calls as unknown as string[][])[0][0];
    expect(decodeBrakePacket(base64ToBytes(sent)!)).toMatchObject({
      senderId: 'me000001',
      hops: 3,
    });

    const online = setup({ online: true });
    const outcomes = await online.coordinator.submitLocal(local);
    expect(online.liveKit.broadcast).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { channel: 'mesh', ok: true },
      { channel: 'cloud', ok: true },
    ]);
  });

  test('reports a failed channel without throwing', async () => {
    const s = setup({ online: true });
    s.nearby.broadcast.mockReturnValueOnce(Promise.reject(new Error('no peers')));
    const outcomes = await s.coordinator.submitLocal(local);
    expect(outcomes).toEqual([
      { channel: 'mesh', ok: false },
      { channel: 'cloud', ok: true },
    ]);
  });

  test('delivers a peer alert once, even when it arrives on both transports', () => {
    const s = setup({ online: true });
    s.hearNearby(alertOf());
    s.hearLiveKit(alertOf());
    s.hearNearby(alertOf());
    expect(s.onPeerBraking).toHaveBeenCalledTimes(1);
    expect(s.onPeerBraking.mock.calls[0][0]).toMatchObject({ senderId: 'abc123xy', seq: 7 });
    expect(s.onPeerBraking.mock.calls[0][0]).not.toHaveProperty('hops');
  });

  test('ignores its own alert, stale alerts, and garbage', () => {
    const s = setup();
    s.hearNearby(alertOf({ senderId: 'me000001' }));
    s.hearNearby(alertOf({ timestamp: NOW - 11_000, seq: 8 }));
    s.hearNearby(alertOf({ timestamp: NOW + 11_000, seq: 9 }));
    expect(s.onPeerBraking).not.toHaveBeenCalled();
    expect(() => {
      s.nearby.onPayload.mock.calls[0][0]('{"v":1,"hazard":"fuel"}');
      s.nearby.onPayload.mock.calls[0][0]('!!!!');
    }).not.toThrow();
  });

  test('relays with one fewer hop, to the cloud only for mesh-heard alerts when online', () => {
    const s = setup({ online: true });
    s.hearNearby(alertOf(), 2);
    expect(s.nearby.broadcast).toHaveBeenCalledTimes(1);
    expect(s.liveKit.broadcast).toHaveBeenCalledTimes(1);
    const relayed = decodeBrakePacket(
      base64ToBytes((s.nearby.broadcast.mock.calls as unknown as string[][])[0][0])!,
    );
    expect(relayed?.hops).toBe(1);

    s.hearLiveKit(alertOf({ seq: 99 }), 3);
    expect(s.nearby.broadcast).toHaveBeenCalledTimes(2);
    expect(s.liveKit.broadcast).toHaveBeenCalledTimes(1);
  });

  test('does not relay when the hop budget is spent', () => {
    const s = setup({ online: true });
    s.hearNearby(alertOf(), 0);
    expect(s.onPeerBraking).toHaveBeenCalledTimes(1);
    expect(s.nearby.broadcast).not.toHaveBeenCalled();
    expect(s.liveKit.broadcast).not.toHaveBeenCalled();
  });

  test('unsubscribes cleanly', () => {
    const s = setup();
    expect(s.hasHandlers()).toBe(true);
    s.off();
    expect(s.hasHandlers()).toBe(false);
  });
});

describe('braking bridge decoding', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    seq: 1,
    onsetAt: NOW,
    raisedAt: NOW + 160,
    speedMps: 15,
    speedKmh: 54,
    peakDecelG: 0.8,
    headingDeg: 90,
    source: 'imu',
    ...over,
  });

  test('decodes a well-formed event', () => {
    expect(decodeHardBraking(raw())).toMatchObject({
      seq: 1,
      speedKmh: 54,
      headingDeg: 90,
      source: 'imu',
    });
  });

  test('drops an out-of-range heading and rejects malformed payloads', () => {
    expect(decodeHardBraking(raw({ headingDeg: 400 }))?.headingDeg).toBeNull();
    expect(decodeHardBraking(raw({ headingDeg: null }))?.headingDeg).toBeNull();
    for (const bad of [
      null,
      'x',
      raw({ source: 'magic' }),
      raw({ peakDecelG: 0 }),
      raw({ speedKmh: -1 }),
      raw({ seq: 'a' }),
    ]) {
      expect(decodeHardBraking(bad)).toBeNull();
    }
  });

  test('describes decisions', () => {
    expect(
      describeBrakingDecision({ outcome: 'rejected', reason: 'low_speed', peakDecelG: 0.7 }),
    ).toBe('rejected (low_speed), peak 0.70 g');
    expect(describeBrakingDecision({ outcome: 'confirmed', dropMps: 5 })).toContain('18 km/h');
  });

  test('the spoken warnings contain no word the voice recogniser would act on', () => {
    expect(extractHazards('Warning sent.')).toEqual([]);
    expect(extractHazards('Warning. Heavy braking ahead.')).toEqual([]);
  });
});

describe('braking hooks', () => {
  const flush = () => ReactTestRenderer.act(async () => {});

  function mount<T>(useIt: () => T) {
    const latest: { current: T | null } = { current: null };
    function Probe() {
      latest.current = useIt();
      return null;
    }
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    return { latest, renderer };
  }

  test('useHardBraking hands the alert to the mesh, then announces', async () => {
    const order: string[] = [];
    const onLocalBraking = jest.fn(() => order.push('send'));
    const announce = jest.fn(() => {
      order.push('speak');
    });
    mount(() => useHardBraking({ onLocalBraking, announce }));
    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit('onHardBrakingDetected', {
        seq: 3,
        onsetAt: NOW,
        raisedAt: NOW + 160,
        speedKmh: 54,
        peakDecelG: 0.8,
        headingDeg: null,
        source: 'imu',
      });
      DeviceEventEmitter.emit('onHardBrakingDetected', { seq: 'bad' });
    });
    await flush();
    expect(onLocalBraking).toHaveBeenCalledTimes(1);
    expect(onLocalBraking.mock.calls[0]).toEqual([expect.objectContaining({ seq: 3 })]);
    expect(order).toEqual(['send', 'speak']);
  });

  test('usePeerBraking shows the flasher for each alert and clears it', async () => {
    jest.useFakeTimers();
    try {
      const announce = jest.fn();
      const { latest } = mount(() => usePeerBraking({ announce }));
      expect(latest.current).toBeNull();
      ReactTestRenderer.act(() => emitPeerBrakingAlert(alertOf()));
      expect(latest.current?.senderId).toBe('abc123xy');
      expect(announce).toHaveBeenCalledTimes(1);
      ReactTestRenderer.act(() => {
        jest.advanceTimersByTime(4100);
      });
      expect(latest.current).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
