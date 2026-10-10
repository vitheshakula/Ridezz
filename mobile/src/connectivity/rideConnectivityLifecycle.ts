/**
 * Small, React-free helpers that let a screen own the Ride Connectivity runtime safely:
 *
 *   createRideNodeIdentity        one secure node id per ride session, stable across retries
 *   createMonotonicClock          performance.now(), or fail closed (never Date.now)
 *   createRideConnectivityController  at most one running runtime per transport session;
 *                                 safe against retries, late async completion and repeat calls
 *   createConnectivityDiagnostics concise, deduplicated diagnostic lines (no payloads)
 */

import type { RideConnectivityEvent, RideConnectivityRuntime } from './rideConnectivityRuntime';
import type { GatewayForwardingDecision } from './gatewayRouting';

export interface RideNodeIdentity {
  /** Secure RideMessage id source for this ride session. */
  readonly generateMessageId: () => string;
  /** The node id for `rideKey`: generated once per ride, stable across repeated calls. A different
   * ride key gets a new id; nothing is persisted. */
  nodeIdFor(rideKey: string): string;
}

export function createRideNodeIdentity(generateId: () => string): RideNodeIdentity {
  let current: { rideKey: string; nodeId: string } | null = null;
  return {
    generateMessageId: generateId,
    nodeIdFor(rideKey: string): string {
      if (!current || current.rideKey !== rideKey) {
        current = { rideKey, nodeId: generateId() };
      }
      return current.nodeId;
    },
  };
}

/**
 * A monotonic clock from performance.now (React Native's native steady clock). Throws when it is
 * unavailable: protocol freshness must never silently fall back to the wall clock.
 */
export function createMonotonicClock(
  runtime: { performance?: unknown } = globalThis as { performance?: unknown },
): () => number {
  const perf = runtime.performance as { now?: unknown } | undefined;
  if (typeof perf !== 'object' || perf === null || typeof perf.now !== 'function') {
    throw new TypeError('performance.now is unavailable: no monotonic clock for the protocol');
  }
  const now = perf.now as () => number;
  return () => now.call(perf);
}

export interface RideConnectivityController {
  /** Call once the transport session has started. Creates and starts at most one runtime; does
   * nothing after dispose() (e.g. an async start that completes after cleanup). */
  transportStarted(): void;
  /** Stops the runtime, if any, and ignores any later transportStarted(). Idempotent. */
  dispose(): void;
  readonly runtime: RideConnectivityRuntime | null;
}

export function createRideConnectivityController({
  createRuntime,
  onError,
}: {
  createRuntime: () => RideConnectivityRuntime;
  /** Runtime creation/start failures (the protocol stays off; nothing else is affected). */
  onError?: (error: unknown) => void;
}): RideConnectivityController {
  let runtime: RideConnectivityRuntime | null = null;
  let disposed = false;
  return {
    transportStarted(): void {
      if (disposed || runtime) {
        return;
      }
      let created: RideConnectivityRuntime | null = null;
      try {
        created = createRuntime();
        created.start();
        runtime = created;
      } catch (error) {
        try {
          created?.stop();
        } catch {
          // Best effort.
        }
        try {
          onError?.(error);
        } catch {
          // Reporting must not throw into the caller's lifecycle.
        }
      }
    },
    dispose(): void {
      disposed = true;
      runtime?.stop();
      runtime = null;
    },
    get runtime(): RideConnectivityRuntime | null {
      return runtime;
    },
  };
}

const short = (id: string) => id.slice(0, 8);

/**
 * Turns runtime events into a few meaningful diagnostic lines: new peers and links, new gateway
 * observations, gateway route changes, routed sends and arrivals, and failures. Steady-state
 * repeats (refreshes, unchanged cycle outcomes) are not logged. Never logs packet payloads or
 * account identifiers; node ids are random per ride and shown truncated.
 */
export function createConnectivityDiagnostics({
  log,
  getRoute,
}: {
  log: (line: string) => void;
  getRoute: () => GatewayForwardingDecision;
}): (event: RideConnectivityEvent) => void {
  let lastRoute = '';
  let lastHeartbeat = '';
  let lastAdvertisement = '';

  const routeKey = (decision: GatewayForwardingDecision) =>
    decision.ok
      ? `gateway route: ${short(decision.route.gatewayNodeId)} via ` +
        `${short(decision.route.nextHopNodeId)} on ${decision.route.transportId}, ` +
        `distance ${decision.distance}`
      : 'no gateway route';

  const checkRoute = () => {
    const key = routeKey(getRoute());
    if (key !== lastRoute && !(lastRoute === '' && key === 'no gateway route')) {
      log(key);
    }
    lastRoute = key;
  };

  return event => {
    if (event.kind === 'heartbeat_cycle' || event.kind === 'gateway_advertisement_cycle') {
      let summary: string;
      if (!event.outcome.ok) {
        summary = 'cycle error';
      } else if (event.kind === 'heartbeat_cycle') {
        const value = event.outcome.value;
        const failed = value.ok ? value.transmissions.filter(t => !t.ok) : [];
        summary = !value.ok
          ? `heartbeat cycle failed: ${value.reason}`
          : failed.length > 0
            ? `heartbeat send failed: ${failed
                .map(t => (t.stage === 'transport' ? t.reason : t.stage))
                .join(', ')}`
            : 'heartbeats ok';
      } else {
        const status = event.outcome.value.status;
        summary =
          status === 'sent'
            ? 'advertising as cloud gateway'
            : status === 'not_reachable'
              ? 'not a cloud gateway'
              : `gateway advertisement ${status}`;
      }
      const previous = event.kind === 'heartbeat_cycle' ? lastHeartbeat : lastAdvertisement;
      const initialQuiet =
        previous === '' && (summary === 'heartbeats ok' || summary === 'not a cloud gateway');
      if (summary !== previous && !initialQuiet) {
        log(summary);
      }
      if (event.kind === 'heartbeat_cycle') {
        lastHeartbeat = summary;
      } else {
        lastAdvertisement = summary;
      }
      return;
    }

    const { result } = event;
    switch (result.stage) {
      case 'heartbeat': {
        const r = result.result;
        if (!r.observed) {
          log(`heartbeat not used: ${r.reason}`);
          return;
        }
        if (r.change !== 'refreshed') {
          log(`peer ${short(r.nodeId)} on ${r.transportId} (${r.change})`);
        }
        const link = r.link;
        if (link && link.observed && link.change === 'reassigned') {
          log(`link reassigned ${short(link.previousNodeId)} -> ${short(r.nodeId)}`);
        } else if (link && link.observed && link.change === 'new_link') {
          log(`link learned -> ${short(r.nodeId)}`);
        } else if (link && !link.observed) {
          log(`link not learned: ${link.reason}`);
        }
        return;
      }
      case 'gateway_advertisement': {
        const r = result.result;
        if (r.observed && r.change !== 'refreshed') {
          const via = r.via?.resolved ? short(r.via.nodeId) : 'unknown sender';
          log(`gateway ${short(r.gatewayNodeId)} seen via ${via}, hop ${r.hopCount}`);
        } else if (!r.observed) {
          log(`gateway advertisement not recorded: ${r.reason}`);
        }
        if (result.relay.status === 'relay_error' || result.relay.status === 'relay_timeout') {
          log(`advertisement relay ${result.relay.status}`);
        } else if (result.relay.status === 'relayed' && r.observed && r.change !== 'refreshed') {
          log(`advertisement relayed (hop ${result.relay.message.hopCount})`);
        }
        checkRoute();
        return;
      }
      case 'routed': {
        const r = result.result;
        // hop = the envelope's hopCount, i.e. relays passed: 0 = straight from the origin. On a
        // forwarded copy it already includes this relay.
        if (r.status === 'gateway_reached') {
          log(`gateway reached for message ${short(r.message.id)} (hop ${r.message.hopCount})`);
        } else if (r.status === 'sent') {
          log(
            `routed ${short(r.message.id)} -> ${short(r.route.nextHopNodeId)} ` +
              `(hop ${r.message.hopCount})`,
          );
        } else if (r.status === 'not_sent') {
          log(`routed message not forwarded: ${r.reason}`);
        } else {
          log(`routed send ${r.status} to ${short(r.route.nextHopNodeId)}`);
        }
        return;
      }
      case 'ack': {
        const r = result.result;
        if (r.status === 'origin_reached') {
          log(`ack reached origin ${short(r.acknowledgement.id)}`);
        } else if (r.status === 'forwarded') {
          log(`ack forwarded ${short(r.acknowledgement.id)}`);
        } else if (r.status === 'not_forwarded') {
          log(`ack not forwarded: ${r.reason}`);
        } else {
          log(`ack return ${r.status}`);
        }
        return;
      }
      default:
        return;
    }
  };
}
