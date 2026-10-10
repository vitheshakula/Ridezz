import React from 'react';
import {
  DeviceEventEmitter,
  NativeModules,
  Platform,
  Vibration,
} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { base64ToBytes, bytesToBase64 } from '../src/braking/brakePacket';
import PackAlertCard from '../src/components/PackAlertCard';
import { createConvoyCoordinator } from '../src/convoy/convoyCoordinator';
import {
  PACK_RECOVERED_EVENT,
  PACK_SEPARATION_EVENT,
  RIDER_LOST_CONTACT_EVENT,
  decodePackAlert,
  decodePackRecovered,
  decodeRiderState,
  emitPeerConvoyAlert,
} from '../src/convoy/convoyEvents';
import {
  CONVOY_PACKET_BYTES,
  decodeConvoyPacket,
  encodeConvoyPacket,
  shortRiderId,
  type ConvoyAlert,
} from '../src/convoy/convoyPacket';
import {
  GROUP_SILENT_KEY,
  describeAlert,
  expireAlerts,
  mostSevere,
  removeAlert,
  spokenLine,
  upsertAlert,
  type PackAlert,
} from '../src/convoy/packAlerts';
import { usePackSeparation } from '../src/convoy/usePackSeparation';
import { extractHazards } from '../src/services/SpeechHazardService';
import type { BroadcastTransport } from '../src/transports/Transport';

const NOW = 1_800_000_000_000;

const alertFixture = (over: Partial<ConvoyAlert> = {}): ConvoyAlert => ({
  eventType: 'BREAKDOWN',
  recovered: false,
  reporterId: 'abc12345',
  subjectId: 'abc12345',
  subjectName: 'Alex',
  seq: 7,
  timestamp: NOW,
  lastKnownLat: 12.971599,
  lastKnownLng: 77.594566,
  speedKmh: 0,
  distanceMeters: 820,
  ...over,
});

const packAlert = (over: Partial<PackAlert> = {}): PackAlert => ({
  key: 'abc12345',
  eventType: 'BREAKDOWN',
  name: 'Alex',
  self: false,
  lat: 12.97,
  lng: 77.59,
  speedKmh: 0,
  distanceMeters: 820,
  at: NOW,
  lastSeenAt: null,
  groupSilent: false,
  ...over,
});

describe('convoy packet', () => {
  it('is 52 bytes and round-trips every field', () => {
    const wire = encodeConvoyPacket(alertFixture({ speedKmh: 63.4 }), 2);
    expect(wire.length).toBe(CONVOY_PACKET_BYTES);
    expect(CONVOY_PACKET_BYTES).toBeLessThanOrEqual(64);
    const back = decodeConvoyPacket(wire);
    expect(back).toMatchObject({
      eventType: 'BREAKDOWN',
      recovered: false,
      reporterId: 'abc12345',
      subjectId: 'abc12345',
      subjectName: 'Alex',
      seq: 7,
      timestamp: NOW,
      speedKmh: 63.4,
      distanceMeters: 820,
      hops: 2,
    });
    expect(back?.lastKnownLat).toBeCloseTo(12.971599, 6);
    expect(back?.lastKnownLng).toBeCloseTo(77.594566, 6);
  });

  it('keeps negative coordinates and flags recoveries', () => {
    const back = decodeConvoyPacket(
      encodeConvoyPacket(
        alertFixture({
          eventType: 'LOST_CONTACT',
          recovered: true,
          lastKnownLat: -33.8688,
          lastKnownLng: -151.2093,
        }),
      ),
    );
    expect(back?.eventType).toBe('LOST_CONTACT');
    expect(back?.recovered).toBe(true);
    expect(back?.lastKnownLat).toBeCloseTo(-33.8688, 6);
    expect(back?.lastKnownLng).toBeCloseTo(-151.2093, 6);
  });

  it('carries an unknown distance and replaces non-ASCII name characters', () => {
    const back = decodeConvoyPacket(
      encodeConvoyPacket(
        alertFixture({ distanceMeters: null, subjectName: 'Zoë Müller-Long' }),
      ),
    );
    expect(back?.distanceMeters).toBeNull();
    expect(back?.subjectName).toBe('Zo? M?ller-L');
  });

  it('survives base64 for the Nearby text transport', () => {
    const wire = encodeConvoyPacket(alertFixture());
    const text = bytesToBase64(wire);
    expect(text).toHaveLength(72);
    expect(base64ToBytes(text)).toBeNull(); // the braking limit (64) must not accept it by accident
    expect(
      decodeConvoyPacket(base64ToBytes(text, 72) as Uint8Array),
    ).toMatchObject({ seq: 7 });
  });

  it('rejects damaged, foreign and wrong-length input', () => {
    const wire = encodeConvoyPacket(alertFixture());
    const flipped = wire.slice();
    flipped[40] = (flipped[40] + 1) % 256;
    expect(decodeConvoyPacket(flipped)).toBeNull();
    const foreign = wire.slice();
    foreign[0] = 0xb7;
    expect(decodeConvoyPacket(foreign)).toBeNull();
    expect(decodeConvoyPacket(wire.slice(0, 51))).toBeNull();
    expect(decodeConvoyPacket(new Uint8Array(52))).toBeNull();
  });

  it('shortens long ids to a stable 8 characters', () => {
    expect(shortRiderId('abc12345')).toBe('abc12345');
    const long = shortRiderId('rider-identity-0001');
    expect(long).toHaveLength(8);
    expect(shortRiderId('rider-identity-0001')).toBe(long);
    expect(shortRiderId('rider-identity-0002')).not.toBe(long);
  });
});

describe('convoy coordinator', () => {
  function transport<T extends string | Uint8Array>() {
    const handlers = new Set<(p: T) => void>();
    const sent: T[] = [];
    const t: BroadcastTransport<T> = {
      broadcast: jest.fn((payload: T) => {
        sent.push(payload);
        return Promise.resolve();
      }),
      onPayload: (h: (p: T) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
    } as unknown as BroadcastTransport<T>;
    return {
      t,
      sent,
      deliver: (p: T) => handlers.forEach(h => h(p)),
      handlers,
    };
  }

  function setup(online = true) {
    const nearby = transport<string>();
    const live = transport<Uint8Array<ArrayBuffer>>();
    const heard: ConvoyAlert[] = [];
    let now = NOW;
    const coordinator = createConvoyCoordinator({
      senderId: 'me000001',
      nearbyTransport: nearby.t,
      liveKitTransport: live.t,
      isOnline: () => online,
      onPeerAlert: a => heard.push(a),
      clock: () => now,
    });
    coordinator.subscribe();
    return {
      nearby,
      live,
      heard,
      coordinator,
      advance: (ms: number) => (now += ms),
    };
  }

  const local = (over: Partial<ConvoyAlert> = {}) => {
    const full: Partial<ConvoyAlert> = alertFixture({
      subjectId: 'me000001',
      ...over,
    });
    delete full.reporterId;
    delete full.seq;
    return full as Omit<ConvoyAlert, 'reporterId' | 'seq'>;
  };

  it('sends over the mesh and the cloud and numbers each alert', async () => {
    const { nearby, live, coordinator } = setup();
    const outcomes = await coordinator.submitLocal(local());
    expect(outcomes).toEqual([
      { channel: 'mesh', ok: true },
      { channel: 'cloud', ok: true },
    ]);
    await coordinator.submitLocal(local());
    expect(nearby.sent).toHaveLength(2);
    expect(live.sent).toHaveLength(2);
    expect(decodeConvoyPacket(live.sent[0])?.seq).toBe(1);
    expect(decodeConvoyPacket(live.sent[1])?.seq).toBe(2);
    expect(decodeConvoyPacket(live.sent[0])?.reporterId).toBe('me000001');
  });

  it('uses the mesh only while offline', async () => {
    const { nearby, live, coordinator } = setup(false);
    expect(await coordinator.submitLocal(local())).toEqual([
      { channel: 'mesh', ok: true },
    ]);
    expect(nearby.sent).toHaveLength(1);
    expect(live.sent).toHaveLength(0);
  });

  it('delivers a peer alert once, relays it, and ignores echoes of its own', () => {
    const { nearby, live, heard } = setup();
    const wire = encodeConvoyPacket(
      alertFixture({ reporterId: 'peer0001', subjectId: 'peer0001' }),
      3,
    );
    nearby.deliver(bytesToBase64(wire));
    nearby.deliver(bytesToBase64(wire));
    live.deliver(wire);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      subjectId: 'peer0001',
      eventType: 'BREAKDOWN',
    });
    expect(nearby.sent).toHaveLength(1);
    expect(
      decodeConvoyPacket(base64ToBytes(nearby.sent[0], 72) as Uint8Array)?.hops,
    ).toBe(2);
    expect(live.sent).toHaveLength(1); // a nearby ingress also goes to the cloud when online

    nearby.deliver(
      bytesToBase64(
        encodeConvoyPacket(alertFixture({ reporterId: 'me000001' })),
      ),
    );
    expect(heard).toHaveLength(1);
  });

  it('does not relay when the hop budget is spent, and drops stale packets', () => {
    const { nearby, heard } = setup();
    nearby.deliver(
      bytesToBase64(
        encodeConvoyPacket(alertFixture({ reporterId: 'peer0001', seq: 1 }), 0),
      ),
    );
    expect(heard).toHaveLength(1);
    expect(nearby.sent).toHaveLength(0);
    nearby.deliver(
      bytesToBase64(
        encodeConvoyPacket(
          alertFixture({
            reporterId: 'peer0001',
            seq: 2,
            timestamp: NOW - 60_000,
          }),
        ),
      ),
    );
    expect(heard).toHaveLength(1);
  });

  it('remembers that a peer already reported a rider, until it recovers', () => {
    const { nearby, coordinator, advance } = setup();
    const lost = alertFixture({
      reporterId: 'peer0001',
      subjectId: 'dave0001',
      eventType: 'LOST_CONTACT',
    });
    expect(coordinator.heardRecently('dave0001', 'LOST_CONTACT')).toBe(false);
    nearby.deliver(bytesToBase64(encodeConvoyPacket(lost)));
    expect(coordinator.heardRecently('dave0001', 'LOST_CONTACT')).toBe(true);
    advance(61_000);
    expect(coordinator.heardRecently('dave0001', 'LOST_CONTACT')).toBe(false);
    nearby.deliver(
      bytesToBase64(
        encodeConvoyPacket({ ...lost, seq: 9, timestamp: NOW + 61_000 }),
      ),
    );
    expect(coordinator.heardRecently('dave0001', 'LOST_CONTACT')).toBe(true);
    nearby.deliver(
      bytesToBase64(
        encodeConvoyPacket({
          ...lost,
          seq: 10,
          timestamp: NOW + 61_000,
          recovered: true,
        }),
      ),
    );
    expect(coordinator.heardRecently('dave0001', 'LOST_CONTACT')).toBe(false);
  });
});

describe('alert list and text', () => {
  it('keeps the more severe alert for a rider and clears only the matching one', () => {
    let list = upsertAlert([], packAlert({ eventType: 'SEPARATION' }));
    list = upsertAlert(list, packAlert({ eventType: 'LOST_CONTACT' }));
    expect(list.map(a => a.eventType)).toEqual(['SEPARATION']);
    list = upsertAlert(list, packAlert({ eventType: 'BREAKDOWN' }));
    expect(list.map(a => a.eventType)).toEqual(['BREAKDOWN']);
    expect(removeAlert(list, 'abc12345', 'SEPARATION')).toHaveLength(1);
    expect(removeAlert(list, 'abc12345', 'BREAKDOWN')).toHaveLength(0);
  });

  it('features the most severe, then the newest, and expires old alerts', () => {
    const list = [
      packAlert({ key: 'a', eventType: 'LOST_CONTACT', at: NOW + 5 }),
      packAlert({ key: 'b', eventType: 'SEPARATION', at: NOW }),
      packAlert({ key: 'c', eventType: 'SEPARATION', at: NOW + 1 }),
    ];
    expect(mostSevere(list)?.key).toBe('c');
    expect(mostSevere([])).toBeNull();
    expect(expireAlerts(list, NOW + 16 * 60_000)).toEqual([]);
    expect(expireAlerts(list, NOW + 1000)).toHaveLength(3);
  });

  it('describes each kind of alert', () => {
    expect(describeAlert(packAlert(), NOW)).toEqual({
      title: 'Alex stopped',
      detail: '820 m from the group',
    });
    expect(
      describeAlert(
        packAlert({ eventType: 'SEPARATION', distanceMeters: 1240 }),
        NOW,
      ).title,
    ).toBe('Alex separated 1.2 km from the group');
    expect(
      describeAlert(
        packAlert({ eventType: 'SEPARATION', self: true, distanceMeters: 640 }),
        NOW,
      ).title,
    ).toBe('You are separated 640 m from the group');
    expect(
      describeAlert(
        packAlert({
          eventType: 'LOST_CONTACT',
          lastSeenAt: NOW - 45_000,
          distanceMeters: null,
        }),
        NOW,
      ),
    ).toEqual({ title: 'Alex lost contact', detail: 'Last seen 45s ago' });
    expect(
      describeAlert(
        packAlert({ key: GROUP_SILENT_KEY, eventType: 'LOST_CONTACT' }),
        NOW,
      ).title,
    ).toBe('No contact with the group');
  });

  it('never speaks an app hazard word, so the recogniser cannot hear its own warning', () => {
    const lines = [
      spokenLine(packAlert()),
      spokenLine(packAlert({ eventType: 'SEPARATION' })),
      spokenLine(packAlert({ eventType: 'LOST_CONTACT' })),
      spokenLine(packAlert({ self: true })),
      spokenLine(packAlert({ self: true, eventType: 'SEPARATION' })),
      spokenLine(
        packAlert({ key: GROUP_SILENT_KEY, eventType: 'LOST_CONTACT' }),
      ),
    ];
    for (const line of lines) {
      expect({ line, hazards: extractHazards(line) }).toEqual({
        line,
        hazards: [],
      });
    }
  });
});

describe('native event decoders', () => {
  const native = {
    eventType: 'SEPARATION',
    riderId: 'self',
    riderName: null,
    self: true,
    lastKnownLat: 12.9,
    lastKnownLng: 77.5,
    speedKmh: 40,
    distanceMeters: 650,
    groupSpeedKmh: 55,
    lastSeenAt: null,
    groupSilent: false,
    timestamp: NOW,
  };

  it('decodes a well-formed alert', () => {
    expect(decodePackAlert(native)).toMatchObject({
      eventType: 'SEPARATION',
      self: true,
      distanceMeters: 650,
    });
  });

  it('keeps a position only as a valid pair', () => {
    expect(decodePackAlert({ ...native, lastKnownLat: 95 })).toMatchObject({
      lastKnownLat: null,
      lastKnownLng: null,
    });
    expect(decodePackAlert({ ...native, lastKnownLng: null })).toMatchObject({
      lastKnownLat: null,
    });
  });

  it.each([
    ['not an object', 'x'],
    ['bad type', { ...native, eventType: 'NOPE' }],
    ['no rider', { ...native, riderId: '' }],
    ['no time', { ...native, timestamp: 'now' }],
  ])('drops a malformed alert: %s', (_name, raw) => {
    expect(decodePackAlert(raw)).toBeNull();
  });

  it('decodes recoveries and rider state', () => {
    expect(
      decodePackRecovered({
        eventType: 'BREAKDOWN',
        riderId: 'self',
        timestamp: NOW,
      }),
    ).toMatchObject({
      eventType: 'BREAKDOWN',
    });
    expect(
      decodePackRecovered({ eventType: 'X', riderId: 'self', timestamp: NOW }),
    ).toBeNull();
    expect(
      decodeRiderState({
        state: 'RIDER_STOPPED',
        timestamp: NOW,
        latitude: 1,
        longitude: 2,
      }),
    ).toEqual({
      state: 'RIDER_STOPPED',
      timestamp: NOW,
      latitude: 1,
      longitude: 2,
    });
    expect(decodeRiderState({ state: 'PARKED', timestamp: NOW })).toBeNull();
  });
});

describe('PackAlertCard', () => {
  it('shows who, what and how far, and dismisses with one tap', () => {
    const onDismiss = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <PackAlertCard
          alert={packAlert()}
          moreCount={2}
          top={100}
          now={NOW}
          onDismiss={onDismiss}
        />,
      );
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('Alex stopped');
    expect(text).toContain('820 m from the group');
    expect(text).toContain('+2 more');
    const press = tree.root.findAll(
      n =>
        n.props.testID === 'pack-alert-dismiss' &&
        typeof n.props.onPress === 'function',
    );
    ReactTestRenderer.act(() => press[0].props.onPress());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('usePackSeparation', () => {
  const peerAlert = (alert: ConvoyAlert) =>
    ReactTestRenderer.act(() => {
      emitPeerConvoyAlert(alert);
    });

  const originalOS = Platform.OS;
  let updatePackPeers: jest.Mock;
  let submitLocal: jest.Mock;
  let heardRecently: jest.Mock;
  let announce: jest.Mock;
  let latest: { current: ReturnType<typeof usePackSeparation> | null };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    (Platform as { OS: string }).OS = 'android';
    updatePackPeers = jest.fn(() => Promise.resolve(true));
    (NativeModules as Record<string, unknown>).CrashDetection = {
      updatePackPeers,
    };
    submitLocal = jest.fn(() => Promise.resolve([]));
    heardRecently = jest.fn(() => false);
    announce = jest.fn(() => Promise.resolve());
    latest = { current: null };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).CrashDetection;
  });

  const peers = [
    {
      id: 'p1',
      name: 'Dave',
      latitude: 12,
      longitude: 77,
      speedMps: 12,
      timestamp: 1,
    },
  ];

  function mount() {
    function Probe() {
      latest.current = usePackSeparation({
        peers,
        selfId: 'me000001',
        selfName: 'Alex',
        coordinator: { submitLocal, heardRecently, subscribe: () => () => {} },
        announce,
      });
      return null;
    }
    ReactTestRenderer.act(() => {
      ReactTestRenderer.create(<Probe />);
    });
  }

  const nativeAlert = (over = {}) => ({
    eventType: 'BREAKDOWN',
    riderId: 'self',
    riderName: null,
    self: true,
    lastKnownLat: 12.5,
    lastKnownLng: 77.5,
    speedKmh: 0,
    distanceMeters: 300,
    groupSpeedKmh: 50,
    lastSeenAt: null,
    groupSilent: false,
    timestamp: NOW,
    ...over,
  });

  it('hands the peers to the native detector every second', () => {
    mount();
    expect(updatePackPeers).toHaveBeenCalledTimes(1);
    expect(updatePackPeers).toHaveBeenLastCalledWith(peers);
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(updatePackPeers).toHaveBeenCalledTimes(4);
  });

  it("broadcasts this rider's own breakdown to the group and shows it", () => {
    mount();
    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit(PACK_SEPARATION_EVENT, nativeAlert());
    });
    expect(submitLocal).toHaveBeenCalledTimes(1);
    expect(submitLocal.mock.calls[0][0]).toMatchObject({
      eventType: 'BREAKDOWN',
      recovered: false,
      subjectId: 'me000001',
      subjectName: 'Alex',
      lastKnownLat: 12.5,
      lastKnownLng: 77.5,
      distanceMeters: 300,
    });
    expect(latest.current?.alerts).toMatchObject([
      { key: 'me000001', eventType: 'BREAKDOWN', self: true },
    ]);
    expect(announce).toHaveBeenCalledWith('Group notified.');
  });

  it("shows a peer's alert (from the mesh) without sending it back out", () => {
    mount();
    peerAlert(
      alertFixture({
        reporterId: 'peer0001',
        subjectId: 'peer0001',
        subjectName: 'Dave',
      }),
    );
    expect(submitLocal).not.toHaveBeenCalled();
    expect(latest.current?.alerts).toMatchObject([
      {
        key: 'peer0001',
        eventType: 'BREAKDOWN',
        name: 'Dave',
        self: false,
        lat: expect.closeTo(12.971599, 5),
      },
    ]);
    expect(announce).toHaveBeenCalledWith('Heads up. Dave is not moving.');
  });

  it('turns a lost heartbeat into an alert with the last position and tells the group', () => {
    mount();
    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit(
        RIDER_LOST_CONTACT_EVENT,
        nativeAlert({
          eventType: 'LOST_CONTACT',
          riderId: 'rider-identity-0001',
          riderName: 'Dave',
          self: false,
          lastSeenAt: NOW - 31_000,
        }),
      );
    });
    const key = shortRiderId('rider-identity-0001');
    expect(latest.current?.alerts).toMatchObject([
      { key, eventType: 'LOST_CONTACT', name: 'Dave', lat: 12.5, lng: 77.5 },
    ]);
    expect(submitLocal.mock.calls[0][0]).toMatchObject({
      eventType: 'LOST_CONTACT',
      subjectId: key,
      subjectName: 'Dave',
    });
    expect(announce).toHaveBeenCalledWith('Dave is out of contact.');
  });

  it('does not repeat a lost-contact report a peer already made', () => {
    heardRecently.mockReturnValue(true);
    mount();
    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit(
        RIDER_LOST_CONTACT_EVENT,
        nativeAlert({
          eventType: 'LOST_CONTACT',
          riderId: 'p1',
          riderName: 'Dave',
          self: false,
        }),
      );
    });
    expect(latest.current?.alerts).toHaveLength(1);
    expect(submitLocal).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('shows one "no contact with the group" alert, and does not broadcast it, when everyone is silent', () => {
    mount();
    ReactTestRenderer.act(() => {
      for (const id of ['p1', 'p2']) {
        DeviceEventEmitter.emit(
          RIDER_LOST_CONTACT_EVENT,
          nativeAlert({
            eventType: 'LOST_CONTACT',
            riderId: id,
            riderName: id,
            self: false,
            groupSilent: true,
          }),
        );
      }
    });
    expect(latest.current?.alerts).toHaveLength(1);
    expect(latest.current?.alerts[0].key).toBe(GROUP_SILENT_KEY);
    expect(submitLocal).not.toHaveBeenCalled();
  });

  it('clears the alert and tells the group when the rider recovers', () => {
    mount();
    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit(PACK_SEPARATION_EVENT, nativeAlert());
    });
    submitLocal.mockClear();
    ReactTestRenderer.act(() => {
      DeviceEventEmitter.emit(PACK_RECOVERED_EVENT, {
        eventType: 'BREAKDOWN',
        riderId: 'self',
        timestamp: NOW + 20_000,
      });
    });
    expect(latest.current?.alerts).toEqual([]);
    expect(submitLocal.mock.calls[0][0]).toMatchObject({
      eventType: 'BREAKDOWN',
      recovered: true,
      subjectId: 'me000001',
    });
  });

  it("clears a peer's alert when its recovery arrives, and dismisses on demand", () => {
    mount();
    peerAlert(alertFixture({ reporterId: 'peer0001', subjectId: 'peer0001' }));
    expect(latest.current?.alerts).toHaveLength(1);
    peerAlert(
      alertFixture({
        reporterId: 'peer0001',
        subjectId: 'peer0001',
        recovered: true,
      }),
    );
    expect(latest.current?.alerts).toHaveLength(0);
    peerAlert(alertFixture({ reporterId: 'peer0002', subjectId: 'peer0002' }));
    ReactTestRenderer.act(() => latest.current?.dismiss('peer0002'));
    expect(latest.current?.alerts).toHaveLength(0);
    expect(submitLocal).not.toHaveBeenCalled();
  });

  it('expires alerts nobody cleared', () => {
    mount();
    peerAlert(alertFixture({ reporterId: 'peer0001', subjectId: 'peer0001' }));
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(16 * 60_000);
    });
    expect(latest.current?.alerts).toHaveLength(0);
  });
});
