import { createHazardCoordinator } from '../src/hazards/HazardCoordinator';
import { createHazardPacket } from '../src/protocol/hazardProtocol';
import {
  SAFETY_HAZARD_MAX_HOPS,
  SAFETY_HAZARD_TTL_MS,
  SAFETY_SOS_MAX_HOPS,
  SAFETY_SOS_TTL_MS,
  createRideSafetyConnectivity,
} from '../src/services/rideSafetyConnectivity';
import type { HardBrakingDetected } from '../src/braking/brakingEvents';
import type { CrashSos } from '../src/crash/crashTypes';
import type { RideConnectivityMessageInput } from '../src/connectivity/rideConnectivityClient';

const NOW = 1_700_000_000_000;

const crashSos = (overrides: Partial<CrashSos> = {}): CrashSos => ({
  sosId: 'sos-123',
  timestamp: NOW,
  impactTimestamp: NOW - 2_000,
  latitude: 12.97,
  longitude: 77.59,
  locationAgeMs: 500,
  speedBeforeImpactMps: 12,
  speedBeforeImpactKmh: 43.2,
  severity: 'SEVERE',
  confidence: 'high',
  path: 'impact_then_stillness',
  peakG: 5.4,
  trigger: 'expired',
  ...overrides,
});

const braking = (overrides: Partial<HardBrakingDetected> = {}): HardBrakingDetected => ({
  seq: 7,
  onsetAt: NOW,
  raisedAt: NOW + 20,
  speedKmh: 61,
  peakDecelG: 0.72,
  headingDeg: 185,
  source: 'imu',
  ...overrides,
});

function setup() {
  const sendMessage = jest.fn<
    Promise<{ messageId: string }>,
    [RideConnectivityMessageInput]
  >(async () => ({ messageId: 'protocol-message-1' }));
  const adapter = createRideSafetyConnectivity({
    rideId: '12345',
    getClient: () => ({ sendMessage }),
    clock: () => NOW,
  });
  return { adapter, sendMessage };
}

describe('Ride safety connectivity adapter', () => {
  test('maps one crash-generated alert to the existing critical SOS type', () => {
    const { adapter, sendMessage } = setup();

    adapter.submitCrashSos(crashSos());

    expect(sendMessage).toHaveBeenCalledWith({
      rideId: '12345',
      type: 'sos',
      priority: 'critical',
      payload: {
        alertType: 'accident',
        sosId: 'sos-123',
        timestamp: NOW,
        impactTimestamp: NOW - 2_000,
        severity: 'SEVERE',
        confidence: 'high',
        latitude: 12.97,
        longitude: 77.59,
        speedKmh: 43.2,
        peakG: 5.4,
        trigger: 'expired',
      },
      ttlMs: SAFETY_SOS_TTL_MS,
      maxHops: SAFETY_SOS_MAX_HOPS,
      destination: { kind: 'gateway' },
    });
  });

  test('suppresses a repeated crash SOS id and does not emit a generic accident hazard', () => {
    const { adapter, sendMessage } = setup();
    const sos = crashSos();

    adapter.submitCrashSos(sos);
    adapter.submitCrashSos(sos);
    adapter.submitVoiceHazard(
      createHazardPacket('accident', 'sender-a', 'Rider A', NOW, {
        impactAt: NOW - 2_000,
        severity: 'SEVERE',
      }),
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].type).toBe('sos');
  });

  test('maps hard braking to the existing critical hazard type', () => {
    const { adapter, sendMessage } = setup();

    adapter.submitHardBraking(braking());

    expect(sendMessage).toHaveBeenCalledWith({
      rideId: '12345',
      type: 'hazard',
      priority: 'critical',
      payload: {
        hazardKind: 'hard_braking',
        seq: 7,
        onsetAt: NOW,
        speedKmh: 61,
        peakDecelG: 0.72,
        headingDeg: 185,
        source: 'imu',
      },
      ttlMs: SAFETY_HAZARD_TTL_MS,
      maxHops: SAFETY_HAZARD_MAX_HOPS,
      destination: { kind: 'gateway' },
    });
  });

  test('maps an accepted voice hazard to the existing high-priority hazard type', () => {
    const { adapter, sendMessage } = setup();
    const packet = createHazardPacket('pothole', 'sender-a', 'Rider A', NOW);

    adapter.submitVoiceHazard(packet);

    expect(sendMessage).toHaveBeenCalledWith({
      rideId: '12345',
      type: 'hazard',
      priority: 'high',
      payload: {
        hazardKind: 'pothole',
        hazardId: packet.id,
        timestamp: NOW,
        senderId: 'sender-a',
        senderName: 'Rider A',
      },
      ttlMs: SAFETY_HAZARD_TTL_MS,
      maxHops: SAFETY_HAZARD_MAX_HOPS,
      destination: { kind: 'gateway' },
    });
  });

  test('isolates synchronous initialization/send failures and asynchronous rejection', async () => {
    const initializationFailure = createRideSafetyConnectivity({
      rideId: '12345',
      getClient: () => {
        throw new Error('secure store unavailable');
      },
    });
    expect(() => initializationFailure.submitCrashSos(crashSos())).not.toThrow();

    const syncSendFailure = createRideSafetyConnectivity({
      rideId: '12345',
      getClient: () => ({
        sendMessage: (() => {
          throw new Error('client not initialized');
        }) as never,
      }),
    });
    expect(() => syncSendFailure.submitHardBraking(braking())).not.toThrow();

    const asyncSendFailure = createRideSafetyConnectivity({
      rideId: '12345',
      getClient: () => ({ sendMessage: jest.fn().mockRejectedValue(new Error('queue failed')) }),
    });
    expect(() => asyncSendFailure.submitVoiceHazard(
      createHazardPacket('gravel', 'sender-a', 'Rider A', NOW),
    )).not.toThrow();
    await Promise.resolve();
  });

  test('Phase 1 dispatch still runs when the additive protocol path is unavailable', async () => {
    const adapter = createRideSafetyConnectivity({
      rideId: '12345',
      getClient: () => {
        throw new Error('protocol unavailable');
      },
    });
    const nearbyBroadcast = jest.fn(async () => {});
    const liveKitBroadcast = jest.fn(async () => {});
    const packet = createHazardPacket('obstacle', 'sender-a', 'Rider A', NOW);
    const coordinator = createHazardCoordinator({
      senderId: 'sender-a',
      nearbyTransport: {
        capabilities: {
          broadcast: true,
          targeted: false,
          peerIdentity: false,
          linkMetrics: false,
          deliveryAck: false,
        },
        broadcast: nearbyBroadcast,
        onPayload: jest.fn(() => () => {}),
      },
      liveKitTransport: {
        capabilities: {
          broadcast: true,
          targeted: false,
          peerIdentity: false,
          linkMetrics: false,
          deliveryAck: false,
        },
        broadcast: liveKitBroadcast,
        onPayload: jest.fn(() => () => {}),
      },
      isOnline: () => true,
      onLocalAccepted: accepted => adapter.submitVoiceHazard(accepted),
      onIncomingAccepted: jest.fn(),
      onLocalSendResult: jest.fn(),
      clock: () => NOW,
    });

    expect(() => coordinator.submitLocal(packet)).not.toThrow();
    await Promise.resolve();

    expect(nearbyBroadcast).toHaveBeenCalledTimes(1);
    expect(liveKitBroadcast).toHaveBeenCalledTimes(1);
  });
});
