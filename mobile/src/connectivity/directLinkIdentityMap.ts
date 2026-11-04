import {
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  isValidRideMessageIdentifier,
  isValidRideMessageTimestamp,
} from './protocol/rideMessage';

export const DIRECT_LINK_DEFAULT_FRESHNESS_MS = 15_000;
export const DIRECT_LINK_MAX_FRESHNESS_MS = 10 * 60 * 1000;
export const DIRECT_LINK_MAX_TRANSPORT_ID_LENGTH = 64;
export const DIRECT_LINK_MAX_TRANSPORT_PEER_ID_LENGTH = 64;
export const DIRECT_LINK_DEFAULT_MAX_LINKS = 256;

export interface DirectLink {
  readonly transportId: string;
  readonly transportPeerId: string;
  readonly nodeId: string;
  readonly lastSeenAt: number;
}

export type DirectLinkObserveResult =
  | { observed: true; change: 'new_link' | 'refreshed' }
  | { observed: true; change: 'reassigned'; previousNodeId: string }
  | { observed: false; reason: 'invalid' | 'local_node' | 'table_full' | 'out_of_order' };

export interface DirectLinkIdentityMapOptions {
  localNodeId: string;
  freshnessMs?: number;
  maxLinks?: number;
}

export interface DirectLinkIdentityMap {
  observe(
    transportId: string,
    transportPeerId: string,
    nodeId: string,
    now: number,
  ): DirectLinkObserveResult;
  resolve(transportId: string, transportPeerId: string, now: number): string | undefined;
  getLinksForNode(nodeId: string, now: number): readonly DirectLink[];
  prune(now: number): void;
}

interface StoredLink {
  nodeId: string;
  lastSeenAt: number;
}

function compareLinks(a: DirectLink, b: DirectLink): number {
  if (a.transportId !== b.transportId) {
    return a.transportId < b.transportId ? -1 : 1;
  }
  if (a.transportPeerId !== b.transportPeerId) {
    return a.transportPeerId < b.transportPeerId ? -1 : 1;
  }
  return 0;
}

export function createDirectLinkIdentityMap({
  localNodeId,
  freshnessMs = DIRECT_LINK_DEFAULT_FRESHNESS_MS,
  maxLinks = DIRECT_LINK_DEFAULT_MAX_LINKS,
}: DirectLinkIdentityMapOptions): DirectLinkIdentityMap {
  if (!isValidRideMessageIdentifier(localNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH)) {
    throw new TypeError('DirectLinkIdentityMap localNodeId must be a valid RideMessage originId');
  }
  if (
    !Number.isSafeInteger(freshnessMs) ||
    freshnessMs <= 0 ||
    freshnessMs > DIRECT_LINK_MAX_FRESHNESS_MS
  ) {
    throw new RangeError(
      'DirectLinkIdentityMap freshnessMs must be an integer in ' +
        `(0, ${DIRECT_LINK_MAX_FRESHNESS_MS}]`,
    );
  }
  if (!Number.isSafeInteger(maxLinks) || maxLinks < 1) {
    throw new RangeError('DirectLinkIdentityMap maxLinks must be a positive integer');
  }

  const links = new Map<string, StoredLink>();

  const keyOf = (transportId: string, transportPeerId: string) =>
    JSON.stringify([transportId, transportPeerId]);
  const isFresh = (lastSeenAt: number, now: number) => now - lastSeenAt < freshnessMs;
  const isValidLinkKey = (transportId: unknown, transportPeerId: unknown) =>
    isValidRideMessageIdentifier(transportId, DIRECT_LINK_MAX_TRANSPORT_ID_LENGTH) &&
    isValidRideMessageIdentifier(transportPeerId, DIRECT_LINK_MAX_TRANSPORT_PEER_ID_LENGTH);

  const prune = (now: number): void => {
    for (const [key, link] of links) {
      if (!isFresh(link.lastSeenAt, now)) {
        links.delete(key);
      }
    }
  };

  return {
    observe(transportId, transportPeerId, nodeId, now): DirectLinkObserveResult {
      if (
        !isValidLinkKey(transportId, transportPeerId) ||
        !isValidRideMessageIdentifier(nodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH) ||
        !isValidRideMessageTimestamp(now)
      ) {
        return { observed: false, reason: 'invalid' };
      }
      if (nodeId === localNodeId) {
        return { observed: false, reason: 'local_node' };
      }

      prune(now);

      const key = keyOf(transportId, transportPeerId);
      const existing = links.get(key);
      if (!existing) {
        if (links.size >= maxLinks) {
          return { observed: false, reason: 'table_full' };
        }
        links.set(key, { nodeId, lastSeenAt: now });
        return { observed: true, change: 'new_link' };
      }
      if (existing.nodeId === nodeId) {
        existing.lastSeenAt = Math.max(existing.lastSeenAt, now);
        return { observed: true, change: 'refreshed' };
      }
      if (now < existing.lastSeenAt) {
        return { observed: false, reason: 'out_of_order' };
      }
      const previousNodeId = existing.nodeId;
      links.set(key, { nodeId, lastSeenAt: now });
      return { observed: true, change: 'reassigned', previousNodeId };
    },

    resolve(transportId, transportPeerId, now): string | undefined {
      if (!isValidLinkKey(transportId, transportPeerId) || !isValidRideMessageTimestamp(now)) {
        return undefined;
      }
      const link = links.get(keyOf(transportId, transportPeerId));
      return link && isFresh(link.lastSeenAt, now) ? link.nodeId : undefined;
    },

    getLinksForNode(nodeId, now): readonly DirectLink[] {
      if (!isValidRideMessageTimestamp(now)) {
        return Object.freeze([]);
      }
      const result: DirectLink[] = [];
      for (const [key, link] of links) {
        if (link.nodeId === nodeId && isFresh(link.lastSeenAt, now)) {
          const [transportId, transportPeerId] = JSON.parse(key) as [string, string];
          result.push(
            Object.freeze({ transportId, transportPeerId, nodeId, lastSeenAt: link.lastSeenAt }),
          );
        }
      }
      result.sort(compareLinks);
      return Object.freeze(result);
    },

    prune(now): void {
      if (isValidRideMessageTimestamp(now)) {
        prune(now);
      }
    },
  };
}
