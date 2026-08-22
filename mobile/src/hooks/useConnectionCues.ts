import { useEffect, useRef } from 'react';
import type { ConnectionState } from 'livekit-client';
import { audioCues } from '../services/audioCues';
import { classifyConnectionTransition, type ConnectionCueTransition } from '../utils/connectionCues';

/** Plays a short tone when the local connection genuinely drops into
 * reconnecting and again when it genuinely recovers -- never on the initial
 * join, and never repeated for the same ongoing reconnect attempt (see
 * classifyConnectionTransition). `onTransition`, if given, fires alongside the
 * cue with the same de-duplicated transition, for callers that also want to
 * record it (e.g. the diagnostics log) without re-deriving it themselves. */
export function useConnectionCues(
  connectionState: ConnectionState,
  onTransition?: (transition: Exclude<ConnectionCueTransition, null>) => void,
): void {
  const previousRef = useRef(connectionState);
  const onTransitionRef = useRef(onTransition);
  onTransitionRef.current = onTransition;

  useEffect(() => {
    const transition = classifyConnectionTransition(previousRef.current, connectionState);
    previousRef.current = connectionState;

    if (transition === 'lost') {
      audioCues.connectionLost();
      onTransitionRef.current?.('lost');
    } else if (transition === 'restored') {
      audioCues.connectionRestored();
      onTransitionRef.current?.('restored');
    }
  }, [connectionState]);
}
