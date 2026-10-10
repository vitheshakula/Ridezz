import { NativeModules } from 'react-native';
import {
  createConnectivityFieldTestObserver,
  isConnectivityFieldTestBuild,
  readConnectivityFieldTestEvidence,
  recordConnectivityFieldTestEvidence,
} from '../src/connectivity/connectivityFieldTestEvidence';
import { PROBE_PAYLOAD_MARKER } from '../src/connectivity/connectivityTestProbe';
import type { RideConnectivityEvent } from '../src/connectivity/rideConnectivityRuntime';

describe('offline connectivity field-test evidence', () => {
  let entries: string[];
  let append: jest.Mock;

  beforeEach(() => {
    entries = [];
    append = jest.fn(async (serialized: string) => {
      entries.push(serialized);
    });
    (NativeModules as Record<string, unknown>).RideazeFieldTestEvidence = {
      enabled: true,
      append,
      read: jest.fn(async () => entries),
      clear: jest.fn(async () => {
        entries = [];
      }),
      printToLogcat: jest.fn(async () => entries.length),
    };
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).RideazeFieldTestEvidence;
  });

  test('is inert without the compile-time native field-test boundary', async () => {
    delete (NativeModules as Record<string, unknown>).RideazeFieldTestEvidence;
    expect(isConnectivityFieldTestBuild()).toBe(false);
    recordConnectivityFieldTestEvidence({
      kind: 'gateway_override_changed',
      enabled: true,
    });
    expect(await readConnectivityFieldTestEvidence()).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  test('writes ordered, sanitized envelopes without payloads or ride identifiers', async () => {
    expect(isConnectivityFieldTestBuild()).toBe(true);
    recordConnectivityFieldTestEvidence({
      kind: 'probe_submitted',
      messageId: 'message-1',
      seq: 1,
      eventAtMs: 123,
    });
    await readConnectivityFieldTestEvidence();

    expect(append).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(entries[0]);
    expect(envelope).toMatchObject({
      schema: 1,
      kind: 'probe_submitted',
      messageId: 'message-1',
      seq: 1,
      eventAtMs: 123,
    });
    expect(entries[0]).not.toMatch(/payload|rideId|latitude|longitude|token/i);
  });

  test('records validated receipt, exact forwarding route, result and duplicate correlation', async () => {
    const observer = createConnectivityFieldTestObserver({
      getRoute: () => ({ ok: false, reason: 'no_route' }),
    });
    const message = {
      v: 1,
      id: 'message-2',
      rideId: 'not-recorded',
      originId: 'origin-node',
      type: 'ride_state',
      priority: 'low',
      createdAt: 100,
      expiresAt: 200,
      hopCount: 1,
      maxHops: 4,
      payload: { probe: PROBE_PAYLOAD_MARKER, seq: 2 },
    } as const;
    const route = {
      gatewayNodeId: 'gateway-node',
      nextHopNodeId: 'next-node',
      transportId: 'nearby',
      hopCount: 0,
      observedAt: 50,
    };

    observer({ kind: 'message_accepted', message } as RideConnectivityEvent);
    observer({
      kind: 'routed_attempt',
      direction: 'forwarded',
      message,
      route,
    } as RideConnectivityEvent);
    observer({
      kind: 'routed_result',
      message,
      result: { status: 'sent', message, route, endpointId: 'never-recorded' },
    } as RideConnectivityEvent);
    observer({
      kind: 'ingress_rejected_detail',
      reason: 'duplicate',
      messageId: message.id,
      messageType: message.type,
    });
    await readConnectivityFieldTestEvidence();

    const parsed = entries.map(value => JSON.parse(value));
    expect(parsed.map(value => value.kind)).toEqual([
      'probe_received',
      'probe_route_attempt',
      'probe_forward_result',
      'protocol_duplicate_suppressed',
    ]);
    expect(parsed[1]).toMatchObject({
      messageId: message.id,
      nextHopNodeId: 'next-node',
      routeDistance: 1,
      hopCount: 1,
    });
    expect(entries.join('\n')).not.toMatch(/not-recorded|never-recorded/);
  });
});
