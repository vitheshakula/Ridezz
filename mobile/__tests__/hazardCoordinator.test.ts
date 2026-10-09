import { createHazardCoordinator } from '../src/hazards/HazardCoordinator';
import {
  createHazardPacket,
  encodeHazardPacket,
  serializeHazardPacket,
  type HazardPacket,
  type HazardType,
} from '../src/protocol/hazardProtocol';
import type { BroadcastTransport, TransportCapabilities } from '../src/transports/Transport';

const NOW = 1_800_000_000_000;
const LOCAL_SENDER_ID = 'local';
const CAPABILITIES: Readonly<TransportCapabilities> = {
  broadcast: true,
  targeted: false,
  peerIdentity: false,
  linkMetrics: false,
  deliveryAck: false,
};

function createFakeTransport<Payload extends string | Uint8Array>(
  name: string,
  order: string[],
) {
  const listeners = new Set<(payload: Payload) => void>();
  const unsubscribes: jest.Mock[] = [];
  const broadcast = jest.fn((_payload: Payload): Promise<void> => {
    order.push(name);
    return Promise.resolve();
  });
  const onPayload = jest.fn((callback: (payload: Payload) => void) => {
    listeners.add(callback);
    const unsubscribe = jest.fn(() => listeners.delete(callback));
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  });
  const transport: BroadcastTransport<Payload> = {
    capabilities: CAPABILITIES,
    broadcast,
    onPayload,
  };
  return {
    transport,
    broadcast,
    onPayload,
    unsubscribes,
    emit(payload: Payload) {
      [...listeners].forEach(listener => listener(payload));
    },
  };
}

function packet(
  id: string,
  hazard: HazardType = 'pothole',
  senderId: string = 'remote',
): HazardPacket {
  return {
    ...createHazardPacket(hazard, senderId, 'Alex', NOW),
    id,
  };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setup(initialOnline = true) {
  let online = initialOnline;
  let now = NOW;
  const order: string[] = [];
  const nearby = createFakeTransport<string>('mesh', order);
  const liveKit = createFakeTransport<Uint8Array<ArrayBuffer>>('cloud', order);
  const onLocalAccepted = jest.fn((_packet: HazardPacket) => order.push('local accepted'));
  const onIncomingAccepted = jest.fn(
    (_packet: HazardPacket, _ingress: 'livekit' | 'nearby', _shouldAnnounce: boolean) =>
      order.push('incoming accepted'),
  );
  const onLocalSendResult = jest.fn((_packet: HazardPacket, _outcomes: unknown) =>
    order.push('send result'),
  );
  const coordinator = createHazardCoordinator({
    senderId: LOCAL_SENDER_ID,
    nearbyTransport: nearby.transport,
    liveKitTransport: liveKit.transport,
    isOnline: () => online,
    onLocalAccepted,
    onIncomingAccepted,
    onLocalSendResult,
    clock: () => now,
  });

  return {
    coordinator,
    nearby,
    liveKit,
    order,
    onLocalAccepted,
    onIncomingAccepted,
    onLocalSendResult,
    setOnline(value: boolean) {
      online = value;
    },
    advance(milliseconds: number) {
      now += milliseconds;
      jest.setSystemTime(now);
    },
  };
}

describe('HazardCoordinator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('local hazards', () => {
    test('notifies first, invokes Nearby before LiveKit, and preserves exact wire payloads online', async () => {
      const state = setup(true);
      const local = packet('local-online', 'gravel', LOCAL_SENDER_ID);

      state.coordinator.submitLocal(local);

      expect(state.onLocalAccepted).toHaveBeenCalledWith(local);
      expect(state.order.slice(0, 3)).toEqual(['local accepted', 'mesh', 'cloud']);
      expect(state.nearby.broadcast).toHaveBeenCalledWith(serializeHazardPacket(local));
      expect(Array.from(state.liveKit.broadcast.mock.calls[0][0])).toEqual(
        Array.from(encodeHazardPacket(local)),
      );

      await settlePromises();
      expect(state.onLocalSendResult).toHaveBeenCalledWith(local, [
        { channel: 'mesh', ok: true },
        { channel: 'cloud', ok: true },
      ]);
    });

    test('always sends Nearby but does not send LiveKit while offline', async () => {
      const state = setup(false);
      const local = packet('local-offline', 'gravel', LOCAL_SENDER_ID);

      state.coordinator.submitLocal(local);
      await settlePromises();

      expect(state.nearby.broadcast).toHaveBeenCalledTimes(1);
      expect(state.liveKit.broadcast).not.toHaveBeenCalled();
      expect(state.onLocalSendResult).toHaveBeenCalledWith(local, [
        { channel: 'mesh', ok: true },
      ]);
    });

    test('reads current online state without recreating the coordinator', () => {
      const state = setup(false);
      state.setOnline(true);

      state.coordinator.submitLocal(packet('became-online', 'police', LOCAL_SENDER_ID));

      expect(state.liveKit.broadcast).toHaveBeenCalledTimes(1);
    });

    test('suppresses a repeated local hazard type without UI or transport effects', async () => {
      const state = setup(true);
      state.coordinator.submitLocal(packet('first', 'pothole', LOCAL_SENDER_ID));
      await settlePromises();
      state.nearby.broadcast.mockClear();
      state.liveKit.broadcast.mockClear();
      state.onLocalAccepted.mockClear();
      state.onLocalSendResult.mockClear();
      state.advance(1);

      state.coordinator.submitLocal(packet('suppressed', 'pothole', LOCAL_SENDER_ID));
      await settlePromises();

      expect(state.onLocalAccepted).not.toHaveBeenCalled();
      expect(state.nearby.broadcast).not.toHaveBeenCalled();
      expect(state.liveKit.broadcast).not.toHaveBeenCalled();
      expect(state.onLocalSendResult).not.toHaveBeenCalled();
    });

    test('reports both local send failures without rejecting', async () => {
      const state = setup(true);
      state.nearby.broadcast.mockImplementationOnce(() => Promise.reject(new Error('mesh down')));
      state.liveKit.broadcast.mockImplementationOnce(() => Promise.reject(new Error('cloud down')));
      const local = packet('failed', 'accident', LOCAL_SENDER_ID);

      expect(() => state.coordinator.submitLocal(local)).not.toThrow();
      await settlePromises();

      expect(state.onLocalSendResult).toHaveBeenCalledWith(local, [
        { channel: 'mesh', ok: false, error: 'mesh down' },
        { channel: 'cloud', ok: false, error: 'cloud down' },
      ]);
    });

    test('reports local outcomes in completion order, matching Phase 1', async () => {
      const state = setup(true);
      let resolveMesh: (() => void) | undefined;
      state.nearby.broadcast.mockImplementationOnce(
        () => new Promise<void>(resolve => (resolveMesh = resolve)),
      );
      state.liveKit.broadcast.mockImplementationOnce(() => Promise.resolve());
      const local = packet('completion-order', 'slow', LOCAL_SENDER_ID);

      state.coordinator.submitLocal(local);
      await settlePromises();
      expect(state.onLocalSendResult).not.toHaveBeenCalled();

      resolveMesh?.();
      await settlePromises();
      expect(state.onLocalSendResult).toHaveBeenCalledWith(local, [
        { channel: 'cloud', ok: true },
        { channel: 'mesh', ok: true },
      ]);
    });
  });

  describe('LiveKit ingress', () => {
    test('accepts valid bytes, notifies before relaying Nearby, and never republishes LiveKit', () => {
      const state = setup(true);
      state.coordinator.subscribe();
      const incoming = packet('livekit-valid');

      state.liveKit.emit(encodeHazardPacket(incoming));

      expect(state.onIncomingAccepted).toHaveBeenCalledWith(incoming, 'livekit', true);
      expect(state.order).toEqual(['incoming accepted', 'mesh']);
      expect(state.nearby.broadcast).toHaveBeenCalledWith(serializeHazardPacket(incoming));
      expect(state.liveKit.broadcast).not.toHaveBeenCalled();
    });

    test('ignores malformed, local-bounce, duplicate, and same-type packets', () => {
      const state = setup(true);
      state.coordinator.subscribe();
      const accepted = packet('accepted');

      state.liveKit.emit(new Uint8Array([0xff]));
      state.liveKit.emit(encodeHazardPacket(packet('local-bounce', 'gravel', LOCAL_SENDER_ID)));
      state.liveKit.emit(encodeHazardPacket(accepted));
      state.liveKit.emit(encodeHazardPacket(accepted));
      state.advance(1);
      state.liveKit.emit(encodeHazardPacket(packet('same-type')));

      expect(state.onIncomingAccepted).toHaveBeenCalledTimes(1);
      expect(state.onIncomingAccepted).toHaveBeenCalledWith(accepted, 'livekit', true);
      expect(state.nearby.broadcast).toHaveBeenCalledTimes(1);
      expect(state.liveKit.broadcast).not.toHaveBeenCalled();
    });

    test('silently swallows a Nearby relay failure', async () => {
      const state = setup(true);
      state.nearby.broadcast.mockImplementationOnce(() => Promise.reject(new Error('mesh down')));
      state.coordinator.subscribe();
      const incoming = packet('livekit-relay-failure');

      expect(() => state.liveKit.emit(encodeHazardPacket(incoming))).not.toThrow();
      await settlePromises();

      expect(state.onIncomingAccepted).toHaveBeenCalledWith(incoming, 'livekit', true);
      expect(state.onLocalSendResult).not.toHaveBeenCalled();
    });
  });

  describe('Nearby ingress', () => {
    test('notifies, then relays LiveKit before Nearby while online', () => {
      const state = setup(true);
      state.coordinator.subscribe();
      const incoming = packet('nearby-online', 'obstacle');

      state.nearby.emit(serializeHazardPacket(incoming));

      expect(state.onIncomingAccepted).toHaveBeenCalledWith(incoming, 'nearby', true);
      expect(state.order).toEqual(['incoming accepted', 'cloud', 'mesh']);
      expect(Array.from(state.liveKit.broadcast.mock.calls[0][0])).toEqual(
        Array.from(encodeHazardPacket(incoming)),
      );
      expect(state.nearby.broadcast).toHaveBeenCalledWith(serializeHazardPacket(incoming));
    });

    test('relays only Nearby while offline', () => {
      const state = setup(false);
      state.coordinator.subscribe();
      const incoming = packet('nearby-offline', 'obstacle');

      state.nearby.emit(serializeHazardPacket(incoming));

      expect(state.onIncomingAccepted).toHaveBeenCalledWith(incoming, 'nearby', true);
      expect(state.nearby.broadcast).toHaveBeenCalledTimes(1);
      expect(state.liveKit.broadcast).not.toHaveBeenCalled();
    });

    test('ignores malformed, duplicate, and same-type packets', () => {
      const state = setup(true);
      state.coordinator.subscribe();
      const accepted = packet('nearby-accepted', 'roadkill');

      state.nearby.emit('not-json');
      state.nearby.emit(serializeHazardPacket(accepted));
      state.nearby.emit(serializeHazardPacket(accepted));
      state.advance(1);
      state.nearby.emit(serializeHazardPacket(packet('nearby-same-type', 'roadkill')));

      expect(state.onIncomingAccepted).toHaveBeenCalledTimes(1);
      expect(state.liveKit.broadcast).toHaveBeenCalledTimes(1);
      expect(state.nearby.broadcast).toHaveBeenCalledTimes(1);
    });

    test('silently swallows both relay failures', async () => {
      const state = setup(true);
      state.liveKit.broadcast.mockImplementationOnce(() => Promise.reject(new Error('cloud down')));
      state.nearby.broadcast.mockImplementationOnce(() => Promise.reject(new Error('mesh down')));
      state.coordinator.subscribe();
      const incoming = packet('nearby-relay-failure', 'fuel');

      expect(() => state.nearby.emit(serializeHazardPacket(incoming))).not.toThrow();
      await settlePromises();

      expect(state.onIncomingAccepted).toHaveBeenCalledWith(incoming, 'nearby', true);
      expect(state.onLocalSendResult).not.toHaveBeenCalled();
    });
  });

  describe('subscriptions', () => {
    test('subscribes once to both transports and cleans both up idempotently', () => {
      const state = setup();
      const firstCleanup = state.coordinator.subscribe();
      const secondCleanup = state.coordinator.subscribe();

      expect(secondCleanup).toBe(firstCleanup);
      expect(state.liveKit.onPayload).toHaveBeenCalledTimes(1);
      expect(state.nearby.onPayload).toHaveBeenCalledTimes(1);

      firstCleanup();
      secondCleanup();
      expect(state.liveKit.unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(state.nearby.unsubscribes[0]).toHaveBeenCalledTimes(1);
    });

    test('allows one fresh subscription set after cleanup without retaining old listeners', () => {
      const state = setup();
      const cleanup = state.coordinator.subscribe();
      cleanup();
      state.coordinator.subscribe();
      const incoming = packet('after-resubscribe', 'sharp_turn');

      state.liveKit.emit(encodeHazardPacket(incoming));

      expect(state.liveKit.onPayload).toHaveBeenCalledTimes(2);
      expect(state.nearby.onPayload).toHaveBeenCalledTimes(2);
      expect(state.onIncomingAccepted).toHaveBeenCalledTimes(1);
    });
  });
});
