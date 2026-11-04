import { OPERATIONAL_SEND_TIMEOUT_MS, describeError, sendWithTimeout } from './boundedSend';
import type { AckReturnResult, AckReturnRouter } from './ackReturnRouter';
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

export type AdvertisementRelayResult =
  | { status: 'not_relayed'; reason: RelayRejection | 'invalid_payload' | 'encode_failed' }
  | { status: 'relayed'; message: RideMessage<unknown> }
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
  | { stage: 'ack'; result: AckReturnResult }
  | { stage: 'unrouted' };

export interface ConnectivityApplicationMessage {
  readonly message: RideMessage<JsonValue>;
  readonly delivery: 'local' | 'gateway';
}

export interface ConnectivityReceiverOptions {
  transportId: string;
  ingress: RideMessageIngress;
  peerTable: PeerTable;
  linkIdentities: DirectLinkIdentityMap;
  gatewayState: GatewayState;
  forwarder: RoutedForwarder;
  ackReturnRouter?: AckReturnRouter;
  controlTransport: { broadcast(payload: string): Promise<void> };
  monotonicClock: () => number;
  wallClock: () => number;
  onApplicationMessage?: (received: ConnectivityApplicationMessage) => void;
  relayTimeoutMs?: number;
}

export interface ConnectivityReceiver {
  handlePayload(
    source: TransportEndpointSource,
    payload: string,
  ): Promise<ConnectivityReceiveResult>;
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
  ackReturnRouter,
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
    } catch {}
  };

  const relayAdvertisement = async (
    message: RideMessage<unknown>,
    recorded: GatewayAdvertisementHandlingResult,
  ): Promise<AdvertisementRelayResult> => {
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
      const result = handleGatewayAdvertisement(
        accepted,
        monotonicClock(),
        gatewayState,
        linkIdentities,
      );
      const relay = await relayAdvertisement(message, result);
      return { stage: 'gateway_advertisement', result, relay };
    }
    if (message.type === 'ack' && message.gatewayRouting === undefined && ackReturnRouter) {
      const result = await ackReturnRouter.route(message);
      if (result.status === 'origin_reached') {
        deliverApplicationMessage(message, 'local');
      }
      return { stage: 'ack', result };
    }
    if (message.gatewayRouting !== undefined) {
      ackReturnRouter?.remember(message, source);
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
            } catch {}
          },
          () => {},
        );
      });
    },
  };
}
