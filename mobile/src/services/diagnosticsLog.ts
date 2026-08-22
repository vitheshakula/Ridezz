import {
  appendDiagnosticEvent,
  type DiagnosticEvent,
  type DiagnosticEventType,
} from '../utils/diagnostics';

/** In-memory-only session diagnostics: a small bounded log of operational events
 * (joins, leaves, reconnects, location state) so a rider can glance at what
 * happened without needing adb during a ride. Deliberately module-scoped (not
 * per-screen state) so the log survives switching tabs, leaving the ride, and
 * returning to the Join screen within the same app session -- and just as
 * deliberately not persisted anywhere, since it resets on app restart and is
 * never sent anywhere. */
let events: DiagnosticEvent[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function logDiagnosticEvent(type: DiagnosticEventType, message: string): void {
  events = appendDiagnosticEvent(events, { type, message, timestamp: Date.now() });
  notify();
}

export function getDiagnosticEvents(): DiagnosticEvent[] {
  return events;
}

export function subscribeToDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
