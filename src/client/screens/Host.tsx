import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CLUE_POINTS, EVENT_NAME_MAX, typeLabel, type HostAction } from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { session } from '../lib/session';
import { useCountdown } from '../lib/useCountdown';
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
      const created = await api.createEvent(eventName.trim() || 'Mystery Rush Night');
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
        <button className="btn btn--primary btn--lg btn--block" disabled={busy}>
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

function HostConsole({
  navigate,
  code,
  hostToken,
}: {
  navigate: (to: string, replace?: boolean) => void;
  code: string;
  hostToken: string;
}) {
  const { status, snapshot, catalog, hostBrief, clockOffset, lastError, send, clearError } = useGameSocket({
    code,
    role: 'host',
    hostToken,
  });

  const round = snapshot?.round ?? null;
  const countdown = useCountdown(round, clockOffset);
  const [selectedMystery, setSelectedMystery] = useState<string>('');
  const [confirm, setConfirm] = useState<null | 'reset' | 'end'>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!lastError) return;
    const id = setTimeout(clearError, 3600);
    return () => clearTimeout(id);
  }, [lastError, clearError]);

  const act = (action: HostAction, extra?: { mysteryId?: string; playerId?: string }) =>
    send({ type: 'host', action, ...extra });

  const startRound = () => {
    act('start_round', selectedMystery ? { mysteryId: selectedMystery } : undefined);
    setSelectedMystery('');
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

          {/* ---------------------------------------------------- round */}
          {phase === 'round' && round ? (
            <div className="card card--accent stack">
              <div className="row row--between">
                <span className="pill pill--category">
                  {typeLabel(round.mysteryType).emoji} {typeLabel(round.mysteryType).label}
                </span>
                <span className="pill pill--live">
                  <span className="dot dot--pulse" /> Mystery {round.roundIndex} live
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
                <div className="reveal" style={{ textAlign: 'left' }}>
                  <div className="reveal__label">Answer (host only)</div>
                  <div className="reveal__answer" style={{ fontSize: 24 }}>
                    {liveBrief.answer}
                  </div>
                </div>
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
                  {total - snapshot.result.totalAnswers} did not answer
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
              ) : (
                <button className="btn btn--go btn--lg btn--block" onClick={startRound}>
                  {snapshot && snapshot.roundsPlayed > 0 ? '▶ Next mystery' : '▶ Start game'}
                </button>
              )}

              {phase === 'results' ? (
                <button className="btn btn--cyan" onClick={() => act('show_leaderboard')}>
                  {'\u{1F4CA}'} Show leaderboard
                </button>
              ) : null}

              {phase !== 'finished' && phase !== 'lobby' ? (
                <button className="btn btn--ghost" onClick={() => setConfirm('end')}>
                  {'\u{1F3C1}'} End event
                </button>
              ) : null}
            </div>

            {phase !== 'round' ? (
              <p className="tiny dim" style={{ margin: 0 }}>
                Clues advance on their own every {(round?.durationPerClue ?? 20000) / 1000} seconds - you
                never need to click through them. Pause freezes the clock for the whole room.
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
              <div className="stat__value">{snapshot?.mysteriesRemaining ?? 0}</div>
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

          {phase !== 'round' ? (
            <div className="card stack">
              <div className="card__title">Pick the next mystery</div>
              <p className="tiny dim" style={{ margin: 0 }}>
                Leave unselected to draw the next one at random.
              </p>
              <div className="picker">
                {catalog.map((m) => (
                  <button
                    className={`picker__item${selectedMystery === m.id ? ' picker__item--selected' : ''}`}
                    key={m.id}
                    disabled={m.used}
                    onClick={() => setSelectedMystery(selectedMystery === m.id ? '' : m.id)}
                  >
                    <span>{typeLabel(m.type).emoji}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block' }}>{m.title}</span>
                      <span className="picker__type">{typeLabel(m.type).label}</span>
                    </span>
                    {m.used ? <span className="tiny dim">played</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

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
                      onClick={() => act('kick_player', { playerId: p.playerId })}
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
            <button className="btn btn--danger btn--sm" onClick={() => setConfirm('reset')}>
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

      {confirm === 'reset' ? (
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

      {confirm === 'end' ? (
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
