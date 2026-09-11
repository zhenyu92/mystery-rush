import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  CLUE_POINTS,
  DIFFICULTIES,
  EVENT_NAME_MAX,
  MYSTERY_TYPES,
  POOL_DEADLINE_MS,
  typeLabel,
  type Difficulty,
  type HostAction,
  type PoolStatus,
} from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { session } from '../lib/session';
import { useCountdown, useDeadline } from '../lib/useCountdown';
import { useGameSocket } from '../lib/useGameSocket';
import { Brand, ConnectionDot, Modal, TimerRing, Toast, formatXp, plural } from '../components/common';
import { AnswerBars, ClueList, CluePips, Leaderboard, Podium } from '../components/game';
import { Confetti } from '../components/Confetti';
import { QrCode } from '../components/QrCode';

export function Host({
  navigate,
  code,
}: {
  navigate: (to: string, replace?: boolean) => void;
  code: string;
}) {
  const hostSession = useMemo(() => (code ? session.getHost(code) : null), [code]);

  if (!code || !hostSession) return <CreateEvent navigate={navigate} attemptedCode={code} />;
  return <HostConsole navigate={navigate} code={code} hostToken={hostSession.hostToken} />;
}

// ---------------------------------------------------------------- creation

function CreateEvent({
  navigate,
  attemptedCode,
}: {
  navigate: (to: string, replace?: boolean) => void;
  attemptedCode: string;
}) {
  const [eventName, setEventName] = useState('Annual Dinner Mystery Rush');
  const [plannedRounds, setPlannedRounds] = useState('8');
  // A spread that most rooms will recognise. The host narrows it if they want
  // a themed night; the only rule is that something is chosen.
  const [categories, setCategories] = useState<string[]>([
    'landmark',
    'movie',
    'food',
    'animal',
    'space',
  ]);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<{ code: string; eventName: string } | null>(null);

  useEffect(() => {
    const last = session.lastHostCode();
    if (last && last !== attemptedCode) {
      const saved = session.getHost(last);
      if (saved) setResumable({ code: saved.eventCode, eventName: saved.eventName });
    }
  }, [attemptedCode]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const planned = Number.parseInt(plannedRounds, 10);
      const created = await api.createEvent({
        eventName: eventName.trim() || 'Mystery Rush Night',
        plannedRounds: Number.isFinite(planned) && planned > 0 ? planned : 1,
        categories,
        difficulty,
      });
      session.saveHost({
        eventCode: created.eventCode,
        hostToken: created.hostToken,
        eventName: created.eventName,
      });
      navigate(`/host?code=${created.eventCode}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the event.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <Brand tagline="Host console" />
      </header>

      {attemptedCode ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            You are not signed in as the host of <strong>{attemptedCode}</strong> on this device. Host
            credentials live in this browser only - create a new event, or reopen the host link from the
            device that created it.
          </p>
        </div>
      ) : null}

      <form className="card card--accent stack" onSubmit={create}>
        <h1 className="title-lg">Create an event</h1>
        <div className="field">
          <label className="field__label" htmlFor="eventName">
            Event name
          </label>
          <input
            id="eventName"
            className="input"
            value={eventName}
            onChange={(e) => setEventName(e.target.value.slice(0, EVENT_NAME_MAX))}
            maxLength={EVENT_NAME_MAX}
            placeholder="Friday Night Mystery Rush"
            autoFocus
          />
          <span className="tiny dim">Shown on every player's phone and on the projector.</span>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="plannedRounds">
            How many mysteries?
          </label>
          <input
            id="plannedRounds"
            className="input"
            type="number"
            min={1}
            max={25}
            value={plannedRounds}
            onChange={(e) => setPlannedRounds(e.target.value)}
          />
          <span className="tiny dim">
            The last one always scores double, so the room stays in play to the end.
          </span>
        </div>

        <div className="field">
          <label className="field__label">What should they be about?</label>
          <div className="catgrid">
            {MYSTERY_TYPES.map((t) => (
              <label key={t} className={`catchip${categories.includes(t) ? ' catchip--on' : ''}`}>
                <input
                  type="checkbox"
                  checked={categories.includes(t)}
                  onChange={() =>
                    setCategories((prev) =>
                      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                    )
                  }
                />
                <span>
                  {typeLabel(t).emoji} {typeLabel(t).label}
                </span>
              </label>
            ))}
          </div>
          <span className="tiny dim">
            Your questions get written for this event once you have a code. Pick at least one.
          </span>
        </div>

        <div className="field">
          <label className="field__label">How hard?</label>
          <div className="row" style={{ gap: 6 }}>
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                type="button"
                className={`btn btn--sm ${difficulty === d ? 'btn--cyan' : 'btn--ghost'}`}
                onClick={() => setDifficulty(d)}
              >
                {d[0].toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <button
          className="btn btn--primary btn--lg btn--block"
          disabled={busy || categories.length === 0}
        >
          {busy ? 'Creating...' : 'Create event and get a code'}
        </button>
      </form>

      {resumable ? (
        <button className="btn btn--ghost btn--block" onClick={() => navigate(`/host?code=${resumable.code}`)}>
          {'↩'} Resume {resumable.eventName} ({resumable.code})
        </button>
      ) : null}

      <button className="link center" onClick={() => navigate('/')}>
        Back to the start
      </button>

      {error ? <Toast message={error} error /> : null}
    </div>
  );
}

// ----------------------------------------------------------------- console

type Confirm =
  | { kind: 'reset' }
  | { kind: 'end' }
  | { kind: 'start_short'; written: number; wanted: number }
  | { kind: 'kick'; playerId: string; nickname: string };

/**
 * The answer, for the person holding the microphone. Masked by default, and
 * rendered as dots rather than blurred: a CSS blur leaves the real string in
 * the DOM and in the paint, which a screenshot or a phone camera recovers.
 * Dots leak only the length.
 */
function HostAnswer({
  answer,
  clues,
  hidden,
  onToggle,
}: {
  answer: string;
  clues: string[];
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="reveal reveal--host">
      <div className="row row--between">
        <div className="reveal__label">Answer (host only)</div>
        <button className="link tiny" onClick={onToggle} aria-pressed={!hidden}>
          {hidden ? '\u{1F441} Show' : '\u{1F648} Hide'}
        </button>
      </div>
      <div className="reveal__answer reveal__answer--host">
        {hidden ? '•'.repeat(Math.min(answer.length, 18)) : answer}
      </div>
      {!hidden && clues.length > 0 ? (
        <details style={{ marginTop: 10 }}>
          <summary className="link tiny">All {clues.length} clues</summary>
          <ol className="tiny muted" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
            {clues.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Writes this event's questions while the room is filling up.
 *
 * The host has already said how many and what about; there is nothing to
 * decide here, so this is a progress line rather than a control. It works in
 * small batches so that "12 of 20 written" is visible progress instead of a
 * spinner that might be stuck, and it stops the moment the server says there
 * is no point asking again.
 *
 * Failure is not an error state. The built-in bank is already queued behind
 * whatever gets written, so a night where the model never answers still plays
 * exactly as it did before any of this existed - it just says so.
 */
function PoolPrep({
  code,
  hostToken,
  pool,
  clockOffset,
}: {
  code: string;
  hostToken: string;
  pool: PoolStatus;
  clockOffset: number;
}) {
  const [tick, setTick] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [working, setWorking] = useState(false);
  // Distinct from `stopped`: a run that gave up on the clock cannot be
  // retried, because the server will refuse from here on.
  const [timedOut, setTimedOut] = useState(false);
  // A ref as well as the state: the state drives the label, the ref stops a
  // second request starting before the first has come back.
  const inFlight = useRef(false);

  // Drawn from the server's own deadline through the measured offset, like
  // every other clock in the app, so the lobby and the Worker agree on when
  // the budget runs out.
  const budgetLeft = useDeadline(pool.expiresAt, clockOffset);

  const wanted = pool.wanted;
  const have = pool.ai;
  const short = Math.max(0, wanted - have);

  useEffect(() => {
    if (stopped || short === 0 || pool.categories.length === 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    let live = true;

    api
      .preparePool(code, hostToken)
      .then((p) => {
        // `done` covers both "we have enough" and "asking again will not
        // help". Either way there is nothing left to do here.
        if (!live) return;
        if (p.timedOut) setTimedOut(true);
        if (p.done) setStopped(true);
      })
      .catch(() => {
        // The room already carries the reason in `pool.lastError`; repeating
        // it here would say the same thing twice.
        if (live) setStopped(true);
      })
      .finally(() => {
        inFlight.current = false;
        if (live) {
          setWorking(false);
          // Nudge the effect rather than relying on the snapshot arriving,
          // so a batch that added nothing still ends the loop cleanly.
          setTick((t) => t + 1);
        }
      });

    return () => {
      live = false;
    };
  }, [code, hostToken, short, stopped, pool.categories.length, tick]);

  if (wanted === 0 || pool.categories.length === 0) return null;

  const ready = have >= wanted;
  const pct = wanted === 0 ? 100 : Math.min(100, Math.round((have / wanted) * 100));

  return (
    <div className="card stack stack--tight">
      <div className="row row--between">
        <div className="card__title" style={{ margin: 0 }}>
          {ready ? '✨ Questions ready' : '✨ Writing your questions'}
        </div>
        <span className="pill">
          {have} of {wanted}
        </span>
      </div>

      <div
        className="poolbar"
        role="progressbar"
        aria-valuenow={have}
        aria-valuemin={0}
        aria-valuemax={wanted}
      >
        <div className="poolbar__fill" style={{ width: `${pct}%` }} />
      </div>

      <p className="tiny dim" style={{ margin: 0 }}>
        {ready
          ? `${wanted} ${wanted === 1 ? 'mystery' : 'mysteries'} written for this event, on ${pool.categories
              .map((c) => typeLabel(c).label)
              .join(', ')}. You can start whenever the room is ready.`
          : timedOut
            ? `Gave up after ${POOL_DEADLINE_MS / 1000}s with ${have} of ${wanted} written. The other ${short} come from the built-in bank, which plays exactly the same - the room will not be able to tell.`
            : working
              ? `Each one is written, checked and scored before it goes in.${
                  budgetLeft > 0 ? ` ${budgetLeft}s left before it falls back to the built-in bank.` : ''
                } The room can keep joining.`
              : stopped
                ? `Wrote ${have} of ${wanted}. The remaining ${short} will come from the built-in bank, which plays exactly the same.`
                : 'Starting...'}
      </p>

      {pool.lastError && !timedOut ? (
        <p className="tiny dim" style={{ margin: 0 }}>
          {pool.lastError}
        </p>
      ) : null}

      {stopped && !ready && !timedOut ? (
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setStopped(false);
            setTick((t) => t + 1);
          }}
        >
          {'↻'} Try the rest again
        </button>
      ) : null}
    </div>
  );
}

function HostConsole({
  navigate,
  code,
  hostToken,
}: {
  navigate: (to: string, replace?: boolean) => void;
  code: string;
  hostToken: string;
}) {
  const { status, snapshot, hostBrief, clockOffset, lastError, send, clearError } = useGameSocket({
    code,
    role: 'host',
    hostToken,
  });

  const round = snapshot?.round ?? null;
  const countdown = useCountdown(round, clockOffset);
  // A union rather than a parallel `kickTarget` state: it makes the four
  // dialogs mutually exclusive by construction.
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // Re-armed per round so ending one round with the answer showing cannot
  // leak the next one.
  const [answerHidden, setAnswerHidden] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!lastError) return;
    const id = setTimeout(clearError, 3600);
    return () => clearTimeout(id);
  }, [lastError, clearError]);

  const roundId = round?.roundId ?? null;
  useEffect(() => {
    setAnswerHidden(true);
  }, [roundId]);

  const act = (action: HostAction, extra?: { mysteryId?: string; playerId?: string }) =>
    send({ type: 'host', action, ...extra });

  /**
   * Which mystery comes next is the room's decision, not the host's - it
   * draws from the questions written for this event first and falls back to
   * the built-in bank. The one thing worth interrupting for is starting a
   * night whose questions are not all written yet.
   */
  const startRound = () => {
    const pool = snapshot?.pool;
    if (pool && pool.categories.length > 0 && pool.ai < pool.wanted && snapshot?.roundsPlayed === 0) {
      setConfirm({ kind: 'start_short', written: pool.ai, wanted: pool.wanted });
      return;
    }
    act('start_round');
  };

  const joinUrl = `${window.location.origin}/?code=${code}`;
  const copyJoinUrl = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked - the URL is on screen anyway */
    }
  };

  const phase = snapshot?.phase ?? 'lobby';
  const answered = round?.answeredCount ?? 0;
  const total = round?.playerCount ?? snapshot?.players.length ?? 0;
  const liveBrief = hostBrief && round && hostBrief.roundId === round.roundId ? hostBrief : null;

  const doubleArmed = (snapshot?.nextRoundMultiplier ?? 1) > 1;
  // The host named a number of mysteries and the room has played them all.
  // There is no next round to offer, only a winner to announce.
  const planComplete =
    snapshot?.plannedRounds != null && snapshot.roundsPlayed >= snapshot.plannedRounds;
  const roundsLeft =
    snapshot?.plannedRounds != null
      ? Math.max(0, snapshot.plannedRounds - snapshot.roundsPlayed)
      : (snapshot?.mysteriesRemaining ?? 0);
  const autoSeconds = useDeadline(snapshot?.autoAdvance?.at ?? null, clockOffset);
  const isFinalPlanned =
    snapshot?.plannedRounds != null && snapshot.roundsPlayed + 1 === snapshot.plannedRounds;

  return (
    <div className="page page--wide">
      <Confetti run={phase === 'finished'} />

      <header className="topbar">
        <Brand tagline="Host console" />
        <div className="hud">
          <span className="pill">{snapshot?.eventName ?? 'Loading...'}</span>
          <ConnectionDot status={status} />
        </div>
      </header>

      <div className="host-grid">
        <main className="stack">
          {/* ---------------------------------------------------- lobby */}
          {phase === 'lobby' ? (
            <div className="codeplate">
              <div className="joinsplit">
                <div>
                  <div className="codeplate__label">Players join with this code</div>
                  <div className="codeplate__code">{code}</div>
                  <button className="link codeplate__url" onClick={copyJoinUrl}>
                    {copied ? 'Copied!' : joinUrl}
                  </button>
                </div>
                {/* Here so the host can hold a laptop up to a straggler who
                    missed the projector. */}
                <QrCode value={joinUrl} size={170} label="Scan to join" />
              </div>
            </div>
          ) : null}

          {phase === 'lobby' && snapshot ? (
            <PoolPrep
              code={code}
              hostToken={hostToken}
              pool={snapshot.pool}
              clockOffset={clockOffset}
            />
          ) : null}

          {/* ------------------------------------------ round: get ready */}
          {phase === 'round' && round && round.status === 'intro' ? (
            <div className="card card--accent intro">
              <span className="cluehead__count">Mystery {round.roundIndex}</span>
              <span
                className="pill pill--category intro__type"
                style={{ fontSize: 16, padding: '12px 22px' }}
              >
                {typeLabel(round.mysteryType).emoji} {typeLabel(round.mysteryType).label}
              </span>
              <h2 className="title-xl intro__title">{round.title}</h2>
              <div className="intro__count">{countdown.seconds}</div>
              <div className="timer__label">First clue in</div>
              {liveBrief ? (
                <HostAnswer
                  answer={liveBrief.answer}
                  clues={liveBrief.clues}
                  hidden={answerHidden}
                  onToggle={() => setAnswerHidden((h) => !h)}
                />
              ) : null}
              <p className="tiny dim" style={{ margin: 0 }}>
                Ten seconds for the room to settle before clue 1. Answering is closed until then.
              </p>
            </div>
          ) : null}

          {/* ---------------------------------------------------- round */}
          {phase === 'round' && round && round.status !== 'intro' ? (
            <div className="card card--accent stack">
              <div className="row row--between">
                <span className="pill pill--category">
                  {typeLabel(round.mysteryType).emoji} {typeLabel(round.mysteryType).label}
                </span>
                <span className="pill pill--live">
                  <span className="dot dot--pulse" /> Mystery {round.roundIndex} live
                  {round.pointsMultiplier > 1 ? ` · ⚡ ${round.pointsMultiplier}x` : ''}
                </span>
              </div>

              <CluePips round={round} fraction={countdown.fraction} />

              <div className="timer">
                <TimerRing
                  seconds={countdown.seconds}
                  fraction={countdown.fraction}
                  size="xl"
                  paused={round.status === 'paused'}
                />
                <div className="stack stack--tight">
                  <div className="timer__label">
                    {round.status === 'paused' ? 'Paused' : 'Next clue in'}
                  </div>
                  <div className="title-lg">
                    Clue {round.currentClue} of {round.clueCount}
                  </div>
                  <div className="timer__worth">{CLUE_POINTS[round.currentClue - 1]} XP on the line</div>
                  <div className="muted">
                    <strong className="big-number">{answered}</strong> of {total} have locked in
                  </div>
                </div>
              </div>

              {liveBrief ? (
                <HostAnswer
                  answer={liveBrief.answer}
                  clues={liveBrief.clues}
                  hidden={answerHidden}
                  onToggle={() => setAnswerHidden((h) => !h)}
                />
              ) : null}

              <ClueList clues={round.clues} currentClue={round.currentClue} totalClues={round.clueCount} />
            </div>
          ) : null}

          {/* -------------------------------------------------- results */}
          {(phase === 'results' || phase === 'leaderboard') && snapshot?.result ? (
            <div className="card stack">
              <div className="row row--between">
                <span className="pill pill--category">
                  {typeLabel(snapshot.result.mysteryType).emoji}{' '}
                  {typeLabel(snapshot.result.mysteryType).label}
                </span>
                <span className="pill">Mystery {snapshot.result.roundIndex} complete</span>
              </div>
              <div className="reveal">
                <div className="reveal__label">The answer was</div>
                <div className="reveal__answer">{snapshot.result.answer}</div>
                <div className="tiny muted" style={{ marginTop: 6 }}>
                  {snapshot.result.correctCount} correct out of {snapshot.result.totalAnswers} answers
                  {' · '}
                  {snapshot.result.players.length - snapshot.result.totalAnswers} did not answer
                </div>
              </div>
              <div className="card__title" style={{ marginTop: 6 }}>
                Answer distribution
              </div>
              <AnswerBars
                distribution={snapshot.result.distribution}
                correctAnswer={snapshot.result.answer}
                total={snapshot.result.totalAnswers}
              />
              <details>
                <summary className="link" style={{ marginTop: 6 }}>
                  Who answered what
                </summary>
                <div className="table-scroll" style={{ marginTop: 10 }}>
                  <div className="lb">
                    {snapshot.result.players.map((p) => (
                      <div className="lb__row" key={p.playerId}>
                        <div className="lb__rank">
                          {p.selectedOption === null ? '–' : p.isCorrect ? '✅' : '❌'}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div className="lb__name">{p.nickname}</div>
                          <div className="lb__meta">
                            {p.selectedOption ?? 'No answer'}
                            {p.clueNumber ? ` · clue ${p.clueNumber}` : ''}
                          </div>
                        </div>
                        <div className="lb__score">{p.pointsAwarded > 0 ? `+${p.pointsAwarded}` : '0'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            </div>
          ) : null}

          {/* ------------------------------------------------- finished */}
          {phase === 'finished' && snapshot ? (
            <div className="card stack center">
              <div className="brand__tag">Final results</div>
              <h2 className="title-xl">{'\u{1F3C6}'} {snapshot.leaderboard[0]?.nickname ?? 'Nobody'} wins</h2>
              <Podium entries={snapshot.leaderboard.slice(0, 3)} />
            </div>
          ) : null}

          {/* ---------------------------------------------- leaderboard */}
          {phase !== 'round' && snapshot ? (
            <div className="card stack">
              <div className="row row--between">
                <div className="card__title" style={{ margin: 0 }}>
                  Leaderboard
                </div>
                <span className="pill">{plural(snapshot.roundsPlayed, 'mystery', 'mysteries')} played</span>
              </div>
              <Leaderboard entries={snapshot.leaderboard} showGains={phase === 'results'} />
            </div>
          ) : null}
        </main>

        {/* ------------------------------------------------------ sidebar */}
        <aside className="stack">
          <div className="card stack">
            <div className="card__title">Controls</div>
            <div className="controls">
              {phase === 'round' ? (
                <>
                  {round?.status === 'paused' ? (
                    <button className="btn btn--go" onClick={() => act('resume')}>
                      {'▶'} Resume
                    </button>
                  ) : (
                    <button className="btn btn--ghost" onClick={() => act('pause')}>
                      {'⏸'} Pause
                    </button>
                  )}
                  <button className="btn btn--primary" onClick={() => act('end_round')}>
                    {'⏹'} End round & reveal
                  </button>
                </>
              ) : planComplete && phase !== 'finished' ? (
                <button
                  className="btn btn--primary btn--lg btn--block"
                  onClick={() => act('end_event')}
                >
                  {'\u{1F3C1}'} Show the winner
                </button>
              ) : phase !== 'finished' ? (
                <button className="btn btn--go btn--lg btn--block" onClick={startRound}>
                  {doubleArmed
                    ? '▶ Start the FINAL mystery'
                    : snapshot && snapshot.roundsPlayed > 0
                      ? '▶ Next mystery'
                      : '▶ Start game'}
                </button>
              ) : null}

              {phase === 'results' ? (
                <button className="btn btn--cyan" onClick={() => act('show_leaderboard')}>
                  {'\u{1F4CA}'} Show leaderboard
                </button>
              ) : null}

              {/* Only while something is actually counting down - a button
                  that does nothing most of the time is worse than none. */}
              {snapshot?.autoAdvance ? (
                <button className="btn btn--ghost" onClick={() => act('hold_auto')}>
                  {'⏸'} Hold ({autoSeconds}s)
                </button>
              ) : null}

              {/* Redundant once the plan is done - "Show the winner" above is
                  the same action without the are-you-sure. */}
              {phase !== 'finished' && phase !== 'lobby' && !planComplete ? (
                <button className="btn btn--ghost" onClick={() => setConfirm({ kind: 'end' })}>
                  {'\u{1F3C1}'} End event
                </button>
              ) : null}
            </div>

            {phase !== 'round' ? (
              <p className="tiny dim" style={{ margin: 0 }}>
                {planComplete
                  ? `All ${snapshot?.plannedRounds} mysteries have been played. The podium comes up on its own - this button is only if you would rather not wait.`
                  : isFinalPlanned
                    ? `This is mystery ${snapshot?.plannedRounds} of ${snapshot?.plannedRounds} - the last one, so it scores double. Tell the room before you start it.`
                    : 'Everything advances on its own. Pause freezes the clock for the whole room, for as long as you are talking.'}
              </p>
            ) : null}

            <div className="row">
              <button className="btn btn--ghost btn--sm" onClick={() => window.open(`/display?code=${code}`, '_blank')}>
                {'\u{1F4FA}'} Open projector view
              </button>
            </div>
          </div>

          <div className="stats-row">
            <div className="stat">
              <div className="stat__value">{snapshot?.players.length ?? 0}</div>
              <div className="stat__label">Players</div>
            </div>
            <div className="stat">
              <div className="stat__value">{snapshot?.roundsPlayed ?? 0}</div>
              <div className="stat__label">Played</div>
            </div>
            <div className="stat">
              <div className="stat__value">{roundsLeft}</div>
              <div className="stat__label">Left</div>
            </div>
            {phase === 'round' ? (
              <div className="stat">
                <div className="stat__value">
                  {answered}/{total}
                </div>
                <div className="stat__label">Answered</div>
              </div>
            ) : null}
          </div>

          <div className="card stack">
            <div className="row row--between">
              <div className="card__title" style={{ margin: 0 }}>
                In the room
              </div>
              <span className="pill">{snapshot?.players.filter((p) => p.connected).length ?? 0} online</span>
            </div>
            {snapshot && snapshot.players.length > 0 ? (
              <div className="playerchips">
                {snapshot.players.map((p) => (
                  <span className="chip" key={p.playerId}>
                    <span className={p.connected ? 'dot dot--on' : 'dot'} />
                    {p.nickname}
                    <button
                      className="chip__kick"
                      title={`Remove ${p.nickname}`}
                      aria-label={`Remove ${p.nickname}`}
                      onClick={() =>
                        setConfirm({ kind: 'kick', playerId: p.playerId, nickname: p.nickname })
                      }
                    >
                      {'×'}
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                Nobody yet. Share code <strong>{code}</strong>.
              </p>
            )}
          </div>

          <div className="card stack">
            <div className="card__title">Danger zone</div>
            <button className="btn btn--danger btn--sm" onClick={() => setConfirm({ kind: 'reset' })}>
              Reset event
            </button>
            <p className="tiny dim" style={{ margin: 0 }}>
              Clears every score and result. Players keep their seats.
            </p>
            <button
              className="link tiny"
              onClick={() => {
                session.clearHost(code);
                navigate('/host');
              }}
            >
              Sign out of this host console
            </button>
          </div>
        </aside>
      </div>

      {confirm?.kind === 'reset' ? (
        <Modal
          title="Reset this event?"
          confirmLabel="Reset event"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            act('reset_event');
            setConfirm(null);
          }}
        >
          This will permanently reset all player scores and game results. The event and everyone in it stay
          put, and the full question bank becomes available again.
        </Modal>
      ) : null}

      {confirm?.kind === 'end' ? (
        <Modal
          title="End the event?"
          confirmLabel="End event"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            act('end_event');
            setConfirm(null);
          }}
        >
          Everyone jumps to the final results and the winner celebration. You can still reset afterwards to
          run another game.
        </Modal>
      ) : null}

      {confirm?.kind === 'start_short' ? (
        <Modal
          title="Questions are not all written yet"
          confirmLabel="Start anyway"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act('start_round');
          }}
        >
          {confirm.written} of {confirm.wanted}{' '}
          {confirm.wanted === 1 ? 'mystery has' : 'mysteries have'} been written for this event. The
          other {confirm.wanted - confirm.written} will come from the built-in question bank, which
          plays exactly the same - the room will not be able to tell. Waiting a little longer may
          get the rest.
        </Modal>
      ) : null}

      {confirm?.kind === 'kick' ? (
        <Modal
          title={`Remove ${confirm.nickname}?`}
          confirmLabel="Remove player"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            act('kick_player', { playerId: confirm.playerId });
            setConfirm(null);
          }}
        >
          They are dropped from the event and their score goes with them. If they rejoin they start
          again from zero.
        </Modal>
      ) : null}

      {lastError ? <Toast message={lastError.message} error /> : null}
      {phase === 'finished' && snapshot ? (
        <div className="center">
          <span className="pill pill--good">
            {formatXp(snapshot.leaderboard[0]?.score ?? 0)} XP winning score
          </span>
        </div>
      ) : null}
    </div>
  );
}
