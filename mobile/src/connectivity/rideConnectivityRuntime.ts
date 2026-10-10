/**
 * Composition root of the Ride Connectivity Protocol for ONE ride session. It wires existing
 * components together; it adds no protocol behaviour of its own.
 *
 *   transport.onPayloadFrom (ONE subscription) -> ConnectivityReceiver
 *       heartbeats -> PeerTable + DirectLinkIdentityMap
 *       gateway advertisements -> GatewayState + flood relay (broadcast)
 *       gatewayRouting messages -> RoutedForwarder (targeted sendTo)
 *   HeartbeatEmitter + scheduler      -> transport.broadcast (this transport only; never LiveKit)
 *   GatewayAdvertisementEmitter + scheduler (only while isCloudReachable()) -> transport.broadcast
 *   sendToGateway(message)            -> RoutedForwarder.sendOriginated
 *
 * Ownership: the caller owns the transport session (e.g. RideScreen starts/stops Nearby). The
 * runtime only subscribes, schedules and sends. stop() unsubscribes, stops both schedulers and
 * rejects further sends; session state is dropped with the instance, which cannot be restarted.
 *
 * Known limitation (unchanged): heartbeats and advertisements go through the transport's
 * broadcast, which on Nearby shares Phase 1's serialized broadcast queue. Timeouts bound how long
 * the runtime waits, they do not cancel a stuck native operation; outcomes reach `onEvent`.
 */

import {
  createConnectivityReceiver,
  type ConnectivityApplicationMessage,
  type ConnectivityReceiveResult,
} from './connectivityReceiver';
import { createAckReturnRouter, type AckReturnResult } from './ackReturnRouter';
import type { CycleOutcome, CycleScheduler } from './cycleScheduler';
import { createDirectLinkIdentityMap } from './directLinkIdentityMap';
import {
  createGatewayAdvertisementEmitter,
  createGatewayAdvertisementScheduler,
  type GatewayAdvertisementCycleResult,
} from './gatewayAdvertisementEmitter';
import {
  getGatewayRouteCandidates,
  selectGatewayForwardingRoute,
  type GatewayForwardingDecision,
} from './gatewayRouting';
import { createGatewayState } from './gatewayState';
import {
  createHeartbeatEmitter,
  createHeartbeatScheduler,
  type HeartbeatCycleResult,
  type HeartbeatTransport,
} from './heartbeatEmitter';
import { createPeerTable } from './peerTable';
import { createRideMessageIngress } from './rideMessageIngress';
import { createRoutedForwarder, type RoutedSendResult } from './routedForwarder';
import type { RideMessage } from './protocol/rideMessage';
import type { JsonValue } from './protocol/jsonValue';
import { createSeenMessageCache } from './protocol/seenMessageCache';
import type { TargetedTransport } from '../transports/Transport';

export type RideConnectivityEvent =
  | { kind: 'receive'; result: ConnectivityReceiveResult }
  | { kind: 'heartbeat_cycle'; outcome: CycleOutcome<HeartbeatCycleResult> }
  | { kind: 'gateway_advertisement_cycle'; outcome: CycleOutcome<GatewayAdvertisementCycleResult> };

export type RideConnectivitySendResult =
  | RoutedSendResult
  /** start() has not been called, or stop() has. Nothing was sent. */
  | { status: 'runtime_not_running' }
  /** This node is itself cloud reachable: delivery is a local cloud hand-off (future upload), not a
   * Nearby route. Nothing was sent. */
  | { status: 'local_gateway' };

export interface RideConnectivityRuntimeOptions {
  /** The ride this session belongs to (RideMessage rideId, e.g. the room code). */
  rideId: string;
  /** This node's Rideaze node id for the session. Must not be an endpoint id, a native mesh id or
   * a display name. */
  localNodeId: string;
  /** Local id of the transport, e.g. NEARBY_TRANSPORT_ID. */
  transportId: string;
  /** The endpoint-aware local transport. Its session lifecycle stays with the caller. */
  transport: TargetedTransport<string> & { broadcast(payload: string): Promise<void> };
  /** Secure RideMessage id source (createRuntimeRideMessageIdGenerator in the app). */
  generateMessageId: () => string;
  /** Protocol wall clock, epoch ms. */
  wallClock: () => number;
  /** Local monotonic clock for presence, links and gateway freshness. */
  monotonicClock: () => number;
  /** Application-level cloud reachability of this node, checked every advertisement cycle. */
  isCloudReachable: () => boolean;
  /** Observability: every receive result and scheduler cycle outcome. Must not throw. */
  onEvent?: (event: RideConnectivityEvent) => void;
  /** Accepted application messages for this node. Intermediate routed messages are excluded. */
  onApplicationMessage?: (received: ConnectivityApplicationMessage) => void;
}

export interface RideConnectivityRuntime {
  /** Subscribes and starts both schedulers. Idempotent while running; throws after stop(). */
  start(): void;
  /** Unsubscribes and stops both schedulers. Idempotent. */
  stop(): void;
  readonly running: boolean;
  /** Routes an application message this node created toward a gateway via one targeted send. */
  sendToGateway(
    message: RideMessage<unknown>,
    gatewayNodeId?: string,
  ): Promise<RideConnectivitySendResult>;
  /** Returns a signed ACK along the recorded reverse path. No route is fabricated. */
  sendAcknowledgement(message: RideMessage<JsonValue>): Promise<AckReturnResult>;
  /** Read-only diagnostic: the route an originated message would take right now. */
  getGatewayRoute(gatewayNodeId?: string): GatewayForwardingDecision;
}

export function createRideConnectivityRuntime({
  rideId,
  localNodeId,
  transportId,
  transport,
  generateMessageId,
  wallClock,
  monotonicClock,
  isCloudReachable,
  onEvent,
  onApplicationMessage,
}: RideConnectivityRuntimeOptions): RideConnectivityRuntime {
  const report = (event: RideConnectivityEvent) => {
    try {
      onEvent?.(event);
    } catch {
      // Observability must never break the protocol.
    }
  };

  // Session-local state: dropped with this instance.
  const ingress = createRideMessageIngress({
    rideId,
    localNodeId,
    seenMessages: createSeenMessageCache(),
    clock: wallClock,
  });
  const peerTable = createPeerTable({ localNodeId });
  const linkIdentities = createDirectLinkIdentityMap({ localNodeId });
  const gatewayState = createGatewayState({ localNodeId });

  const forwarder = createRoutedForwarder({
    localNodeId,
    transportId,
    transport,
    gatewayState,
    linkIdentities,
    monotonicClock,
    wallClock,
  });
  const ackReturnRouter = createAckReturnRouter({
    localNodeId,
    sendTo: (endpointId, payload) => transport.sendTo(endpointId, payload),
    wallClock,
  });
  const receiver = createConnectivityReceiver({
    transportId,
    ingress,
    peerTable,
    linkIdentities,
    gatewayState,
    forwarder,
    ackReturnRouter,
    controlTransport: transport,
    monotonicClock,
    wallClock,
    onApplicationMessage,
  });

  // Heartbeats go over this one local transport only; LiveKit never participates.
  const heartbeatTransport: HeartbeatTransport = {
    id: transportId,
    payload: 'string',
    broadcast: payload => transport.broadcast(payload),
  };
  const heartbeatScheduler: CycleScheduler = createHeartbeatScheduler(
    createHeartbeatEmitter({
      rideId,
      localNodeId,
      getActiveTransports: () => [heartbeatTransport],
      generateMessageId,
      wallClock,
    }),
    { onCycleSettled: outcome => report({ kind: 'heartbeat_cycle', outcome }) },
  );
  const advertisementScheduler: CycleScheduler = createGatewayAdvertisementScheduler(
    createGatewayAdvertisementEmitter({
      rideId,
      localNodeId,
      transport,
      generateMessageId,
      wallClock,
      isCloudReachable,
    }),
    { onCycleSettled: outcome => report({ kind: 'gateway_advertisement_cycle', outcome }) },
  );

  let state: 'idle' | 'running' | 'stopped' = 'idle';
  let unsubscribe: (() => void) | null = null;

  return {
    start(): void {
      if (state === 'running') {
        return;
      }
      if (state === 'stopped') {
        throw new Error('A stopped ride connectivity runtime cannot be restarted');
      }
      state = 'running';
      unsubscribe = receiver.subscribe(transport, result => report({ kind: 'receive', result }));
      heartbeatScheduler.start();
      advertisementScheduler.start();
    },

    stop(): void {
      if (state !== 'running') {
        state = 'stopped';
        return;
      }
      state = 'stopped';
      unsubscribe?.();
      unsubscribe = null;
      heartbeatScheduler.stop();
      advertisementScheduler.stop();
      ackReturnRouter.clear();
    },

    get running(): boolean {
      return state === 'running';
    },

    async sendToGateway(message, gatewayNodeId): Promise<RideConnectivitySendResult> {
      if (state !== 'running') {
        return { status: 'runtime_not_running' };
      }
      let reachable = false;
      try {
        reachable = isCloudReachable() === true;
      } catch {
        reachable = false;
      }
      if (reachable) {
        return { status: 'local_gateway' };
      }
      return forwarder.sendOriginated(message, gatewayNodeId);
    },

    async sendAcknowledgement(message): Promise<AckReturnResult> {
      if (state !== 'running') {
        return { status: 'not_forwarded', reason: 'unknown_return_route' };
      }
      return ackReturnRouter.route(message);
    },

    getGatewayRoute(gatewayNodeId): GatewayForwardingDecision {
      return selectGatewayForwardingRoute(
        getGatewayRouteCandidates(
          { localNodeId, gatewayState, linkIdentities, now: monotonicClock() },
          gatewayNodeId,
        ),
        { gatewayNodeId },
      );
    },
  };
}
