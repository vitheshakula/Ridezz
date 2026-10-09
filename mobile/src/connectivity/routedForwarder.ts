/**
 * Executes gateway-routed sends over one targeted transport (Nearby in this version).
 *
 *   route.nextHopNodeId -> fresh DirectLinkIdentityMap link -> endpoint -> serialize -> sendTo
 *
 * Exactly one targeted send per routed hop, to exactly one endpoint. Never broadcasts, never tries
 * another endpoint, route or gateway, never retries, never mints a new message id. Routes on any
 * other transport fail closed as 'unsupported_transport'.
 *
 * Routed vs flooded: a message carrying gatewayRouting is handled here only; it must never also be
 * passed to flood relay (relay policy / Phase 1 broadcast).
 */

import {
  decideGatewayForward,
  originateGatewayRouted,
  type GatewayForwardDecision,
  type GatewayOriginDecision,
} from './gatewayForwarding';
import {
  resolvePreviousHop,
  resolveTargetEndpoint,
  type GatewayRouteCandidate,
  type GatewayRouteContext,
} from './gatewayRouting';
import { OPERATIONAL_SEND_TIMEOUT_MS, describeError, sendWithTimeout } from './boundedSend';
import type { DirectLinkIdentityMap } from './directLinkIdentityMap';
import type { GatewayState } from './gatewayState';
import type { RideMessageIngressResult } from './rideMessageIngress';
import type { RideMessage, RideMessageType } from './protocol/rideMessage';
import { serializeRideMessage } from './protocol/rideMessageCodec';
import type { TargetedTransport } from '../transports/Transport';

/** Local operational bound on one sendTo(); expiry means "result unknown", not "not delivered". */
export const ROUTED_SEND_TIMEOUT_MS = OPERATIONAL_SEND_TIMEOUT_MS;

type AcceptedIngress = Extract<RideMessageIngressResult, { accepted: true }>;
type OriginRejection = Extract<
  GatewayOriginDecision<unknown, RideMessageType>,
  { ok: false }
>['reason'];
type ForwardRejection = Extract<
  GatewayForwardDecision<unknown, RideMessageType>,
  { outcome: 'failed' }
>['reason'];

/** Everything a later retry policy would need about one attempted routed hop. */
export interface RoutedHop {
  message: RideMessage<unknown>;
  route: GatewayRouteCandidate;
  endpointId: string;
}

export type RoutedSendResult =
  | ({ status: 'sent' } & RoutedHop)
  /** sendTo() did not settle in time: the send may or may not have happened. */
  | ({ status: 'send_timeout' } & RoutedHop)
  /** sendTo() rejected (e.g. the endpoint is no longer a confirmed connection). */
  | ({ status: 'transport_error'; error: string } & RoutedHop)
  | {
      status: 'not_sent';
      reason:
        | OriginRejection
        | ForwardRejection
        | 'unsupported_transport'
        | 'no_endpoint'
        | 'encode_failed';
      route?: GatewayRouteCandidate;
    };

export type RoutedForwardResult =
  | { status: 'gateway_reached'; message: RideMessage<unknown>; targetGatewayId: string }
  | RoutedSendResult;

export interface RoutedForwarderOptions {
  localNodeId: string;
  /** The only transport this forwarder sends on, e.g. NEARBY_TRANSPORT_ID. */
  transportId: string;
  transport: Pick<TargetedTransport<string>, 'sendTo'>;
  gatewayState: GatewayState;
  linkIdentities: DirectLinkIdentityMap;
  /** Local monotonic clock (state freshness). */
  monotonicClock: () => number;
  /** Protocol wall clock (message expiry). */
  wallClock: () => number;
  sendTimeoutMs?: number;
}

export interface RoutedForwarder {
  /** Originates routed forwarding of a message this node created, optionally toward one gateway. */
  sendOriginated(message: RideMessage<unknown>, gatewayNodeId?: string): Promise<RoutedSendResult>;
  /** Handles an accepted routed message: gateway reached, or forward exactly one hop. */
  forwardAccepted(accepted: AcceptedIngress): Promise<RoutedForwardResult>;
}


export function createRoutedForwarder({
  localNodeId,
  transportId,
  transport,
  gatewayState,
  linkIdentities,
  monotonicClock,
  wallClock,
  sendTimeoutMs = ROUTED_SEND_TIMEOUT_MS,
}: RoutedForwarderOptions): RoutedForwarder {
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs <= 0) {
    throw new RangeError('Routed forwarder sendTimeoutMs must be a positive integer');
  }

  const context = (now: number): GatewayRouteContext => ({
    localNodeId,
    gatewayState,
    linkIdentities,
    now,
  });

  /** One targeted send of `message` along `route`, or a fail-closed result. */
  const transmit = async (
    message: RideMessage<unknown>,
    route: GatewayRouteCandidate,
    now: number,
  ): Promise<RoutedSendResult> => {
    if (route.transportId !== transportId) {
      return { status: 'not_sent', reason: 'unsupported_transport', route };
    }
    const endpointId = resolveTargetEndpoint(linkIdentities, route.nextHopNodeId, transportId, now);
    if (endpointId === undefined) {
      return { status: 'not_sent', reason: 'no_endpoint', route };
    }
    let payload: string;
    try {
      payload = serializeRideMessage(message);
    } catch {
      return { status: 'not_sent', reason: 'encode_failed', route };
    }

    const hop: RoutedHop = { message, route, endpointId };
    const outcome = await sendWithTimeout(
      () => transport.sendTo(endpointId, payload),
      sendTimeoutMs,
    );
    if (outcome.ok) {
      return { status: 'sent', ...hop };
    }
    if ('timedOut' in outcome) {
      return { status: 'send_timeout', ...hop };
    }
    return { status: 'transport_error', error: describeError(outcome.error), ...hop };
  };

  return {
    async sendOriginated(message, gatewayNodeId): Promise<RoutedSendResult> {
      const now = monotonicClock();
      const decision = originateGatewayRouted(message, context(now), gatewayNodeId);
      if (!decision.ok) {
        return { status: 'not_sent', reason: decision.reason };
      }
      return transmit(decision.message, decision.route, now);
    },

    async forwardAccepted({ message, source }): Promise<RoutedForwardResult> {
      const now = monotonicClock();
      // Direct previous hop from verified link identity, never message.originId.
      const previousHop = resolvePreviousHop(source, linkIdentities, now);
      const decision = decideGatewayForward(message, context(now), previousHop, wallClock());
      if (decision.outcome === 'gateway_reached') {
        return { status: 'gateway_reached', message, targetGatewayId: decision.targetGatewayId };
      }
      if (decision.outcome === 'failed') {
        return { status: 'not_sent', reason: decision.reason };
      }
      return transmit(decision.message, decision.route, now);
    },
  };
}
