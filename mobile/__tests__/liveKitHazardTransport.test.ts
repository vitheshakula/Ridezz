import { RoomEvent, type Room } from 'livekit-client';
import {
  createHazardPacket,
  encodeHazardPacket,
  parseHazardPacket,
} from '../src/protocol/hazardProtocol';
import { createHazardPolicy } from '../src/protocol/hazardPolicy';
import {
  LIVEKIT_HAZARD_TOPIC,
  createLiveKitHazardTransport,
} from '../src/transports/LiveKitHazardTransport';

const NOW = 1_800_000_000_000;

type DataListener = (
  payload: Uint8Array,
  participant?: unknown,
  kind?: unknown,
  topic?: string,
) => void;

describe('LiveKitHazardTransport', () => {
  let publishData: jest.Mock;
  let on: jest.Mock;
  let off: jest.Mock;
  let dataListener: DataListener | undefined;
  let room: Room;

  beforeEach(() => {
    dataListener = undefined;
    publishData = jest.fn(() => Promise.resolve());
    on = jest.fn((event: RoomEvent, listener: DataListener) => {
      if (event === RoomEvent.DataReceived) {
        dataListener = listener;
      }
    });
    off = jest.fn();
    room = {
      localParticipant: { publishData },
      on,
      off,
    } as unknown as Room;
  });

  test('reports only the capabilities exposed by the current hazard adapter', () => {
    expect(createLiveKitHazardTransport(room).capabilities).toEqual({
      broadcast: true,
      targeted: false,
      peerIdentity: false,
      linkMetrics: false,
      deliveryAck: false,
    });
  });

  test('publishes the exact encoded bytes reliably on the hazard topic', async () => {
    const packet = createHazardPacket('pothole', 'local', 'Alex', NOW);
    const payload = encodeHazardPacket(packet);

    await expect(createLiveKitHazardTransport(room).broadcast(payload)).resolves.toBeUndefined();

    expect(publishData).toHaveBeenCalledTimes(1);
    expect(publishData).toHaveBeenCalledWith(payload, {
      reliable: true,
      topic: 'ridezz.hazard',
    });
    expect(publishData.mock.calls[0][0]).toBe(payload);
    expect(LIVEKIT_HAZARD_TOPIC).toBe('ridezz.hazard');
  });

  test('propagates publish failures unchanged', async () => {
    const error = new Error('PC manager is closed');
    publishData.mockRejectedValueOnce(error);

    await expect(
      createLiveKitHazardTransport(room).broadcast(new Uint8Array([1, 2, 3])),
    ).rejects.toBe(error);
  });

  test('delivers raw hazard-topic payloads and ignores participant metadata', () => {
    const onPayload = jest.fn();
    createLiveKitHazardTransport(room).onPayload(onPayload);
    const payload = new Uint8Array([1, 2, 3]);

    dataListener?.(payload, { identity: 'remote-rider' }, undefined, LIVEKIT_HAZARD_TOPIC);

    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(onPayload).toHaveBeenCalledWith(payload);
    expect(onPayload.mock.calls[0][0]).toBe(payload);
  });

  test('ignores unrelated LiveKit data topics', () => {
    const onPayload = jest.fn();
    createLiveKitHazardTransport(room).onPayload(onPayload);

    dataListener?.(new Uint8Array([1]), undefined, undefined, 'ridezz.location');
    dataListener?.(new Uint8Array([2]), undefined, undefined, 'ridezz.destination');
    dataListener?.(new Uint8Array([3]), undefined, undefined, undefined);

    expect(onPayload).not.toHaveBeenCalled();
  });

  test('forwards malformed bytes without attempting hazard parsing', () => {
    const onPayload = jest.fn();
    createLiveKitHazardTransport(room).onPayload(onPayload);
    const malformed = new Uint8Array([0xff, 0x00]);

    dataListener?.(malformed, undefined, undefined, LIVEKIT_HAZARD_TOPIC);

    expect(onPayload).toHaveBeenCalledWith(malformed);
  });

  test('removes the exact DataReceived listener during cleanup', () => {
    const unsubscribe = createLiveKitHazardTransport(room).onPayload(jest.fn());
    const subscribedListener = dataListener;

    expect(on).toHaveBeenCalledWith(RoomEvent.DataReceived, subscribedListener);
    unsubscribe();
    expect(off).toHaveBeenCalledWith(RoomEvent.DataReceived, subscribedListener);
  });

  test('composes raw ingress through the protocol parser and livekit policy path', () => {
    const packet = createHazardPacket('gravel', 'remote', 'Taylor', NOW);
    const policy = createHazardPolicy('local', () => NOW);
    const decideIncoming = jest.spyOn(policy, 'decideIncoming');
    const decisions: unknown[] = [];
    createLiveKitHazardTransport(room).onPayload(payload => {
      const parsed = parseHazardPacket(payload, NOW);
      if (parsed) {
        decisions.push(policy.decideIncoming(parsed, 'livekit', true));
      }
    });

    dataListener?.(encodeHazardPacket(packet), undefined, undefined, LIVEKIT_HAZARD_TOPIC);
    dataListener?.(new Uint8Array([0xff]), undefined, undefined, LIVEKIT_HAZARD_TOPIC);

    expect(decideIncoming).toHaveBeenCalledTimes(1);
    expect(decideIncoming).toHaveBeenCalledWith(packet, 'livekit', true);
    expect(decisions).toEqual([
      {
        accepted: true,
        shouldAnnounce: true,
        relayNearby: true,
        relayLiveKit: false,
      },
    ]);
  });
});
