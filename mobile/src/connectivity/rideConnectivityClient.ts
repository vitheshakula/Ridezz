import type { ConnectivityApplicationMessage } from './connectivityReceiver';
import { type RideNodeIdentity } from './rideConnectivityLifecycle';
import type {
  RideConnectivityRuntime,
  RideConnectivitySendResult,
} from './rideConnectivityRuntime';
import { isJsonValue, type JsonValue } from './protocol/jsonValue';
import {
  RIDE_MESSAGE_MAX_GATEWAY_DISTANCE,
  RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
  RIDE_MESSAGE_MAX_RIDE_ID_LENGTH,
  createRideMessage,
  isGatewayRoutableMessageType,
  isRideMessagePriority,
  isRideMessageType,
  isValidRideMessageIdentifier,
  isValidRideMessageMaxHops,
  isValidRideMessageTimestamp,
  isValidRideMessageTtl,
  withGatewayRouting,
  type RideMessage,
  type RideMessagePriority,
  type RideMessageType,
} from './protocol/rideMessage';
import { serializeRideMessage } from './protocol/rideMessageCodec';
import type { TargetedTransport, Transport } from '../transports/Transport';

/** Matches the name bound used by the current Android Nearby endpoint name. */
export const RIDE_CONNECTIVITY_MAX_RIDER_NAME_LENGTH = 24;

/** Authentication is an application-layer precondition. Deliberately contains no token. */
export interface RideConnectivityRideContext {
  readonly rideId: string;
  readonly riderName: string;
}

/** M1 routes application messages toward one discovered cloud gateway. */
export interface RideConnectivityDestination {
  readonly kind: 'gateway';
  /** Omit to use the best currently known gateway. This is an unauthenticated protocol node id. */
  readonly gatewayNodeId?: string;
}

export interface RideConnectivityMessageInput {
  /** Must match the active ride, preventing a stale service from sending into a new session. */
  readonly rideId: string;
  /** Heartbeats and gateway advertisements are runtime-owned and are rejected here. */
  readonly type: RideMessageType;
  readonly priority: RideMessagePriority;
  readonly payload: JsonValue;
  readonly ttlMs: number;
  readonly maxHops: number;
  readonly destination?: RideConnectivityDestination;
}

/** Public application view of a received RideMessage. Routing metadata is intentionally omitted.
 * `originId` is an unauthenticated per-ride protocol node id, never a verified rider identity. */
export type RideConnectivityIncomingMessage = Readonly<
  Pick<
    RideMessage<JsonValue>,
    'id' | 'rideId' | 'originId' | 'type' | 'priority' | 'createdAt' | 'expiresAt' | 'payload'
  >
>;

export interface RideConnectivityMessageSubmission {
  /** A valid locally generated protocol id. This confirms submission, not delivery. */
  readonly messageId: string;
}

interface RideConnectivityDeliveryBase {
  readonly messageId: string;
  readonly at: number;
}

export type RideConnectivityDeliveryStatus =
  | (RideConnectivityDeliveryBase & { readonly state: 'queued' })
  | (RideConnectivityDeliveryBase & { readonly state: 'sending' })
  | (RideConnectivityDeliveryBase & {
      /** The send operation resolved. This is not destination delivery. */
      readonly state: 'transport_accepted';
      readonly transportId: string;
    })
  | (RideConnectivityDeliveryBase & {
      /** Reserved for a future verified ACK correlator; M1 never emits this state. */
      readonly state: 'destination_delivered';
      readonly acknowledgementMessageId: string;
    })
  | (RideConnectivityDeliveryBase & {
      readonly state: 'failed';
      readonly reason:
        | 'routing_unavailable'
        | 'transport_unavailable'
        | 'send_timeout'
        | 'runtime_unavailable'
        | 'local_gateway_handoff_unavailable'
        | 'encoding_failed';
      /** `unknown` means the operation timed out or threw after its actual outcome became unclear. */
      readonly outcome: 'not_sent' | 'unknown';
    })
  | (RideConnectivityDeliveryBase & {
      /** The message TTL elapsed without valid destination acknowledgement evidence. */
      readonly state: 'expired';
      readonly expiresAt: number;
    });

/** Transport state only. A direct peer count is not a count of authenticated Rideaze users. */
export interface RideConnectivityPeerStatus {
  readonly transportId: string;
  readonly state: 'inactive' | 'starting' | 'active' | 'unavailable' | 'error';
  readonly transportAvailable: boolean | null;
  readonly directPeerCount: number;
}

export type RideConnectivityErrorCode =
  | 'initialization_error'
  | 'invalid_message_input'
  | 'transport_unavailable'
  | 'send_timeout'
  | 'runtime_error'
  | 'lifecycle_error';

/** Sanitized structured error. It never contains payloads, tokens, endpoint ids, or raw errors. */
export interface RideConnectivityErrorEvent {
  readonly code: RideConnectivityErrorCode;
  readonly operation: 'start' | 'stop' | 'send' | 'receive' | 'listener';
  readonly reason: string;
  readonly recoverable: boolean;
  readonly messageId?: string;
}

export type RideConnectivityMessageListener = (
  message: RideConnectivityIncomingMessage,
) => void;
export type RideConnectivityPeerStatusListener = (status: RideConnectivityPeerStatus) => void;
export type RideConnectivityDeliveryStatusListener = (
  status: RideConnectivityDeliveryStatus,
) => void;
export type RideConnectivityErrorListener = (error: RideConnectivityErrorEvent) => void;

export interface RideConnectivityClient {
  /** Starts one ride. Same-ride calls are idempotent; a different active ride is rejected. */
  start(rideContext: RideConnectivityRideContext): Promise<void>;
  /** Stops the current generation and its internal subscriptions. Idempotent. */
  stop(): Promise<void>;
  /** Validates and submits one gateway-routed message. The result is not a delivery receipt. */
  sendMessage(input: RideConnectivityMessageInput): Promise<RideConnectivityMessageSubmission>;
  onMessage(listener: RideConnectivityMessageListener): () => void;
  onPeerStatus(listener: RideConnectivityPeerStatusListener): () => void;
  onDeliveryStatus(listener: RideConnectivityDeliveryStatusListener): () => void;
  onError(listener: RideConnectivityErrorListener): () => void;
}

/** Dependency seam used by the app composition root and deterministic tests. */
export interface RideConnectivityClientAdapter {
  readonly transportId: string;
  readonly transport: Transport<string> & TargetedTransport<string>;
  createNodeIdentity(): RideNodeIdentity;
  createRuntime(options: {
    readonly rideContext: RideConnectivityRideContext;
    readonly localNodeId: string;
    readonly generateMessageId: () => string;
    readonly onApplicationMessage: (received: ConnectivityApplicationMessage) => void;
  }): RideConnectivityRuntime;
  /** Protocol wall clock. */
  readonly clock?: () => number;
}

export class RideConnectivityClientError extends Error {
  readonly code: RideConnectivityErrorCode;

  constructor(code: RideConnectivityErrorCode, message: string) {
    super(message);
    this.name = 'RideConnectivityClientError';
    this.code = code;
  }
}

interface ActiveGeneration {
  readonly context: RideConnectivityRideContext;
  readonly identity: RideNodeIdentity;
  readonly localNodeId: string;
  readonly runtime: RideConnectivityRuntime;
  readonly unsubscribeTransport: readonly (() => void)[];
  /** Guards a receive already in flight while this generation is being stopped. */
  readonly receiveGate: { open: boolean };
}

function validRideContext(value: unknown): value is RideConnectivityRideContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const context = value as Record<string, unknown>;
  return (
    isValidRideMessageIdentifier(context.rideId, RIDE_MESSAGE_MAX_RIDE_ID_LENGTH) &&
    typeof context.riderName === 'string' &&
    context.riderName.trim().length > 0 &&
    context.riderName.length <= RIDE_CONNECTIVITY_MAX_RIDER_NAME_LENGTH &&
    !context.riderName.includes('|')
  );
}

function validDestination(value: unknown): value is RideConnectivityDestination | undefined {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const destination = value as Record<string, unknown>;
  return (
    destination.kind === 'gateway' &&
    (destination.gatewayNodeId === undefined ||
      isValidRideMessageIdentifier(
        destination.gatewayNodeId,
        RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH,
      ))
  );
}

function applicationMessageFrom(
  received: ConnectivityApplicationMessage,
): RideConnectivityIncomingMessage {
  const { message } = received;
  return Object.freeze({
    id: message.id,
    rideId: message.rideId,
    originId: message.originId,
    type: message.type,
    priority: message.priority,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
    payload: message.payload,
  });
}

const TERMINAL_DELIVERY_STATES: ReadonlySet<RideConnectivityDeliveryStatus['state']> = new Set([
  'destination_delivered',
  'failed',
  'expired',
]);

/** Creates one lifecycle owner. Only one instance should own a concrete transport at a time. */
export function createRideConnectivityClient({
  transportId,
  transport,
  createNodeIdentity,
  createRuntime,
  clock = () => Date.now(),
}: RideConnectivityClientAdapter): RideConnectivityClient {
  if (!isValidRideMessageIdentifier(transportId, 64)) {
    throw new TypeError('RideConnectivityClient transportId must be a valid identifier');
  }

  const messageListeners = new Set<RideConnectivityMessageListener>();
  const peerListeners = new Set<RideConnectivityPeerStatusListener>();
  const deliveryListeners = new Set<RideConnectivityDeliveryStatusListener>();
  const errorListeners = new Set<RideConnectivityErrorListener>();
  const deliveryStates = new Map<string, RideConnectivityDeliveryStatus['state']>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let active: ActiveGeneration | null = null;
  let operationTail: Promise<void> = Promise.resolve();
  let peerStatus: RideConnectivityPeerStatus = Object.freeze({
    transportId,
    state: 'inactive',
    transportAvailable: null,
    directPeerCount: 0,
  });

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const emitError = (event: RideConnectivityErrorEvent): void => {
    const safeEvent = Object.freeze({ ...event });
    for (const listener of [...errorListeners]) {
      try {
        listener(safeEvent);
      } catch {
        // Error listeners are the final reporting boundary and cannot recursively report failure.
      }
    }
  };

  const notify = <T>(
    listeners: ReadonlySet<(event: T) => void>,
    event: T,
    channel: 'message' | 'peer_status' | 'delivery_status',
  ): void => {
    let listenerFailed = false;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        listenerFailed = true;
      }
    }
    if (listenerFailed) {
      emitError({
        code: 'runtime_error',
        operation: 'listener',
        reason: `${channel}_listener_failed`,
        recoverable: true,
      });
    }
  };

  const updatePeerStatus = (
    next: Omit<RideConnectivityPeerStatus, 'transportId'>,
  ): void => {
    const normalized: RideConnectivityPeerStatus = Object.freeze({ transportId, ...next });
    if (
      normalized.state === peerStatus.state &&
      normalized.transportAvailable === peerStatus.transportAvailable &&
      normalized.directPeerCount === peerStatus.directPeerCount
    ) {
      return;
    }
    peerStatus = normalized;
    notify(peerListeners, peerStatus, 'peer_status');
  };

  const emitDelivery = (status: RideConnectivityDeliveryStatus): void => {
    const previous = deliveryStates.get(status.messageId);
    if (previous && TERMINAL_DELIVERY_STATES.has(previous)) {
      return;
    }
    deliveryStates.set(status.messageId, status.state);
    if (TERMINAL_DELIVERY_STATES.has(status.state)) {
      const timer = expiryTimers.get(status.messageId);
      if (timer !== undefined) {
        clearTimeout(timer);
        expiryTimers.delete(status.messageId);
      }
    }
    notify(deliveryListeners, Object.freeze({ ...status }), 'delivery_status');
  };

  const clearDeliveryTracking = (): void => {
    for (const timer of expiryTimers.values()) {
      clearTimeout(timer);
    }
    expiryTimers.clear();
    deliveryStates.clear();
  };

  const scheduleExpiry = (message: RideMessage<JsonValue>): void => {
    const expire = () => {
      const remaining = message.expiresAt - clock();
      if (remaining > 0) {
        expiryTimers.set(message.id, setTimeout(expire, remaining));
        return;
      }
      expiryTimers.delete(message.id);
      emitDelivery({
        state: 'expired',
        messageId: message.id,
        at: clock(),
        expiresAt: message.expiresAt,
      });
    };
    const delay = message.expiresAt - clock();
    if (delay <= 0) {
      expire();
      return;
    }
    expiryTimers.set(message.id, setTimeout(expire, delay));
  };

  const failLifecycle = (
    code: RideConnectivityErrorCode,
    operation: RideConnectivityErrorEvent['operation'],
    reason: string,
    message: string,
  ): never => {
    emitError({ code, operation, reason, recoverable: true });
    throw new RideConnectivityClientError(code, message);
  };

  const doStart = async (rawContext: RideConnectivityRideContext): Promise<void> => {
    if (!validRideContext(rawContext)) {
      failLifecycle(
        'lifecycle_error',
        'start',
        'invalid_ride_context',
        'Ride connectivity requires a valid ride context',
      );
    }
    const context = Object.freeze({ rideId: rawContext.rideId, riderName: rawContext.riderName });
    if (active) {
      if (active.context.rideId === context.rideId) {
        return;
      }
      failLifecycle(
        'lifecycle_error',
        'start',
        'different_ride_active',
        'Stop the active ride before starting another ride',
      );
    }

    updatePeerStatus({ state: 'starting', transportAvailable: null, directPeerCount: 0 });
    const unsubscribeTransport: (() => void)[] = [];
    const receiveGate = { open: true };
    let runtime: RideConnectivityRuntime | null = null;
    let transportStarted = false;
    try {
      unsubscribeTransport.push(
        transport.onStatus(status => {
          const peerCount = Number.isSafeInteger(status.peers) && status.peers >= 0 ? status.peers : 0;
          updatePeerStatus({
            state: status.error ? 'error' : status.active ? 'active' : 'inactive',
            transportAvailable: status.error ? status.active : true,
            directPeerCount: peerCount,
          });
          if (status.error && !status.active) {
            emitError({
              code: 'transport_unavailable',
              operation: 'start',
              reason: 'transport_status_error',
              recoverable: true,
            });
          }
        }),
      );
      unsubscribeTransport.push(
        transport.onPeerCountChanged(count => {
          if (!Number.isSafeInteger(count) || count < 0) {
            return;
          }
          updatePeerStatus({ ...peerStatus, directPeerCount: count });
        }),
      );

      try {
        await transport.start({ roomCode: context.rideId, riderName: context.riderName });
        transportStarted = true;
      } catch {
        updatePeerStatus({ state: 'unavailable', transportAvailable: false, directPeerCount: 0 });
        failLifecycle(
          'transport_unavailable',
          'start',
          'transport_start_failed',
          'The connectivity transport could not start',
        );
      }

      const identity = createNodeIdentity();
      const localNodeId = identity.nodeIdFor(context.rideId);
      if (!isValidRideMessageIdentifier(localNodeId, RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH)) {
        throw new TypeError('The generated local node id is invalid');
      }
      runtime = createRuntime({
        rideContext: context,
        localNodeId,
        generateMessageId: identity.generateMessageId,
        onApplicationMessage: received => {
          if (receiveGate.open) {
            notify(messageListeners, applicationMessageFrom(received), 'message');
          }
        },
      });
      runtime.start();
      active = Object.freeze({
        context,
        identity,
        localNodeId,
        runtime,
        unsubscribeTransport,
        receiveGate,
      });
      updatePeerStatus({
        state: 'active',
        transportAvailable: true,
        directPeerCount: peerStatus.directPeerCount,
      });
    } catch (error) {
      receiveGate.open = false;
      try {
        runtime?.stop();
      } catch {
        emitError({
          code: 'runtime_error',
          operation: 'start',
          reason: 'failed_runtime_cleanup',
          recoverable: true,
        });
      }
      for (const unsubscribe of unsubscribeTransport.splice(0)) {
        try {
          unsubscribe();
        } catch {
          emitError({
            code: 'runtime_error',
            operation: 'start',
            reason: 'failed_listener_cleanup',
            recoverable: true,
          });
        }
      }
      if (transportStarted) {
        try {
          await transport.stop();
        } catch {
          emitError({
            code: 'transport_unavailable',
            operation: 'start',
            reason: 'failed_transport_cleanup',
            recoverable: true,
          });
        }
      }
      active = null;
      if (!(error instanceof RideConnectivityClientError)) {
        updatePeerStatus({ state: 'error', transportAvailable: null, directPeerCount: 0 });
        emitError({
          code: 'initialization_error',
          operation: 'start',
          reason: 'runtime_initialization_failed',
          recoverable: true,
        });
        throw new RideConnectivityClientError(
          'initialization_error',
          'The connectivity runtime could not initialize',
        );
      }
      throw error;
    }
  };

  const doStop = async (): Promise<void> => {
    if (!active) {
      updatePeerStatus({ state: 'inactive', transportAvailable: null, directPeerCount: 0 });
      return;
    }
    const generation = active;
    active = null;
    generation.receiveGate.open = false;
    clearDeliveryTracking();
    let stopFailure: RideConnectivityClientError | null = null;
    try {
      generation.runtime.stop();
    } catch {
      emitError({
        code: 'runtime_error',
        operation: 'stop',
        reason: 'runtime_stop_failed',
        recoverable: true,
      });
      stopFailure = new RideConnectivityClientError(
        'runtime_error',
        'The connectivity runtime did not stop cleanly',
      );
    }
    for (const unsubscribe of generation.unsubscribeTransport) {
      try {
        unsubscribe();
      } catch {
        emitError({
          code: 'runtime_error',
          operation: 'stop',
          reason: 'transport_listener_cleanup_failed',
          recoverable: true,
        });
      }
    }
    try {
      await transport.stop();
    } catch {
      emitError({
        code: 'transport_unavailable',
        operation: 'stop',
        reason: 'transport_stop_failed',
        recoverable: true,
      });
      stopFailure ??= new RideConnectivityClientError(
        'transport_unavailable',
        'The connectivity transport did not stop cleanly',
      );
    }
    updatePeerStatus({ state: 'inactive', transportAvailable: null, directPeerCount: 0 });
    if (stopFailure) {
      throw stopFailure;
    }
  };

  const invalidMessage = (reason: string): never => {
    emitError({
      code: 'invalid_message_input',
      operation: 'send',
      reason,
      recoverable: true,
    });
    throw new RideConnectivityClientError(
      'invalid_message_input',
      'The application message is invalid',
    );
  };

  const validateAndCreateMessage = (
    input: RideConnectivityMessageInput,
    generation: ActiveGeneration,
  ): RideMessage<JsonValue> => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalidMessage('message_must_be_an_object');
    }
    if (
      !isValidRideMessageIdentifier(input.rideId, RIDE_MESSAGE_MAX_RIDE_ID_LENGTH) ||
      input.rideId !== generation.context.rideId
    ) {
      return invalidMessage('incorrect_ride_context');
    }
    if (!isRideMessageType(input.type) || !isGatewayRoutableMessageType(input.type)) {
      return invalidMessage('invalid_application_message_type');
    }
    if (!isRideMessagePriority(input.priority)) {
      return invalidMessage('invalid_priority');
    }
    if (input.payload === null || !isJsonValue(input.payload)) {
      return invalidMessage('invalid_json_payload');
    }
    if (!isValidRideMessageTtl(input.ttlMs)) {
      return invalidMessage('invalid_ttl');
    }
    if (!isValidRideMessageMaxHops(input.maxHops)) {
      return invalidMessage('invalid_hop_limit');
    }
    if (!validDestination(input.destination)) {
      return invalidMessage('invalid_destination');
    }

    const now = clock();
    if (!isValidRideMessageTimestamp(now)) {
      emitError({
        code: 'runtime_error',
        operation: 'send',
        reason: 'invalid_protocol_clock',
        recoverable: true,
      });
      throw new RideConnectivityClientError('runtime_error', 'The protocol clock is invalid');
    }
    let messageId: string;
    try {
      messageId = generation.identity.generateMessageId();
    } catch {
      emitError({
        code: 'runtime_error',
        operation: 'send',
        reason: 'message_id_generation_failed',
        recoverable: true,
      });
      throw new RideConnectivityClientError(
        'runtime_error',
        'A secure message identifier could not be generated',
      );
    }
    if (!isValidRideMessageIdentifier(messageId, 128)) {
      emitError({
        code: 'runtime_error',
        operation: 'send',
        reason: 'invalid_generated_message_id',
        recoverable: true,
      });
      throw new RideConnectivityClientError(
        'runtime_error',
        'The generated message identifier is invalid',
      );
    }

    const message = createRideMessage({
      id: messageId,
      rideId: generation.context.rideId,
      originId: generation.localNodeId,
      type: input.type,
      priority: input.priority,
      payload: input.payload,
      ttlMs: input.ttlMs,
      maxHops: input.maxHops,
      now,
    });
    try {
      // Validate both the base envelope and a worst-case final routed envelope. The latter ensures
      // gateway metadata cannot make a boundary-accepted packet exceed the wire-size limit.
      serializeRideMessage(message);
      serializeRideMessage(
        withGatewayRouting(message, {
          targetGatewayId:
            input.destination?.gatewayNodeId ?? 'g'.repeat(RIDE_MESSAGE_MAX_ORIGIN_ID_LENGTH),
          forwarderDistance: RIDE_MESSAGE_MAX_GATEWAY_DISTANCE,
        }),
      );
    } catch {
      return invalidMessage('invalid_or_oversized_wire_message');
    }
    return message;
  };

  const emitFailedSend = (
    messageId: string,
    reason: Extract<RideConnectivityDeliveryStatus, { state: 'failed' }>['reason'],
    outcome: Extract<RideConnectivityDeliveryStatus, { state: 'failed' }>['outcome'],
  ): void => {
    emitDelivery({ state: 'failed', messageId, at: clock(), reason, outcome });
  };

  const handleSendResult = (
    message: RideMessage<JsonValue>,
    result: RideConnectivitySendResult,
  ): void => {
    switch (result.status) {
      case 'sent':
        emitDelivery({
          state: 'transport_accepted',
          messageId: message.id,
          at: clock(),
          transportId,
        });
        scheduleExpiry(message);
        return;
      case 'send_timeout':
        emitError({
          code: 'send_timeout',
          operation: 'send',
          reason: 'transport_outcome_unknown',
          recoverable: true,
          messageId: message.id,
        });
        emitFailedSend(message.id, 'send_timeout', 'unknown');
        return;
      case 'transport_error':
        emitError({
          code: 'transport_unavailable',
          operation: 'send',
          reason: 'transport_send_rejected',
          recoverable: true,
          messageId: message.id,
        });
        emitFailedSend(message.id, 'transport_unavailable', 'not_sent');
        return;
      case 'not_sent':
        emitFailedSend(
          message.id,
          result.reason === 'encode_failed' ? 'encoding_failed' : 'routing_unavailable',
          'not_sent',
        );
        return;
      case 'local_gateway':
        emitError({
          code: 'runtime_error',
          operation: 'send',
          reason: 'local_gateway_handoff_unavailable',
          recoverable: true,
          messageId: message.id,
        });
        emitFailedSend(message.id, 'local_gateway_handoff_unavailable', 'not_sent');
        return;
      case 'runtime_not_running':
        emitError({
          code: 'runtime_error',
          operation: 'send',
          reason: 'runtime_not_running',
          recoverable: true,
          messageId: message.id,
        });
        emitFailedSend(message.id, 'runtime_unavailable', 'not_sent');
    }
  };

  const doSend = async (
    input: RideConnectivityMessageInput,
  ): Promise<RideConnectivityMessageSubmission> => {
    const generation = active;
    if (!generation) {
      return failLifecycle(
        'lifecycle_error',
        'send',
        'client_not_started',
        'Start ride connectivity before sending a message',
      );
    }
    const message = validateAndCreateMessage(input, generation);
    emitDelivery({ state: 'queued', messageId: message.id, at: clock() });
    emitDelivery({ state: 'sending', messageId: message.id, at: clock() });
    try {
      const result = await generation.runtime.sendToGateway(
        message,
        input.destination?.gatewayNodeId,
      );
      handleSendResult(message, result);
    } catch {
      emitError({
        code: 'runtime_error',
        operation: 'send',
        reason: 'runtime_send_failed',
        recoverable: true,
        messageId: message.id,
      });
      emitFailedSend(message.id, 'runtime_unavailable', 'unknown');
    }
    return Object.freeze({ messageId: message.id });
  };

  const subscribe = <T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) => {
    if (typeof listener !== 'function') {
      throw new TypeError('RideConnectivityClient listener must be a function');
    }
    listeners.add(listener);
    let subscribed = true;
    return (): void => {
      if (subscribed) {
        subscribed = false;
        listeners.delete(listener);
      }
    };
  };

  return {
    start(rideContext): Promise<void> {
      return enqueue(() => doStart(rideContext));
    },

    stop(): Promise<void> {
      return enqueue(doStop);
    },

    sendMessage(input): Promise<RideConnectivityMessageSubmission> {
      return enqueue(() => doSend(input));
    },

    onMessage(listener): () => void {
      return subscribe(messageListeners, listener);
    },

    onPeerStatus(listener): () => void {
      const unsubscribe = subscribe(peerListeners, listener);
      try {
        listener(peerStatus);
      } catch {
        emitError({
          code: 'runtime_error',
          operation: 'listener',
          reason: 'peer_status_listener_failed',
          recoverable: true,
        });
      }
      return unsubscribe;
    },

    onDeliveryStatus(listener): () => void {
      return subscribe(deliveryListeners, listener);
    },

    onError(listener): () => void {
      return subscribe(errorListeners, listener);
    },
  };
}
