import { useState } from 'react';
import {
  DIFFICULTIES,
  MYSTERY_TYPES,
  typeLabel,
  type Difficulty,
  type Mystery,
  type MysteryCandidate,
  type ValidationIssue,
} from '../../shared/types';
import { ApiError, api, type PoolResponse } from '../lib/api';

/**
 * The host's mystery-preparation workflow.
 *
 * Deliberately a panel inside the existing console rather than a new screen:
 * this is preparation, and the night itself is still the code, the clues and
 * the leaderboard. Nothing generated here is playable until the host has
 * looked at it and pressed a button.
 */
export function AiGenerator({
  code,
  hostToken,
  onApproved,
}: {
  code: string;
  hostToken: string;
  onApproved: (mystery: Mystery) => void;
}) {
  const [categories, setCategories] = useState<string[]>(['landmark']);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [count, setCount] = useState(5);
  const [phase, setPhase] = useState<'idle' | 'generating' | 'evaluating'>('idle');
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MysteryCandidate | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  const busy = phase !== 'idle';

  const toggleCategory = (type: string) => {
    setCategories((prev) => (prev.includes(type) ? prev.filter((c) => c !== type) : [...prev, type]));
  };

  const generate = async () => {
    setError(null);
    setPreview(null);
    setPhase('generating');
    // Generation and evaluation are one request; the second label is what the
    // server is doing for most of the wait, so it is worth saying so.
    const evaluating = setTimeout(() => setPhase('evaluating'), 4000);
    try {
      const result = await api.generateMysteries(code, {
        hostToken,
        categories,
        difficulty,
        count,
      });
      setPool(result);
      if (result.error && result.candidates.length === 0) setError(result.error);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'AI generation is temporarily unavailable.',
      );
      setPool(null);
    } finally {
      clearTimeout(evaluating);
      setPhase('idle');
    }
  };

  /**
   * Replace one card. Asks for a single mystery in that card's own category,
   * so regenerating a weak food mystery does not hand back a landmark.
   */
  const regenerate = async (candidate: MysteryCandidate) => {
    setRegenerating(candidate.mystery.id);
    setError(null);
    try {
      const result = await api.generateMysteries(code, {
        hostToken,
        categories: [candidate.mystery.type],
        difficulty: candidate.difficulty,
        count: 1,
      });
      const replacement = result.candidates[0];
      if (!replacement) {
        setError(result.error ?? 'Nothing usable came back. Try again.');
        return;
      }
      setPool((prev) =>
        prev
          ? {
              ...prev,
              candidates: prev.candidates.map((c) =>
                c.mystery.id === candidate.mystery.id ? replacement : c,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'AI generation is temporarily unavailable.');
    } finally {
      setRegenerating(null);
    }
  };

  const approve = async (candidate: MysteryCandidate) => {
    setApproving(candidate.mystery.id);
    setError(null);
    try {
      await api.approveMystery(code, { hostToken, mystery: candidate.mystery });
      setApproved((prev) => new Set(prev).add(candidate.mystery.id));
      onApproved(candidate.mystery);
      setPreview(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that mystery.');
    } finally {
      setApproving(null);
    }
  };

  return (
    <div className="card stack">
      <div className="row row--between">
        <div className="card__title" style={{ margin: 0 }}>
          {'✨'} Generate with AI
        </div>
        {pool && pool.candidates.length > 0 ? (
          <span className="pill pill--muted">{approved.size} added</span>
        ) : null}
      </div>

      <div className="field">
        <span className="field__label">Categories</span>
        <div className="catgrid">
          {MYSTERY_TYPES.map((t) => (
            <label key={t} className={`catchip${categories.includes(t) ? ' catchip--on' : ''}`}>
              <input
                type="checkbox"
                checked={categories.includes(t)}
                onChange={() => toggleCategory(t)}
                disabled={busy}
              />
              <span>
                {typeLabel(t).emoji} {typeLabel(t).label}
              </span>
            </label>
          ))}
        </div>
        <span className="tiny dim">
          {categories.length === 0
            ? 'Pick at least one.'
            : categories.length === 1
              ? 'The pool will only use this category.'
              : `The pool will be spread across these ${categories.length} categories.`}
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="ai-difficulty">
          Difficulty
        </label>
        <select
          id="ai-difficulty"
          className="select"
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value as Difficulty)}
          disabled={busy}
        >
          {DIFFICULTIES.map((d) => (
            <option key={d} value={d}>
              {d[0]!.toUpperCase() + d.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="ai-count">
          How many
        </label>
        <select
          id="ai-count"
          className="select"
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          disabled={busy}
        >
          {[1, 3, 5, 8, 10].map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'mystery' : 'mysteries'}
            </option>
          ))}
        </select>
      </div>

      <button
        className="btn btn--cyan btn--block"
        onClick={generate}
        disabled={busy || categories.length === 0}
      >
        {phase === 'generating'
          ? 'Generating...'
          : phase === 'evaluating'
            ? 'Evaluating...'
            : `✨ Generate ${count === 1 ? 'a mystery' : count + ' mysteries'}`}
      </button>

      {busy ? <div className="scanline" /> : null}

      {error ? (
        <div className="aicard aicard--bad">
          <div className="aicard__title">{'✕'} {error}</div>
          <p className="tiny dim" style={{ margin: 0 }}>
            The built-in mysteries still work - pick one from the list below.
          </p>
        </div>
      ) : null}

      {pool?.candidates.map((c) => (
        <CandidateCard
          key={c.mystery.id}
          candidate={c}
          approved={approved.has(c.mystery.id)}
          rejected={rejected.has(c.mystery.id)}
          approving={approving === c.mystery.id}
          regenerating={regenerating === c.mystery.id}
          onPreview={() => setPreview(c)}
          onApprove={() => approve(c)}
          onRegenerate={() => regenerate(c)}
          onReject={() => setRejected((prev) => new Set(prev).add(c.mystery.id))}
        />
      ))}

      {pool && pool.rejected.length > 0 ? (
        <details>
          <summary className="link tiny">
            {pool.rejected.length} discarded before you saw {pool.rejected.length === 1 ? 'it' : 'them'}
          </summary>
          <ul className="tiny dim" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
            {pool.rejected.map((r, i) => (
              <li key={i}>
                <strong>{r.answer}</strong> {'—'} {r.issues.map((x) => x.message).join(' ')}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {pool && pool.candidates.length === 0 && !error ? (
        <p className="tiny dim" style={{ margin: 0 }}>
          Nothing survived validation this time. Try again, or a different category.
        </p>
      ) : null}

      {preview ? (
        <PreviewModal
          candidate={preview}
          onClose={() => setPreview(null)}
          onApprove={() => approve(preview)}
          approved={approved.has(preview.mystery.id)}
        />
      ) : null}
    </div>
  );
}

function scoreTone(score: number): string {
  return score >= 75 ? 'good' : score >= 50 ? 'warn' : 'bad';
}

function CandidateCard({
  candidate,
  approved,
  rejected,
  approving,
  regenerating,
  onPreview,
  onApprove,
  onRegenerate,
  onReject,
}: {
  candidate: MysteryCandidate;
  approved: boolean;
  rejected: boolean;
  approving: boolean;
  regenerating: boolean;
  onPreview: () => void;
  onApprove: () => void;
  onRegenerate: () => void;
  onReject: () => void;
}) {
  const { mystery, evaluation, issues } = candidate;
  const warnings = issues.filter((i) => i.severity === 'warning');
  const tone = evaluation ? scoreTone(evaluation.score) : 'warn';

  return (
    <div className={`aicard aicard--${rejected ? 'muted' : tone}`}>
      <div className="row row--between">
        <span className="pill pill--category">
          {typeLabel(mystery.type).emoji} {typeLabel(mystery.type).label}
        </span>
        {evaluation ? (
          <span className={`pill pill--${tone === 'good' ? 'good' : 'muted'}`}>
            {evaluation.score}/100
          </span>
        ) : (
          <span className="pill pill--muted">not scored</span>
        )}
      </div>

      <div className="aicard__title">{mystery.answer}</div>
      <div className="tiny dim">
        {mystery.clues.length} clues {'·'} {mystery.options.length} options {'·'}{' '}
        {candidate.difficulty}
      </div>

      <div className="row" style={{ gap: 6 }}>
        {approved ? (
          <span className="pill pill--good">{'✓'} Added to the game</span>
        ) : rejected ? (
          <span className="pill pill--muted">{'✕'} Rejected</span>
        ) : evaluation?.approved ? (
          <span className="pill pill--good">{'✓'} Approved by the evaluator</span>
        ) : (
          <span className="pill pill--streak">{'⚠'} Needs review</span>
        )}
        {warnings.length > 0 ? (
          <span className="pill pill--streak">
            {'⚠'} {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {evaluation && evaluation.feedback.length > 0 ? (
        <ul className="tiny dim" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
          {evaluation.feedback.slice(0, 3).map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      ) : null}

      {!approved && !rejected ? (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--ghost btn--sm" onClick={onPreview}>
            Preview
          </button>
          <button className="btn btn--go btn--sm" onClick={onApprove} disabled={approving}>
            {approving ? 'Adding...' : 'Add to game'}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={onRegenerate} disabled={regenerating}>
            {regenerating ? 'Regenerating...' : 'Regenerate'}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={onReject}>
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The mystery as the room would meet it, plus everything only the host is
 * allowed to see. This is the last checkpoint before content reaches a
 * projector, so it shows the answer, the machine's opinion, and any warning
 * that was not serious enough to reject outright.
 */
function PreviewModal({
  candidate,
  onClose,
  onApprove,
  approved,
}: {
  candidate: MysteryCandidate;
  onClose: () => void;
  onApprove: () => void;
  approved: boolean;
}) {
  const { mystery, evaluation, issues } = candidate;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Mystery preview"
        style={{ maxWidth: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row row--between">
          <span className="pill pill--category">
            {typeLabel(mystery.type).emoji} {typeLabel(mystery.type).label}
          </span>
          <span className="pill pill--muted">{candidate.difficulty}</span>
        </div>

        <h2 className="modal__title" style={{ marginTop: 10 }}>
          {mystery.title}
        </h2>

        <div className="reveal reveal--host" style={{ marginTop: 10 }}>
          <div className="reveal__label">Answer (host only)</div>
          <div className="reveal__answer" style={{ fontSize: 22 }}>
            {mystery.answer}
          </div>
        </div>

        <div className="card__title" style={{ marginTop: 16, marginBottom: 8 }}>
          The five clues
        </div>
        <ol className="stack stack--tight" style={{ margin: 0, paddingLeft: 20 }}>
          {mystery.clues.map((clue, i) => (
            <li key={i} className="small" style={{ marginBottom: 6 }}>
              {clue}
              <span className="tiny dim"> {'·'} worth {[500, 400, 300, 200, 100][i]} XP</span>
            </li>
          ))}
        </ol>

        <div className="card__title" style={{ marginTop: 16, marginBottom: 8 }}>
          Options
        </div>
        <div className="playerchips">
          {mystery.options.map((o) => (
            <span className={`chip${o === mystery.answer ? ' chip--answer' : ''}`} key={o}>
              {o}
            </span>
          ))}
        </div>

        {evaluation ? (
          <>
            <div className="card__title" style={{ marginTop: 16, marginBottom: 8 }}>
              AI evaluation
            </div>
            <div className="row">
              <span className="pill">{evaluation.score}/100</span>
              <span className="pill">ambiguity {evaluation.ambiguity.toFixed(2)}</span>
              <span className="pill">reads as {evaluation.difficulty}</span>
            </div>
            {evaluation.feedback.length > 0 ? (
              <ul className="tiny dim" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
                {evaluation.feedback.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="tiny dim" style={{ marginTop: 14 }}>
            The evaluator could not be reached, so this one has not been scored.
          </p>
        )}

        {issues.length > 0 ? (
          <ul className="tiny" style={{ margin: '12px 0 0', paddingLeft: 18, color: 'var(--gold)' }}>
            {issues.map((i: ValidationIssue, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        ) : null}

        <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          {!approved ? (
            <button className="btn btn--go" onClick={onApprove}>
              Add to game
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
