import { isHeartbeatPayload } from './protocol/heartbeat';
import type { PeerObserveResult, PeerTable } from './peerTable';
import type { RideMessageIngressResult } from './rideMessageIngress';
import type { DirectLinkIdentityMap, DirectLinkObserveResult } from './directLinkIdentityMap';

export type AcceptedRideMessageIngress = Extract<RideMessageIngressResult, { accepted: true }>;

type PeerTableRejection = Extract<PeerObserveResult, { observed: false }>['reason'];
type PeerTableChange = Extract<PeerObserveResult, { observed: true }>['change'];

export type HeartbeatLinkResult =
  | DirectLinkObserveResult
  | { observed: false; reason: 'no_transport_peer_id' };

export type HeartbeatHandlingResult =
  | {
      observed: true;
      nodeId: string;
      transportId: string;
      change: PeerTableChange;
      link?: HeartbeatLinkResult;
    }
  | { observed: false; reason: 'not_heartbeat' | 'not_direct' | 'invalid_payload' }
  | { observed: false; reason: 'peer_rejected'; peerRejection: PeerTableRejection };

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
        : linkIdentities.observe(source.transportId, source.peerId, message.originId, monotonicNow);
  }
  return observed;
}
