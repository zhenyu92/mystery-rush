import { useEffect, useRef } from 'react';
import {
  CLUE_COUNT,
  CLUE_POINTS,
  type AnswerTally,
  type LeaderboardEntry,
  type PublicRound,
} from '../../shared/types';
import { formatSeconds, formatXp } from './common';

/**
 * The clue stack. Earlier clues stay on screen so players can reason across
 * all of them; unrevealed ones sit there as locked slots to keep the pressure
 * visible ("three more chances, each worth less").
 */
export function ClueList({
  clues,
  currentClue,
  totalClues = CLUE_COUNT,
  showLockedSlots = true,
  compact = false,
}: {
  clues: string[];
  currentClue: number;
  totalClues?: number;
  showLockedSlots?: boolean;
  compact?: boolean;
}) {
  // Only the clue that just landed animates in; re-renders from the timer
  // ticking must not re-trigger it.
  const animatedRef = useRef(0);
  const isNew = currentClue > animatedRef.current;
  useEffect(() => {
    animatedRef.current = Math.max(animatedRef.current, currentClue);
  }, [currentClue]);

  const slots = Array.from({ length: totalClues }, (_, i) => i + 1);

  return (
    <div className="clue-list">
      {slots.map((n) => {
        const text = clues[n - 1];
        if (!text) {
          if (!showLockedSlots) return null;
          // Locked slots stay deliberately slim: they signal what is still to
          // come without pushing the answer control off a phone screen.
          return (
            <div className="clue clue--locked" key={n}>
              <div className="clue__no" aria-hidden="true">
                {'\u{1F512}'}
              </div>
              <div className="clue__text">
                Clue {n} {'·'} {CLUE_POINTS[n - 1]} XP
              </div>
            </div>
          );
        }
        const current = n === currentClue;
        return (
          <div
            className={`clue${current ? ' clue--current' : ''}${current && isNew ? ' clue--enter' : ''}`}
            key={n}
          >
            <div className="clue__no">{n}</div>
            <div>
              <div className="clue__text" style={compact ? { fontSize: 15 } : undefined}>
                {text}
              </div>
              <div className="clue__worth">
                {current ? `Answer now for ${CLUE_POINTS[n - 1]} XP` : `Was worth ${CLUE_POINTS[n - 1]} XP`}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Five segments: filled for spent clues, draining for the live one. */
export function CluePips({ round, fraction }: { round: PublicRound; fraction: number }) {
  return (
    <div className="pips" aria-hidden="true">
      {Array.from({ length: round.clueCount }, (_, i) => {
        const n = i + 1;
        if (n < round.currentClue) return <div className="pip pip--done" key={n} />;
        if (n === round.currentClue) {
          return (
            <div
              className="pip pip--active"
              key={n}
              style={{ ['--fill' as string]: `${Math.round(fraction * 100)}%` }}
            />
          );
        }
        return <div className="pip" key={n} />;
      })}
    </div>
  );
}

export function AnswerBars({
  distribution,
  correctAnswer,
  total,
}: {
  distribution: AnswerTally[];
  /** Omit while a round is live so the host screen cannot spoil the answer. */
  correctAnswer?: string;
  total: number;
}) {
  const max = Math.max(1, ...distribution.map((d) => d.count));
  return (
    <div className="bars">
      {distribution.map((d) => {
        const isCorrect = correctAnswer !== undefined && d.option === correctAnswer;
        return (
          <div className="bar" key={d.option}>
            <div className={`bar__track${isCorrect ? ' bar--correct' : ''}`}>
              <div className="bar__fill" style={{ ['--pct' as string]: `${(d.count / max) * 100}%` }} />
              <div className="bar__label">
                {isCorrect ? <span aria-label="correct answer">{'✅'}</span> : null}
                <span>{d.option}</span>
              </div>
            </div>
            <div className="bar__count">
              {d.count}
              {total > 0 ? <span className="dim tiny"> / {total}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Leaderboard({
  entries,
  meId,
  limit,
  showGains = false,
}: {
  entries: LeaderboardEntry[];
  meId?: string | null;
  limit?: number;
  showGains?: boolean;
}) {
  const shown = limit ? entries.slice(0, limit) : entries;
  const me = meId ? entries.find((e) => e.playerId === meId) : undefined;
  const meHidden = me !== undefined && !shown.some((e) => e.playerId === me.playerId);

  if (entries.length === 0) {
    return <p className="muted center">No scores yet - play a mystery to get on the board.</p>;
  }

  return (
    <div className="lb">
      {shown.map((entry) => (
        <LeaderboardRow key={entry.playerId} entry={entry} me={entry.playerId === meId} showGains={showGains} />
      ))}
      {meHidden && me ? (
        <>
          <div className="center dim tiny">- - -</div>
          <LeaderboardRow entry={me} me showGains={showGains} />
        </>
      ) : null}
    </div>
  );
}

const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];

function LeaderboardRow({
  entry,
  me,
  showGains,
}: {
  entry: LeaderboardEntry;
  me: boolean;
  showGains: boolean;
}) {
  // Before anyone has scored, every player ties on 0 and would otherwise all
  // be shown wearing gold. Medals are for players who actually earned points.
  const medalled = entry.rank <= 3 && entry.score > 0;
  const medal = medalled ? MEDALS[entry.rank - 1] : null;
  return (
    <div className={`lb__row${me ? ' lb__row--me' : ''}${medalled ? ` lb__row--${entry.rank}` : ''}`}>
      <div className="lb__rank">{medal ?? entry.rank}</div>
      <div style={{ minWidth: 0 }}>
        <div className="lb__name">
          {entry.nickname}
          {me ? <span className="dim small"> (you)</span> : null}
          {entry.rankDelta !== 0 ? (
            <span className={`lb__delta lb__delta--${entry.rankDelta > 0 ? 'up' : 'down'}`}>
              {entry.rankDelta > 0 ? '↑' : '↓'}
              {Math.abs(entry.rankDelta)}
            </span>
          ) : null}
        </div>
        <div className="lb__meta">
          {entry.correctAnswers}/{entry.mysteriesPlayed} correct
          {entry.streak > 1 ? ` · \u{1F525} ${entry.streak}` : ''}
          {/* Shown all night rather than sprung at the end, so the tiebreak
              is never a surprise when it decides the prize. */}
          {entry.avgResponseMs !== null ? ` · ⚡ ${formatSeconds(entry.avgResponseMs)}` : ''}
          {!entry.connected ? ' · offline' : ''}
        </div>
      </div>
      <div>
        <div className="lb__score">{formatXp(entry.score)}</div>
        {showGains && entry.lastRoundPoints > 0 ? (
          <div className="lb__gain">+{entry.lastRoundPoints}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Positions are fixed by index, not by density: pass `[first, undefined,
 * third]` during a staged reveal and third place stays on the third-place
 * block instead of sliding into the winner's spot.
 */
export function Podium({ entries }: { entries: Array<LeaderboardEntry | undefined> }) {
  const [first, second, third] = entries;
  // Visual order puts the winner in the middle, raised above the other two.
  const slots: Array<{ entry: LeaderboardEntry | undefined; place: 1 | 2 | 3; delay: number }> = [
    { entry: second, place: 2, delay: 0.15 },
    { entry: first, place: 1, delay: 0.45 },
    { entry: third, place: 3, delay: 0 },
  ];

  return (
    <div className="podium">
      {slots.map(({ entry, place, delay }) =>
        entry ? (
          <div className="podium__slot" key={place} style={{ animationDelay: `${delay}s` }}>
            <div className="podium__medal">{MEDALS[place - 1]}</div>
            <div className="podium__name">{entry.nickname}</div>
            <div className="podium__score">{formatXp(entry.score)} XP</div>
            <div className={`podium__block podium__block--${place}`}>{place}</div>
          </div>
        ) : (
          <div key={place} />
        ),
      )}
    </div>
  );
}
