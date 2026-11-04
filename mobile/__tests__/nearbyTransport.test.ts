import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  createHazardPacket,
  parseHazardPacket,
  serializeHazardPacket,
} from '../src/protocol/hazardProtocol';

const NOW = 1_800_000_000_000;

describe('nearbyTransport', () => {
  const originalOS = Platform.OS;
  let transport: typeof import('../src/transports/NearbyTransport').nearbyTransport;
  let startMeshSession: jest.Mock;
  let stopMeshSession: jest.Mock;
  let broadcastHazard: jest.Mock;
  let resolvers: Array<() => void>;

  beforeEach(() => {
    resolvers = [];
    startMeshSession = jest.fn(() => Promise.resolve());
    stopMeshSession = jest.fn(() => Promise.resolve());
    broadcastHazard = jest.fn(() => new Promise<void>(resolve => resolvers.push(resolve)));
    (Platform as { OS: string }).OS = 'android';
    (NativeModules as Record<string, unknown>).NearbyMeshModule = {
      startMeshSession,
      stopMeshSession,
      broadcastHazard,
    };
    jest.isolateModules(() => {
      transport = require('../src/transports/NearbyTransport').nearbyTransport;
    });
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
  });

  test('reports only the capabilities implemented by Nearby', () => {
    expect(transport.capabilities).toEqual({
      broadcast: true,
      targeted: true,
      peerIdentity: true,
      linkMetrics: false,
      deliveryAck: false,
    });
  });

  test('forwards lifecycle calls and session values unchanged', async () => {
    await expect(
      transport.start({ roomCode: ' AbC123 ', riderName: 'Alex|Rider' }),
    ).resolves.toBeUndefined();
    expect(startMeshSession).toHaveBeenCalledWith(' AbC123 ', 'Alex|Rider');

    await expect(transport.stop()).resolves.toBeUndefined();
    expect(stopMeshSession).toHaveBeenCalledTimes(1);
  });

  test('forwards raw payloads strictly one at a time and in order', async () => {
    const packetJson = serializeHazardPacket(createHazardPacket('pothole', 'local', 'Alex', NOW));
    const first$ = transport.broadcast(packetJson);
    const second$ = transport.broadcast('not-json');

    await Promise.resolve();
    await Promise.resolve();
    expect(broadcastHazard).toHaveBeenCalledTimes(1);
    expect(broadcastHazard).toHaveBeenNthCalledWith(1, packetJson);

    resolvers[0]();
    await first$;
    await Promise.resolve();
    await Promise.resolve();
    expect(broadcastHazard).toHaveBeenCalledTimes(2);
    expect(broadcastHazard).toHaveBeenNthCalledWith(2, 'not-json');

    resolvers[1]();
    await second$;
  });

  test('keeps the send queue usable after a native send fails', async () => {
    broadcastHazard.mockImplementationOnce(() => Promise.reject(new Error('busy')));
    broadcastHazard.mockImplementationOnce(() => Promise.resolve());

    await expect(transport.broadcast('first')).rejects.toThrow('busy');
    await expect(transport.broadcast('second')).resolves.toBeUndefined();
  });

  test('forwards incoming strings unchanged without parsing hazard packets', () => {
    const onPayload = jest.fn();
    const unsubscribe = transport.onPayload(onPayload);

    DeviceEventEmitter.emit('onHazardReceived', 'not-json');
    DeviceEventEmitter.emit('onHazardReceived', '{"anything":true}');
    DeviceEventEmitter.emit('onHazardReceived', 42);

    expect(onPayload.mock.calls.map(call => call[0])).toEqual(['not-json', '{"anything":true}']);

    unsubscribe();
    DeviceEventEmitter.emit('onHazardReceived', 'after-cleanup');
    expect(onPayload).toHaveBeenCalledTimes(2);
  });

  test('leaves Nearby hazard validation at the protocol boundary', () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const packet = createHazardPacket('pothole', 'remote', 'Alex', NOW);
    const parsed: unknown[] = [];
    const unsubscribe = transport.onPayload(payload => {
      const candidate = parseHazardPacket(payload);
      if (candidate) {
        parsed.push(candidate);
      }
    });

    DeviceEventEmitter.emit('onHazardReceived', serializeHazardPacket(packet));
    DeviceEventEmitter.emit('onHazardReceived', 'malformed');
    DeviceEventEmitter.emit(
      'onHazardReceived',
      serializeHazardPacket({ ...packet, timestamp: NOW - 60_000 }),
    );

    expect(parsed).toEqual([packet]);
    unsubscribe();
    jest.useRealTimers();
  });

  test('normalizes status events exactly as the previous wrapper did and cleans up', () => {
    const onStatus = jest.fn();
    const unsubscribe = transport.onStatus(onStatus);

    DeviceEventEmitter.emit('onMeshStatus', JSON.stringify({ active: true, peers: 2 }));
    DeviceEventEmitter.emit(
      'onMeshStatus',
      JSON.stringify({ active: false, peers: 0, error: 'Wi-Fi Direct busy' }),
    );
    DeviceEventEmitter.emit('onMeshStatus', 'not json');
    DeviceEventEmitter.emit('onMeshStatus', JSON.stringify({}));

    expect(onStatus.mock.calls.map(call => call[0])).toEqual([
      { active: true, peers: 2, error: null },
      { active: false, peers: 0, error: 'Wi-Fi Direct busy' },
      { active: false, peers: 0, error: null },
    ]);

    unsubscribe();
    DeviceEventEmitter.emit('onMeshStatus', JSON.stringify({ active: true, peers: 5 }));
    expect(onStatus).toHaveBeenCalledTimes(3);
  });

  test('reports peer counts, ignores malformed events, and cleans up', () => {
    const onPeerCount = jest.fn();
    const unsubscribe = transport.onPeerCountChanged(onPeerCount);

    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({ peerCount: 1 }));
    DeviceEventEmitter.emit('onPeerCountChanged', 'not json');
    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({}));
    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({ peerCount: 0 }));

    expect(onPeerCount.mock.calls.map(call => call[0])).toEqual([1, 0]);

    unsubscribe();
    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({ peerCount: 5 }));
    expect(onPeerCount).toHaveBeenCalledTimes(2);
  });

  test('preserves unavailable-platform start, stop, and send behavior', async () => {
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
    jest.isolateModules(() => {
      transport = require('../src/transports/NearbyTransport').nearbyTransport;
    });

    await expect(transport.start({ roomCode: 'ABC123', riderName: 'Alex' })).rejects.toThrow(
      'not available',
    );
    await expect(transport.broadcast('payload')).rejects.toThrow('not available');
    await expect(transport.stop()).resolves.toBeUndefined();
  });
});
