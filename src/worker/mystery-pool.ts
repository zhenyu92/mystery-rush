/**
 * Turns a host's request into reviewable candidates.
 *
 * The order is deliberate: generate, then check the things a rule can decide,
 * then - only for what survived - spend a second model call on the things it
 * cannot. Evaluating a mystery that is already structurally broken wastes
 * time the host is sitting through, and invites the model to excuse a fault
 * the rules already caught.
 *
 * Nothing here touches game state. It returns candidates; the host approves
 * them; the Durable Object decides what is playable.
 */

import {
  MAX_POOL_SIZE,
  type Difficulty,
  type Mystery,
  type MysteryCandidate,
  type ValidationIssue,
} from '../shared/types';
import type { Env } from './db';
import { MYSTERIES, randomId } from './game';
import { LlmUnavailableError, evaluateMystery, generateMysteries, type RawMystery } from './llm';
import { hasErrors, validateMystery } from './mystery-validation';

/**
 * How many times we will go back to the model for replacements. Bounded, and
 * bounded low: a host waiting on a spinner would rather see eight good
 * mysteries and a note than wait through four silent retries.
 */
const MAX_ATTEMPTS = 3;

export interface PoolResult {
  candidates: MysteryCandidate[];
  /** Candidates that failed the rules outright, kept so the host sees why. */
  rejected: Array<{ issues: ValidationIssue[]; answer: string }>;
  /** Set when generation itself failed; candidates may still hold earlier wins. */
  error: string | null;
  attempts: number;
}

/**
 * The bar a mystery must clear to go straight into an event with nobody
 * reading it first.
 *
 * Deterministic rules come first and carry the veto: `docs/mystery-evaluation.md`
 * found the model rating a two-clue-thin Shawshank question 96/100, so the
 * evaluator is treated as a second opinion that can only ever *lower* the
 * verdict, never rescue a candidate the rules were unhappy with. That is why
 * warnings - not just errors - are disqualifying here, even though a host
 * reviewing by hand would have been allowed to wave them through.
 *
 * A missing evaluation is a fail, not a pass. If the judge could not be
 * reached, nobody has read the question, and the built-in bank is a better
 * answer than an unread one.
 */
export function meetsAutoAcceptBar(candidate: MysteryCandidate): boolean {
  if (candidate.issues.length > 0) return false;
  const e = candidate.evaluation;
  if (!e) return false;
  return e.approved && e.score >= AUTO_ACCEPT_SCORE && e.ambiguity <= AUTO_ACCEPT_AMBIGUITY;
}

export const AUTO_ACCEPT_SCORE = 75;
export const AUTO_ACCEPT_AMBIGUITY = 0.3;

/**
 * Why a candidate missed the automatic bar, in the same shape as a validation
 * issue so the host sees one consistent list rather than two vocabularies.
 */
function describeRejection(candidate: MysteryCandidate): ValidationIssue[] {
  const issues = [...candidate.issues];
  const e = candidate.evaluation;
  if (!e) {
    issues.push({
      code: 'not_evaluated',
      severity: 'error',
      message: 'Could not be checked for quality, so it was not used.',
    });
    return issues;
  }
  if (!e.approved) {
    issues.push({ code: 'not_approved', severity: 'error', message: 'Did not pass the quality check.' });
  }
  if (e.score < AUTO_ACCEPT_SCORE) {
    issues.push({ code: 'low_score', severity: 'error', message: `Scored ${e.score}, below ${AUTO_ACCEPT_SCORE}.` });
  }
  if (e.ambiguity > AUTO_ACCEPT_AMBIGUITY) {
    issues.push({ code: 'ambiguous', severity: 'error', message: 'More than one option could be right.' });
  }
  return issues;
}

function tidy(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Normalise before validating, so that trivia like stray whitespace is not
 * reported to the host as a fault. Anything structural is left exactly as the
 * model produced it - the validator must see the real shape.
 */
function normalise(raw: RawMystery, fallbackType: string): Mystery {
  return {
    id: randomId('ai'),
    type: tidy(raw.type, 40) || fallbackType,
    title: tidy(raw.title, 48) || 'AI Mystery',
    answer: tidy(raw.answer, 60),
    options: Array.isArray(raw.options) ? raw.options.map((o) => tidy(o, 60)) : [],
    clues: Array.isArray(raw.clues) ? raw.clues.map((c) => tidy(c, 200)) : [],
  };
}

export interface BuildPoolOptions {
  categories: string[];
  difficulty: Difficulty;
  count: number;
  /** Answers already available to this event, built-in or approved. */
  existingAnswers?: string[];
  promptVariant?: 'production' | 'basic';
  /** Skip the AI evaluation pass. The offline evaluation scores separately. */
  skipEvaluation?: boolean;
  /**
   * Only return candidates that clear {@link meetsAutoAcceptBar}, replacing
   * the ones that do not. Used when there is no host reading the output.
   */
  autoAccept?: boolean;
}

export async function buildMysteryPool(env: Env, opts: BuildPoolOptions): Promise<PoolResult> {
  const want = Math.max(1, Math.min(MAX_POOL_SIZE, Math.floor(opts.count)));
  const categories = opts.categories.filter((c) => typeof c === 'string' && c.length > 0);

  const candidates: MysteryCandidate[] = [];
  const rejected: PoolResult['rejected'] = [];

  const seenIds = new Set<string>(MYSTERIES.map((m) => m.id));
  const seenAnswers = new Set<string>([
    ...MYSTERIES.map((m) => m.answer.toLowerCase()),
    ...(opts.existingAnswers ?? []).map((a) => a.toLowerCase()),
  ]);

  let error: string | null = null;
  let attempts = 0;

  while (candidates.length < want && attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const missing = want - candidates.length;

    let batch: RawMystery[];
    try {
      batch = await generateMysteries(env, {
        categories,
        difficulty: opts.difficulty,
        count: missing,
        avoidAnswers: [...seenAnswers].slice(-40),
        promptVariant: opts.promptVariant,
      });
    } catch (err) {
      // Keep whatever earlier attempts produced rather than losing the pool.
      error =
        err instanceof LlmUnavailableError
          ? err.message
          : 'AI generation is temporarily unavailable.';
      break;
    }

    if (batch.length === 0) break;

    for (const raw of batch) {
      if (candidates.length >= want) break;

      const mystery = normalise(raw, categories[0] ?? '');
      const issues = validateMystery(mystery, {
        allowedCategories: categories,
        seenIds,
        seenAnswers,
      });

      if (hasErrors(issues)) {
        rejected.push({ issues, answer: mystery.answer || '(no answer)' });
        continue;
      }

      const candidate: MysteryCandidate = {
        mystery,
        difficulty: opts.difficulty,
        issues,
        evaluation: null,
        status: 'pending',
      };

      // Judge only what passed the rules: evaluating an already-broken
      // mystery wastes the host's time and invites the model to excuse a
      // fault the rules already caught. A failed evaluation never loses a
      // mystery that is otherwise fine - it just leaves it unjudged.
      if (!opts.skipEvaluation) {
        try {
          candidate.evaluation = await evaluateMystery(env, mystery, opts.difficulty);
        } catch {
          candidate.evaluation = null;
        }
      }

      if (opts.autoAccept && !meetsAutoAcceptBar(candidate)) {
        rejected.push({ issues: describeRejection(candidate), answer: mystery.answer });
        continue;
      }

      // Only claim the answer once it is actually kept, so a rejected
      // candidate does not stop a better one using the same subject.
      seenIds.add(mystery.id);
      seenAnswers.add(mystery.answer.toLowerCase());
      candidates.push(candidate);
    }
  }

  return { candidates, rejected, error, attempts };
}
