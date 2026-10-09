import {
  RoomEvent,
  type DataPacket_Kind,
  type Participant,
  type Room,
} from 'livekit-client';
import type { BroadcastTransport, TransportCapabilities } from './Transport';

export const LIVEKIT_HAZARD_TOPIC = 'ridezz.hazard';

export const LIVEKIT_HAZARD_TRANSPORT_CAPABILITIES: Readonly<TransportCapabilities> =
  Object.freeze({
    broadcast: true,
    targeted: false,
    peerIdentity: false,
    linkMetrics: false,
    deliveryAck: false,
  });

/** Room-bound adapter for reliable hazard data. Payload interpretation remains protocol-owned. */
export function createLiveKitHazardTransport(
  room: Room,
): BroadcastTransport<Uint8Array<ArrayBuffer>> {
  return {
    capabilities: LIVEKIT_HAZARD_TRANSPORT_CAPABILITIES,

    broadcast(payload: Uint8Array<ArrayBuffer>): Promise<void> {
      return room.localParticipant.publishData(payload, {
        reliable: true,
        topic: LIVEKIT_HAZARD_TOPIC,
      });
    },

    onPayload(callback: (payload: Uint8Array<ArrayBuffer>) => void): () => void {
      function handleData(
        payload: Uint8Array<ArrayBuffer>,
        _participant?: Participant,
        _kind?: DataPacket_Kind,
        topic?: string,
      ) {
        if (topic === LIVEKIT_HAZARD_TOPIC) {
          callback(payload);
        }
      }

      room.on(RoomEvent.DataReceived, handleData);
      return () => {
        room.off(RoomEvent.DataReceived, handleData);
      };
    },
  };
}
