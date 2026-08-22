import { useSyncExternalStore } from 'react';
import {
  getDiagnosticEvents,
  subscribeToDiagnostics,
} from '../services/diagnosticsLog';
import type { DiagnosticEvent } from '../utils/diagnostics';

/** Live-subscribes to the module-scoped diagnostics log. */
export function useDiagnosticsLog(): DiagnosticEvent[] {
  return useSyncExternalStore(subscribeToDiagnostics, getDiagnosticEvents);
}
