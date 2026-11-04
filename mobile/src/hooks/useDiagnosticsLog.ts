import { useSyncExternalStore } from 'react';
import { getDiagnosticEvents, subscribeToDiagnostics } from '../services/diagnosticsLog';
import type { DiagnosticEvent } from '../utils/diagnostics';

export function useDiagnosticsLog(): DiagnosticEvent[] {
  return useSyncExternalStore(subscribeToDiagnostics, getDiagnosticEvents);
}
