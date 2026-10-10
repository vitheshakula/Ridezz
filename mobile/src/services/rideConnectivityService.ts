import { DevSettings } from 'react-native';
import { createRuntimeRideMessageIdGenerator } from '../connectivity/rideMessageIdRuntime';
import {
  createConnectivityDiagnostics,
  createMonotonicClock,
  createRideConnectivityController,
  createRideNodeIdentity,
  type RideConnectivityController,
  type RideNodeIdentity,
} from '../connectivity/rideConnectivityLifecycle';
import {
  createRideConnectivityRuntime,
  type RideConnectivityRuntime,
} from '../connectivity/rideConnectivityRuntime';
import {
  createRideConnectivityClient,
  type RideConnectivityClient,
} from '../connectivity/rideConnectivityClient';
import {
  isDevMenuGatewayForced,
  isRideCloudReachable,
  setDevMenuGatewayForced,
} from '../connectivity/debugGatewayOverride';
import { NEARBY_TRANSPORT_ID, nearbyTransport } from '../transports/NearbyTransport';
import { logDiagnosticEvent } from './diagnosticsLog';

/**
 * App-side composition of the Ride Connectivity Protocol (Phase 2) on Nearby. Additive: Phase 1
 * hazards keep using their own Nearby paths untouched. The screen keeps owning
 * nearbyTransport.start/stop; this only creates the runtime that rides on that session.
 */

/** Diagnostics are for device testing; set false to silence them. */
const RIDE_CONNECTIVITY_DIAGNOSTICS = true;

export function logRideConnectivity(line: string): void {
  if (!RIDE_CONNECTIVITY_DIAGNOSTICS) {
    return;
  }
  logDiagnosticEvent('mesh_protocol', line);
  if (__DEV__) {
    console.log(`[RideConnectivity] ${line}`);
  }
}

/** One secure identity per ride session. Throws if secure randomness is unavailable. */
export function createAppRideNodeIdentity(): RideNodeIdentity {
  return createRideNodeIdentity(createRuntimeRideMessageIdGenerator());
}

/**
 * Public application-facing connectivity client. This client owns the Nearby session lifecycle;
 * only one owner may use the concrete Nearby transport at a time. RideScreen continues using the
 * legacy composition below until its application-service integration is migrated separately.
 */
export function createAppRideConnectivityClient(): RideConnectivityClient {
  return createRideConnectivityClient({
    transportId: NEARBY_TRANSPORT_ID,
    transport: nearbyTransport,
    createNodeIdentity: createAppRideNodeIdentity,
    createRuntime: ({
      rideContext,
      localNodeId,
      generateMessageId,
      onApplicationMessage,
    }) => {
      let runtime: RideConnectivityRuntime | undefined;
      runtime = createRideConnectivityRuntime({
        rideId: rideContext.rideId,
        localNodeId,
        transportId: NEARBY_TRANSPORT_ID,
        transport: nearbyTransport,
        generateMessageId,
        wallClock: () => Date.now(),
        monotonicClock: createMonotonicClock(),
        isCloudReachable: isRideCloudReachable,
        onApplicationMessage,
        onEvent: createConnectivityDiagnostics({
          log: logRideConnectivity,
          getRoute: () =>
            runtime ? runtime.getGatewayRoute() : { ok: false, reason: 'no_route' },
        }),
      });
      logRideConnectivity(
        `public client runtime created as node ${localNodeId.slice(0, 8)}` +
          (isRideCloudReachable() ? ' (TEST cloud gateway)' : ''),
      );
      return runtime;
    },
  });
}

/**
 * A controller for one Nearby session of one ride. Call transportStarted() after
 * nearbyTransport.start() resolves and dispose() before nearbyTransport.stop(). Any failure to
 * create the runtime (no secure randomness, no monotonic clock) leaves the protocol off and is
 * logged; Phase 1 is unaffected.
 */
export function createNearbyRideConnectivity({
  roomCode,
  getNodeIdentity,
}: {
  roomCode: string;
  /** The ride session's identity (created once per mounted ride, reused across Nearby retries). */
  getNodeIdentity: () => RideNodeIdentity;
}): RideConnectivityController {
  return createRideConnectivityController({
    createRuntime: () => {
      const identity = getNodeIdentity();
      let runtime: RideConnectivityRuntime | undefined;
      runtime = createRideConnectivityRuntime({
        rideId: roomCode,
        localNodeId: identity.nodeIdFor(roomCode),
        transportId: NEARBY_TRANSPORT_ID,
        transport: nearbyTransport,
        generateMessageId: identity.generateMessageId,
        wallClock: () => Date.now(),
        monotonicClock: createMonotonicClock(),
        isCloudReachable: isRideCloudReachable,
        onEvent: createConnectivityDiagnostics({
          log: logRideConnectivity,
          getRoute: () =>
            runtime ? runtime.getGatewayRoute() : { ok: false, reason: 'no_route' },
        }),
      });
      logRideConnectivity(
        `protocol started as node ${identity.nodeIdFor(roomCode).slice(0, 8)}` +
          (isRideCloudReachable() ? ' (TEST cloud gateway)' : ''),
      );
      return runtime;
    },
    onError: error =>
      logRideConnectivity(
        `protocol off: ${error instanceof Error ? error.message : 'unexpected error'}`,
      ),
  });
}

let devMenuRegistered = false;

/** Debug builds only: adds a dev-menu item that makes THIS phone a test cloud gateway. */
export function registerRideConnectivityDevMenu(): void {
  if (!__DEV__ || devMenuRegistered) {
    return;
  }
  devMenuRegistered = true;
  DevSettings.addMenuItem('Rideaze: toggle test cloud gateway', () => {
    setDevMenuGatewayForced(!isDevMenuGatewayForced());
    logRideConnectivity(
      isDevMenuGatewayForced()
        ? 'TEST: this phone now advertises as cloud gateway'
        : 'TEST: cloud gateway override off',
    );
  });
}
