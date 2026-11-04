import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { createRideMessageIngress } from '../src/connectivity/rideMessageIngress';
import { createSeenMessageCache } from '../src/connectivity/protocol/seenMessageCache';
import { createHeartbeatMessage } from '../src/connectivity/protocol/heartbeat';
import { serializeRideMessage } from '../src/connectivity/protocol/rideMessageCodec';
import { handleHeartbeat } from '../src/connectivity/heartbeatHandler';
import { createPeerTable } from '../src/connectivity/peerTable';
import { createDirectLinkIdentityMap } from '../src/connectivity/directLinkIdentityMap';

const WALL = 1_700_000_000_000;

type NearbyModule = typeof import('../src/transports/NearbyTransport');

describe('nearbyTransport endpoint-aware interface', () => {
  const originalOS = Platform.OS;
  let mod: NearbyModule;
  let broadcastHazard: jest.Mock;
  let sendPayloadTo: jest.Mock;

  function load(native: Record<string, unknown> | undefined) {
    if (native) {
      (NativeModules as Record<string, unknown>).NearbyMeshModule = native;
    } else {
      delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
    }
    jest.isolateModules(() => {
      mod = require('../src/transports/NearbyTransport');
    });
  }

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'android';
    broadcastHazard = jest.fn(() => Promise.resolve());
    sendPayloadTo = jest.fn(() => Promise.resolve());
    load({
      startMeshSession: jest.fn(() => Promise.resolve()),
      stopMeshSession: jest.fn(() => Promise.resolve()),
      broadcastHazard,
      sendPayloadTo,
    });
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
  });

  const emitFrom = (endpointId: unknown, payload: unknown) =>
    DeviceEventEmitter.emit('onPayloadReceivedFrom', JSON.stringify({ endpointId, payload }));

  describe('capabilities', () => {
    test('targeted and peer identity are true; delivery ack and link metrics stay false', () => {
      expect(mod.NEARBY_TRANSPORT_CAPABILITIES).toEqual({
        broadcast: true,
        targeted: true,
        peerIdentity: true,
        linkMetrics: false,
        deliveryAck: false,
      });
      expect(mod.NEARBY_TRANSPORT_ID).toBe('nearby');
    });
  });

  describe('receive with sender endpoint', () => {
    test('delivers the payload with its endpoint as a transport-local source', () => {
      const received: unknown[] = [];
      const unsubscribe = mod.nearbyTransport.onPayloadFrom((source, payload) =>
        received.push({ source, payload }),
      );

      emitFrom('endpoint-B', 'raw-message');

      expect(received).toEqual([{ source: { endpointId: 'endpoint-B' }, payload: 'raw-message' }]);
      unsubscribe();
    });

    test('maps to an ingress source { transportId: nearby, peerId: endpointId }', () => {
      const ingress = createRideMessageIngress({
        rideId: '12345',
        localNodeId: 'rider-a',
        seenMessages: createSeenMessageCache(),
        clock: () => WALL + 50,
      });
      const results: unknown[] = [];
      const unsubscribe = mod.nearbyTransport.onPayloadFrom((source, payload) =>
        results.push(
          ingress.ingest(payload, {
            transportId: mod.NEARBY_TRANSPORT_ID,
            peerId: source.endpointId,
          }),
        ),
      );
      const hb = createHeartbeatMessage({
        id: 'hb-1',
        rideId: '12345',
        originId: 'rider-b',
        createdAt: WALL,
      });

      emitFrom('endpoint-B', serializeRideMessage(hb));

      expect(results).toEqual([
        { accepted: true, message: hb, source: { transportId: 'nearby', peerId: 'endpoint-B' } },
      ]);
      unsubscribe();
    });

    test('lets a direct heartbeat establish (nearby, endpoint-B) -> rider-b', () => {
      const ingress = createRideMessageIngress({
        rideId: '12345',
        localNodeId: 'rider-a',
        seenMessages: createSeenMessageCache(),
        clock: () => WALL + 50,
      });
      const peers = createPeerTable({ localNodeId: 'rider-a' });
      const links = createDirectLinkIdentityMap({ localNodeId: 'rider-a' });
      const unsubscribe = mod.nearbyTransport.onPayloadFrom((source, payload) => {
        const result = ingress.ingest(payload, {
          transportId: mod.NEARBY_TRANSPORT_ID,
          peerId: source.endpointId,
        });
        if (result.accepted) {
          handleHeartbeat(result, 50_000, peers, links);
        }
      });

      const hb = createHeartbeatMessage({
        id: 'hb-2',
        rideId: '12345',
        originId: 'rider-b',
        createdAt: WALL,
      });
      emitFrom('endpoint-B', serializeRideMessage(hb));

      expect(links.resolve('nearby', 'endpoint-B', 50_000)).toBe('rider-b');
      expect(peers.isDirectPeer('rider-b', 50_000)).toBe(true);
      unsubscribe();
    });

    test('ignores malformed endpoint-aware events', () => {
      const callback = jest.fn();
      const unsubscribe = mod.nearbyTransport.onPayloadFrom(callback);

      DeviceEventEmitter.emit('onPayloadReceivedFrom', 'not json');
      DeviceEventEmitter.emit('onPayloadReceivedFrom', 42);
      DeviceEventEmitter.emit('onPayloadReceivedFrom', 'null');
      emitFrom('', 'payload');
      emitFrom(undefined, 'payload');
      emitFrom(7, 'payload');
      emitFrom('endpoint-B', 42);
      emitFrom('endpoint-B', undefined);

      expect(callback).not.toHaveBeenCalled();
      unsubscribe();
    });

    test('the source object is frozen and the subscription can be removed', () => {
      const sources: { endpointId: string }[] = [];
      const unsubscribe = mod.nearbyTransport.onPayloadFrom(source => sources.push(source));

      emitFrom('endpoint-B', 'x');
      unsubscribe();
      emitFrom('endpoint-B', 'y');

      expect(sources).toHaveLength(1);
      expect(Object.isFrozen(sources[0])).toBe(true);
    });
  });

  describe('Phase 1 / protocol receive boundary', () => {
    test('each event reaches only its own consumer, exactly once', () => {
      const phase1 = jest.fn();
      const protocol = jest.fn();
      const offPhase1 = mod.nearbyTransport.onPayload(phase1);
      const offProtocol = mod.nearbyTransport.onPayloadFrom(protocol);

      DeviceEventEmitter.emit('onHazardReceived', 'packet');
      emitFrom('endpoint-B', 'packet');

      expect(phase1).toHaveBeenCalledTimes(1);
      expect(phase1).toHaveBeenCalledWith('packet');
      expect(protocol).toHaveBeenCalledTimes(1);
      expect(protocol).toHaveBeenCalledWith({ endpointId: 'endpoint-B' }, 'packet');
      offPhase1();
      offProtocol();
    });
  });

  describe('targeted send', () => {
    test('calls native sendPayloadTo exactly once and never broadcasts', async () => {
      await expect(mod.nearbyTransport.sendTo('endpoint-B', 'payload')).resolves.toBeUndefined();

      expect(sendPayloadTo).toHaveBeenCalledTimes(1);
      expect(sendPayloadTo).toHaveBeenCalledWith('endpoint-B', 'payload');
      expect(broadcastHazard).not.toHaveBeenCalled();
    });

    test('a native rejection (unknown/stale endpoint) propagates, no fallback', async () => {
      sendPayloadTo.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error('Endpoint endpoint-Z is not a confirmed connection'), {
            code: 'mesh_unknown_endpoint',
          }),
        ),
      );

      await expect(mod.nearbyTransport.sendTo('endpoint-Z', 'payload')).rejects.toMatchObject({
        code: 'mesh_unknown_endpoint',
      });
      expect(broadcastHazard).not.toHaveBeenCalled();
    });

    test('an empty endpoint id is rejected before reaching native', async () => {
      await expect(mod.nearbyTransport.sendTo('', 'payload')).rejects.toThrow('non-empty');
      await expect(mod.nearbyTransport.sendTo(undefined as never, 'payload')).rejects.toThrow(
        'non-empty',
      );
      expect(sendPayloadTo).not.toHaveBeenCalled();
      expect(broadcastHazard).not.toHaveBeenCalled();
    });

    test('a native build without sendPayloadTo rejects instead of broadcasting', async () => {
      load({
        startMeshSession: jest.fn(),
        stopMeshSession: jest.fn(),
        broadcastHazard,
      });
      await expect(mod.nearbyTransport.sendTo('endpoint-B', 'payload')).rejects.toThrow(
        'not supported',
      );
      expect(broadcastHazard).not.toHaveBeenCalled();
    });

    test('rejects off Android or without the native module', async () => {
      load(undefined);
      await expect(mod.nearbyTransport.sendTo('endpoint-B', 'p')).rejects.toThrow('not available');
    });

    test('is independent of the Phase 1 broadcast queue', async () => {
      broadcastHazard.mockImplementation(() => new Promise<void>(() => {}));
      mod.nearbyTransport.broadcast('stuck broadcast').catch(() => {});
      await Promise.resolve();

      await expect(mod.nearbyTransport.sendTo('endpoint-B', 'routed')).resolves.toBeUndefined();
      expect(sendPayloadTo).toHaveBeenCalledWith('endpoint-B', 'routed');
    });
  });

  describe('Phase 1 compatibility', () => {
    test('broadcast uses broadcastHazard; onPayload still gets raw strings', async () => {
      const received = jest.fn();
      const unsubscribe = mod.nearbyTransport.onPayload(received);

      await mod.nearbyTransport.broadcast('hazard-json');
      DeviceEventEmitter.emit('onHazardReceived', 'hazard-json');

      expect(broadcastHazard).toHaveBeenCalledWith('hazard-json');
      expect(sendPayloadTo).not.toHaveBeenCalled();
      expect(received).toHaveBeenCalledWith('hazard-json');
      unsubscribe();
    });
  });
});
