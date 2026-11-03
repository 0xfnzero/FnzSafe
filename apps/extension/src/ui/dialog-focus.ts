import { useEffect, useRef } from 'react';

/** Keep keyboard navigation inside the active panel and restore its trigger. */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void, active = true) {
  const ref = useRef<T>(null);
  const previous = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const controls = () => Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(n => n.getClientRects().length);
    (el.querySelector<HTMLElement>('input:not([type="checkbox"]):not(:disabled)') ?? controls()[0])?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const nodes = controls(), first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    el.addEventListener('keydown', key);
    return () => { el.removeEventListener('keydown', key); if (previous.current?.isConnected) previous.current.focus(); };
  }, [active]);
  return ref;
}
