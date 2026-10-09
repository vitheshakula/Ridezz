/**
 * Turns an accepted, DIRECT heartbeat into a PeerTable observation. Runs after ingress (which has
 * already parsed, ride-checked and deduplicated the packet); it never parses, dedups, sends or
 * relays.
 *
 * Identity mapping:
 *   peer node id   = message.originId     (Rideaze node identity; unauthenticated for now)
 *   transport id   = source.transportId
 *   source.peerId  is transport-local (e.g. an endpoint id). It is never used as a node id; it
 *                  only keys the optional DirectLinkIdentityMap link claim.
 *
 * Clock domains: message timestamps are wall-clock and cross devices; PeerTable freshness is
 * local. The observation time is therefore passed in separately (`monotonicNow`) and the
 * message's createdAt/expiresAt are never used as lastSeenAt.
 */

import { isHeartbeatPayload } from './protocol/heartbeat';
import type { PeerObserveResult, PeerTable } from './peerTable';
import type { RideMessageIngressResult } from './rideMessageIngress';
import type { DirectLinkIdentityMap, DirectLinkObserveResult } from './directLinkIdentityMap';

export type AcceptedRideMessageIngress = Extract<RideMessageIngressResult, { accepted: true }>;

type PeerTableRejection = Extract<PeerObserveResult, { observed: false }>['reason'];
type PeerTableChange = Extract<PeerObserveResult, { observed: true }>['change'];

/** Outcome of recording the (transportId, source.peerId) -> originId link claim. */
export type HeartbeatLinkResult =
  | DirectLinkObserveResult
  | { observed: false; reason: 'no_transport_peer_id' };

export type HeartbeatHandlingResult =
  | {
      observed: true;
      nodeId: string;
      transportId: string;
      change: PeerTableChange;
      /** Present only when a DirectLinkIdentityMap was supplied. */
      link?: HeartbeatLinkResult;
    }
  | { observed: false; reason: 'not_heartbeat' | 'not_direct' | 'invalid_payload' }
  | { observed: false; reason: 'peer_rejected'; peerRejection: PeerTableRejection };

/**
 * Checks, in order: heartbeat type, directness (hopCount === 0; relayed heartbeats fail closed),
 * payload shape, then PeerTable.observe. Never throws for message contents.
 *
 * With `linkIdentities`, a heartbeat that refreshed presence also records the unauthenticated
 * claim (source.transportId, source.peerId) -> message.originId. Presence never depends on it:
 * a transport that exposes no peer id still refreshes PeerTable exactly as without the map.
 */
export function handleHeartbeat(
  { message, source }: AcceptedRideMessageIngress,
  monotonicNow: number,
  peerTable: PeerTable,
  linkIdentities?: DirectLinkIdentityMap,
): HeartbeatHandlingResult {
  if (message.type !== 'heartbeat') {
    return { observed: false, reason: 'not_heartbeat' };
  }
  if (message.hopCount !== 0) {
    return { observed: false, reason: 'not_direct' };
  }
  if (!isHeartbeatPayload(message.payload)) {
    return { observed: false, reason: 'invalid_payload' };
  }

  const result = peerTable.observe(message.originId, source.transportId, monotonicNow);
  if (!result.observed) {
    return { observed: false, reason: 'peer_rejected', peerRejection: result.reason };
  }
  const observed: HeartbeatHandlingResult = {
    observed: true,
    nodeId: message.originId,
    transportId: source.transportId,
    change: result.change,
  };
  if (linkIdentities) {
    observed.link =
      source.peerId === undefined
        ? { observed: false, reason: 'no_transport_peer_id' }
        : linkIdentities.observe(
            source.transportId,
            source.peerId,
            message.originId,
            monotonicNow,
          );
  }
  return observed;
}
