/**
 * M7-A developer-only connectivity test probe. One explicit action submits ONE low-priority
 * `ride_state` message through the application's existing RideConnectivityClient.sendMessage(), so
 * a physical test exercises the real pipeline: validation, encrypted outbox, gateway routing,
 * targeted Nearby sends, relays, dedup, retries and expiry. It never creates or starts a transport,
 * never touches hazards, crash, braking, mesh sync or LiveKit, and never claims delivery: only a
 * verified ACK (none exist yet) can produce `destination_delivered`.
 *
 * Gating: the probe runs only when ENABLE_CONNECTIVITY_TEST_PROBE is true AND the build is a
 * development build (__DEV__). A release APK can never run it, even with the flag accidentally on.
 * Local enabling procedure: docs/architecture/connectivity-test-probe-m7.md.
 */

import type {
  RideConnectivityClient,
  RideConnectivityDeliveryStatus,
  RideConnectivityIncomingMessage,
} from './rideConnectivityClient';

/** MUST stay false in committed code (a unit test enforces it). Flip only in a local working copy. */
export const ENABLE_CONNECTIVITY_TEST_PROBE = false;

export const PROBE_MESSAGE_TYPE = 'ride_state' as const;
export const PROBE_PRIORITY = 'low' as const;
export const PROBE_TTL_MS = 60_000;
export const PROBE_MAX_HOPS = 4;
export const PROBE_MIN_INTERVAL_MS = 5_000;
export const PROBE_MAX_PER_SESSION = 10;
/** Marks a ride_state payload as a probe. Carries no rider, location or account data. */
export const PROBE_PAYLOAD_MARKER = 'rideaze-connectivity-probe-v1';

/** Bound on delivery statuses held while a submission's message id is not yet known. */
const MAX_BUFFERED_STATUSES = 32;

export type ConnectivityTestProbeResult =
  | { readonly status: 'probe_disabled' }
  | { readonly status: 'session_inactive' }
  | { readonly status: 'rate_limited'; readonly retryAfterMs: number }
  | { readonly status: 'session_limit_reached' }
  | { readonly status: 'submitted'; readonly seq: number; readonly messageId: string }
  | { readonly status: 'submission_failed'; readonly seq: number; readonly reason: string };

export interface ConnectivityTestProbePayload {
  readonly probe: typeof PROBE_PAYLOAD_MARKER;
  readonly seq: number;
}

export interface ConnectivityTestProbe {
  /** True only for an enabled flag in a development build. */
  readonly available: boolean;
  /** The ride's protocol session is up (RideMeshSession reached 'protocol' mode). */
  sessionStarted(rideId: string): void;
  /** The ride session is ending: drops subscriptions, tracked ids and counters. Idempotent. */
  sessionEnded(): void;
  /** One call submits at most one message. Never throws. */
  send(): Promise<ConnectivityTestProbeResult>;
}

export interface ConnectivityTestProbeOptions {
  readonly client: Pick<RideConnectivityClient, 'sendMessage' | 'onDeliveryStatus' | 'onMessage'>;
  readonly enabled: boolean;
  readonly isDevelopmentBuild: boolean;
  /** Local time for rate limiting only; message ids and timestamps come from the client. */
  readonly clock?: () => number;
  /** Whether this node currently acts as a (test) cloud gateway; used to label receipts. */
  readonly isCloudReachable?: () => boolean;
  readonly log: (line: string) => void;
}

export function isConnectivityTestProbeAvailable(
  enabled: boolean,
  isDevelopmentBuild: boolean,
): boolean {
  return enabled === true && isDevelopmentBuild === true;
}

export function isConnectivityTestProbePayload(
  value: unknown,
): value is ConnectivityTestProbePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).length === 2 &&
    payload.probe === PROBE_PAYLOAD_MARKER &&
    Number.isSafeInteger(payload.seq) &&
    (payload.seq as number) >= 1 &&
    (payload.seq as number) <= PROBE_MAX_PER_SESSION
  );
}

const short = (id: string) => id.slice(0, 8);

/** Human-readable, sanitized line for one delivery status of a tracked probe. */
export function describeProbeDeliveryStatus(status: RideConnectivityDeliveryStatus): string | null {
  const head = `probe ${short(status.messageId)} |`;
  switch (status.state) {
    case 'queued':
      return `${head} queued`;
    case 'sending':
      // Every attempt emits this; the attempt's outcome line carries the information.
      return null;
    case 'transport_accepted':
      return `${head} transport_accepted (one hop accepted; not delivery)`;
    case 'retry_scheduled': {
      const inSeconds = Math.max(0, Math.round((status.nextAttemptAt - status.at) / 1000));
      return `${head} retry_scheduled in ${inSeconds}s | last=${status.lastAttempt ?? 'unknown'}`;
    }
    case 'destination_delivered':
      return `${head} destination_delivered (verified ACK ${short(status.acknowledgementMessageId)})`;
    case 'failed':
      return status.reason === 'retry_exhausted'
        ? `${head} retry_exhausted | delivery_unconfirmed | last=${status.lastAttempt ?? 'unknown'}`
        : `${head} failed | ${status.reason} | outcome=${status.outcome}`;
    case 'expired':
      return `${head} expired | delivery_unconfirmed`;
  }
}

export function createConnectivityTestProbe({
  client,
  enabled,
  isDevelopmentBuild,
  clock = () => Date.now(),
  isCloudReachable = () => false,
  log,
}: ConnectivityTestProbeOptions): ConnectivityTestProbe {
  const available = isConnectivityTestProbeAvailable(enabled, isDevelopmentBuild);

  let session: {
    readonly rideId: string;
    readonly tracked: Set<string>;
    readonly unsubscribe: readonly (() => void)[];
    /** Statuses seen while a submission is in flight, before its id is known. */
    pendingStatuses: RideConnectivityDeliveryStatus[] | null;
    submitted: number;
    lastSubmittedAt: number | null;
  } | null = null;

  const safeLog = (line: string): void => {
    try {
      log(line);
    } catch {
      // Diagnostics must never affect the probe or the protocol.
    }
  };

  const report = (status: RideConnectivityDeliveryStatus): void => {
    const line = describeProbeDeliveryStatus(status);
    if (line) {
      safeLog(line);
    }
  };

  const receiptLabel = (): string => {
    try {
      return isCloudReachable() ? 'gateway_received' : 'received_unrouted';
    } catch {
      return 'received_unrouted';
    }
  };

  const endSession = (): void => {
    const ending = session;
    session = null;
    if (!ending) {
      return;
    }
    for (const unsubscribe of ending.unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // Best effort.
      }
    }
  };

  return {
    available,

    sessionStarted(rideId): void {
      if (!available) {
        return;
      }
      if (session?.rideId === rideId) {
        return;
      }
      endSession();
      const current = {
        rideId,
        tracked: new Set<string>(),
        unsubscribe: [] as (() => void)[],
        pendingStatuses: null as RideConnectivityDeliveryStatus[] | null,
        submitted: 0,
        lastSubmittedAt: null as number | null,
      };
      session = current;
      current.unsubscribe.push(
        client.onDeliveryStatus(status => {
          if (session !== current) {
            return;
          }
          if (current.tracked.has(status.messageId)) {
            report(status);
          } else if (
            current.pendingStatuses &&
            current.pendingStatuses.length < MAX_BUFFERED_STATUSES
          ) {
            current.pendingStatuses.push(status);
          }
        }),
        client.onMessage((message: RideConnectivityIncomingMessage) => {
          if (
            session !== current ||
            message.type !== PROBE_MESSAGE_TYPE ||
            !isConnectivityTestProbePayload(message.payload)
          ) {
            return;
          }
          safeLog(
            `probe ${short(message.id)} | ${receiptLabel()} | from ${short(message.originId)} ` +
              `seq=${message.payload.seq}`,
          );
        }),
      );
      safeLog('test probe armed for this ride (debug build)');
    },

    sessionEnded(): void {
      endSession();
    },

    async send(): Promise<ConnectivityTestProbeResult> {
      if (!available) {
        return { status: 'probe_disabled' };
      }
      const current = session;
      if (!current) {
        safeLog('probe not sent: no active protocol session');
        return { status: 'session_inactive' };
      }
      if (current.submitted >= PROBE_MAX_PER_SESSION) {
        safeLog(`probe not sent: session limit (${PROBE_MAX_PER_SESSION}) reached`);
        return { status: 'session_limit_reached' };
      }
      const now = clock();
      if (
        current.pendingStatuses !== null ||
        (current.lastSubmittedAt !== null && now - current.lastSubmittedAt < PROBE_MIN_INTERVAL_MS)
      ) {
        const retryAfterMs =
          current.lastSubmittedAt === null
            ? PROBE_MIN_INTERVAL_MS
            : Math.max(0, PROBE_MIN_INTERVAL_MS - (now - current.lastSubmittedAt));
        safeLog('probe not sent: rate limited (1 per 5 s)');
        return { status: 'rate_limited', retryAfterMs };
      }

      current.submitted += 1;
      current.lastSubmittedAt = now;
      const seq = current.submitted;
      current.pendingStatuses = [];
      try {
        const { messageId } = await client.sendMessage({
          rideId: current.rideId,
          type: PROBE_MESSAGE_TYPE,
          priority: PROBE_PRIORITY,
          payload: { probe: PROBE_PAYLOAD_MARKER, seq },
          ttlMs: PROBE_TTL_MS,
          maxHops: PROBE_MAX_HOPS,
          destination: { kind: 'gateway' },
        });
        const buffered = current.pendingStatuses ?? [];
        current.pendingStatuses = null;
        if (session !== current) {
          return { status: 'submission_failed', seq, reason: 'session_ended' };
        }
        current.tracked.add(messageId);
        safeLog(`probe #${seq} submitted | id=${short(messageId)}`);
        for (const status of buffered) {
          if (status.messageId === messageId) {
            report(status);
          }
        }
        return { status: 'submitted', seq, messageId };
      } catch (error) {
        const buffered = current.pendingStatuses ?? [];
        current.pendingStatuses = null;
        const code = (error as { code?: unknown } | null)?.code;
        const reason = typeof code === 'string' ? code : 'unexpected_error';
        safeLog(`probe #${seq} submission_failed | ${reason}`);
        // A message created but not queued (e.g. outbox full) still reports queued/failed for its
        // own id. Client operations are serialized and only the probe submits messages, so the
        // buffer holds this submission's statuses alone.
        for (const status of buffered) {
          if (session === current && (status.state === 'queued' || status.state === 'failed')) {
            report(status);
          }
        }
        return { status: 'submission_failed', seq, reason };
      }
    },
  };
}
