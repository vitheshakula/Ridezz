import type {
  RideConnectivityClient,
  RideConnectivityRideContext,
} from '../connectivity/rideConnectivityClient';
import type { Transport } from '../transports/Transport';

export const RIDE_MESH_RETRY_MS = 10_000;

export const RIDE_MESH_MAX_RIDER_NAME_LENGTH = 24;

const FALLBACK_RIDER_NAME = 'Rider';

export type RideMeshSessionMode = 'protocol' | 'phase1_only';

export interface NearbyStartError {
  readonly code?: string;
  readonly message?: string;
}

export interface RideMeshSessionCallbacks {
  readonly rideId: string;
  readonly riderName: string;
  onStarted(mode: RideMeshSessionMode): void;
  onStopping(): void;
  onError(message: string): void;
}

export interface RideMeshSessionOwnerOptions {
  readonly client: Pick<RideConnectivityClient, 'start' | 'stop'> | null;
  readonly fallbackTransport: Pick<Transport<string>, 'start' | 'stop'>;
  getLastStartError(): NearbyStartError | null;
  log?(line: string): void;
  readonly retryMs?: number;
}

export interface RideMeshSessionOwner {
  start(callbacks: RideMeshSessionCallbacks): () => void;
}

export function sanitizeRideMeshRiderName(riderName: string): string {
  const sanitized = String(riderName ?? '')
    .replace(/\|/g, ' ')
    .slice(0, RIDE_MESH_MAX_RIDER_NAME_LENGTH);
  return sanitized.trim().length > 0 ? sanitized : FALLBACK_RIDER_NAME;
}

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
    } catch {}
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
        if (error?.code !== 'mesh_unsupported') {
          timer = setTimeout(attempt, retryMs);
        }
      };

      const startPhase1Only = (): void => {
        fallbackStartIssued = true;
        enqueue(() =>
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
