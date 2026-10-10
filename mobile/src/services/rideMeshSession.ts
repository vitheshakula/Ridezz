import type {
  RideConnectivityClient,
  RideConnectivityRideContext,
} from '../connectivity/rideConnectivityClient';
import type { Transport } from '../transports/Transport';

/**
 * The single owner of the Nearby session lifecycle for a ride screen.
 *
 *   protocol mode (normal):  RideConnectivityClient.start/stop -- the client starts Nearby and the
 *                            Ride Connectivity runtime on it, and stops both.
 *   phase1_only (fallback):  the raw Nearby transport start/stop, used only when the protocol
 *                            cannot initialize (no secure randomness, no monotonic clock, ...).
 *                            Phase 1 hazards and mesh sync keep working; the protocol stays off,
 *                            as with the legacy controller.
 *
 * A session is in exactly one mode at a time and never starts Nearby through both. Every Nearby
 * lifecycle call, from any session in either mode, goes through one serial queue, so a stop issued
 * by an unmounting screen always reaches native before the next screen's start (native
 * startMeshSession restarts the whole session, dropping every connection). Starting a session
 * while another is live supersedes (disposes) the older one first.
 *
 * Observers (HazardCoordinator, meshSyncManager, status and peer-count listeners) are not owned
 * here: they subscribe to the transport's events directly and never start or stop it.
 */

/** Same cadence as the previous RideScreen retry (e.g. Wi-Fi or Bluetooth switched on later). */
export const RIDE_MESH_RETRY_MS = 10_000;

/** Mirrors NearbyMeshModule.startMeshSession's endpoint-name bound (`take(24)`). */
export const RIDE_MESH_MAX_RIDER_NAME_LENGTH = 24;

const FALLBACK_RIDER_NAME = 'Rider';

export type RideMeshSessionMode = 'protocol' | 'phase1_only';

/** The native rejection of a Nearby start, as far as it is known. */
export interface NearbyStartError {
  readonly code?: string;
  readonly message?: string;
}

export interface RideMeshSessionCallbacks {
  readonly rideId: string;
  readonly riderName: string;
  /** Nearby is up. Called at most once per session and never after dispose. */
  onStarted(mode: RideMeshSessionMode): void;
  /** Called once on dispose, before Nearby is stopped. */
  onStopping(): void;
  /** A Nearby start failed; the native message when one is available. Never after dispose. */
  onError(message: string): void;
}

export interface RideMeshSessionOwnerOptions {
  /** The application-wide connectivity client, or null when it could not be created. */
  readonly client: Pick<RideConnectivityClient, 'start' | 'stop'> | null;
  /** Raw Nearby lifecycle, used only in phase1_only mode. */
  readonly fallbackTransport: Pick<Transport<string>, 'start' | 'stop'>;
  /** The native rejection behind the client's last (deliberately sanitized) start failure. */
  getLastStartError(): NearbyStartError | null;
  log?(line: string): void;
  readonly retryMs?: number;
}

export interface RideMeshSessionOwner {
  /** Starts one session and returns its idempotent dispose. */
  start(callbacks: RideMeshSessionCallbacks): () => void;
}

/**
 * The rider name exactly as native advertises it: every '|' becomes a space and the result is cut
 * to 24 UTF-16 units. A name left blank is replaced, since the client requires a non-blank name.
 */
export function sanitizeRideMeshRiderName(riderName: string): string {
  const sanitized = String(riderName ?? '')
    .replace(/\|/g, ' ')
    .slice(0, RIDE_MESH_MAX_RIDER_NAME_LENGTH);
  return sanitized.trim().length > 0 ? sanitized : FALLBACK_RIDER_NAME;
}

/** Only a failed transport start is retried in protocol mode; anything else turns the protocol off. */
function isTransportStartFailure(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'transport_unavailable';
}

function describeFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unexpected error';
}

export function createRideMeshSessionOwner({
  client,
  fallbackTransport,
  getLastStartError,
  log,
  retryMs = RIDE_MESH_RETRY_MS,
}: RideMeshSessionOwnerOptions): RideMeshSessionOwner {
  let tail: Promise<unknown> = Promise.resolve();
  let current: { dispose(): void } | null = null;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const report = (line: string): void => {
    try {
      log?.(line);
    } catch {
      // Diagnostics must never affect the lifecycle.
    }
  };

  return {
    start(callbacks): () => void {
      if (current) {
        report('mesh session superseded by a new session');
        current.dispose();
      }

      const context: RideConnectivityRideContext = Object.freeze({
        rideId: callbacks.rideId,
        riderName: sanitizeRideMeshRiderName(callbacks.riderName),
      });
      let disposed = false;
      let mode: RideMeshSessionMode = client ? 'protocol' : 'phase1_only';
      let fallbackStartIssued = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const notify = (callback: () => void): void => {
        try {
          callback();
        } catch {
          report('mesh session callback failed');
        }
      };

      const startFailed = (error: NearbyStartError | null | undefined): void => {
        notify(() => callbacks.onError(error?.message ?? 'unavailable'));
        // Unsupported hardware won't ever recover.
        if (error?.code !== 'mesh_unsupported') {
          timer = setTimeout(attempt, retryMs);
        }
      };

      const startPhase1Only = (): void => {
        fallbackStartIssued = true;
        enqueue(() =>
          // A session disposed while this start waited in the queue never reaches native.
          disposed
            ? Promise.resolve()
            : fallbackTransport.start({ roomCode: context.rideId, riderName: context.riderName }),
        ).then(
          () => {
            if (!disposed) {
              notify(() => callbacks.onStarted('phase1_only'));
            }
          },
          (error: NearbyStartError | undefined) => {
            if (!disposed) {
              startFailed(error);
            }
          },
        );
      };

      const startProtocol = (activeClient: Pick<RideConnectivityClient, 'start'>): void => {
        // Read the native error inside the queued operation, before any later start can reset it.
        enqueue(() =>
          disposed
            ? Promise.resolve(null)
            : activeClient.start(context).then(
                () => null,
                (error: unknown) => ({ error, startError: getLastStartError() }),
              ),
        ).then(failure => {
          if (disposed) {
            return;
          }
          if (!failure) {
            notify(() => callbacks.onStarted('protocol'));
            return;
          }
          if (isTransportStartFailure(failure.error)) {
            startFailed(failure.startError);
            return;
          }
          // The client has already stopped Nearby itself; continue without the protocol.
          mode = 'phase1_only';
          report(`protocol off: ${describeFailure(failure.error)}; Phase 1 mesh only`);
          startPhase1Only();
        });
      };

      function attempt(): void {
        timer = undefined;
        if (disposed) {
          return;
        }
        if (mode === 'protocol' && client) {
          startProtocol(client);
        } else {
          startPhase1Only();
        }
      }

      const session = {
        dispose(): void {
          if (disposed) {
            return;
          }
          disposed = true;
          clearTimeout(timer);
          if (current === session) {
            current = null;
          }
          notify(() => callbacks.onStopping());
          if (client) {
            // Idempotent; a no-op when the client never started.
            enqueue(() => client.stop()).catch(() => report('mesh session: client stop failed'));
          }
          if (fallbackStartIssued) {
            enqueue(() => fallbackTransport.stop()).catch(() =>
              report('mesh session: Nearby stop failed'),
            );
          }
        },
      };
      current = session;

      if (!client) {
        report('protocol off: connectivity client unavailable; Phase 1 mesh only');
      }
      attempt();
      return session.dispose;
    },
  };
}
