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
  | { status: 'runtime_not_running' }
  | { status: 'local_gateway' };

export interface RideConnectivityRuntimeOptions {
  rideId: string;
  localNodeId: string;
  transportId: string;
  transport: TargetedTransport<string> & { broadcast(payload: string): Promise<void> };
  generateMessageId: () => string;
  wallClock: () => number;
  monotonicClock: () => number;
  isCloudReachable: () => boolean;
  onEvent?: (event: RideConnectivityEvent) => void;
  onApplicationMessage?: (received: ConnectivityApplicationMessage) => void;
}

export interface RideConnectivityRuntime {
  start(): void;
  stop(): void;
  readonly running: boolean;
  sendToGateway(
    message: RideMessage<unknown>,
    gatewayNodeId?: string,
  ): Promise<RideConnectivitySendResult>;
  sendAcknowledgement(message: RideMessage<JsonValue>): Promise<AckReturnResult>;
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
    } catch {}
  };

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
