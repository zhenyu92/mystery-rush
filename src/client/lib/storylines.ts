import type { Snapshot } from '../../shared/types';

export interface Storyline {
  id: string;
  emoji: string;
  label: string;
  value: string;
}

/**
 * The between-rounds screen used to be a strict subset of the results screen,
 * and it is up for the longest single stretch of the night — the host's
 * patter. These are the things a real game show puts in that gap.
 *
 * All of it is derived from the snapshot the projector already has. Pure, so
 * it is obvious what each one claims and easy to check.
 */
export function pickStorylines(snapshot: Snapshot): Storyline[] {
  const out: Storyline[] = [];
  const board = snapshot.leaderboard;
  const result = snapshot.result;

  const hottest = board.reduce<(typeof board)[number] | null>(
    (best, e) => (e.streak > (best?.streak ?? 0) ? e : best),
    null,
  );
  if (hottest && hottest.streak >= 2) {
    out.push({
      id: 'streak',
      emoji: '\u{1F525}',
      label: 'On a run',
      value: `${hottest.nickname} has ${hottest.streak} in a row`,
    });
  }

  if (result) {
    // The earliest correct answer of the round: the bravest call, not just
    // the luckiest one.
    const earliest = result.players
      .filter((p) => p.isCorrect && p.clueNumber !== null)
      .sort((a, b) => (a.clueNumber ?? 9) - (b.clueNumber ?? 9))[0];
    if (earliest) {
      out.push({
        id: 'fastest',
        emoji: '\u{1F3AF}',
        label: 'Called it first',
        value: `${earliest.nickname} on clue ${earliest.clueNumber}`,
      });
    }

    const trap = result.distribution
      .filter((d) => d.option !== result.answer && d.count > 0)
      .sort((a, b) => b.count - a.count)[0];
    if (trap) {
      out.push({
        id: 'trap',
        emoji: '\u{1F573}️',
        label: 'The trap',
        value: `${trap.count} said ${trap.option}`,
      });
    }
  }

  // The closest gap in the top five - who is actually being chased.
  const top = board.slice(0, 5);
  let closest: { a: string; b: string; gap: number } | null = null;
  for (let i = 1; i < top.length; i++) {
    const gap = top[i - 1].score - top[i].score;
    if (top[i - 1].score > 0 && (closest === null || gap < closest.gap)) {
      closest = { a: top[i - 1].nickname, b: top[i].nickname, gap };
    }
  }
  if (closest) {
    out.push({
      id: 'race',
      emoji: '⚔️',
      label: 'Closest race',
      value:
        closest.gap === 0
          ? `${closest.a} and ${closest.b} are level`
          : `${closest.gap} XP between ${closest.a} and ${closest.b}`,
    });
  }

  return out;
}
