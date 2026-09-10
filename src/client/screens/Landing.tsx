import { useEffect, useState, type FormEvent } from 'react';
import { CLUE_COUNT, CLUE_DURATION_MS, NICKNAME_MAX } from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { session } from '../lib/session';
import { Brand, Toast } from '../components/common';

type Step = 'code' | 'nickname';

export function Landing({
  navigate,
  initialCode,
}: {
  navigate: (to: string, replace?: boolean) => void;
  initialCode: string;
}) {
  const [step, setStep] = useState<Step>('code');
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [eventName, setEventName] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ total: number; types: number } | null>(null);
  const [resumable, setResumable] = useState<{ code: string; nickname: string } | null>(null);

  useEffect(() => {
    api
      .mysteryStats()
      .then((s) => setStats({ total: s.total, types: Object.keys(s.byType).length }))
      .catch(() => setStats(null));

    const last = session.lastPlayerCode();
    if (last) {
      const saved = session.getPlayer(last);
      if (saved) setResumable({ code: saved.eventCode, nickname: saved.nickname });
    }
  }, []);

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (clean.length < 4) {
      setError('Event codes are at least 4 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const info = await api.lookupEvent(clean);
      setEventName(info.eventName);
      setCode(clean);

      // Already have a seat at this event? Walk straight back in.
      const saved = session.getPlayer(clean);
      if (saved) {
        const rejoined = await api.join(clean, {
          playerId: saved.playerId,
          playerToken: saved.playerToken,
        });
        session.savePlayer({ ...saved, ...rejoined });
        navigate(`/play?code=${clean}`);
        return;
      }
      setStep('nickname');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not find that event.');
    } finally {
      setBusy(false);
    }
  };

  const submitNickname = async (e: FormEvent) => {
    e.preventDefault();
    const name = nickname.trim();
    if (!name) {
      setError('Pick a nickname first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const joined = await api.join(code, { nickname: name });
      session.savePlayer({
        eventCode: joined.eventCode,
        playerId: joined.playerId,
        playerToken: joined.playerToken,
        nickname: joined.nickname,
        eventName: joined.eventName,
      });
      navigate(`/play?code=${joined.eventCode}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="center stack" style={{ alignItems: 'center', paddingTop: 18 }}>
        <Brand large tagline="Live clue-cracking game show" />
        <h1 className="title-xl" style={{ marginTop: 12 }}>
          Crack the clue.
          <br />
          <span style={{ color: 'var(--lime)' }}>Beat the room.</span>
        </h1>
        <p className="muted" style={{ maxWidth: 420 }}>
          Five clues. {CLUE_DURATION_MS / 1000} seconds each. The longer you wait, the less it is worth -
          so how sure are you?
        </p>
      </div>

      {step === 'code' ? (
        <form className="card card--accent stack" onSubmit={submitCode}>
          <div className="field">
            <label className="field__label" htmlFor="code">
              Event code
            </label>
            <input
              id="code"
              className="input input--code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
              placeholder="ABCDE"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              enterKeyHint="go"
              maxLength={8}
              autoFocus
            />
          </div>
          <button className="btn btn--primary btn--lg btn--block" disabled={busy}>
            {busy ? 'Checking...' : 'Find my event'}
          </button>
        </form>
      ) : (
        <form className="card card--accent stack" onSubmit={submitNickname}>
          <div className="center">
            <div className="pill pill--good">{'✓'} {eventName ?? 'Event found'}</div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="nickname">
              Your nickname
            </label>
            <input
              id="nickname"
              className="input"
              value={nickname}
              onChange={(e) => setNickname(e.target.value.slice(0, NICKNAME_MAX))}
              placeholder="What should the room call you?"
              maxLength={NICKNAME_MAX}
              enterKeyHint="go"
              autoFocus
            />
            <span className="tiny dim">
              Shown on the leaderboard. {NICKNAME_MAX - nickname.length} characters left.
            </span>
          </div>
          <button className="btn btn--go btn--lg btn--block" disabled={busy}>
            {busy ? 'Joining...' : 'Join the game'}
          </button>
          <button
            type="button"
            className="link center"
            onClick={() => {
              setStep('code');
              setError(null);
            }}
          >
            Use a different code
          </button>
        </form>
      )}

      {resumable && step === 'code' ? (
        <button className="btn btn--ghost btn--block" onClick={() => navigate(`/play?code=${resumable.code}`)}>
          {'↩'} Rejoin {resumable.code} as {resumable.nickname}
        </button>
      ) : null}

      <div className="card stack">
        <div className="card__title">Running the show?</div>
        <div className="row">
          <button className="btn btn--cyan" onClick={() => navigate('/host')}>
            {'\u{1F3A4}'} Host an event
          </button>
          <button className="btn btn--ghost" onClick={() => navigate('/display')}>
            {'\u{1F4FA}'} Projector view
          </button>
        </div>
        <p className="tiny dim" style={{ margin: 0 }}>
          Hosting creates a code your team types in on their phones. The projector view is the big screen
          in the room.
        </p>
      </div>

      <div className="stats-row">
        <div className="stat">
          <div className="stat__value">{stats?.total ?? '-'}</div>
          <div className="stat__label">Mysteries</div>
        </div>
        <div className="stat">
          <div className="stat__value">{stats?.types ?? '-'}</div>
          <div className="stat__label">Categories</div>
        </div>
        <div className="stat">
          <div className="stat__value">{CLUE_COUNT}</div>
          <div className="stat__label">Clues each</div>
        </div>
        <div className="stat">
          <div className="stat__value">500</div>
          <div className="stat__label">Max XP</div>
        </div>
      </div>

      {error ? <Toast message={error} error /> : null}
    </div>
  );
}
