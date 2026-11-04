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
import { createPersistentOutbox } from '../connectivity/persistentOutbox';
import { createSecureOutboxStore } from '../connectivity/secureOutboxStore';
import {
  isDevMenuGatewayForced,
  isRideCloudReachable,
  setDevMenuGatewayForced,
} from '../connectivity/debugGatewayOverride';
import { NEARBY_TRANSPORT_ID, nearbyTransport } from '../transports/NearbyTransport';
import { logDiagnosticEvent } from './diagnosticsLog';
import {
  createRideMeshSessionOwner,
  type NearbyStartError,
  type RideMeshSessionCallbacks,
  type RideMeshSessionOwner,
} from './rideMeshSession';
import { createLogger } from '../utils/logger';

const log = createLogger('RideConnectivity');

const RIDE_CONNECTIVITY_DIAGNOSTICS = true;

export function logRideConnectivity(line: string): void {
  if (!RIDE_CONNECTIVITY_DIAGNOSTICS) {
    return;
  }
  logDiagnosticEvent('mesh_protocol', line);
  log.debug(line);
}

export function createAppRideNodeIdentity(): RideNodeIdentity {
  return createRideNodeIdentity(createRuntimeRideMessageIdGenerator());
}

let lastNearbyStartError: NearbyStartError | null = null;

function describeNearbyStartError(error: unknown): NearbyStartError {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return Object.freeze({
    ...(typeof code === 'string' && { code }),
    ...(typeof message === 'string' && { message }),
  });
}

const clientNearbyTransport: typeof nearbyTransport = {
  ...nearbyTransport,
  start(session) {
    lastNearbyStartError = null;
    return nearbyTransport.start(session).catch((error: unknown) => {
      lastNearbyStartError = describeNearbyStartError(error);
      throw error;
    });
  },
};

function createAppRideConnectivityClient(): RideConnectivityClient {
  const outbox = createPersistentOutbox({ store: createSecureOutboxStore() });
  return createRideConnectivityClient({
    transportId: NEARBY_TRANSPORT_ID,
    transport: clientNearbyTransport,
    createNodeIdentity: createAppRideNodeIdentity,
    outbox,
    onDiagnostic: event => logRideConnectivity(JSON.stringify(event)),
    createRuntime: ({ rideContext, localNodeId, generateMessageId, onApplicationMessage }) => {
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
          getRoute: () => (runtime ? runtime.getGatewayRoute() : { ok: false, reason: 'no_route' }),
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

let appClient: RideConnectivityClient | undefined;

export function getAppRideConnectivityClient(): RideConnectivityClient {
  appClient ??= createAppRideConnectivityClient();
  return appClient;
}

let appMeshSessionOwner: RideMeshSessionOwner | undefined;

function appClientOrNull(): RideConnectivityClient | null {
  try {
    return getAppRideConnectivityClient();
  } catch (error) {
    logRideConnectivity(
      `connectivity client unavailable: ${
        error instanceof Error ? error.message : 'unexpected error'
      }`,
    );
    return null;
  }
}

export function startAppRideMeshSession(callbacks: RideMeshSessionCallbacks): () => void {
  appMeshSessionOwner ??= createRideMeshSessionOwner({
    client: appClientOrNull(),
    fallbackTransport: nearbyTransport,
    getLastStartError: () => lastNearbyStartError,
    log: logRideConnectivity,
  });
  return appMeshSessionOwner.start(callbacks);
}

export function createNearbyRideConnectivity({
  roomCode,
  getNodeIdentity,
}: {
  roomCode: string;
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
          getRoute: () => (runtime ? runtime.getGatewayRoute() : { ok: false, reason: 'no_route' }),
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
