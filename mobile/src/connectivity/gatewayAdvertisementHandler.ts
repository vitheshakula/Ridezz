import type { DirectLinkIdentityMap } from './directLinkIdentityMap';
import type { GatewayObserveResult, GatewayState } from './gatewayState';
import { isGatewayAdvertisementPayload } from './protocol/gatewayAdvertisement';
import type { RideMessageIngressResult } from './rideMessageIngress';

type AcceptedIngress = Extract<RideMessageIngressResult, { accepted: true }>;
type GatewayStateRejection = Extract<GatewayObserveResult, { observed: false }>['reason'];
type GatewayStateChange = Extract<GatewayObserveResult, { observed: true }>['change'];

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
