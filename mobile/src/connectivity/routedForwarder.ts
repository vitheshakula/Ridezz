import {
  decideGatewayForward,
  originateGatewayRouted,
  type GatewayForwardDecision,
  type GatewayOriginDecision,
} from './gatewayForwarding';
import {
  resolvePreviousHop,
  resolveTargetEndpoint,
  gatewayRouteKey,
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

export const ROUTED_SEND_TIMEOUT_MS = OPERATIONAL_SEND_TIMEOUT_MS;
export const ROUTED_DEFAULT_MAX_ROUTE_ATTEMPTS = 3;

type AcceptedIngress = Extract<RideMessageIngressResult, { accepted: true }>;
type OriginRejection = Extract<
  GatewayOriginDecision<unknown, RideMessageType>,
  { ok: false }
>['reason'];
type ForwardRejection = Extract<
  GatewayForwardDecision<unknown, RideMessageType>,
  { outcome: 'failed' }
>['reason'];

export interface RoutedHop {
  message: RideMessage<unknown>;
  route: GatewayRouteCandidate;
  endpointId: string;
}

export type RoutedSendResult =
  | ({ status: 'sent' } & RoutedHop)
  | ({ status: 'send_timeout' } & RoutedHop)
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
  transportId: string;
  transport: Pick<TargetedTransport<string>, 'sendTo'>;
  gatewayState: GatewayState;
  linkIdentities: DirectLinkIdentityMap;
  monotonicClock: () => number;
  wallClock: () => number;
  sendTimeoutMs?: number;
  maxRouteAttempts?: number;
}

export interface RoutedForwarder {
  sendOriginated(message: RideMessage<unknown>, gatewayNodeId?: string): Promise<RoutedSendResult>;
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
  maxRouteAttempts = ROUTED_DEFAULT_MAX_ROUTE_ATTEMPTS,
}: RoutedForwarderOptions): RoutedForwarder {
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs <= 0) {
    throw new RangeError('Routed forwarder sendTimeoutMs must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRouteAttempts) || maxRouteAttempts <= 0) {
    throw new RangeError('Routed forwarder maxRouteAttempts must be a positive integer');
  }

  const context = (now: number): GatewayRouteContext => ({
    localNodeId,
    gatewayState,
    linkIdentities,
    now,
  });

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
      const excluded = new Set<string>();
      let lastFailure: RoutedSendResult | undefined;
      for (let attempt = 0; attempt < maxRouteAttempts; attempt++) {
        const now = monotonicClock();
        const decision = originateGatewayRouted(message, context(now), gatewayNodeId, excluded);
        if (!decision.ok) {
          return lastFailure ?? { status: 'not_sent', reason: decision.reason };
        }
        const result = await transmit(decision.message, decision.route, now);
        if (
          result.status === 'sent' ||
          result.status === 'send_timeout' ||
          (result.status === 'not_sent' && result.reason === 'encode_failed')
        ) {
          return result;
        }
        lastFailure = result;
        if ('route' in result && result.route) {
          excluded.add(gatewayRouteKey(result.route));
        } else {
          return result;
        }
      }
      return lastFailure ?? { status: 'not_sent', reason: 'no_route' };
    },

    async forwardAccepted({ message, source }): Promise<RoutedForwardResult> {
      const excluded = new Set<string>();
      let lastFailure: RoutedSendResult | undefined;
      for (let attempt = 0; attempt < maxRouteAttempts; attempt++) {
        const now = monotonicClock();
        const previousHop = resolvePreviousHop(source, linkIdentities, now);
        const decision = decideGatewayForward(
          message,
          context(now),
          previousHop,
          wallClock(),
          excluded,
        );
        if (decision.outcome === 'gateway_reached') {
          return { status: 'gateway_reached', message, targetGatewayId: decision.targetGatewayId };
        }
        if (decision.outcome === 'failed') {
          return lastFailure ?? { status: 'not_sent', reason: decision.reason };
        }
        const result = await transmit(decision.message, decision.route, now);
        if (
          result.status === 'sent' ||
          result.status === 'send_timeout' ||
          (result.status === 'not_sent' && result.reason === 'encode_failed')
        ) {
          return result;
        }
        lastFailure = result;
        if ('route' in result && result.route) {
          excluded.add(gatewayRouteKey(result.route));
        } else {
          return result;
        }
      }
      return lastFailure ?? { status: 'not_sent', reason: 'no_route' };
    },
  };
}
