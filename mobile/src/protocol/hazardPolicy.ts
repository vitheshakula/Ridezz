import {
  HAZARD_PACKET_MAX_AGE_MS,
  type HazardPacket,
  type HazardType,
} from './hazardProtocol';

export const HAZARD_THROTTLE_MS = 4000;

export type HazardIngress = 'livekit' | 'nearby';

export type LocalHazardSuppressionReason = 'recently_received_type' | 'recently_sent_type';
export type IncomingHazardRejectionReason =
  | 'local_sender'
  | 'duplicate_id'
  | 'recently_received_type';

export type LocalHazardDecision =
  | {
      accepted: true;
      shouldAnnounce: false;
      sendNearby: true;
      sendLiveKit: boolean;
    }
  | {
      accepted: false;
      shouldAnnounce: false;
      sendNearby: false;
      sendLiveKit: false;
      reason: LocalHazardSuppressionReason;
    };

export type IncomingHazardDecision =
  | {
      accepted: true;
      shouldAnnounce: boolean;
      relayNearby: true;
      relayLiveKit: boolean;
    }
  | {
      accepted: false;
      shouldAnnounce: false;
      relayNearby: false;
      relayLiveKit: false;
      reason: IncomingHazardRejectionReason;
    };

export interface HazardPolicy {
  decideLocalSend(packet: HazardPacket, isOnline: boolean): LocalHazardDecision;
  decideIncoming(
    packet: HazardPacket,
    ingress: HazardIngress,
    isOnline: boolean,
  ): IncomingHazardDecision;
  /** Claims one packet id for spoken playback. Exposed so the independent TTS gate is testable. */
  claimAnnouncement(packetId: string): boolean;
}

/** True when a hazard of this type was already recorded within HAZARD_THROTTLE_MS. */
export function isWithinHazardWindow(
  recent: Map<HazardType, number>,
  hazard: HazardType,
  now: number = Date.now(),
): boolean {
  const last = recent.get(hazard);
  return last !== undefined && now - last < HAZARD_THROTTLE_MS;
}

/** Records a hazard type when its current suppression window is free. */
export function claimHazardWindow(
  recent: Map<HazardType, number>,
  hazard: HazardType,
  now: number = Date.now(),
): boolean {
  if (isWithinHazardWindow(recent, hazard, now)) {
    return false;
  }
  recent.set(hazard, now);
  return true;
}

/** Records an id once, pruning entries only when another check occurs and only after they are
 * strictly older than the packet validity window. */
export function rememberHazardOnce(
  remembered: Map<string, number>,
  id: string,
  now: number = Date.now(),
): boolean {
  for (const [seenId, seenAt] of remembered) {
    if (now - seenAt > HAZARD_PACKET_MAX_AGE_MS) {
      remembered.delete(seenId);
    }
  }
  if (remembered.has(id)) {
    return false;
  }
  remembered.set(id, now);
  return true;
}

/**
 * Owns the current Phase 1 dedupe and relay decisions. The injected clock exists for deterministic
 * tests; production uses Date.now at each decision point, matching the former RideScreen helpers.
 */
export function createHazardPolicy(
  localSenderId: string,
  clock: () => number = Date.now,
): HazardPolicy {
  const seenPacketIds = new Map<string, number>();
  const spokenPacketIds = new Map<string, number>();
  const recentlySentHazards = new Map<HazardType, number>();
  const recentlyReceivedHazards = new Map<HazardType, number>();

  const claimAnnouncement = (packetId: string): boolean =>
    rememberHazardOnce(spokenPacketIds, packetId, clock());

  return {
    decideLocalSend(packet: HazardPacket, isOnline: boolean): LocalHazardDecision {
      // Deliberately remember before type suppression. Existing Phase 1 behavior depends on this
      // ordering, even though a packet rejected below may never be transmitted.
      rememberHazardOnce(seenPacketIds, packet.id, clock());

      if (isWithinHazardWindow(recentlyReceivedHazards, packet.hazard, clock())) {
        return {
          accepted: false,
          shouldAnnounce: false,
          sendNearby: false,
          sendLiveKit: false,
          reason: 'recently_received_type',
        };
      }
      if (!claimHazardWindow(recentlySentHazards, packet.hazard, clock())) {
        return {
          accepted: false,
          shouldAnnounce: false,
          sendNearby: false,
          sendLiveKit: false,
          reason: 'recently_sent_type',
        };
      }
      return {
        accepted: true,
        shouldAnnounce: false,
        sendNearby: true,
        sendLiveKit: isOnline,
      };
    },

    decideIncoming(
      packet: HazardPacket,
      ingress: HazardIngress,
      isOnline: boolean,
    ): IncomingHazardDecision {
      // Local bounces are rejected before touching either id store, as they were in RideScreen.
      if (packet.senderId === localSenderId) {
        return {
          accepted: false,
          shouldAnnounce: false,
          relayNearby: false,
          relayLiveKit: false,
          reason: 'local_sender',
        };
      }
      if (!rememberHazardOnce(seenPacketIds, packet.id, clock())) {
        return {
          accepted: false,
          shouldAnnounce: false,
          relayNearby: false,
          relayLiveKit: false,
          reason: 'duplicate_id',
        };
      }
      if (!claimHazardWindow(recentlyReceivedHazards, packet.hazard, clock())) {
        return {
          accepted: false,
          shouldAnnounce: false,
          relayNearby: false,
          relayLiveKit: false,
          reason: 'recently_received_type',
        };
      }
      return {
        accepted: true,
        shouldAnnounce: claimAnnouncement(packet.id),
        relayNearby: true,
        relayLiveKit: ingress === 'nearby' && isOnline,
      };
    },

    claimAnnouncement,
  };
}
