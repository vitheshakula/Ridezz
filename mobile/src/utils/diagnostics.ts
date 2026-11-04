export type DiagnosticEventType =
  | 'joined_room'
  | 'connection_lost'
  | 'reconnected'
  | 'rider_joined'
  | 'rider_left'
  | 'location_started'
  | 'location_permission_unavailable'
  | 'location_paused'
  | 'location_resumed'
  | 'location_fix_received'
  | 'location_error'
  | 'mesh_hazard_received'
  | 'remote_participant_disconnected'
  | 'remote_location_resumed'
  | 'mesh_protocol'
  | 'crash_sensors'
  | 'crash_decision'
  | 'crash_countdown'
  | 'crash_sos'
  | 'braking';

export interface DiagnosticEvent {
  type: DiagnosticEventType;
  message: string;
  timestamp: number;
}

export const MAX_DIAGNOSTIC_EVENTS = 100;

export function appendDiagnosticEvent(
  events: DiagnosticEvent[],
  event: DiagnosticEvent,
): DiagnosticEvent[] {
  const next = [...events, event];
  return next.length > MAX_DIAGNOSTIC_EVENTS
    ? next.slice(next.length - MAX_DIAGNOSTIC_EVENTS)
    : next;
}
