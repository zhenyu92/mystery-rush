import { useEffect, useState } from 'react';
import type { PublicRound } from '../../shared/types';

export interface Countdown {
  remainingMs: number;
  /** Whole seconds shown to the player, 20 down to 0. */
  seconds: number;
  /** 1 at the start of a clue, 0 when it expires. */
  fraction: number;
}

/**
 * Display-only clock.
 *
 * The interval here never decides anything: it re-reads the server's
 * `clueEndsAt` (corrected by the measured clock offset) on every tick, so a
 * throttled background tab or a tampered system clock changes what the player
 * sees and nothing else. The Durable Object alarm is what actually advances
 * the clue.
 */
export function useCountdown(round: PublicRound | null, clockOffset: number): Countdown {
  const [, force] = useState(0);

  const paused = round?.status === 'paused';

  useEffect(() => {
    if (!round || paused) return;
    const id = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [round, paused]);

  if (!round) return { remainingMs: 0, seconds: 0, fraction: 0 };

  // Fill the ring against the window actually running - the intro is 10s,
  // a clue is 20s - so the arc always drains from full to empty.
  const total = round.windowMs || round.durationPerClue || 1;
  const remainingMs = paused
    ? round.remainingMs
    : Math.max(0, round.clueEndsAt - (Date.now() + clockOffset));

  return {
    remainingMs,
    seconds: Math.max(0, Math.ceil(remainingMs / 1000)),
    fraction: Math.min(1, Math.max(0, remainingMs / total)),
  };
}
