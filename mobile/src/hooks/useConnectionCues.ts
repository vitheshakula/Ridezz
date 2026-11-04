import { useEffect, useRef } from 'react';
import type { ConnectionState } from 'livekit-client';
import { audioCues } from '../services/audioCues';
import {
  classifyConnectionTransition,
  type ConnectionCueTransition,
} from '../utils/connectionCues';

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
