import { ConnectionState } from 'livekit-client';

export type ConnectionCueTransition = 'lost' | 'restored' | null;

function isReconnectingState(state: ConnectionState): boolean {
  return state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting;
}

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
