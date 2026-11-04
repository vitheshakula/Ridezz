import React from 'react';
import { DeviceEventEmitter, NativeModules, StyleSheet, Platform, Vibration } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import CrashAlertModal, {
  MOTION_NOTICE_MS,
  QUICK_CANCEL_MS,
  VIBRATION_STAGES,
  vibrationStage,
} from '../src/components/CrashAlertModal';
import type { CrashState } from '../src/crash/crashTypes';
import { useCrashDetection } from '../src/crash/useCrashDetection';

const T0 = 1_700_000_000_000;
const TOTAL = 40_000;

type Renderer = ReactTestRenderer.ReactTestRenderer;

const countdown = (ms = TOTAL): CrashState => ({
  phase: 'countdown',
  countdownEndsAt: T0 + ms,
  countdownMs: ms,
});

const advance = (ms: number) =>
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(ms);
  });

const byId = (tree: Renderer, id: string) =>
  tree.root.findAll(n => n.props.testID === id && typeof n.type === 'string');

const text = (tree: Renderer) => JSON.stringify(tree.toJSON());

const press = (tree: Renderer, id: string) => {
  const target = tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
  expect(target.length).toBeGreaterThan(0);
  ReactTestRenderer.act(() => {
    target[0].props.onPress();
  });
};

function render(state: CrashState) {
  const props = {
    onCancel: jest.fn(),
    onSendNow: jest.fn(),
    onAcknowledge: jest.fn(),
  };
  let tree!: Renderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<CrashAlertModal top={100} state={state} {...props} />);
  });
  const rerender = (next: CrashState) =>
    ReactTestRenderer.act(() => {
      tree.update(<CrashAlertModal top={100} state={next} {...props} />);
    });
  return { tree, props, rerender };
}

describe('CrashAlertModal', () => {
  let vibrate: jest.SpyInstance;
  let cancelVibration: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    cancelVibration = jest.spyOn(Vibration, 'cancel').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders nothing while idle', () => {
    expect(render({ phase: 'idle' }).tree.toJSON()).toBeNull();
  });

  describe('stage 1: 10 s quick cancel', () => {
    it('starts at 10 s with the cancel button and no check-in buttons', () => {
      const { tree } = render(countdown());
      expect(byId(tree, 'crash-stage-1')).toHaveLength(1);
      expect(byId(tree, 'crash-seconds')[0].props.children).toBe(10);
      expect(text(tree)).toContain('Cancel');
      expect(byId(tree, 'crash-im-ok')).toHaveLength(0);
      expect(byId(tree, 'crash-send-now')).toHaveLength(0);
    });

    it('counts down per second and shrinks the progress bar', () => {
      const { tree } = render(countdown());
      const barWidth = () =>
        parseFloat(String(StyleSheet.flatten(byId(tree, 'crash-progress')[0].props.style).width));
      expect(barWidth()).toBeCloseTo(100, 0);
      advance(3000);
      expect(byId(tree, 'crash-seconds')[0].props.children).toBe(7);
      expect(barWidth()).toBeCloseTo(70, 0);
    });

    it('cancels with one tap: calls onCancel, silences the vibration and can be dismissed', () => {
      const { tree, props, rerender } = render(countdown());
      advance(4000);
      press(tree, 'crash-cancel');
      expect(props.onCancel).toHaveBeenCalledTimes(1);
      expect(props.onSendNow).not.toHaveBeenCalled();

      rerender({ phase: 'cancelled', cancelReason: 'user' });
      expect(cancelVibration).toHaveBeenCalled();
      expect(tree.toJSON()).toBeNull();
    });

    it('uses the gentle pulse', () => {
      render(countdown());
      expect(vibrate).toHaveBeenLastCalledWith(VIBRATION_STAGES[0], true);
    });
  });

  describe('stage 2: 30 s check-in', () => {
    it('takes over after 10 s with a 30 s countdown and both buttons', () => {
      const { tree } = render(countdown());
      advance(QUICK_CANCEL_MS + 100);
      expect(byId(tree, 'crash-stage-2')).toHaveLength(1);
      expect(byId(tree, 'crash-stage-1')).toHaveLength(0);
      expect(byId(tree, 'crash-seconds')[0].props.children).toBe(30);
      expect(text(tree)).toContain('Are you OK?');
      expect(byId(tree, 'crash-cancel')).toHaveLength(0);
      expect(byId(tree, 'crash-im-ok')).toHaveLength(1);
      expect(byId(tree, 'crash-send-now')).toHaveLength(1);
    });

    it('escalates the vibration as the check-in runs down', () => {
      render(countdown());
      advance(QUICK_CANCEL_MS + 100);
      expect(vibrate).toHaveBeenLastCalledWith(VIBRATION_STAGES[1], true);
      advance(11_000);
      expect(vibrate).toHaveBeenLastCalledWith(VIBRATION_STAGES[2], true);
      advance(10_000);
      expect(vibrate).toHaveBeenLastCalledWith(VIBRATION_STAGES[3], true);
    });

    it('classifies vibration stages', () => {
      expect(vibrationStage(true, 0.1)).toBe(0);
      expect(vibrationStage(false, 1)).toBe(1);
      expect(vibrationStage(false, 0.5)).toBe(2);
      expect(vibrationStage(false, 0.1)).toBe(3);
    });

    it('"I\'M OK" aborts the emergency via onCancel', () => {
      const { tree, props } = render(countdown());
      advance(15_000);
      press(tree, 'crash-im-ok');
      expect(props.onCancel).toHaveBeenCalledTimes(1);
      expect(props.onSendNow).not.toHaveBeenCalled();
    });

    it('"ALERT GROUP NOW" skips the wait via onSendNow', () => {
      const { tree, props } = render(countdown());
      advance(15_000);
      press(tree, 'crash-send-now');
      expect(props.onSendNow).toHaveBeenCalledTimes(1);
      expect(props.onCancel).not.toHaveBeenCalled();
    });

    it('follows the countdown length from the native event', () => {
      const { tree } = render(countdown(25_000));
      advance(QUICK_CANCEL_MS + 100);
      expect(byId(tree, 'crash-seconds')[0].props.children).toBe(15);
    });
  });

  describe('after the countdown', () => {
    it('shows "SOS DISPATCHED" with one long buzz and acknowledges on tap', () => {
      const { tree, props, rerender } = render(countdown());
      advance(TOTAL);
      rerender({ phase: 'sos' });
      expect(text(tree)).toContain('SOS DISPATCHED');
      expect(byId(tree, 'crash-cancel')).toHaveLength(0);
      expect(cancelVibration).toHaveBeenCalled();
      expect(vibrate).toHaveBeenLastCalledWith(800);
      press(tree, 'crash-acknowledge');
      expect(props.onAcknowledge).toHaveBeenCalledTimes(1);
    });

    it('shows a motion-detected notice when riding resumes, then clears it', () => {
      const { tree } = render({
        phase: 'cancelled',
        cancelReason: 'riding_resumed',
      });
      expect(byId(tree, 'crash-motion-notice')).toHaveLength(1);
      expect(text(tree)).toContain('MOTION DETECTED');
      advance(MOTION_NOTICE_MS + 50);
      expect(tree.toJSON()).toBeNull();
    });

    it('shows nothing after a manual cancel', () => {
      expect(render({ phase: 'cancelled', cancelReason: 'user' }).tree.toJSON()).toBeNull();
    });
  });
});

describe('CrashAlertModal wired to the native crash bridge', () => {
  const originalOS = Platform.OS;
  let native: Record<string, jest.Mock>;
  const sosPayload = {
    sosId: 'sos-42',
    timestamp: T0 + TOTAL,
    impactTimestamp: T0 - 5000,
    latitude: 12.97,
    longitude: 77.59,
    locationAgeMs: 900,
    speedBeforeImpactMps: 20,
    speedBeforeImpactKmh: 72,
    severity: 'SEVERE',
    confidence: 'high',
    path: 'crash',
    peakG: 6.1,
    trigger: 'expired',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    jest.spyOn(Vibration, 'cancel').mockImplementation(() => {});
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
      consumePendingSos: jest.fn(() => Promise.resolve(null)),
      simulateCrash: jest.fn(() => Promise.resolve()),
    };
    (NativeModules as Record<string, unknown>).CrashDetection = native;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).CrashDetection;
  });

  async function mount(onSos: jest.Mock) {
    function Screen() {
      const crash = useCrashDetection({ enabled: true, onSos });
      return (
        <CrashAlertModal
          top={100}
          state={crash.state}
          onCancel={crash.cancel}
          onSendNow={crash.sendNow}
          onAcknowledge={crash.acknowledge}
        />
      );
    }
    let tree!: Renderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<Screen />);
    });
    await ReactTestRenderer.act(async () => {
      DeviceEventEmitter.emit('onCrashCandidateDetected', {
        countdownMs: TOTAL,
        confidence: 'high',
        severity: 'SEVERE',
        path: 'crash',
      });
    });
    return tree;
  }

  it('shows the quick-cancel stage when onCrashCandidateDetected fires, and cancel reaches the native module', async () => {
    const tree = await mount(jest.fn());
    expect(byId(tree, 'crash-stage-1')).toHaveLength(1);
    press(tree, 'crash-cancel');
    expect(native.cancelCrashAlert).toHaveBeenCalledTimes(1);
  });

  it("I'M OK in the check-in stage reaches cancelCrashAlert, ALERT GROUP NOW reaches sendAlertNow", async () => {
    const tree = await mount(jest.fn());
    advance(15_000);
    press(tree, 'crash-im-ok');
    expect(native.cancelCrashAlert).toHaveBeenCalledTimes(1);
    press(tree, 'crash-send-now');
    expect(native.sendAlertNow).toHaveBeenCalledTimes(1);
  });

  it('dispatches the SOS (with coordinates and telemetry) when the check-in runs out', async () => {
    const onSos = jest.fn();
    const tree = await mount(onSos);
    advance(TOTAL);
    expect(onSos).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      DeviceEventEmitter.emit('onCountdownExpired', sosPayload);
    });
    expect(onSos).toHaveBeenCalledTimes(1);
    expect(onSos.mock.calls[0][0]).toMatchObject({
      sosId: 'sos-42',
      latitude: 12.97,
      longitude: 77.59,
      speedBeforeImpactKmh: 72,
      peakG: 6.1,
      trigger: 'expired',
    });
    expect(text(tree)).toContain('SOS DISPATCHED');
  });
});
