import { useEffect, useMemo, useRef, useState } from 'react';
import { diffPresence, type PresenceEvent, type RiderIdentity } from '../utils/riderPresence';

const TOAST_DURATION_MS = 3000;

function presenceMessage(event: PresenceEvent): string {
  switch (event.type) {
    case 'joined':
      return `${event.name} joined`;
    case 'rejoined':
      return `${event.name} rejoined`;
    case 'left':
      return `${event.name} left the ride`;
  }
}

export function useRiderPresenceToasts(
  currentRiders: RiderIdentity[],
  onEvent?: (event: PresenceEvent) => void,
): string | null {
  const previousRef = useRef<RiderIdentity[]>(currentRiders);
  const seenIdentitiesRef = useRef<Set<string>>(new Set(currentRiders.map(r => r.identity)));
  const isFirstRunRef = useRef(true);
  const queueRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const identityKey = useMemo(() => currentRiders.map(r => r.identity).join(','), [currentRiders]);

  useEffect(() => {
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      previousRef.current = currentRiders;
      return;
    }

    const events = diffPresence(previousRef.current, currentRiders, seenIdentitiesRef.current);
    previousRef.current = currentRiders;
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      onEventRef.current?.(event);
    }

    queueRef.current.push(...events.map(presenceMessage));
    if (!timerRef.current) {
      showNext();
    }

    function showNext() {
      const next = queueRef.current.shift();
      setMessage(next ?? null);
      if (next) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          showNext();
        }, TOAST_DURATION_MS);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return message;
}
