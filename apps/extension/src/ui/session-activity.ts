import { useEffect } from 'react';
import { api } from './api';

/** Polling and background tabs never extend a session; only actual UI activity does. */
export function useWalletActivity() {
  useEffect(() => {
    let last = 0;
    const activity = (event: Event) => {
      if (!event.isTrusted || document.visibilityState !== 'visible' || Date.now() - last < 15_000) return;
      last = Date.now();
      void api({ type: 'TOUCH_SESSION' }).catch(() => undefined);
    };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const event of events) window.addEventListener(event, activity, { passive: true });
    return () => { for (const event of events) window.removeEventListener(event, activity); };
  }, []);
}
