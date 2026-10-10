import { NativeModules } from 'react-native';
import type { ConnectivityTestProbeEvidence } from './connectivityTestProbe';
import { isConnectivityTestProbePayload } from './connectivityTestProbe';
import type { GatewayForwardingDecision } from './gatewayRouting';
import type { RideConnectivityEvent } from './rideConnectivityRuntime';

interface FieldTestEvidenceNativeModule {
  readonly enabled?: boolean;
  append(serialized: string): Promise<void>;
  read(): Promise<readonly string[]>;
  clear(): Promise<void>;
  printToLogcat(): Promise<number>;
}

const nativeModule = (): FieldTestEvidenceNativeModule | null => {
  const candidate = (NativeModules as Record<string, unknown>).RideazeFieldTestEvidence as
    | FieldTestEvidenceNativeModule
    | undefined;
  return candidate?.enabled === true ? candidate : null;
};

export type ConnectivityFieldTestEvidence =
  | ConnectivityTestProbeEvidence
  | Readonly<{
      kind: 'session_started';
      localNodeId: string;
      transportId: string;
    }>
  | Readonly<{ kind: 'gateway_override_changed'; enabled: boolean }>
  | Readonly<{
      kind: 'gateway_route_available';
      gatewayNodeId: string;
      nextHopNodeId: string;
      transportId: string;
      routeDistance: number;
    }>
  | Readonly<{ kind: 'gateway_route_unavailable'; reason: string }>
  | Readonly<{
      kind: 'probe_received';
      messageId: string;
      seq: number;
      originNodeId: string;
      hopCount: number;
    }>
  | Readonly<{
      kind: 'probe_route_attempt';
      direction: 'originated' | 'forwarded';
      messageId: string;
      seq: number;
      hopCount: number;
      gatewayNodeId: string;
      nextHopNodeId: string;
      transportId: string;
      routeDistance: number;
    }>
  | Readonly<{
      kind: 'probe_forward_result';
      messageId: string;
      seq: number;
      hopCount: number;
      status: string;
      nextHopNodeId?: string;
      transportId?: string;
      routeDistance?: number;
      reason?: string;
    }>
  | Readonly<{
      kind: 'probe_gateway_reached';
      messageId: string;
      seq: number;
      hopCount: number;
      gatewayNodeId: string;
    }>
  | Readonly<{
      kind: 'protocol_duplicate_suppressed';
      messageId: string;
      messageType?: string;
    }>;

/** True only when the native, compile-time field-test boundary is active. */
export function isConnectivityFieldTestBuild(): boolean {
  return nativeModule() !== null;
}

let appendQueue: Promise<void> = Promise.resolve();

/** Best-effort ordered write. Callers never wait for evidence I/O and failures never escape. */
export function recordConnectivityFieldTestEvidence(
  event: ConnectivityFieldTestEvidence,
): void {
  const native = nativeModule();
  if (!native) {
    return;
  }
  const monotonicNow = (
    globalThis as typeof globalThis & { performance?: { now?: () => number } }
  ).performance?.now?.();
  const envelope = {
    schema: 1,
    recordedAtMs: Date.now(),
    ...(typeof monotonicNow === 'number' && Number.isFinite(monotonicNow) && {
      monotonicMs: Math.floor(monotonicNow),
    }),
    ...event,
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
  } catch {
    return;
  }
  appendQueue = appendQueue.then(() => native.append(serialized)).catch(() => undefined);
}

export async function readConnectivityFieldTestEvidence(): Promise<readonly string[]> {
  await appendQueue;
  return nativeModule()?.read() ?? [];
}

export async function clearConnectivityFieldTestEvidence(): Promise<void> {
  await appendQueue;
  return nativeModule()?.clear();
}

export async function printConnectivityFieldTestEvidence(): Promise<number> {
  await appendQueue;
  return nativeModule()?.printToLogcat() ?? 0;
}

/** Converts protocol events into payload-free, correlatable records for the three-phone test. */
export function createConnectivityFieldTestObserver({
  getRoute,
}: {
  getRoute: () => GatewayForwardingDecision;
}): (event: RideConnectivityEvent) => void {
  let lastRoute = '';
  let lastGatewayCycle = '';

  const recordRoute = (): void => {
    const decision = getRoute();
    const key = decision.ok
      ? `${decision.route.gatewayNodeId}|${decision.route.nextHopNodeId}|${decision.distance}`
      : `none|${decision.reason}`;
    if (key === lastRoute) {
      return;
    }
    lastRoute = key;
    if (decision.ok) {
      recordConnectivityFieldTestEvidence({
        kind: 'gateway_route_available',
        gatewayNodeId: decision.route.gatewayNodeId,
        nextHopNodeId: decision.route.nextHopNodeId,
        transportId: decision.route.transportId,
        routeDistance: decision.distance,
      });
    } else {
      recordConnectivityFieldTestEvidence({
        kind: 'gateway_route_unavailable',
        reason: decision.reason,
      });
    }
  };

  return event => {
    if (event.kind === 'message_accepted') {
      const { message } = event;
      if (message.type === 'ride_state' && isConnectivityTestProbePayload(message.payload)) {
        recordConnectivityFieldTestEvidence({
          kind: 'probe_received',
          messageId: message.id,
          seq: message.payload.seq,
          originNodeId: message.originId,
          hopCount: message.hopCount,
        });
      }
      return;
    }

    if (event.kind === 'routed_attempt') {
      const { message, route } = event;
      if (message.type === 'ride_state' && isConnectivityTestProbePayload(message.payload)) {
        recordConnectivityFieldTestEvidence({
          kind: 'probe_route_attempt',
          direction: event.direction,
          messageId: message.id,
          seq: message.payload.seq,
          hopCount: message.hopCount,
          gatewayNodeId: route.gatewayNodeId,
          nextHopNodeId: route.nextHopNodeId,
          transportId: route.transportId,
          routeDistance: route.hopCount + 1,
        });
      }
      return;
    }

    if (event.kind === 'ingress_rejected_detail') {
      if (event.reason === 'duplicate') {
        recordConnectivityFieldTestEvidence({
          kind: 'protocol_duplicate_suppressed',
          messageId: event.messageId,
          messageType: event.messageType,
        });
      }
      return;
    }

    if (event.kind === 'routed_result') {
      const { message, result } = event;
      if (message.type !== 'ride_state' || !isConnectivityTestProbePayload(message.payload)) {
        return;
      }
      if (result.status === 'gateway_reached') {
        recordConnectivityFieldTestEvidence({
          kind: 'probe_gateway_reached',
          messageId: message.id,
          seq: message.payload.seq,
          hopCount: message.hopCount,
          gatewayNodeId: result.targetGatewayId,
        });
        return;
      }
      recordConnectivityFieldTestEvidence({
        kind: 'probe_forward_result',
        messageId: message.id,
        seq: message.payload.seq,
        hopCount: message.hopCount,
        status: result.status,
        ...('route' in result && result.route !== undefined && {
          nextHopNodeId: result.route.nextHopNodeId,
          transportId: result.route.transportId,
          routeDistance: result.route.hopCount + 1,
        }),
        ...('reason' in result && { reason: result.reason }),
      });
      return;
    }

    if (event.kind === 'gateway_advertisement_cycle') {
      const status = event.outcome.ok ? event.outcome.value.status : 'cycle_error';
      if (status !== lastGatewayCycle) {
        lastGatewayCycle = status;
        if (status === 'sent') {
          recordConnectivityFieldTestEvidence({ kind: 'gateway_override_changed', enabled: true });
        }
      }
      return;
    }

    if (event.kind !== 'receive') {
      return;
    }
    const received = event.result;
    if (received.stage === 'gateway_advertisement') {
      recordRoute();
      return;
    }
  };
}
