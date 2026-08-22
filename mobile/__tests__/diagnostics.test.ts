import {
  appendDiagnosticEvent,
  MAX_DIAGNOSTIC_EVENTS,
  type DiagnosticEvent,
} from '../src/utils/diagnostics';

function makeEvent(message: string, timestamp = 1000): DiagnosticEvent {
  return { type: 'joined_room', message, timestamp };
}

describe('appendDiagnosticEvent', () => {
  it('appends to an empty log', () => {
    const result = appendDiagnosticEvent([], makeEvent('a'));
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('a');
  });

  it('preserves order, oldest first', () => {
    const result = appendDiagnosticEvent(
      [makeEvent('a', 1), makeEvent('b', 2)],
      makeEvent('c', 3),
    );
    expect(result.map(e => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const original = [makeEvent('a')];
    appendDiagnosticEvent(original, makeEvent('b'));
    expect(original).toHaveLength(1);
  });

  it('drops the oldest event once MAX_DIAGNOSTIC_EVENTS is exceeded', () => {
    let events: DiagnosticEvent[] = [];
    for (let i = 0; i < MAX_DIAGNOSTIC_EVENTS; i++) {
      events = appendDiagnosticEvent(events, makeEvent(`event-${i}`, i));
    }
    expect(events).toHaveLength(MAX_DIAGNOSTIC_EVENTS);

    events = appendDiagnosticEvent(events, makeEvent('overflow', MAX_DIAGNOSTIC_EVENTS));
    expect(events).toHaveLength(MAX_DIAGNOSTIC_EVENTS);
    expect(events[0].message).toBe('event-1');
    expect(events[events.length - 1].message).toBe('overflow');
  });
});
