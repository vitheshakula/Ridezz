import {
  appendDiagnosticEvent,
  type DiagnosticEvent,
  type DiagnosticEventType,
} from '../utils/diagnostics';

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
