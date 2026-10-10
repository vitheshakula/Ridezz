import React from 'react';
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {
  decodeCalibration,
  decodeCrashCandidate,
  decodeCrashSos,
  decodeMonitorStatus,
  describeDecision,
} from '../src/crash/crashTypes';
import {
  createHazardPacket,
  parseHazardPacket,
  serializeHazardPacket,
} from '../src/protocol/hazardProtocol';
import { buildHazardAnnouncement } from '../src/services/SpeechHazardService';
import { useCrashDetection } from '../src/crash/useCrashDetection';

const NOW = 1_800_000_000_000;

const sosPayload = (over: Record<string, unknown> = {}) => ({
  sosId: 'sos-1',
  timestamp: NOW,
  impactTimestamp: NOW - 26_000,
  latitude: 10.5,
  longitude: 20.5,
  locationAgeMs: 800,
  speedBeforeImpactMps: 20,
  speedBeforeImpactKmh: 72,
  severity: 'SEVERE',
  confidence: 'high',
  path: 'crash',
  peakG: 6.5,
  trigger: 'expired',
  ...over,
});

describe('crash bridge decoders', () => {
  test('decodes a well-formed SOS payload', () => {
    expect(decodeCrashSos(sosPayload())).toEqual(sosPayload());
  });

  test('keeps a position only as a valid pair', () => {
    expect(decodeCrashSos(sosPayload({ latitude: 95 }))).toMatchObject({
      latitude: null,
      longitude: null,
      locationAgeMs: null,
    });
    expect(decodeCrashSos(sosPayload({ longitude: null }))).toMatchObject({
      latitude: null,
      longitude: null,
    });
  });

  test('accepts an alert with no GNSS at all', () => {
    expect(
      decodeCrashSos(
        sosPayload({
          latitude: null,
          longitude: null,
          locationAgeMs: null,
          speedBeforeImpactMps: null,
          speedBeforeImpactKmh: null,
        }),
      ),
    ).toMatchObject({ latitude: null, speedBeforeImpactKmh: null, severity: 'SEVERE' });
  });

  test.each([
    ['not an object', 'x'],
    ['null', null],
    ['missing id', sosPayload({ sosId: '' })],
    ['bad severity', sosPayload({ severity: 'EXTREME' })],
    ['bad confidence', sosPayload({ confidence: 'sure' })],
    ['non-finite time', sosPayload({ timestamp: Number.NaN })],
  ])('rejects an SOS payload that is %s', (_name, raw) => {
    expect(decodeCrashSos(raw)).toBeNull();
  });

  test('decodes and validates a candidate', () => {
    expect(
      decodeCrashCandidate({ countdownMs: 20000, confidence: 'high', severity: 'HIGH', path: 'crash' }),
    ).toEqual({ countdownMs: 20000, confidence: 'high', severity: 'HIGH', path: 'crash' });
    expect(
      decodeCrashCandidate({ countdownMs: 0, confidence: 'high', severity: 'HIGH' }),
    ).toBeNull();
    expect(
      decodeCrashCandidate({ countdownMs: 5, confidence: 'low', severity: 'HIGH' }),
    ).toBeNull();
  });

  test('decodes monitor status and calibration results', () => {
    expect(decodeMonitorStatus({ sensorsStalled: true, gnss: 'active' })).toEqual({
      sensorsStalled: true,
      gnss: 'active',
    });
    expect(decodeMonitorStatus({ gnss: 'active' })).toBeNull();
    expect(decodeCalibration({ success: true, reason: null, deltaDeg: 12.5 })).toEqual({
      success: true,
      reason: null,
      deltaDeg: 12.5,
    });
    expect(decodeCalibration({ success: false, reason: 'not_steady' })).toEqual({
      success: false,
      reason: 'not_steady',
      deltaDeg: null,
    });
    expect(decodeCalibration(undefined).success).toBe(false);
  });

  test('describes decisions for the diagnostics log without any coordinates', () => {
    expect(describeDecision({ outcome: 'rejected', reason: 'no_rotation', peakG: 2.2 })).toBe(
      'rejected (no_rotation), peak 2.2 g',
    );
    const confirmed = describeDecision({
      outcome: 'confirmed',
      evidence: {
        path: 'crash',
        confidence: 'high',
        peakG: 6.5,
        maxGyroRadS: 8,
        tiltDeg: 90,
        stillMs: 4200,
        preSpeedMps: 20,
        postSpeedMps: 0.3,
      },
    });
    expect(confirmed).toContain('crash/high');
    expect(confirmed).toContain('tilt 90°');
  });
});

describe('hazard protocol: crash alert details', () => {
  const sos = { impactAt: NOW - 26_000, severity: 'HIGH' as const, lat: 10.5, lng: 20.5, speedKmh: 72 };

  test('an ordinary packet is unchanged: no sos key at all', () => {
    const packet = createHazardPacket('accident', 'sender-1', 'Alex', NOW);
    expect('sos' in packet).toBe(false);
    expect(serializeHazardPacket(packet)).not.toContain('sos');
  });

  test('round-trips the crash details through the wire format', () => {
    const packet = createHazardPacket('accident', 'sender-1', 'Alex', NOW, sos);
    expect(parseHazardPacket(serializeHazardPacket(packet), NOW)).toEqual(packet);
  });

  test('a malformed sos block is dropped but the packet is still accepted', () => {
    const wire = JSON.stringify({
      ...createHazardPacket('accident', 'sender-1', 'Alex', NOW),
      sos: { impactAt: 'soon', severity: 'HIGH' },
    });
    const parsed = parseHazardPacket(wire, NOW);
    expect(parsed).not.toBeNull();
    expect(parsed && 'sos' in parsed).toBe(false);
  });

  test('keeps the severity but drops an out-of-range position', () => {
    const wire = JSON.stringify({
      ...createHazardPacket('accident', 'sender-1', 'Alex', NOW),
      sos: { impactAt: NOW, severity: 'SEVERE', lat: 123, lng: 20, speedKmh: -4 },
    });
    expect(parseHazardPacket(wire, NOW)?.sos).toEqual({ impactAt: NOW, severity: 'SEVERE' });
  });

  test('announces an automatic alert differently from a spoken report', () => {
    expect(buildHazardAnnouncement(createHazardPacket('accident', 's', 'Alex', NOW, sos))).toBe(
      'Alex may have crashed.',
    );
    expect(buildHazardAnnouncement(createHazardPacket('accident', 's', 'Alex', NOW))).toBe(
      'Alex reported Accident.',
    );
  });
});

describe('useCrashDetection', () => {
  const originalOS = Platform.OS;
  let native: Record<string, jest.Mock>;

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'android';
    native = {
      startMonitoring: jest.fn(() =>
        Promise.resolve({
          accelMaxRangeG: 8,
          hasGyroscope: true,
          hasGravity: true,
          gnss: 'active',
          samplingHz: 100,
          foregroundServiceActive: true,
          alreadyRunning: false,
        }),
      ),
      stopMonitoring: jest.fn(() => Promise.resolve()),
      cancelCrashAlert: jest.fn(() => Promise.resolve(true)),
      sendAlertNow: jest.fn(() => Promise.resolve(true)),
      acknowledgeAlert: jest.fn(() => Promise.resolve(true)),
      calibrateRidingAngle: jest.fn(() => Promise.resolve({ success: true, reason: null })),
      clearRidingCalibration: jest.fn(() => Promise.resolve(true)),
      consumePendingSos: jest.fn(() => Promise.resolve(null)),
      simulateCrash: jest.fn(() => Promise.resolve()),
    };
    (NativeModules as Record<string, unknown>).CrashDetection = native;
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).CrashDetection;
  });

  function mount(onSos: jest.Mock, enabled = true) {
    const latest: { current: ReturnType<typeof useCrashDetection> | null } = { current: null };
    function Probe() {
      latest.current = useCrashDetection({ enabled, onSos });
      return null;
    }
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    return { latest, renderer };
  }

  const flush = () => ReactTestRenderer.act(async () => {});

  test('starts monitoring on mount and stops on unmount', async () => {
    const { latest, renderer } = mount(jest.fn());
    await flush();
    expect(native.startMonitoring).toHaveBeenCalledTimes(1);
    expect(latest.current?.status).toBe('active');
    ReactTestRenderer.act(() => renderer.unmount());
    expect(native.stopMonitoring).toHaveBeenCalledTimes(1);
  });

  test('mirrors the countdown and hands the alert to onSos exactly once', async () => {
    const onSos = jest.fn();
    const { latest } = mount(onSos);
    await flush();

    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit('onCrashCandidateDetected', {
        countdownMs: 20000,
        confidence: 'high',
        severity: 'HIGH',
        path: 'crash',
      });
    });
    expect(latest.current?.state.phase).toBe('countdown');
    expect(latest.current?.state.countdownEndsAt).toBeGreaterThan(Date.now());

    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit('onCountdownExpired', sosPayload());
      // The same alert re-delivered must not be dispatched twice.
      DeviceEventEmitter.emit('onCountdownExpired', sosPayload());
    });
    await flush();
    expect(onSos).toHaveBeenCalledTimes(1);
    expect(onSos.mock.calls[0][0]).toMatchObject({ sosId: 'sos-1', severity: 'SEVERE' });
    expect(latest.current?.state.phase).toBe('sos');
    expect(native.consumePendingSos).toHaveBeenCalled();
  });

  test('recovers an alert that fired before JS was listening', async () => {
    native.consumePendingSos.mockResolvedValueOnce(sosPayload({ sosId: 'missed-1' }));
    const onSos = jest.fn();
    mount(onSos);
    await flush();
    expect(onSos).toHaveBeenCalledTimes(1);
    expect(onSos.mock.calls[0][0].sosId).toBe('missed-1');
  });

  test('ignores malformed native events', async () => {
    const onSos = jest.fn();
    const { latest } = mount(onSos);
    await flush();
    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit('onCountdownExpired', { sosId: 'x' });
      DeviceEventEmitter.emit('onCrashCandidateDetected', { countdownMs: 'soon' });
    });
    expect(onSos).not.toHaveBeenCalled();
    expect(latest.current?.state.phase).toBe('idle');
  });

  test('cancel, send-now and acknowledge go to the native module', async () => {
    const { latest } = mount(jest.fn());
    await flush();
    latest.current?.cancel();
    latest.current?.sendNow();
    latest.current?.acknowledge();
    expect(native.cancelCrashAlert).toHaveBeenCalledTimes(1);
    expect(native.sendAlertNow).toHaveBeenCalledTimes(1);
    expect(native.acknowledgeAlert).toHaveBeenCalledTimes(1);
  });

  test('reports unsupported when the phone cannot detect impacts', async () => {
    native.startMonitoring.mockRejectedValueOnce({
      code: 'crash_unsupported_accelerometer',
      message: 'Accelerometer range 2.0 g is below the 3.9 g needed',
    });
    const { latest } = mount(jest.fn());
    await flush();
    expect(latest.current?.status).toBe('unsupported');
    expect(latest.current?.statusDetail).toContain('2.0 g');
  });

  test('does nothing while disabled', async () => {
    const { latest } = mount(jest.fn(), false);
    await flush();
    expect(native.startMonitoring).not.toHaveBeenCalled();
    expect(latest.current?.status).toBe('off');
  });
});
