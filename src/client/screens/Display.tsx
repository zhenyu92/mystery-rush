import { useEffect, useState, type FormEvent } from 'react';
import { CLUE_POINTS, typeLabel, type LeaderboardEntry, type Snapshot } from '../../shared/types';
import { useCountdown, useDeadline } from '../lib/useCountdown';
import { useGameSocket } from '../lib/useGameSocket';
import { Brand, ConnectionDot, TimerRing, formatSeconds, formatXp, plural } from '../components/common';
import { AnswerBars, Leaderboard, Podium } from '../components/game';
import { Confetti } from '../components/Confetti';
import { SoundGate } from '../components/SoundGate';
import { useStageAudio } from '../lib/useStageAudio';
import { usePhaseTransition } from '../lib/usePhaseTransition';
import { REVEAL_LEAD_MS, stageAudio } from '../lib/audio';
import { pickStorylines } from '../lib/storylines';
import { QrCode } from '../components/QrCode';

/**
 * The big screen in the room. Read-only, no credentials, everything sized off
 * viewport units so it reads from the back row.
 */
export function Display({
  navigate,
  code,
}: {
  navigate: (to: string, replace?: boolean) => void;
  code: string;
}) {
  if (!code) return <AskForCode navigate={navigate} />;
  return <Stage code={code} />;
}

function AskForCode({ navigate }: { navigate: (to: string, replace?: boolean) => void }) {
  const [code, setCode] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim().length >= 4) navigate(`/display?code=${code.trim().toUpperCase()}`);
  };
  return (
    <div className="page">
      <header className="topbar">
        <Brand tagline="Projector view" />
      </header>
      <form className="card card--accent stack" onSubmit={submit}>
        <h1 className="title-lg">Show an event on the big screen</h1>
        <div className="field">
          <label className="field__label" htmlFor="dcode">
            Event code
          </label>
          <input
            id="dcode"
            className="input input--code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
            placeholder="ABCDE"
            autoFocus
          />
        </div>
        <button className="btn btn--primary btn--lg btn--block">Open projector view</button>
      </form>
      <button className="link center" onClick={() => navigate('/')}>
        Back to the start
      </button>
    </div>
  );
}

type FinaleStage = 'countdown' | 'third' | 'second' | 'first' | 'celebrate';

function Stage({ code }: { code: string }) {
  const { status, snapshot, clockOffset } = useGameSocket({ code, role: 'display' });
  const round = snapshot?.round ?? null;
  const countdown = useCountdown(round, clockOffset);
  const phase = snapshot?.phase ?? 'lobby';

  const finale = useFinaleSequence(phase === 'finished');
  const joinUrl = `${window.location.origin}/?code=${code}`;
  const nextSeconds = useDeadline(snapshot?.autoAdvance?.at ?? null, clockOffset);
  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useStageAudio({
    phase,
    round,
    seconds: countdown.seconds,
    finaleStage: finale.stage,
    finaleTick: finale.tick,
    reducedMotion,
  });

  // The intro-to-first-clue cut is the most important one on the projector
  // and is not a phase change at all, so key the scene on both.
  const phaseKey =
    phase === 'round' ? (round?.status === 'intro' ? 'round:intro' : 'round:live') : phase;
  // Results waits for the drumroll, so the chord and the answer land together.
  const { shown: scene, state: sceneState } = usePhaseTransition(
    phaseKey,
    phaseKey === 'results' && stageAudio.isEnabled() ? REVEAL_LEAD_MS : 260,
  );

  return (
    <div className="page page--stage">
      <Confetti run={phase === 'finished' && finale.stage === 'celebrate'} continuous count={220} />

      <header className="topbar" style={{ marginBottom: 8 }}>
        <Brand tagline={snapshot?.eventName ?? 'Live'} />
        <div className="hud">
          {phase !== 'lobby' ? <span className="pill">Code {code}</span> : null}
          {snapshot ? <span className="pill">{snapshot.players.length} playing</span> : null}
          <ConnectionDot status={status} />
        </div>
      </header>
      <SoundGate />

      {/* Confetti and the header stay outside this wrapper: an ancestor
          with a transform or filter breaks the canvas's fixed position,
          and the confetti would restart on every scene change. */}
      <div className={`stage__scene stage__scene--${sceneState}`} key={scene}>
      {/* ------------------------------------------------------- lobby */}
      {scene === 'lobby' && snapshot ? (
        <div className="stack center" style={{ alignItems: 'center', gap: 24 }}>
          <div className="brand__tag">Join now on your phone</div>
          <div className="joinsplit" style={{ maxWidth: 1200 }}>
            <div className="codeplate">
              <div className="codeplate__label">Event code</div>
              <div className="codeplate__code" style={{ fontSize: 'clamp(64px, 13vw, 170px)' }}>
                {code}
              </div>
              <div className="codeplate__url" style={{ fontSize: 'clamp(15px, 1.7vw, 24px)' }}>
                {joinUrl}
              </div>
            </div>
            {/* Scanning skips both the URL and the code entirely. */}
            <QrCode value={joinUrl} size={260} label="Or scan to join" />
          </div>
          <div className="scanline" style={{ width: '60%' }} />
          <div className="playerchips" style={{ justifyContent: 'center', maxWidth: 1100 }}>
            {snapshot.players.map((p) => (
              <span className="chip" key={p.playerId} style={{ fontSize: 18, padding: '10px 16px' }}>
                <span className={p.connected ? 'dot dot--on' : 'dot'} />
                {p.nickname}
              </span>
            ))}
          </div>
          {snapshot.players.length === 0 ? (
            <p className="muted stage__prev">Waiting for the first player...</p>
          ) : null}
        </div>
      ) : null}

      {/* -------------------------------------------- round: get ready */}
      {scene === 'round:intro' && round ? (
        <div className="intro">
          <div className="brand__tag">Mystery {round.roundIndex}</div>
          <span
            className="pill pill--category intro__type"
            style={{ fontSize: 'clamp(16px, 2vw, 30px)', padding: '14px 30px' }}
          >
            {typeLabel(round.mysteryType).emoji} {typeLabel(round.mysteryType).label}
          </span>
          <h1 className="winner__name intro__title" style={{ fontSize: 'clamp(38px, 7vw, 96px)' }}>
            {round.title}
          </h1>
          {round.pointsMultiplier > 1 ? (
            <div className="pill pill--streak intro__type" style={{ fontSize: 'clamp(15px, 1.8vw, 26px)', padding: '12px 26px' }}>
              {'⚡'} DOUBLE POINTS {'·'} everything counts twice
            </div>
          ) : null}
          <div className="intro__count intro__count--xl">{countdown.seconds}</div>
          <div className="brand__tag intro__hint">First clue in</div>
        </div>
      ) : null}

      {/* ------------------------------------------------------- round */}
      {scene === 'round:live' && round ? (
        <div className="stage__grid">
          <div className="stack" style={{ gap: 20 }}>
            <div className="row">
              <span className="pill pill--category" style={{ fontSize: 15, padding: '8px 16px' }}>
                {typeLabel(round.mysteryType).emoji} {typeLabel(round.mysteryType).label}
              </span>
              <span className="pill pill--live" style={{ fontSize: 15, padding: '8px 16px' }}>
                Clue {round.currentClue} of {round.clueCount}
              </span>
              <span className="pill pill--xp" style={{ fontSize: 15, padding: '8px 16px' }}>
                {CLUE_POINTS[round.currentClue - 1] * round.pointsMultiplier} XP
              </span>
              {round.pointsMultiplier > 1 ? (
                <span className="pill pill--streak" style={{ fontSize: 15, padding: '8px 16px' }}>
                  {'⚡'} DOUBLE POINTS
                </span>
              ) : null}
            </div>

            <p className="stage__clue">
              {'“'}
              {round.clues[round.currentClue - 1]}
              {'”'}
            </p>

            {round.currentClue > 1 ? (
              <div className="stack stack--tight">
                <div className="brand__tag">Earlier clues</div>
                {round.clues.slice(0, -1).map((clue, i) => (
                  <p className="stage__prev" key={i}>
                    {i + 1}. {clue}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="stack center" style={{ alignItems: 'center', gap: 16 }}>
            <div className="timer timer--xl">
              <TimerRing
                seconds={countdown.seconds}
                fraction={countdown.fraction}
                size="xl"
                paused={round.status === 'paused'}
              />
            </div>
            <div className="brand__tag">
              {round.status === 'paused' ? 'Paused' : round.currentClue >= round.clueCount ? 'Last chance' : 'Next clue in'}
            </div>
            <div className="stage__title">
              {round.answeredCount}
              <span className="muted"> / {round.playerCount}</span>
            </div>
            <div className="brand__tag">Locked in</div>
          </div>
        </div>
      ) : null}

      {/* ----------------------------------------------------- results */}
      {scene === 'results' && snapshot?.result ? (
        <div className="stage__grid">
          <div className="stack" style={{ gap: 18 }}>
            <div className="reveal">
              <div className="reveal__label" style={{ fontSize: 18 }}>
                The answer was
              </div>
              <div className="reveal__answer" style={{ fontSize: 'clamp(38px, 6vw, 88px)' }}>
                {snapshot.result.answer}
              </div>
            </div>
            <p className="stage__prev center">
              {snapshot.result.correctCount} of {snapshot.result.totalAnswers} answers were right
              {nextSeconds > 0 ? ` · standings in ${nextSeconds}s` : ''}
            </p>
            <AnswerBars
              distribution={snapshot.result.distribution}
              correctAnswer={snapshot.result.answer}
              total={snapshot.result.totalAnswers}
            />
          </div>
          <div className="stack stage__lb">
            <div className="brand__tag">Standings</div>
            <Leaderboard entries={snapshot.leaderboard} limit={8} showGains />
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------- leaderboard */}
      {scene === 'leaderboard' && snapshot ? (
        <div className="stack center" style={{ gap: 18 }}>
          {nextSeconds > 0 ? (
            <div
              className="pill pill--live"
              style={{ fontSize: 'clamp(14px, 1.6vw, 22px)', padding: '10px 22px' }}
            >
              Next mystery in {nextSeconds}
            </div>
          ) : null}
          <h1 className="stage__title center">
            {'\u{1F4CA}'} Leaderboard{' '}
            <span className="muted" style={{ fontSize: '0.5em' }}>
              after {plural(snapshot.roundsPlayed, 'mystery', 'mysteries')}
            </span>
          </h1>
          <div className="interlude">
            <div className="stage__lb">
              <Leaderboard entries={snapshot.leaderboard} limit={8} showGains />
            </div>
            <div className="stack">
              <div className="stat">
                <div className="stat__value">
                  {snapshot.mysteriesRemaining > 0
                    ? formatXp(snapshot.mysteriesRemaining * CLUE_POINTS[0])
                    : '—'}
                </div>
                <div className="stat__label">
                  {snapshot.mysteriesRemaining > 0
                    ? `XP still on the table · ${snapshot.mysteriesRemaining} to play`
                    : 'Last mystery played'}
                </div>
              </div>
              <Storylines snapshot={snapshot} />
              {snapshot.result ? (
                <p className="stage__prev center">
                  Last answer: <strong>{snapshot.result.answer}</strong>
                </p>
              ) : null}
            </div>
          </div>
          {/* Someone 800 behind needs to know the gap can still be closed
              before the round starts, not after it. */}
          {snapshot.nextRoundMultiplier > 1 ? (
            <div className="pill pill--streak" style={{ fontSize: 'clamp(16px, 2vw, 30px)', padding: '14px 30px' }}>
              {'⚡'} Next up:{' '}
              {snapshot.plannedRounds !== null && snapshot.roundsPlayed + 1 === snapshot.plannedRounds
                ? 'FINAL MYSTERY'
                : 'DOUBLE POINTS'}{' '}
              {'·'} everything counts twice
            </div>
          ) : null}
        </div>
      ) : null}

      {/* -------------------------------------------------- the finale */}
      {scene === 'finished' && snapshot ? (
        <FinalReveal
          stage={finale.stage}
          tick={finale.tick}
          entries={snapshot.leaderboard}
          rounds={snapshot.roundsPlayed}
        />
      ) : null}
      </div>

      {!snapshot ? (
        <div className="center stack" style={{ alignItems: 'center' }}>
          <div className="scanline" style={{ width: 240 }} />
          <p className="muted">Connecting to event {code}...</p>
        </div>
      ) : null}
    </div>
  );
}

/** Rotating one-liners for the between-rounds screen. */
function Storylines({ snapshot }: { snapshot: Snapshot }) {
  const lines = pickStorylines(snapshot);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (lines.length < 2) return;
    const id = setInterval(() => setI((n) => (n + 1) % lines.length), 5000);
    return () => clearInterval(id);
  }, [lines.length]);

  if (lines.length === 0) return null;
  const line = lines[i % lines.length];
  return (
    <div className="storyline" key={line.id}>
      <div className="storyline__emoji">{line.emoji}</div>
      <div>
        <div className="brand__tag">{line.label}</div>
        <div className="storyline__value">{line.value}</div>
      </div>
    </div>
  );
}

/**
 * Drives the 3-2-1 build-up and the bottom-up podium reveal. Presentation
 * only - the scores were settled by the server long before this runs.
 */
function useFinaleSequence(active: boolean) {
  const [stage, setStage] = useState<FinaleStage>('countdown');
  const [tick, setTick] = useState(3);

  useEffect(() => {
    if (!active) {
      setStage('countdown');
      setTick(3);
      return;
    }
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    setStage('countdown');
    setTick(3);
    at(1000, () => setTick(2));
    at(2000, () => setTick(1));
    at(3000, () => setStage('third'));
    at(5000, () => setStage('second'));
    at(7000, () => setStage('first'));
    at(9000, () => setStage('celebrate'));

    return () => timers.forEach(clearTimeout);
  }, [active]);

  return { stage, tick };
}

const ORDER: FinaleStage[] = ['countdown', 'third', 'second', 'first', 'celebrate'];

function FinalReveal({
  stage,
  tick,
  entries,
  rounds,
}: {
  stage: FinaleStage;
  tick: number;
  entries: LeaderboardEntry[];
  rounds: number;
}) {
  const reached = (s: FinaleStage) => ORDER.indexOf(stage) >= ORDER.indexOf(s);
  const winner = entries[0];

  if (stage === 'countdown') {
    return (
      <div className="stack center" style={{ alignItems: 'center' }}>
        <h1 className="winner__label">{'\u{1F3C6}'} Final results</h1>
        <div className="countdown-huge" key={tick}>
          {tick}
        </div>
      </div>
    );
  }

  return (
    <div className="stack center" style={{ alignItems: 'center', gap: 22 }}>
      {reached('celebrate') && winner ? (
        <div className="winner">
          <div className="winner__label">{'\u{1F389}'} We have a winner</div>
          <div className="winner__name">{winner.nickname}</div>
          <div className="winner__score">{formatXp(winner.score)} XP</div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
            <div className="pill pill--streak" style={{ fontSize: 15 }}>
              {'\u{1F3C6}'} Mystery Master
            </div>
            {/* Say it out loud when the score alone did not decide it, rather
                than letting the room wonder how the tie was broken. */}
            {winner.tiedOnScore && winner.avgResponseMs !== null ? (
              <div className="pill pill--xp" style={{ fontSize: 15 }}>
                {'⚡'} Won on speed {'·'} {formatSeconds(winner.avgResponseMs)} avg
                {entries[1]?.avgResponseMs != null
                  ? ` vs ${formatSeconds(entries[1].avgResponseMs)}`
                  : ''}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="winner">
          <div className="winner__label">{'\u{1F3C6}'} Final results</div>
          <div className="stage__title">
            {reached('first')
              ? 'And the winner is...'
              : reached('second')
                ? 'Runner up'
                : 'Third place'}
          </div>
        </div>
      )}

      <Podium
        entries={[
          reached('first') ? entries[0] : undefined,
          reached('second') ? entries[1] : undefined,
          reached('third') ? entries[2] : undefined,
        ]}
      />

      {/* Everyone from 4th down, as one compact strip - a full table would
          push the podium off the top of the projector. */}
      {reached('celebrate') && entries.length > 3 ? (
        <div className="center stack stack--tight" style={{ maxWidth: 1200 }}>
          <p className="brand__tag">The rest of the field after {plural(rounds, 'mystery', 'mysteries')}</p>
          <div className="playerchips" style={{ justifyContent: 'center' }}>
            {entries.slice(3).map((e) => (
              <span className="chip" key={e.playerId} style={{ fontSize: 17 }}>
                <span className="dim">{e.rank}</span>
                {e.nickname}
                <span className="lb__gain" style={{ color: 'var(--lime)' }}>
                  {formatXp(e.score)}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
