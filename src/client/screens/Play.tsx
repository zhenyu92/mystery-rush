import { useEffect, useMemo, useRef, useState } from 'react';
import { CLUE_POINTS, typeLabel } from '../../shared/types';
import { session } from '../lib/session';
import { useCountdown } from '../lib/useCountdown';
import { useGameSocket } from '../lib/useGameSocket';
import { Brand, ConnectionDot, TimerRing, Toast, formatXp, plural } from '../components/common';
import { AnswerBars, ClueList, CluePips, Leaderboard, Podium } from '../components/game';
import { Confetti } from '../components/Confetti';

export function Play({ navigate, code }: { navigate: (to: string, replace?: boolean) => void; code: string }) {
  const saved = useMemo(() => (code ? session.getPlayer(code) : null), [code]);

  const {
    status,
    snapshot,
    self,
    clockOffset,
    lastError,
    fatal,
    send,
    clearError,
  } = useGameSocket({
    code,
    role: 'player',
    playerId: saved?.playerId,
    playerToken: saved?.playerToken,
    enabled: Boolean(saved),
  });

  const round = snapshot?.round ?? null;
  const countdown = useCountdown(round, clockOffset);

  const [choice, setChoice] = useState('');
  const [pending, setPending] = useState(false);

  // Errors auto-dismiss so a stale toast never sits on top of the answer box.
  useEffect(() => {
    if (!lastError) return;
    const id = setTimeout(clearError, 3200);
    return () => clearTimeout(id);
  }, [lastError, clearError]);

  // A rejected submission has to release the button again.
  useEffect(() => {
    if (lastError) setPending(false);
  }, [lastError]);

  // Fresh round: clear the previous pick.
  const roundId = round?.roundId ?? null;
  useEffect(() => {
    setChoice('');
    setPending(false);
  }, [roundId]);

  // When a new clue lands: a short buzz, so a player watching the room rather
  // than their phone feels the round move on, and a scroll that brings the new
  // clue into view above the docked answer control.
  const lastClue = useRef(0);
  useEffect(() => {
    const clue = round?.currentClue ?? 0;
    if (clue > lastClue.current && lastClue.current > 0) {
      navigator.vibrate?.(35);
      requestAnimationFrame(() => {
        document.querySelector('.clue--current')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    lastClue.current = clue;
  }, [round?.currentClue]);

  if (!code || !saved) {
    return (
      <div className="page center stack">
        <Brand large />
        <div className="card stack">
          <h2 className="title-lg">You are not in this event yet</h2>
          <p className="muted">Enter the event code to take a seat.</p>
          <button className="btn btn--primary btn--block" onClick={() => navigate(`/?code=${code}`)}>
            Join an event
          </button>
        </div>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="page center stack">
        <Brand large />
        <div className="card stack">
          <h2 className="title-lg">{fatal}</h2>
          <button
            className="btn btn--ghost btn--block"
            onClick={() => {
              session.clearPlayer(code);
              navigate('/');
            }}
          >
            Back to the start
          </button>
        </div>
      </div>
    );
  }

  const phase = snapshot?.phase ?? 'lobby';
  const myResult = snapshot?.result?.players.find((p) => p.playerId === self?.playerId) ?? null;
  const myRank = snapshot?.leaderboard.find((e) => e.playerId === self?.playerId) ?? null;
  const won = phase === 'finished' && myRank?.rank === 1;

  return (
    <div className="page">
      <Confetti run={phase === 'finished' && Boolean(won)} continuous />

      <header className="topbar">
        <Brand />
        <ConnectionDot status={status} />
      </header>

      <div className="row row--between">
        <div>
          <div className="hud__name">{snapshot?.eventName ?? saved.eventName}</div>
          <div className="tiny dim">
            {saved.nickname} {'·'} code {code}
          </div>
        </div>
        <div className="hud">
          <span className="pill pill--xp">{formatXp(self?.score ?? 0)} XP</span>
          {(self?.streak ?? 0) > 0 ? <span className="pill pill--streak">{'\u{1F525}'} {self?.streak}</span> : null}
          {/* Before the first mystery everyone is tied, so a rank would be noise. */}
          {myRank && (snapshot?.roundsPlayed ?? 0) > 0 ? (
            <span className="pill">#{myRank.rank}</span>
          ) : null}
        </div>
      </div>

      {!snapshot ? (
        <div className="card center stack">
          <div className="scanline" />
          <p className="muted">Connecting to the event...</p>
        </div>
      ) : null}

      {phase === 'lobby' && snapshot ? (
        <div className="card card--accent center stack">
          <div className="title-lg">{'\u{1F4CD}'} You are in!</div>
          <p className="muted">Hang tight - the host starts the first mystery any moment.</p>
          <div className="scanline" />
          <div className="pill">
            {snapshot.players.length} {snapshot.players.length === 1 ? 'player' : 'players'} in the room
          </div>
          <div className="playerchips" style={{ justifyContent: 'center' }}>
            {snapshot.players.slice(0, 24).map((p) => (
              <span className="chip" key={p.playerId}>
                <span className={p.connected ? 'dot dot--on' : 'dot'} />
                {p.nickname}
              </span>
            ))}
          </div>
          <p className="tiny dim" style={{ marginTop: 6 }}>
            Answer on clue 1 for 500 XP, or wait for a clue you are sure about and settle for less.
          </p>
        </div>
      ) : null}

      {phase === 'round' && round ? (
        <>
          <div className="card stack">
            <div className="row row--between">
              <span className="pill pill--category">
                {typeLabel(round.mysteryType).emoji} {typeLabel(round.mysteryType).label}
              </span>
              <span className="cluehead__count">Mystery {round.roundIndex}</span>
            </div>

            <h2 className="title-lg">What am I?</h2>
            <CluePips round={round} fraction={countdown.fraction} />

            <div className="timer" style={{ marginTop: 4 }}>
              <TimerRing
                seconds={countdown.seconds}
                fraction={countdown.fraction}
                paused={round.status === 'paused'}
              />
              <div>
                <div className="timer__label">
                  {round.status === 'paused' ? 'Paused by host' : 'Answer now for'}
                </div>
                <div className="timer__worth">{CLUE_POINTS[round.currentClue - 1]} XP</div>
                <div className="tiny dim">
                  Clue {round.currentClue} of {round.clueCount} {'·'}{' '}
                  {round.status === 'paused'
                    ? 'clock frozen'
                    : round.currentClue >= round.clueCount
                      ? `round ends in ${countdown.seconds}s`
                      : `next clue in ${countdown.seconds}s`}{' '}
                  {'·'} {round.answeredCount}/{round.playerCount} answered
                </div>
              </div>
            </div>
          </div>

          <ClueList clues={round.clues} currentClue={round.currentClue} totalClues={round.clueCount} />

          <div className="answer-dock">
          {self?.hasAnswered ? (
            <div className="locked">
              <div className="locked__title">{'\u{1F512}'} ANSWER LOCKED</div>
              <div className="locked__answer">{self.selectedOption}</div>
              <div className="locked__hint">
                Locked on clue {self.answeredAtClue} {'·'} worth{' '}
                {CLUE_POINTS[(self.answeredAtClue ?? 1) - 1]} XP if you are right.
                <br />
                Results at the end of the round.
              </div>
            </div>
          ) : (
            <div className="card stack">
              <div className="card__title">Select your answer</div>
              <select
                className="select"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                disabled={!round.acceptingAnswers || pending}
                aria-label="Select your answer"
              >
                <option value="">Select your answer...</option>
                {round.options.map((option) => (
                  <option value={option} key={option}>
                    {option}
                  </option>
                ))}
              </select>
              <button
                className="btn btn--go btn--lg btn--block"
                disabled={!choice || !round.acceptingAnswers || pending}
                onClick={() => {
                  if (!choice) return;
                  setPending(true);
                  send({ type: 'submit_answer', option: choice });
                }}
              >
                {pending ? 'Locking in...' : `Lock in for ${CLUE_POINTS[round.currentClue - 1]} XP`}
              </button>
              <p className="tiny dim center" style={{ margin: 0 }}>
                One guess per mystery. You cannot change it, so make it count.
              </p>
            </div>
          )}
          </div>
        </>
      ) : null}

      {phase === 'results' && snapshot?.result ? (
        <>
          {myResult?.selectedOption == null ? (
            <div className="verdict verdict--idle">
              <div className="verdict__emoji">{'\u{1F914}'}</div>
              <div className="verdict__title">No answer this time</div>
              <div className="verdict__sub">Get one in next round - even a late guess is worth 100 XP.</div>
            </div>
          ) : myResult.isCorrect ? (
            <div className="verdict verdict--correct">
              <div className="verdict__emoji">{'\u{1F389}'}</div>
              <div className="verdict__title">Correct!</div>
              <div className="verdict__points">+{myResult.pointsAwarded} XP</div>
              <div className="verdict__sub">
                Nailed it on clue {myResult.clueNumber}
                {(self?.streak ?? 0) > 1 ? ` · \u{1F525} ${self?.streak} in a row` : ''}
              </div>
            </div>
          ) : (
            <div className="verdict verdict--wrong">
              <div className="verdict__emoji">{'\u{1F615}'}</div>
              <div className="verdict__title">Not this one</div>
              <div className="verdict__sub">
                You picked {myResult.selectedOption} on clue {myResult.clueNumber}.
              </div>
            </div>
          )}

          <div className="reveal">
            <div className="reveal__label">The answer was</div>
            <div className="reveal__answer">{snapshot.result.answer}</div>
            <div className="tiny muted" style={{ marginTop: 6 }}>
              {snapshot.result.correctCount} of {snapshot.result.totalAnswers} answers were right
            </div>
          </div>

          <div className="card stack">
            <div className="card__title">What the room picked</div>
            <AnswerBars
              distribution={snapshot.result.distribution}
              correctAnswer={snapshot.result.answer}
              total={snapshot.result.totalAnswers}
            />
          </div>

          <div className="card stack">
            <div className="card__title">All five clues</div>
            <ClueList
              clues={snapshot.result.clues}
              currentClue={0}
              totalClues={snapshot.result.clues.length}
              showLockedSlots={false}
              compact
            />
          </div>
        </>
      ) : null}

      {phase === 'leaderboard' && snapshot ? (
        <div className="card stack">
          <div className="row row--between">
            <div className="card__title" style={{ margin: 0 }}>
              Leaderboard
            </div>
            <span className="pill">After {plural(snapshot.roundsPlayed, 'mystery', 'mysteries')}</span>
          </div>
          <Leaderboard entries={snapshot.leaderboard} meId={self?.playerId} showGains />
          <p className="tiny dim center" style={{ margin: 0 }}>
            Next mystery starts when the host is ready.
          </p>
        </div>
      ) : null}

      {phase === 'finished' && snapshot ? (
        <>
          <div className="card center stack">
            <div className="brand__tag">Final results</div>
            <h2 className="title-xl">{won ? '\u{1F3C6} You won!' : `You finished #${myRank?.rank ?? '-'}`}</h2>
            <div className="timer__worth">{formatXp(self?.score ?? 0)} XP</div>
            <p className="muted">
              {self?.correctAnswers ?? 0} correct out of{' '}
              {plural(self?.mysteriesPlayed ?? 0, 'mystery', 'mysteries')}
              {(self?.bestStreak ?? 0) > 1 ? ` · best streak \u{1F525} ${self?.bestStreak}` : ''}
            </p>
          </div>
          <Podium entries={snapshot.leaderboard.slice(0, 3)} />
          <div className="card stack">
            <div className="card__title">Final standings</div>
            <Leaderboard entries={snapshot.leaderboard} meId={self?.playerId} />
          </div>
        </>
      ) : null}

      {status === 'failed' ? (
        <Toast message="Lost the connection. Retrying..." error />
      ) : lastError ? (
        <Toast message={lastError.message} error />
      ) : null}
    </div>
  );
}
