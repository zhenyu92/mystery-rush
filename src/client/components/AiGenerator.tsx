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
  const [category, setCategory] = useState<string>('landmark');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [phase, setPhase] = useState<'idle' | 'generating' | 'evaluating'>('idle');
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MysteryCandidate | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  const busy = phase !== 'idle';

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
        categories: [category],
        difficulty,
        count: 1,
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
        <label className="field__label" htmlFor="ai-category">
          Category
        </label>
        <select
          id="ai-category"
          className="select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={busy}
        >
          {MYSTERY_TYPES.map((t) => (
            <option key={t} value={t}>
              {typeLabel(t).emoji} {typeLabel(t).label}
            </option>
          ))}
        </select>
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

      <button className="btn btn--cyan btn--block" onClick={generate} disabled={busy}>
        {phase === 'generating'
          ? 'Generating...'
          : phase === 'evaluating'
            ? 'Evaluating...'
            : '✨ Generate a mystery'}
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
          onPreview={() => setPreview(c)}
          onApprove={() => approve(c)}
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
  onPreview,
  onApprove,
  onReject,
}: {
  candidate: MysteryCandidate;
  approved: boolean;
  rejected: boolean;
  approving: boolean;
  onPreview: () => void;
  onApprove: () => void;
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
