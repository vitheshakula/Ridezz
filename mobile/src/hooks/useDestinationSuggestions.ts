import { useEffect, useState } from 'react';
import type { RideDestination } from '../components/RiderMap';
import { MIN_SUGGESTION_QUERY_LENGTH, searchDestinations } from '../services/destinationService';

const DEBOUNCE_MS = 350;

export function useDestinationSuggestions(query: string, enabled: boolean): RideDestination[] {
  const [suggestions, setSuggestions] = useState<RideDestination[]>([]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed.length < MIN_SUGGESTION_QUERY_LENGTH) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      searchDestinations(trimmed).then(results => {
        if (!cancelled) {
          setSuggestions(results);
        }
      });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, enabled]);

  return suggestions;
}
