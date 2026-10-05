import { HAZARD_TTL_MS, HazardSyncQueue } from '../src/services/hazardSyncQueue';
import type { HazardEventPacket } from '../src/types/telemetry';

const NOW = 1_800_000_000_000;

const hazard = (over: Partial<HazardEventPacket> = {}): HazardEventPacket => ({
  type: 'HAZARD_EVENT',
  hazardId: 'h1',
  hazardType: 'pothole',
  originRiderId: 'alex',
  riderName: 'Alex',
  senderId: 'alex',
  latitude: 17.385,
  longitude: 78.4867,
  timestamp: NOW,
  ttl: 5,
  visitedNodes: ['alex'],
  ...over,
});

describe('HazardSyncQueue.add', () => {
  it('accepts a fresh hazard and reports it as new', () => {
    const queue = new HazardSyncQueue(() => NOW);
    expect(queue.add(hazard())).toBe(true);
    expect(queue.active().map(h => h.hazardId)).toEqual(['h1']);
  });

  it('refuses a duplicate id without disturbing the original', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard());
    expect(queue.add(hazard({ timestamp: NOW + 1000 }))).toBe(false);
    expect(queue.active()).toHaveLength(1);
    expect(queue.active()[0].timestamp).toBe(NOW);
  });

  it('refuses a hazard that is already older than the TTL on arrival', () => {
    const queue = new HazardSyncQueue(() => NOW);
    expect(queue.add(hazard({ timestamp: NOW - HAZARD_TTL_MS - 1 }))).toBe(false);
    expect(queue.active()).toHaveLength(0);
  });

  it('accepts a hazard exactly at the TTL boundary', () => {
    const queue = new HazardSyncQueue(() => NOW);
    expect(queue.add(hazard({ timestamp: NOW - HAZARD_TTL_MS }))).toBe(true);
  });
});

describe('hasSeen', () => {
  it('stays true for an id even after the hazard itself expires', () => {
    let now = NOW;
    const queue = new HazardSyncQueue(() => now);
    queue.add(hazard());
    now = NOW + HAZARD_TTL_MS + 1;
    expect(queue.active()).toHaveLength(0); // expired out of the active list
    expect(queue.hasSeen('h1')).toBe(true); // but never re-admitted as "new"
    expect(queue.add(hazard({ timestamp: now }))).toBe(false);
  });

  it('is false for an id never seen', () => {
    expect(new HazardSyncQueue(() => NOW).hasSeen('never-seen')).toBe(false);
  });
});

describe('active', () => {
  it('lists hazards newest first', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard({ hazardId: 'old', timestamp: NOW - 1000 }));
    queue.add(hazard({ hazardId: 'new', timestamp: NOW }));
    expect(queue.active().map(h => h.hazardId)).toEqual(['new', 'old']);
  });

  it('drops expired hazards from the list but keeps unexpired ones', () => {
    // A clock that advances, so a hazard admitted fresh can be aged past its TTL and pruned --
    // add() refuses anything already stale on arrival, so that's the only way to produce this.
    let now = NOW;
    const queue = new HazardSyncQueue(() => now);
    queue.add(hazard({ hazardId: 'will-expire' }));
    now = NOW + HAZARD_TTL_MS + 1;
    queue.add(hazard({ hazardId: 'fresh', timestamp: now }));
    expect(queue.active().map(h => h.hazardId)).toEqual(['fresh']);
  });

  it('is empty when nothing has been added', () => {
    expect(new HazardSyncQueue(() => NOW).active()).toEqual([]);
  });
});

describe('per-peer receipt tracking', () => {
  it('starts with no peer marked as having received anything', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard());
    expect(queue.hasReceivedBy('h1', 'bilal')).toBe(false);
  });

  it('marks and reports receipt independently per peer', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard());
    queue.markReceivedBy('h1', 'bilal');
    expect(queue.hasReceivedBy('h1', 'bilal')).toBe(true);
    expect(queue.hasReceivedBy('h1', 'casey')).toBe(false);
  });

  it('forgetPeer clears only that peer, for every hazard', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard({ hazardId: 'h1' }));
    queue.add(hazard({ hazardId: 'h2', timestamp: NOW + 1 }));
    queue.markReceivedBy('h1', 'bilal');
    queue.markReceivedBy('h2', 'bilal');
    queue.markReceivedBy('h1', 'casey');

    queue.forgetPeer('bilal');

    expect(queue.hasReceivedBy('h1', 'bilal')).toBe(false);
    expect(queue.hasReceivedBy('h2', 'bilal')).toBe(false);
    expect(queue.hasReceivedBy('h1', 'casey')).toBe(true); // untouched
  });
});

describe('popNextForPeer (the gentle, one-at-a-time reconnect flush)', () => {
  it('returns null for a peer with nothing pending', () => {
    const queue = new HazardSyncQueue(() => NOW);
    expect(queue.popNextForPeer('bilal')).toBeNull();
  });

  it('hands back exactly one hazard per call, not everything at once', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard({ hazardId: 'h1', timestamp: NOW }));
    queue.add(hazard({ hazardId: 'h2', timestamp: NOW + 1000 }));
    queue.add(hazard({ hazardId: 'h3', timestamp: NOW + 2000 }));

    const first = queue.popNextForPeer('bilal');
    expect(first?.hazardId).toBe('h1');
    // calling again immediately does not also hand back h2 and h3 -- the caller controls pacing.
    expect(queue.pendingCountForPeer('bilal')).toBe(2);
  });

  it('delivers oldest-first, so a catching-up rider sees events in the order they happened', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard({ hazardId: 'newest', timestamp: NOW + 2000 }));
    queue.add(hazard({ hazardId: 'oldest', timestamp: NOW }));
    queue.add(hazard({ hazardId: 'middle', timestamp: NOW + 1000 }));

    expect(queue.popNextForPeer('bilal')?.hazardId).toBe('oldest');
    expect(queue.popNextForPeer('bilal')?.hazardId).toBe('middle');
    expect(queue.popNextForPeer('bilal')?.hazardId).toBe('newest');
    expect(queue.popNextForPeer('bilal')).toBeNull();
  });

  it('skips hazards already marked received by that peer (e.g. they reported one themselves)', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard({ hazardId: 'h1', timestamp: NOW }));
    queue.add(hazard({ hazardId: 'h2', timestamp: NOW + 1000 }));
    queue.markReceivedBy('h1', 'bilal');

    expect(queue.popNextForPeer('bilal')?.hazardId).toBe('h2');
    expect(queue.popNextForPeer('bilal')).toBeNull();
  });

  it('tracks each peer independently', () => {
    const queue = new HazardSyncQueue(() => NOW);
    queue.add(hazard({ hazardId: 'h1' }));
    queue.popNextForPeer('bilal');
    expect(queue.pendingCountForPeer('bilal')).toBe(0);
    expect(queue.pendingCountForPeer('casey')).toBe(1);
  });

  it('never hands back an expired hazard', () => {
    let now = NOW;
    const queue = new HazardSyncQueue(() => now);
    queue.add(hazard({ hazardId: 'h1' }));
    now = NOW + HAZARD_TTL_MS + 1;
    expect(queue.popNextForPeer('bilal')).toBeNull();
  });
});

describe('a realistic reconnect scenario', () => {
  it('a rider offline for three hazards gets exactly those three, in order, one per call', () => {
    const queue = new HazardSyncQueue(() => NOW);
    // Three hazards happen while "bilal" is out of range.
    queue.add(hazard({ hazardId: 'pothole-1', hazardType: 'pothole', timestamp: NOW }));
    queue.add(hazard({ hazardId: 'accident-1', hazardType: 'accident', timestamp: NOW + 60_000 }));
    queue.add(hazard({ hazardId: 'obstacle-1', hazardType: 'obstacle', timestamp: NOW + 120_000 }));

    // bilal reconnects; the mesh manager calls popNextForPeer once per spacing interval.
    const delivered: string[] = [];
    for (;;) {
      const next = queue.popNextForPeer('bilal');
      if (!next) break;
      delivered.push(next.hazardId);
    }

    expect(delivered).toEqual(['pothole-1', 'accident-1', 'obstacle-1']);
    expect(queue.pendingCountForPeer('bilal')).toBe(0);
  });
});
