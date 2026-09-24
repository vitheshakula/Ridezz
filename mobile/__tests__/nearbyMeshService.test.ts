import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { createHazardPacket, serializeHazardPacket } from '../src/services/SpeechHazardService';

const NOW = 1_800_000_000_000;

describe('nearbyMeshService', () => {
  const originalOS = Platform.OS;
  let mesh: typeof import('../src/services/NearbyMeshService').nearbyMeshService;
  let broadcastHazard: jest.Mock;
  let resolvers: Array<() => void>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    resolvers = [];
    broadcastHazard = jest.fn(() => new Promise<void>(resolve => resolvers.push(resolve)));
    (Platform as { OS: string }).OS = 'android';
    (NativeModules as Record<string, unknown>).NearbyMeshModule = {
      startMeshSession: jest.fn(() => Promise.resolve()),
      stopMeshSession: jest.fn(() => Promise.resolve()),
      broadcastHazard,
    };
    jest.isolateModules(() => {
      mesh = require('../src/services/NearbyMeshService').nearbyMeshService;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
  });

  const packet = createHazardPacket('pothole', 'me', 'Alex', NOW);

  it('sends broadcasts strictly one at a time, in order', async () => {
    const second = createHazardPacket('gravel', 'me', 'Alex', NOW + 1);
    const first$ = mesh.broadcastHazard(packet);
    const second$ = mesh.broadcastHazard(second);

    await Promise.resolve();
    await Promise.resolve();
    expect(broadcastHazard).toHaveBeenCalledTimes(1);
    expect(JSON.parse(broadcastHazard.mock.calls[0][0]).hazard).toBe('pothole');

    resolvers[0]();
    await first$;
    await Promise.resolve();
    await Promise.resolve();
    expect(broadcastHazard).toHaveBeenCalledTimes(2);
    expect(JSON.parse(broadcastHazard.mock.calls[1][0]).hazard).toBe('gravel');

    resolvers[1]();
    await second$;
  });

  it('keeps sending after one broadcast fails', async () => {
    broadcastHazard.mockImplementationOnce(() => Promise.reject(new Error('busy')));
    broadcastHazard.mockImplementationOnce(() => Promise.resolve());

    await expect(mesh.broadcastHazard(packet)).rejects.toThrow('busy');
    await expect(mesh.broadcastHazard(packet)).resolves.toBeUndefined();
  });

  it('rejects when the native module is missing', async () => {
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
    jest.isolateModules(() => {
      mesh = require('../src/services/NearbyMeshService').nearbyMeshService;
    });
    await expect(mesh.broadcastHazard(packet)).rejects.toThrow('not available');
    await expect(mesh.start('ABC123', 'Alex')).rejects.toThrow('not available');
    await expect(mesh.stop()).resolves.toBeUndefined();
  });

  it('delivers valid received hazards and drops invalid or stale ones', () => {
    const onHazard = jest.fn();
    const unsubscribe = mesh.onHazardReceived(onHazard);

    DeviceEventEmitter.emit('onHazardReceived', serializeHazardPacket(packet));
    DeviceEventEmitter.emit('onHazardReceived', 'garbage');
    DeviceEventEmitter.emit('onHazardReceived', 42);
    DeviceEventEmitter.emit(
      'onHazardReceived',
      serializeHazardPacket({ ...packet, timestamp: NOW - 60_000 }),
    );

    expect(onHazard).toHaveBeenCalledTimes(1);
    expect(onHazard).toHaveBeenCalledWith(packet);

    unsubscribe();
    DeviceEventEmitter.emit('onHazardReceived', serializeHazardPacket(packet));
    expect(onHazard).toHaveBeenCalledTimes(1);
  });

  it('parses mesh status pushes and ignores malformed ones', () => {
    const onStatus = jest.fn();
    const unsubscribe = mesh.onStatus(onStatus);

    DeviceEventEmitter.emit('onMeshStatus', JSON.stringify({ active: true, peers: 2 }));
    DeviceEventEmitter.emit(
      'onMeshStatus',
      JSON.stringify({ active: false, peers: 0, error: 'Wi-Fi Direct busy' }),
    );
    DeviceEventEmitter.emit('onMeshStatus', 'not json');
    DeviceEventEmitter.emit('onMeshStatus', JSON.stringify({}));

    expect(onStatus.mock.calls.map(c => c[0])).toEqual([
      { active: true, peers: 2, error: null },
      { active: false, peers: 0, error: 'Wi-Fi Direct busy' },
      { active: false, peers: 0, error: null },
    ]);
    unsubscribe();
  });

  it('reports peer count changes and ignores malformed pushes', () => {
    const onPeerCount = jest.fn();
    const unsubscribe = mesh.onPeerCountChanged(onPeerCount);

    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({ peerCount: 1 }));
    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({ peerCount: 3 }));
    DeviceEventEmitter.emit('onPeerCountChanged', 'not json');
    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({}));
    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({ peerCount: 0 }));

    expect(onPeerCount.mock.calls.map(c => c[0])).toEqual([1, 3, 0]);

    unsubscribe();
    DeviceEventEmitter.emit('onPeerCountChanged', JSON.stringify({ peerCount: 5 }));
    expect(onPeerCount).toHaveBeenCalledTimes(3);
  });
});
