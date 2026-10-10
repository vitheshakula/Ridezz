/**
 * The single receive pipeline for Ride Connectivity Protocol traffic from an endpoint-aware
 * transport: one ingress (one dedup) per node, then dispatch by message kind.
 *
 *   onPayloadFrom(endpointId, payload)
 *     -> ingress with source { transportId, peerId: endpointId }
 *     -> heartbeat              -> handleHeartbeat (presence + direct-link identity)
 *     -> gateway_advertisement  -> handleGatewayAdvertisement (gateway state, resolved sender)
 *     -> message with gatewayRouting -> RoutedForwarder (gateway reached, or one targeted hop)
 *     -> any other message      -> 'unrouted' (no flooding and no local delivery here yet)
 *
 * It subscribes only to the endpoint-aware event (onPayloadFrom), never to the Phase 1 event, so
 * no packet is processed twice.
 *
 * Two forwarding modes, kept strictly apart:
 *   - Control-plane FLOOD (gateway advertisements): broadcast to every connected endpoint, bounded
 *     by ingress dedup (stable message id), expiry, hop limit and relay policy. After the
 *     advertisement is recorded locally, the relay copy from decideRelay is broadcast. Recording
 *     never depends on the relay succeeding. Heartbeats are never relayed (relay policy refuses).
 *   - Data-plane ROUTING (messages carrying gatewayRouting): one targeted sendTo per hop via the
 *     RoutedForwarder. Never broadcast.
 * Application messages without gatewayRouting are not flooded here ('unrouted').
 *
 * Broadcast echo: a node's relay also reaches the endpoint it came from. That copy is dropped by
 * the receiver's ingress (duplicate id, or local origin at the gateway), so floods terminate.
 */

import { OPERATIONAL_SEND_TIMEOUT_MS, describeError, sendWithTimeout } from './boundedSend';
import type { DirectLinkIdentityMap } from './directLinkIdentityMap';
import {
  handleGatewayAdvertisement,
  type GatewayAdvertisementHandlingResult,
} from './gatewayAdvertisementHandler';
import type { GatewayState } from './gatewayState';
import { handleHeartbeat, type HeartbeatHandlingResult } from './heartbeatHandler';
import type { PeerTable } from './peerTable';
import { decideRelay, type RelayRejection } from './relayPolicy';
import type { RideMessage } from './protocol/rideMessage';
import type { JsonValue } from './protocol/jsonValue';
import { serializeRideMessage } from './protocol/rideMessageCodec';
import type { RideMessageIngress, RideMessageIngressRejection } from './rideMessageIngress';
import type { RoutedForwarder, RoutedForwardResult } from './routedForwarder';
import type { TargetedTransport, TransportEndpointSource } from '../transports/Transport';

/** What happened to the flood relay of an accepted advertisement, independent of recording. */
export type AdvertisementRelayResult =
  | { status: 'not_relayed'; reason: RelayRejection | 'invalid_payload' | 'encode_failed' }
  | { status: 'relayed'; message: RideMessage<unknown> }
  /** broadcast() did not settle in time: the relay may or may not have gone out. */
  | { status: 'relay_timeout'; message: RideMessage<unknown> }
  | { status: 'relay_error'; message: RideMessage<unknown>; error: string };

export type ConnectivityReceiveResult =
  | { stage: 'ingress_rejected'; reason: RideMessageIngressRejection }
  | { stage: 'heartbeat'; result: HeartbeatHandlingResult }
  | {
      stage: 'gateway_advertisement';
      result: GatewayAdvertisementHandlingResult;
      relay: AdvertisementRelayResult;
    }
  | { stage: 'routed'; result: RoutedForwardResult }
  | { stage: 'unrouted' };

/** An accepted application message that is intended for this node. Intermediate routed messages
 * are never reported here. `originId` is a protocol node id, not an authenticated user identity. */
export interface ConnectivityApplicationMessage {
  readonly message: RideMessage<JsonValue>;
  readonly delivery: 'local' | 'gateway';
}

export interface ConnectivityReceiverOptions {
  /** The transport this receiver serves, e.g. NEARBY_TRANSPORT_ID. */
  transportId: string;
  ingress: RideMessageIngress;
  peerTable: PeerTable;
  linkIdentities: DirectLinkIdentityMap;
  gatewayState: GatewayState;
  forwarder: RoutedForwarder;
  /** Broadcast on the same local transport, used only for control-plane flood relay. */
  controlTransport: { broadcast(payload: string): Promise<void> };
  /** Local monotonic clock (presence/gateway freshness). Ingress keeps its own wall clock. */
  monotonicClock: () => number;
  /** Protocol wall clock, for relay expiry checks. */
  wallClock: () => number;
  /** Optional application hand-off. Exceptions are isolated from the receive pipeline. */
  onApplicationMessage?: (received: ConnectivityApplicationMessage) => void;
  /** Bound on one relay broadcast; defaults to OPERATIONAL_SEND_TIMEOUT_MS. */
  relayTimeoutMs?: number;
}

export interface ConnectivityReceiver {
  handlePayload(
    source: TransportEndpointSource,
    payload: string,
  ): Promise<ConnectivityReceiveResult>;
  /** Subscribes to the endpoint-aware receive event. Each result goes to `onResult`, if given. */
  subscribe(
    transport: Pick<TargetedTransport<string>, 'onPayloadFrom'>,
    onResult?: (result: ConnectivityReceiveResult) => void,
  ): () => void;
}

export function createConnectivityReceiver({
  transportId,
  ingress,
  peerTable,
  linkIdentities,
  gatewayState,
  forwarder,
  controlTransport,
  monotonicClock,
  wallClock,
  onApplicationMessage,
  relayTimeoutMs = OPERATIONAL_SEND_TIMEOUT_MS,
}: ConnectivityReceiverOptions): ConnectivityReceiver {
  if (!Number.isSafeInteger(relayTimeoutMs) || relayTimeoutMs <= 0) {
    throw new RangeError('Connectivity receiver relayTimeoutMs must be a positive integer');
  }

  const deliverApplicationMessage = (
    message: RideMessage<JsonValue>,
    delivery: ConnectivityApplicationMessage['delivery'],
  ): void => {
    try {
      onApplicationMessage?.({ message, delivery });
    } catch {
      // Application observers must never interrupt forwarding or the receive subscription.
    }
  };

  /** Flood relay of an accepted advertisement: same id, hopCount + 1, per relay policy. */
  const relayAdvertisement = async (
    message: RideMessage<unknown>,
    recorded: GatewayAdvertisementHandlingResult,
  ): Promise<AdvertisementRelayResult> => {
    // A malformed advertisement is not propagated. Local capacity rejections (table full) still
    // relay: other nodes may have room to record it.
    if (!recorded.observed && recorded.reason === 'invalid_payload') {
      return { status: 'not_relayed', reason: 'invalid_payload' };
    }
    const decision = decideRelay(message, wallClock());
    if (!decision.relay) {
      return { status: 'not_relayed', reason: decision.reason };
    }
    let payload: string;
    try {
      payload = serializeRideMessage(decision.message);
    } catch {
      return { status: 'not_relayed', reason: 'encode_failed' };
    }
    const outcome = await sendWithTimeout(
      () => controlTransport.broadcast(payload),
      relayTimeoutMs,
    );
    if (outcome.ok) {
      return { status: 'relayed', message: decision.message };
    }
    if ('timedOut' in outcome) {
      return { status: 'relay_timeout', message: decision.message };
    }
    return {
      status: 'relay_error',
      message: decision.message,
      error: describeError(outcome.error),
    };
  };

  const handlePayload = async (
    source: TransportEndpointSource,
    payload: string,
  ): Promise<ConnectivityReceiveResult> => {
    const accepted = ingress.ingest(payload, { transportId, peerId: source.endpointId });
    if (!accepted.accepted) {
      return { stage: 'ingress_rejected', reason: accepted.reason };
    }
    const { message } = accepted;
    if (message.type === 'heartbeat') {
      return {
        stage: 'heartbeat',
        result: handleHeartbeat(accepted, monotonicClock(), peerTable, linkIdentities),
      };
    }
    if (message.type === 'gateway_advertisement') {
      // Record first: discovery stands regardless of what happens to the relay.
      const result = handleGatewayAdvertisement(
        accepted,
        monotonicClock(),
        gatewayState,
        linkIdentities,
      );
      const relay = await relayAdvertisement(message, result);
      return { stage: 'gateway_advertisement', result, relay };
    }
    if (message.gatewayRouting !== undefined) {
      const result = await forwarder.forwardAccepted(accepted);
      if (result.status === 'gateway_reached') {
        deliverApplicationMessage(message, 'gateway');
      }
      return { stage: 'routed', result };
    }
    deliverApplicationMessage(message, 'local');
    return { stage: 'unrouted' };
  };

  return {
    handlePayload,

    subscribe(transport, onResult): () => void {
      return transport.onPayloadFrom((source, payload) => {
        handlePayload(source, payload).then(
          result => {
            try {
              onResult?.(result);
            } catch {
              // Observability must not break receive.
            }
          },
          () => {
            // handlePayload resolves for every packet outcome; an exception here is a local bug,
            // swallowed so one bad packet cannot stop the receive loop.
          },
        );
      });
    },
  };
}
