import type { HardBrakingDetected } from '../braking/brakingEvents';
import type { CrashSos } from '../crash/crashTypes';
import type { RideConnectivityClient } from '../connectivity/rideConnectivityClient';
import type { HazardPacket } from '../protocol/hazardProtocol';
import { getAppRideConnectivityClient } from './rideConnectivityService';

export const SAFETY_SOS_TTL_MS = 5 * 60 * 1000;
export const SAFETY_HAZARD_TTL_MS = 30 * 1000;
export const SAFETY_SOS_MAX_HOPS = 8;
export const SAFETY_HAZARD_MAX_HOPS = 4;
const MAX_RECENT_SOS_IDS = 128;

type SafetyConnectivityClient = Pick<RideConnectivityClient, 'sendMessage'>;

export interface RideSafetyConnectivityOptions {
  readonly rideId: string;
  readonly getClient?: () => SafetyConnectivityClient;
  readonly clock?: () => number;
}

export interface RideSafetyConnectivity {
  /** Best-effort protocol copy of a confirmed crash SOS. Never waits for delivery. */
  submitCrashSos(sos: CrashSos): void;
  /** Best-effort protocol copy of a native hard-braking event. */
  submitHardBraking(event: HardBrakingDetected): void;
  /** Best-effort protocol copy of a Phase 1 voice hazard accepted by HazardCoordinator. */
  submitVoiceHazard(packet: HazardPacket): void;
}

/**
 * Additive bridge from the existing Phase 1 safety paths into Ride Connectivity Protocol.
 * Submission is deliberately fire-and-forget: neither client initialization nor send failure can
 * block Phase 1, and sendMessage resolving is never interpreted as destination delivery.
 */
export function createRideSafetyConnectivity({
  rideId,
  getClient = getAppRideConnectivityClient,
  clock = Date.now,
}: RideSafetyConnectivityOptions): RideSafetyConnectivity {
  const recentSosIds = new Map<string, number>();

  const submit = (input: Parameters<SafetyConnectivityClient['sendMessage']>[0]): void => {
    try {
      const result = getClient().sendMessage(input);
      Promise.resolve(result).catch(() => {});
    } catch {
      // Protocol initialization/submission is isolated from the established Phase 1 path.
    }
  };

  const claimSos = (sosId: string): boolean => {
    const now = clock();
    for (const [id, expiresAt] of recentSosIds) {
      if (expiresAt <= now) {
        recentSosIds.delete(id);
      }
    }
    if (recentSosIds.has(sosId)) {
      return false;
    }
    if (recentSosIds.size >= MAX_RECENT_SOS_IDS) {
      const oldest = recentSosIds.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        recentSosIds.delete(oldest);
      }
    }
    recentSosIds.set(sosId, now + SAFETY_SOS_TTL_MS);
    return true;
  };

  return {
    submitCrashSos(sos): void {
      if (!claimSos(sos.sosId)) {
        return;
      }
      const hasPosition = sos.latitude !== null && sos.longitude !== null;
      submit({
        rideId,
        type: 'sos',
        priority: 'critical',
        payload: {
          alertType: 'accident',
          sosId: sos.sosId,
          timestamp: sos.timestamp,
          impactTimestamp: sos.impactTimestamp,
          severity: sos.severity,
          confidence: sos.confidence,
          ...(hasPosition
            ? { latitude: sos.latitude as number, longitude: sos.longitude as number }
            : {}),
          ...(sos.speedBeforeImpactKmh !== null
            ? { speedKmh: sos.speedBeforeImpactKmh }
            : {}),
          peakG: sos.peakG,
          trigger: sos.trigger,
        },
        ttlMs: SAFETY_SOS_TTL_MS,
        maxHops: SAFETY_SOS_MAX_HOPS,
        destination: { kind: 'gateway' },
      });
    },

    submitHardBraking(event): void {
      submit({
        rideId,
        type: 'hazard',
        priority: 'critical',
        payload: {
          hazardKind: 'hard_braking',
          seq: event.seq,
          onsetAt: event.onsetAt,
          speedKmh: event.speedKmh,
          peakDecelG: event.peakDecelG,
          ...(event.headingDeg !== null ? { headingDeg: event.headingDeg } : {}),
          source: event.source,
        },
        ttlMs: SAFETY_HAZARD_TTL_MS,
        maxHops: SAFETY_HAZARD_MAX_HOPS,
        destination: { kind: 'gateway' },
      });
    },

    submitVoiceHazard(packet): void {
      // Crash detection already submits the same event as the stronger, longer-lived SOS message.
      if (packet.hazard === 'accident') {
        return;
      }
      submit({
        rideId,
        type: 'hazard',
        priority: 'high',
        payload: {
          hazardKind: packet.hazard,
          hazardId: packet.id,
          timestamp: packet.timestamp,
          senderId: packet.senderId,
          senderName: packet.senderName,
        },
        ttlMs: SAFETY_HAZARD_TTL_MS,
        maxHops: SAFETY_HAZARD_MAX_HOPS,
        destination: { kind: 'gateway' },
      });
    },
  };
}
