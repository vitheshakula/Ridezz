import {
  createHazardEventPacket,
  createMeshSyncManager,
  shouldRelay,
  TELEMETRY_PING_INTERVAL_MS,
} from '../src/services/meshSyncManager';
import { RECONNECT_FLUSH_SPACING_MS } from '../src/services/hazardSyncQueue';
import type { HazardEventPacket, MeshPacket, RiderNode } from '../src/types/telemetry';

const NOW = 1_800_000_000_000;
const HYD: RiderNode = { riderId: 'bilal', latitude: 17.4, longitude: 78.48, timestampMs: NOW };

const hazard = (over: Partial<HazardEventPacket> = {}): HazardEventPacket => ({
  type: 'HAZARD_EVENT',
  hazardId: 'h1',
  originRiderId: 'alex',
  riderName: 'Alex',
  senderId: 'alex',
  hazardType: 'pothole',
  latitude: 17.385,
  longitude: 78.4867,
  visitedNodes: ['alex'],
  ttl: 5,
  timestamp: NOW,
  ...over,
});

describe('createHazardEventPacket', () => {
  it('starts at max ttl with only the raiser in visitedNodes', () => {
    const packet = createHazardEventPacket('pothole', 'alex', 'Alex', { latitude: 1, longitude: 2 }, NOW);
    expect(packet).toMatchObject({
      type: 'HAZARD_EVENT',
      originRiderId: 'alex',
      riderName: 'Alex',
      senderId: 'alex',
      hazardType: 'pothole',
      visitedNodes: ['alex'],
      ttl: 5,
      timestamp: NOW,
    });
  });

  it('gives two hazards raised at different times different ids', () => {
    const a = createHazardEventPacket('pothole', 'alex', 'Alex', { latitude: 1, longitude: 2 }, NOW);
    const b = createHazardEventPacket('pothole', 'alex', 'Alex', { latitude: 1, longitude: 2 }, NOW + 1);
    expect(a.hazardId).not.toBe(b.hazardId);
  });
});

describe('shouldRelay', () => {
  it('never relays once ttl is spent', () => {
    expect(shouldRelay(hazard({ ttl: 0 }), 'bilal', [HYD])).toBe(false);
  });

  it('never relays a hazard that has already passed through us', () => {
    expect(shouldRelay(hazard({ visitedNodes: ['alex', 'bilal'] }), 'bilal', [HYD])).toBe(false);
  });

  it('does not relay when no known rider still needs it', () => {
    expect(shouldRelay(hazard(), 'bilal', [])).toBe(false);
  });

  it('relays when a known rider has not seen it yet', () => {
    const casey: RiderNode = { riderId: 'casey', latitude: 17.39, longitude: 78.49, timestampMs: NOW };
    expect(shouldRelay(hazard(), 'bilal', [casey])).toBe(true);
  });

  it('does not relay when every known rider is already in visitedNodes', () => {
    const casey: RiderNode = { riderId: 'casey', latitude: 17.39, longitude: 78.49, timestampMs: NOW };
    expect(shouldRelay(hazard({ visitedNodes: ['alex', 'casey'] }), 'bilal', [casey])).toBe(false);
  });
});

function harness(selfRiderId: string, location: { latitude: number; longitude: number } | null = { latitude: 17.4, longitude: 78.48 }) {
  const sent: MeshPacket[] = [];
  const ridersSeen: RiderNode[][] = [];
  const hazardsSeen: HazardEventPacket[] = [];
  let currentLocation = location;

  const manager = createMeshSyncManager({
    selfRiderId,
    selfRiderName: selfRiderId,
    send: packet => sent.push(packet),
    getLocation: () => currentLocation,
    onRidersChanged: riders => ridersSeen.push(riders),
    onHazardReceived: h => hazardsSeen.push(h),
    now: () => NOW,
  });

  return {
    manager,
    sent,
    ridersSeen,
    hazardsSeen,
    setLocation: (loc: typeof currentLocation) => {
      currentLocation = loc;
    },
  };
}

describe('telemetry duty cycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends an immediate ping on start, then one every pingIntervalMs', () => {
    const { manager, sent } = harness('alex');
    manager.start();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'TELEMETRY_PING', riderId: 'alex' });

    jest.advanceTimersByTime(TELEMETRY_PING_INTERVAL_MS);
    expect(sent).toHaveLength(2);

    manager.stop();
    jest.advanceTimersByTime(TELEMETRY_PING_INTERVAL_MS * 3);
    expect(sent).toHaveLength(2); // stopped -- no more pings
  });

  it('skips a ping when no GPS fix is available yet', () => {
    const { manager, sent } = harness('alex', null);
    manager.start();
    expect(sent).toHaveLength(0);
  });
});

describe('handlePacket: TELEMETRY_PING', () => {
  it('adds a newly heard rider and notifies', () => {
    const { manager, ridersSeen } = harness('alex');
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'bilal', riderName: 'Bilal', latitude: 1, longitude: 2, timestamp: NOW });
    expect(manager.getKnownRiders()).toEqual([
      { riderId: 'bilal', riderName: 'Bilal', latitude: 1, longitude: 2, timestampMs: NOW },
    ]);
    expect(ridersSeen).toHaveLength(1);
  });

  it('ignores a ping older than or equal to the one already known for that rider', () => {
    const { manager, ridersSeen } = harness('alex');
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'bilal', riderName: 'Bilal', latitude: 1, longitude: 2, timestamp: NOW });
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'bilal', riderName: 'Bilal', latitude: 9, longitude: 9, timestamp: NOW });
    expect(manager.getKnownRiders()[0]).toEqual({ riderId: 'bilal', riderName: 'Bilal', latitude: 1, longitude: 2, timestampMs: NOW });
    expect(ridersSeen).toHaveLength(1); // second ping did not fire another notification
  });

  it('accepts a strictly newer ping and updates position', () => {
    const { manager } = harness('alex');
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'bilal', riderName: 'Bilal', latitude: 1, longitude: 2, timestamp: NOW });
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'bilal', riderName: 'Bilal', latitude: 9, longitude: 9, timestamp: NOW + 1 });
    expect(manager.getKnownRiders()[0].latitude).toBe(9);
  });

  it('keeps the previously known name if a later ping somehow omits one', () => {
    const { manager } = harness('alex');
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'bilal', riderName: 'Bilal', latitude: 1, longitude: 2, timestamp: NOW });
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'bilal', riderName: '', latitude: 9, longitude: 9, timestamp: NOW + 1 });
    expect(manager.getKnownRiders()[0].riderName).toBe('Bilal');
  });
});

describe('handlePacket: HAZARD_EVENT', () => {
  it('records a new hazard and notifies once', () => {
    const { manager, hazardsSeen } = harness('bilal');
    manager.handlePacket(hazard());
    expect(hazardsSeen).toHaveLength(1);
    expect(manager.getHazardQueue().hasSeen('h1')).toBe(true);
  });

  it('drops an exact duplicate without re-notifying', () => {
    const { manager, hazardsSeen } = harness('bilal');
    manager.handlePacket(hazard());
    manager.handlePacket(hazard());
    expect(hazardsSeen).toHaveLength(1);
  });

  it('updates the origin rider\'s known position from the hazard\'s own GPS fix', () => {
    const { manager, ridersSeen } = harness('bilal');
    manager.handlePacket(hazard({ originRiderId: 'alex', riderName: 'Alex', latitude: 17.5, longitude: 78.5, timestamp: NOW }));
    expect(manager.getKnownRiders()).toEqual([
      { riderId: 'alex', riderName: 'Alex', latitude: 17.5, longitude: 78.5, timestampMs: NOW },
    ]);
    expect(ridersSeen).toHaveLength(1);
  });

  it('does not regress a rider to an older fix carried by a late-arriving hazard', () => {
    const { manager } = harness('bilal');
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'alex', riderName: 'Alex', latitude: 1, longitude: 1, timestamp: NOW + 1000 });
    manager.handlePacket(hazard({ originRiderId: 'alex', latitude: 9, longitude: 9, timestamp: NOW }));
    expect(manager.getKnownRiders()[0]).toEqual({ riderId: 'alex', riderName: 'Alex', latitude: 1, longitude: 1, timestampMs: NOW + 1000 });
  });

  it('a duplicate hazard (already seen) does not re-update the rider position or re-notify', () => {
    const { manager, ridersSeen } = harness('bilal');
    manager.handlePacket(hazard({ originRiderId: 'alex', latitude: 17.5, longitude: 78.5, timestamp: NOW }));
    ridersSeen.length = 0;
    manager.handlePacket(hazard({ originRiderId: 'alex', latitude: 99, longitude: 99, timestamp: NOW }));
    expect(manager.getKnownRiders()[0]).toMatchObject({ latitude: 17.5, longitude: 78.5 });
    expect(ridersSeen).toHaveLength(0);
  });

  it('relays onward when a known rider has not seen it, decrementing ttl and extending visitedNodes', () => {
    const { manager, sent } = harness('bilal');
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'casey', riderName: 'Casey', latitude: 17.39, longitude: 78.49, timestamp: NOW });
    manager.handlePacket(hazard());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'HAZARD_EVENT',
      hazardId: 'h1',
      senderId: 'bilal',
      ttl: 4,
      visitedNodes: ['alex', 'bilal'],
    });
  });

  it('does not relay when no known rider still needs it', () => {
    const { manager, sent } = harness('bilal');
    manager.handlePacket(hazard());
    expect(sent).toHaveLength(0);
  });

  it('never relays a packet already at ttl 0', () => {
    const { manager, sent } = harness('bilal');
    manager.handlePacket({ type: 'TELEMETRY_PING', riderId: 'casey', riderName: 'Casey', latitude: 17.39, longitude: 78.49, timestamp: NOW });
    manager.handlePacket(hazard({ ttl: 0 }));
    expect(sent).toHaveLength(0);
  });
});

describe('raiseHazard', () => {
  it('adds to the local queue and sends immediately, independent of the ping timer', () => {
    const { manager, sent } = harness('alex');
    manager.raiseHazard('accident', { latitude: 17.4, longitude: 78.48 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'HAZARD_EVENT', hazardType: 'accident', originRiderId: 'alex' });
    const sentHazard = sent[0] as HazardEventPacket;
    expect(manager.getHazardQueue().hasSeen(sentHazard.hazardId)).toBe(true);
  });

  it('a self-raised hazard that bounces back is dropped, not re-notified or re-relayed', () => {
    const { manager, sent, hazardsSeen } = harness('alex');
    manager.raiseHazard('accident', { latitude: 17.4, longitude: 78.48 });
    const raised = sent[0] as HazardEventPacket;
    sent.length = 0;

    manager.handlePacket({ ...raised, senderId: 'bilal', ttl: raised.ttl - 1, visitedNodes: [...raised.visitedNodes, 'bilal'] });

    expect(hazardsSeen).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('reconnect sync: handlePeerCountChanged + SYNC_REQUEST/SYNC_RESPONSE', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('announces itself with a SYNC_REQUEST only on a 0 -> positive peer-count transition', () => {
    const { manager, sent } = harness('alex');
    manager.handlePeerCountChanged(0); // still zero, not a reconnect
    expect(sent).toHaveLength(0);

    manager.handlePeerCountChanged(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'SYNC_REQUEST', riderId: 'alex', lastKnownHazardTimestamp: 0 });

    manager.handlePeerCountChanged(2); // already connected -- not a new reconnect
    expect(sent).toHaveLength(1);
  });

  it('reports its newest known hazard timestamp as lastKnownHazardTimestamp', () => {
    const { manager, sent } = harness('alex');
    manager.handlePacket(hazard({ hazardId: 'old', timestamp: NOW - 1000 }));
    manager.handlePacket(hazard({ hazardId: 'new', timestamp: NOW }));
    sent.length = 0;

    manager.handlePeerCountChanged(1);
    expect(sent[0]).toMatchObject({ type: 'SYNC_REQUEST', lastKnownHazardTimestamp: NOW });
  });

  it('answering a SYNC_REQUEST trickles hazards one at a time, spaced out, never all at once', () => {
    const { manager, sent } = harness('bilal');
    manager.handlePacket(hazard({ hazardId: 'h1', timestamp: NOW }));
    manager.handlePacket(hazard({ hazardId: 'h2', timestamp: NOW + 1000 }));
    manager.handlePacket(hazard({ hazardId: 'h3', timestamp: NOW + 2000 }));
    sent.length = 0;

    manager.handlePacket({ type: 'SYNC_REQUEST', riderId: 'casey', lastKnownHazardTimestamp: 0 });
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).pendingHazards.map((h: HazardEventPacket) => h.hazardId)).toEqual(['h1']);

    jest.advanceTimersByTime(RECONNECT_FLUSH_SPACING_MS);
    expect(sent).toHaveLength(2);
    expect((sent[1] as any).pendingHazards[0].hazardId).toBe('h2');

    jest.advanceTimersByTime(RECONNECT_FLUSH_SPACING_MS);
    expect(sent).toHaveLength(3);
    expect((sent[2] as any).pendingHazards[0].hazardId).toBe('h3');

    // caught up -- no more SYNC_RESPONSEs, even after more time passes.
    jest.advanceTimersByTime(RECONNECT_FLUSH_SPACING_MS * 3);
    expect(sent).toHaveLength(3);
  });

  it('skips hazards the requester already reported knowing about by their lastKnownHazardTimestamp', () => {
    const { manager, sent } = harness('bilal');
    manager.handlePacket(hazard({ hazardId: 'already-known', timestamp: NOW }));
    manager.handlePacket(hazard({ hazardId: 'missed-it', timestamp: NOW + 1000 }));
    sent.length = 0;

    manager.handlePacket({ type: 'SYNC_REQUEST', riderId: 'casey', lastKnownHazardTimestamp: NOW });
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).pendingHazards[0].hazardId).toBe('missed-it');

    jest.advanceTimersByTime(RECONNECT_FLUSH_SPACING_MS * 3);
    expect(sent).toHaveLength(1); // nothing further pending
  });

  it('does not flush at all when the requester has nothing pending', () => {
    const { manager, sent } = harness('bilal');
    manager.handlePacket({ type: 'SYNC_REQUEST', riderId: 'casey', lastKnownHazardTimestamp: 0 });
    expect(sent).toHaveLength(0);
    jest.advanceTimersByTime(RECONNECT_FLUSH_SPACING_MS * 3);
    expect(sent).toHaveLength(0);
  });

  it('ignores a SYNC_REQUEST from itself', () => {
    const { manager, sent } = harness('alex');
    manager.handlePacket(hazard());
    sent.length = 0;
    manager.handlePacket({ type: 'SYNC_REQUEST', riderId: 'alex', lastKnownHazardTimestamp: 0 });
    expect(sent).toHaveLength(0);
  });

  it('receiving a SYNC_RESPONSE feeds each hazard through the same path as a direct HAZARD_EVENT', () => {
    const { manager, hazardsSeen } = harness('casey');
    manager.handlePacket({ type: 'SYNC_RESPONSE', pendingHazards: [hazard({ hazardId: 'caught-up' })] });
    expect(hazardsSeen.map(h => h.hazardId)).toEqual(['caught-up']);
    expect(manager.getHazardQueue().hasSeen('caught-up')).toBe(true);
  });

  it('stop() cancels an in-progress flush', () => {
    const { manager, sent } = harness('bilal');
    manager.handlePacket(hazard({ hazardId: 'h1', timestamp: NOW }));
    manager.handlePacket(hazard({ hazardId: 'h2', timestamp: NOW + 1000 }));
    sent.length = 0;

    manager.handlePacket({ type: 'SYNC_REQUEST', riderId: 'casey', lastKnownHazardTimestamp: 0 });
    expect(sent).toHaveLength(1);
    manager.stop();

    jest.advanceTimersByTime(RECONNECT_FLUSH_SPACING_MS * 3);
    expect(sent).toHaveLength(1); // no further flush after stop
  });
});
