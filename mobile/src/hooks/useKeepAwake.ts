import { useEffect } from 'react';
import { keepAwake } from '../services/keepAwake';

/** Mirrors `enabled` onto the native keep-screen-on flag. Always releases the
 * flag on unmount regardless of the last `enabled` value, so leaving the ride
 * can never strand the screen pinned awake -- this hook lives at the RideRoom
 * level (not per-tab), so switching between Intercom/Map does not unmount it
 * and does not accidentally release the flag. */
export function useKeepAwake(enabled: boolean): void {
  useEffect(() => {
    if (enabled) {
      keepAwake.enable();
    } else {
      keepAwake.disable();
    }
  }, [enabled]);

  useEffect(() => {
    return () => {
      keepAwake.disable();
    };
  }, []);
}
