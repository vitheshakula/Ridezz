import {
  encodeHazardPacket,
  parseHazardPacket,
  serializeHazardPacket,
  type HazardPacket,
} from '../protocol/hazardProtocol';
import { createHazardPolicy, type HazardIngress } from '../protocol/hazardPolicy';
import type { BroadcastTransport } from '../transports/Transport';

export type HazardSendChannel = 'mesh' | 'cloud';

export type HazardSendOutcome =
  | { channel: HazardSendChannel; ok: true }
  | { channel: HazardSendChannel; ok: false; error: string };

export interface HazardCoordinatorOptions {
  senderId: string;
  nearbyTransport: BroadcastTransport<string>;
  liveKitTransport: BroadcastTransport<Uint8Array<ArrayBuffer>>;
  isOnline: () => boolean;
  onLocalAccepted: (packet: HazardPacket) => void;
  onIncomingAccepted: (
    packet: HazardPacket,
    ingress: HazardIngress,
    shouldAnnounce: boolean,
  ) => void;
  onLocalSendResult: (packet: HazardPacket, outcomes: readonly HazardSendOutcome[]) => void;
  /** Optional deterministic clock for policy tests; production uses Date.now. */
  clock?: () => number;
}

export interface HazardCoordinator {
  submitLocal(packet: HazardPacket): void;
  /** Subscribes to both transports. Repeated calls share one active subscription set. */
  subscribe(): () => void;
}

/** Owns v1 hazard protocol, policy, and cross-transport routing without presentation effects. */
export function createHazardCoordinator({
  senderId,
  nearbyTransport,
  liveKitTransport,
  isOnline,
  onLocalAccepted,
  onIncomingAccepted,
  onLocalSendResult,
  clock,
}: HazardCoordinatorOptions): HazardCoordinator {
  const policy = createHazardPolicy(senderId, clock);
  let activeCleanup: (() => void) | null = null;

  const sendNearby = (packet: HazardPacket) =>
    nearbyTransport.broadcast(serializeHazardPacket(packet));
  const sendLiveKit = (packet: HazardPacket) =>
    liveKitTransport.broadcast(encodeHazardPacket(packet));

  const handleIncoming = (payload: string | Uint8Array, ingress: HazardIngress) => {
    const packet = parseHazardPacket(payload);
    if (!packet) {
      return;
    }
    const decision = policy.decideIncoming(packet, ingress, isOnline());
    if (!decision.accepted) {
      return;
    }

    onIncomingAccepted(packet, ingress, decision.shouldAnnounce);

    // Preserve Phase 1 relay invocation order and best-effort error handling.
    if (decision.relayLiveKit) {
      sendLiveKit(packet).catch(() => {});
    }
    if (decision.relayNearby) {
      sendNearby(packet).catch(() => {});
    }
  };

  return {
    submitLocal(packet: HazardPacket): void {
      const decision = policy.decideLocalSend(packet, isOnline());
      if (!decision.accepted) {
        return;
      }

      onLocalAccepted(packet);
      const outcomes: HazardSendOutcome[] = [];
      const attempt = (channel: HazardSendChannel, send: Promise<unknown>) =>
        send.then(
          () => {
            outcomes.push({ channel, ok: true });
          },
          (error: { message?: string }) => {
            outcomes.push({ channel, ok: false, error: error?.message ?? 'error' });
          },
        );

      // Preserve Phase 1 invocation order: Nearby first, then LiveKit when online.
      const sends = decision.sendNearby ? [attempt('mesh', sendNearby(packet))] : [];
      if (decision.sendLiveKit) {
        sends.push(attempt('cloud', sendLiveKit(packet)));
      }
      Promise.all(sends).then(() => onLocalSendResult(packet, outcomes));
    },

    subscribe(): () => void {
      if (activeCleanup) {
        return activeCleanup;
      }

      const unsubscribeLiveKit = liveKitTransport.onPayload(payload =>
        handleIncoming(payload, 'livekit'),
      );
      const unsubscribeNearby = nearbyTransport.onPayload(payload =>
        handleIncoming(payload, 'nearby'),
      );
      let active = true;
      const cleanup = () => {
        if (!active) {
          return;
        }
        active = false;
        unsubscribeLiveKit();
        unsubscribeNearby();
        if (activeCleanup === cleanup) {
          activeCleanup = null;
        }
      };
      activeCleanup = cleanup;
      return cleanup;
    },
  };
}
