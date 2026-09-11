import { useEffect, useRef, useState } from 'react';

/**
 * Holds the previous value for a beat so a screen can animate out before the
 * next one animates in.
 *
 * Projector only. On a phone the page is a scrolling document, and a window
 * where the answer control is mid-transition is a window where a player
 * cannot lock in.
 */
export function usePhaseTransition<T>(value: T, ms = 260): { shown: T; state: 'in' | 'out' } {
  const [shown, setShown] = useState(value);
  const [state, setState] = useState<'in' | 'out'>('in');
  const latest = useRef(value);

  latest.current = value;

  useEffect(() => {
    if (value === shown) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || ms <= 0) {
      setShown(value);
      setState('in');
      return;
    }

    setState('out');
    const id = setTimeout(() => {
      // Take the newest value, not the one captured when the timer started -
      // two changes inside the window should land on the second.
      setShown(latest.current);
      setState('in');
    }, ms);
    return () => clearTimeout(id);
  }, [value, shown, ms]);

  return { shown, state };
}
