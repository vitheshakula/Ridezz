import { ConnectionQuality } from 'livekit-client';
import {
  MAX_RIDERS,
  connectionQualityLabel,
  diffPresence,
  isRoomOverCapacity,
  riderStatusLabel,
  sortByJoinOrder,
  type RiderIdentity,
} from '../src/utils/riderPresence';

describe('isRoomOverCapacity', () => {
  test('1 rider is under capacity', () => {
    expect(isRoomOverCapacity(1, MAX_RIDERS)).toBe(false);
  });

  test('2 riders is under capacity', () => {
    expect(isRoomOverCapacity(2, MAX_RIDERS)).toBe(false);
  });

  test('exactly 10 riders is at, not over, capacity', () => {
    expect(isRoomOverCapacity(10, MAX_RIDERS)).toBe(false);
  });

  test('an 11th rider is over capacity', () => {
    expect(isRoomOverCapacity(11, MAX_RIDERS)).toBe(true);
  });
});

describe('sortByJoinOrder', () => {
  test('orders riders oldest joinedAt first', () => {
    const riders = [
      { identity: 'c', joinedAt: new Date(3000) },
      { identity: 'a', joinedAt: new Date(1000) },
      { identity: 'b', joinedAt: new Date(2000) },
    ];
    expect(sortByJoinOrder(riders).map(r => r.identity)).toEqual(['a', 'b', 'c']);
  });

  test('does not mutate the input array', () => {
    const riders = [{ identity: 'b', joinedAt: new Date(2) }, { identity: 'a', joinedAt: new Date(1) }];
    const original = [...riders];
    sortByJoinOrder(riders);
    expect(riders).toEqual(original);
  });

  test('handles 10 riders without dropping any', () => {
    const riders = Array.from({ length: 10 }, (_, i) => ({
      identity: `rider-${i}`,
      joinedAt: new Date(10 - i),
    }));
    const sorted = sortByJoinOrder(riders);
    expect(sorted).toHaveLength(10);
    expect(sorted[0].identity).toBe('rider-9');
    expect(sorted[9].identity).toBe('rider-0');
  });
});

describe('diffPresence', () => {
  function rider(identity: string): RiderIdentity {
    return { identity, name: identity };
  }

  test('a first-time rider produces a joined event', () => {
    const seen = new Set<string>();
    const events = diffPresence([], [rider('rahul')], seen);
    expect(events).toEqual([{ type: 'joined', name: 'rahul' }]);
    expect(seen.has('rahul')).toBe(true);
  });

  test('a rider leaving produces a left event', () => {
    const seen = new Set<string>(['rahul']);
    const events = diffPresence([rider('rahul')], [], seen);
    expect(events).toEqual([{ type: 'left', name: 'rahul' }]);
  });

  test('a previously-seen identity reappearing produces a rejoined event, not joined', () => {
    const seen = new Set<string>(['rahul']);
    const events = diffPresence([], [rider('rahul')], seen);
    expect(events).toEqual([{ type: 'rejoined', name: 'rahul' }]);
  });

  test('no change produces no events', () => {
    const seen = new Set<string>(['rahul']);
    const events = diffPresence([rider('rahul')], [rider('rahul')], seen);
    expect(events).toEqual([]);
  });

  test('going from 1 to 2 riders only announces the new one', () => {
    const seen = new Set<string>(['rahul']);
    const events = diffPresence([rider('rahul')], [rider('rahul'), rider('sai')], seen);
    expect(events).toEqual([{ type: 'joined', name: 'sai' }]);
  });

  test('filling a room from 0 to 10 riders announces all 10 joins', () => {
    const seen = new Set<string>();
    const riders = Array.from({ length: 10 }, (_, i) => rider(`rider-${i}`));
    const events = diffPresence([], riders, seen);
    expect(events).toHaveLength(10);
    expect(events.every(e => e.type === 'joined')).toBe(true);
    expect(seen.size).toBe(10);
  });
});

describe('connectionQualityLabel', () => {
  test('Excellent produces no label', () => {
    expect(connectionQualityLabel(ConnectionQuality.Excellent)).toBeNull();
  });

  test('Good produces no label', () => {
    expect(connectionQualityLabel(ConnectionQuality.Good)).toBeNull();
  });

  test('Unknown produces no label', () => {
    expect(connectionQualityLabel(ConnectionQuality.Unknown)).toBeNull();
  });

  test('Poor is labeled', () => {
    expect(connectionQualityLabel(ConnectionQuality.Poor)).toBe('Poor connection');
  });

  test('Lost is labeled distinctly from Poor', () => {
    expect(connectionQualityLabel(ConnectionQuality.Lost)).toBe('Connection lost');
  });
});

describe('riderStatusLabel', () => {
  test('muted takes priority over speaking', () => {
    expect(riderStatusLabel(true, true, null)).toBe('Muted');
  });

  test('speaking shows when not muted', () => {
    expect(riderStatusLabel(false, true, null)).toBe('Speaking');
  });

  test('falls back to the quality label when idle and unmuted', () => {
    expect(riderStatusLabel(false, false, 'Poor connection')).toBe('Poor connection');
  });

  test('shows nothing when idle, unmuted, and quality is fine', () => {
    expect(riderStatusLabel(false, false, null)).toBeNull();
  });
});
