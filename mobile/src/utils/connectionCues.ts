import { ConnectionState } from 'livekit-client';

export type ConnectionCueTransition = 'lost' | 'restored' | null;

function isReconnectingState(state: ConnectionState): boolean {
  return state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting;
}

/** Classifies a connection-state change into an audible-cue-worthy transition, or
 * null for anything else (including the very first Connecting -> Connected, which
 * is a join, not a "restore"). "lost" only fires from a previously-healthy
 * Connected state, and "restored" only fires from a previously-reconnecting state --
 * so a cue never fires for the initial connect, and never repeats for the same
 * ongoing reconnection attempt. */
export function classifyConnectionTransition(
  previous: ConnectionState,
  current: ConnectionState,
): ConnectionCueTransition {
  if (previous === ConnectionState.Connected && isReconnectingState(current)) {
    return 'lost';
  }
  if (isReconnectingState(previous) && current === ConnectionState.Connected) {
    return 'restored';
  }
  return null;
}
