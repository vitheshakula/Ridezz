/**
 * Turns an accepted gateway advertisement into a GatewayState observation. Runs after ingress
 * (which owns parsing, ride checks, local-origin rejection and dedup); it never parses, dedups,
 * relays, sends, or touches PeerTable. Relaying is decided separately by relay policy.
 *
 * Identity:
 *   gateway node id = message.originId    (unauthenticated for now)
 *   hop count       = message.hopCount    (how far the advertisement travelled)
 *   transport id    = source.transportId  (local link it arrived on)
 *   via node id     = DirectLinkIdentityMap.resolve(source.transportId, source.peerId), optional
 *   source.peerId itself is transport-local and is never stored or used as a node id.
 *
 * Clock domains: `monotonicNow` is the local observation time; the message's wall-clock
 * createdAt/expiresAt are never used as lastSeenAt.
 *
 * Dedup implication: one advertisement (one id) reaching this node over two paths is accepted
 * once, so only its first-arriving path is observed. Each advertisement cycle carries a new id,
 * so other paths are observed on later cycles as their copies arrive first.
 */

import type { DirectLinkIdentityMap } from './directLinkIdentityMap';
import type { GatewayObserveResult, GatewayState } from './gatewayState';
import { isGatewayAdvertisementPayload } from './protocol/gatewayAdvertisement';
import type { RideMessageIngressResult } from './rideMessageIngress';

type AcceptedIngress = Extract<RideMessageIngressResult, { accepted: true }>;
type GatewayStateRejection = Extract<GatewayObserveResult, { observed: false }>['reason'];
type GatewayStateChange = Extract<GatewayObserveResult, { observed: true }>['change'];

/**
 * How the direct sender (the neighbour that handed over this copy) was determined:
 *   - resolved: (source.transportId, source.peerId) maps to a fresh direct-link identity.
 *   - no_transport_peer_id: the transport exposed no endpoint id.
 *   - unknown_link: no fresh identity for that endpoint.
 *   - sender_mismatch: the identity contradicts the hop count. An unrelayed copy (hopCount 0) must
 *     come from the gateway itself, and a relayed copy (hopCount > 0) must not, since nodes never
 *     relay their own messages. Fails closed: treated as unresolved.
 */
export type GatewayAdvertisementVia =
  | { resolved: true; nodeId: string }
  | { resolved: false; reason: 'no_transport_peer_id' | 'unknown_link' | 'sender_mismatch' };

export type GatewayAdvertisementHandlingResult =
  | {
      observed: true;
      gatewayNodeId: string;
      transportId: string;
      hopCount: number;
      change: GatewayStateChange;
      /** Present only when a DirectLinkIdentityMap was supplied. */
      via?: GatewayAdvertisementVia;
    }
  | { observed: false; reason: 'not_gateway_advertisement' | 'invalid_payload' }
  | { observed: false; reason: 'gateway_rejected'; gatewayRejection: GatewayStateRejection };

function resolveVia(
  { message, source }: AcceptedIngress,
  monotonicNow: number,
  linkIdentities: DirectLinkIdentityMap,
): GatewayAdvertisementVia {
  if (source.peerId === undefined) {
    return { resolved: false, reason: 'no_transport_peer_id' };
  }
  const nodeId = linkIdentities.resolve(source.transportId, source.peerId, monotonicNow);
  if (nodeId === undefined) {
    return { resolved: false, reason: 'unknown_link' };
  }
  if ((message.hopCount === 0) !== (nodeId === message.originId)) {
    return { resolved: false, reason: 'sender_mismatch' };
  }
  return { resolved: true, nodeId };
}

/**
 * Checks, in order: message type, payload shape, then GatewayState.observe. Never throws for
 * message contents. With `linkIdentities`, the direct sender is resolved now, at receipt, and
 * stored as the observation's viaNodeId; an unresolved sender still records the gateway as known,
 * just not via any routable neighbour. Without it, behaviour is as before (no viaNodeId).
 */
export function handleGatewayAdvertisement(
  accepted: AcceptedIngress,
  monotonicNow: number,
  gatewayState: GatewayState,
  linkIdentities?: DirectLinkIdentityMap,
): GatewayAdvertisementHandlingResult {
  const { message, source } = accepted;
  if (message.type !== 'gateway_advertisement') {
    return { observed: false, reason: 'not_gateway_advertisement' };
  }
  if (!isGatewayAdvertisementPayload(message.payload)) {
    return { observed: false, reason: 'invalid_payload' };
  }

  const via = linkIdentities && resolveVia(accepted, monotonicNow, linkIdentities);
  const result = gatewayState.observe(
    message.originId,
    source.transportId,
    message.hopCount,
    monotonicNow,
    via?.resolved ? via.nodeId : undefined,
  );
  if (!result.observed) {
    return { observed: false, reason: 'gateway_rejected', gatewayRejection: result.reason };
  }
  return {
    observed: true,
    gatewayNodeId: message.originId,
    transportId: source.transportId,
    hopCount: message.hopCount,
    change: result.change,
    ...(via && { via }),
  };
}
