import type { BroadcastTransport } from '../transports/Transport';
import {
  BRAKE_MAX_HOPS,
  BRAKE_PACKET_MAX_SKEW_MS,
  base64ToBytes,
  bytesToBase64,
  decodeBrakePacket,
  encodeBrakePacket,
  type BrakeAlert,
} from './brakePacket';

export type BrakeIngress = 'livekit' | 'nearby';

export interface BrakeCoordinatorOptions {
  /** This rider's id; must match the id the alerts are sent under. */
  senderId: string;
  nearbyTransport: BroadcastTransport<string>;
  liveKitTransport: BroadcastTransport<Uint8Array<ArrayBuffer>>;
  isOnline: () => boolean;
  /** A braking alert from another rider, delivered once. */
  onPeerBraking: (alert: BrakeAlert, ingress: BrakeIngress) => void;
  clock?: () => number;
}

export interface BrakeSendOutcome {
  channel: 'mesh' | 'cloud';
  ok: boolean;
}

export interface BrakeCoordinator {
  /** Broadcasts this rider's own braking alert immediately. The detector owns the cooldown. */
  submitLocal(alert: Omit<BrakeAlert, 'senderId'>): Promise<BrakeSendOutcome[]>;
  /** Subscribes to both transports; repeated calls share one subscription set. */
  subscribe(): () => void;
}

const REMEMBER_MS = 30_000;

/**
 * Routes the compact braking alert over the same two transports as hazards: Nearby first (always),
 * then LiveKit when online. Received alerts are deduplicated by sender+sequence, dropped when stale,
 * and re-broadcast a limited number of hops so riders out of direct radio range still hear it.
 */
export function createBrakeCoordinator({
  senderId,
  nearbyTransport,
  liveKitTransport,
  isOnline,
  onPeerBraking,
  clock = Date.now,
}: BrakeCoordinatorOptions): BrakeCoordinator {
  const seen = new Map<string, number>();
  let active: (() => void) | null = null;

  const remember = (key: string): boolean => {
    const now = clock();
    for (const [k, at] of seen) {
      if (now - at > REMEMBER_MS) {
        seen.delete(k);
      }
    }
    if (seen.has(key)) {
      return false;
    }
    seen.set(key, now);
    return true;
  };
  const keyOf = (a: BrakeAlert) => `${a.senderId}:${a.seq}:${a.timestamp}`;

  const sendNearby = (alert: BrakeAlert, hops: number) =>
    nearbyTransport.broadcast(bytesToBase64(encodeBrakePacket(alert, hops)));
  const sendLiveKit = (alert: BrakeAlert, hops: number) =>
    liveKitTransport.broadcast(encodeBrakePacket(alert, hops));

  const handle = (bytes: Uint8Array | null, ingress: BrakeIngress) => {
    const packet = bytes && decodeBrakePacket(bytes);
    if (!packet || packet.senderId === senderId) {
      return;
    }
    if (Math.abs(clock() - packet.timestamp) > BRAKE_PACKET_MAX_SKEW_MS) {
      return;
    }
    const { hops, ...alert } = packet;
    if (!remember(keyOf(alert))) {
      return;
    }

    onPeerBraking(alert, ingress);

    if (hops > 0) {
      sendNearby(alert, hops - 1).catch(() => {});
      if (ingress === 'nearby' && isOnline()) {
        sendLiveKit(alert, hops - 1).catch(() => {});
      }
    }
  };

  const attempt = (channel: 'mesh' | 'cloud', send: Promise<unknown>): Promise<BrakeSendOutcome> =>
    send.then(
      () => ({ channel, ok: true }),
      () => ({ channel, ok: false }),
    );

  return {
    submitLocal(partial) {
      const alert: BrakeAlert = { ...partial, senderId };
      remember(keyOf(alert));
      const sends = [attempt('mesh', sendNearby(alert, BRAKE_MAX_HOPS))];
      if (isOnline()) {
        sends.push(attempt('cloud', sendLiveKit(alert, BRAKE_MAX_HOPS)));
      }
      return Promise.all(sends);
    },

    subscribe() {
      if (active) {
        return active;
      }
      const offLiveKit = liveKitTransport.onPayload(payload => handle(payload, 'livekit'));
      const offNearby = nearbyTransport.onPayload(text => handle(base64ToBytes(text), 'nearby'));
      let live = true;
      const cleanup = () => {
        if (!live) {
          return;
        }
        live = false;
        offLiveKit();
        offNearby();
        if (active === cleanup) {
          active = null;
        }
      };
      active = cleanup;
      return cleanup;
    },
  };
}
