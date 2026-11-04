import { useEffect } from 'react';
import { keepAwake } from '../services/keepAwake';

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
