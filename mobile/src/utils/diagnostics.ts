export type DiagnosticEventType =
  | 'joined_room'
  | 'connection_lost'
  | 'reconnected'
  | 'rider_joined'
  | 'rider_left'
  | 'location_started'
  | 'location_permission_unavailable'
  | 'location_paused'
  | 'location_resumed';

export interface DiagnosticEvent {
  type: DiagnosticEventType;
  message: string;
  timestamp: number;
}

export const MAX_DIAGNOSTIC_EVENTS = 100;

/** Appends an event to a bounded ring buffer, dropping the oldest entries once
 * MAX_DIAGNOSTIC_EVENTS is exceeded. Only ever holds operational metadata --
 * event type, a short human-readable message, and a timestamp -- never audio,
 * conversation content, precise GPS trails, keys, or tokens (see call sites). */
export function appendDiagnosticEvent(
  events: DiagnosticEvent[],
  event: DiagnosticEvent,
): DiagnosticEvent[] {
  const next = [...events, event];
  return next.length > MAX_DIAGNOSTIC_EVENTS
    ? next.slice(next.length - MAX_DIAGNOSTIC_EVENTS)
    : next;
}
