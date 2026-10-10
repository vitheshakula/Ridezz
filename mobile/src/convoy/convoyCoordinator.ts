import { base64ToBytes, bytesToBase64 } from '../braking/brakePacket';
import type { BroadcastTransport } from '../transports/Transport';
import {
  CONVOY_MAX_HOPS,
  CONVOY_PACKET_MAX_SKEW_MS,
  decodeConvoyPacket,
  encodeConvoyPacket,
  type ConvoyAlert,
  type PackEventType,
} from './convoyPacket';

export type ConvoyIngress = 'livekit' | 'nearby';

export interface ConvoyCoordinatorOptions {
  /** This rider's id; must match the id the alerts are sent under. */
  senderId: string;
  nearbyTransport: BroadcastTransport<string>;
  liveKitTransport: BroadcastTransport<Uint8Array<ArrayBuffer>>;
  isOnline: () => boolean;
  /** An alert (or recovery) from another rider, delivered once. */
  onPeerAlert: (alert: ConvoyAlert, ingress: ConvoyIngress) => void;
  clock?: () => number;
}

export interface ConvoySendOutcome {
  channel: 'mesh' | 'cloud';
  ok: boolean;
}

export interface ConvoyCoordinator {
  /** Broadcasts an alert about this rider (or one this phone noticed) now; assigns the sequence. */
  submitLocal(
    alert: Omit<ConvoyAlert, 'reporterId' | 'seq'>,
  ): Promise<ConvoySendOutcome[]>;
  /** True when another rider already reported this subject + type recently (avoids an echo storm). */
  heardRecently(
    subjectId: string,
    eventType: PackEventType,
    withinMs?: number,
  ): boolean;
  /** Subscribes to both transports; repeated calls share one subscription set. */
  subscribe(): () => void;
}

const REMEMBER_MS = 60_000;
const HEARD_DEFAULT_MS = 60_000;
/** base64 of 52 bytes is 72 characters. */
const NEARBY_MAX_CHARS = 72;

/**
 * Routes convoy alerts over the same two transports as hazards and braking: Nearby first (always),
 * then LiveKit when online. Received alerts are deduplicated by reporter + sequence, dropped when
 * stale, and re-broadcast a limited number of hops so riders out of direct range still hear them.
 */
export function createConvoyCoordinator({
  senderId,
  nearbyTransport,
  liveKitTransport,
  isOnline,
  onPeerAlert,
  clock = Date.now,
}: ConvoyCoordinatorOptions): ConvoyCoordinator {
  const seen = new Map<string, number>();
  const heard = new Map<string, number>();
  let seq = 0;
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
  const keyOf = (a: ConvoyAlert) => `${a.reporterId}:${a.seq}:${a.timestamp}`;
  const heardKey = (subjectId: string, type: PackEventType) =>
    `${subjectId}:${type}`;

  const sendNearby = (alert: ConvoyAlert, hops: number) =>
    nearbyTransport.broadcast(bytesToBase64(encodeConvoyPacket(alert, hops)));
  const sendLiveKit = (alert: ConvoyAlert, hops: number) =>
    liveKitTransport.broadcast(encodeConvoyPacket(alert, hops));

  const handle = (bytes: Uint8Array | null, ingress: ConvoyIngress) => {
    const packet = bytes && decodeConvoyPacket(bytes);
    if (!packet || packet.reporterId === senderId) {
      return;
    }
    if (Math.abs(clock() - packet.timestamp) > CONVOY_PACKET_MAX_SKEW_MS) {
      return;
    }
    const { hops, ...alert } = packet;
    if (!remember(keyOf(alert))) {
      return;
    }
    if (alert.recovered) {
      heard.delete(heardKey(alert.subjectId, alert.eventType));
    } else {
      heard.set(heardKey(alert.subjectId, alert.eventType), clock());
    }

    onPeerAlert(alert, ingress);

    if (hops > 0) {
      sendNearby(alert, hops - 1).catch(() => {});
      if (ingress === 'nearby' && isOnline()) {
        sendLiveKit(alert, hops - 1).catch(() => {});
      }
    }
  };

  const attempt = (
    channel: 'mesh' | 'cloud',
    send: Promise<unknown>,
  ): Promise<ConvoySendOutcome> =>
    send.then(
      () => ({ channel, ok: true }),
      () => ({ channel, ok: false }),
    );

  return {
    submitLocal(partial) {
      seq = (seq % 0xffff) + 1;
      const alert: ConvoyAlert = { ...partial, reporterId: senderId, seq };
      remember(keyOf(alert));
      const sends = [attempt('mesh', sendNearby(alert, CONVOY_MAX_HOPS))];
      if (isOnline()) {
        sends.push(attempt('cloud', sendLiveKit(alert, CONVOY_MAX_HOPS)));
      }
      return Promise.all(sends);
    },

    heardRecently(subjectId, eventType, withinMs = HEARD_DEFAULT_MS) {
      const at = heard.get(heardKey(subjectId, eventType));
      return at !== undefined && clock() - at <= withinMs;
    },

    subscribe() {
      if (active) {
        return active;
      }
      const offLiveKit = liveKitTransport.onPayload(payload =>
        handle(payload, 'livekit'),
      );
      const offNearby = nearbyTransport.onPayload(text =>
        handle(base64ToBytes(text, NEARBY_MAX_CHARS), 'nearby'),
      );
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
