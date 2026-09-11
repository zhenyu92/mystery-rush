/**
 * Deterministic validation for generated mysteries.
 *
 * This runs before the model is ever asked to judge its own work, and it is
 * the only gate that is allowed to be strict: AI output is untrusted input
 * that will be rendered on a projector in front of a room, so anything that
 * can be decided by a rule is decided here rather than by a second opinion
 * from the same kind of system that produced it.
 *
 * Pure. No I/O, no AI, no game state - so it is cheap to test exhaustively,
 * and the same rules can be pointed at the hand-written bank to check the
 * rules themselves are not nonsense.
 */

import {
  ANSWER_MAX_LENGTH,
  CLUE_COUNT,
  CLUE_MAX_LENGTH,
  CLUE_MIN_LENGTH,
  OPTIONS_MAX,
  OPTIONS_MIN,
  TITLE_MAX_LENGTH,
  isMysteryType,
  type Mystery,
  type ValidationIssue,
} from '../shared/types';

/** Anything that could turn generated text into markup or script. */
const UNSAFE = /[<>]|javascript:|data:text\/html|on\w+\s*=/i;

/**
 * Words too common to count as giving the answer away. "The Great Wall" and
 * "Great Pyramid" share "great"; that tells a player nothing.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'from',
  'great', 'famous', 'national', 'international', 'world', 'new', 'old',
  'big', 'little', 'first', 'last', 'city', 'tower', 'house', 'museum',
]);

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Case-insensitive whole-phrase match, so "Moon" does not hit "moonlight". */
function containsPhrase(haystack: string, needle: string): boolean {
  const h = ` ${words(haystack).join(' ')} `;
  const n = ` ${words(needle).join(' ')} `;
  return n.trim().length > 0 && h.includes(n);
}

/** Words from the answer distinctive enough that using one is a real tell. */
function distinctiveTokens(answer: string): string[] {
  return words(answer).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

const err = (code: string, message: string): ValidationIssue => ({ code, severity: 'error', message });
const warn = (code: string, message: string): ValidationIssue => ({ code, severity: 'warning', message });

export interface ValidateOptions {
  /** The categories the host actually asked for. */
  allowedCategories: string[];
  /** Ids and answers already taken, so a pool cannot repeat itself. */
  seenIds?: Set<string>;
  seenAnswers?: Set<string>;
}

/**
 * Check one candidate. Returns every issue found rather than stopping at the
 * first, so the host sees the whole picture and a regeneration prompt can be
 * told everything that was wrong at once.
 *
 * Errors make a mystery unplayable. Warnings are for the host to weigh.
 */
export function validateMystery(raw: unknown, opts: ValidateOptions): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [err('not_an_object', 'The model did not return a mystery object.')];
  }
  const m = raw as Partial<Mystery>;

  // --- shape ---------------------------------------------------------
  for (const field of ['id', 'type', 'title', 'answer'] as const) {
    if (typeof m[field] !== 'string' || m[field]!.trim().length === 0) {
      issues.push(err(`missing_${field}`, `Missing or empty "${field}".`));
    }
  }
  if (!Array.isArray(m.clues)) issues.push(err('missing_clues', 'Missing "clues".'));
  if (!Array.isArray(m.options)) issues.push(err('missing_options', 'Missing "options".'));

  // Everything below reads these, so stop if the shape is not there at all.
  if (issues.length > 0) return issues;

  const id = m.id!.trim();
  const type = m.type!.trim();
  const title = m.title!.trim();
  const answer = m.answer!.trim();
  const clues = m.clues!;
  const options = m.options!;

  // --- category ------------------------------------------------------
  if (!isMysteryType(type)) {
    issues.push(err('unknown_type', `"${type}" is not a supported category.`));
  } else if (!opts.allowedCategories.includes(type)) {
    issues.push(
      err('category_not_requested', `Category "${type}" was not one of the categories you chose.`),
    );
  }

  // --- uniqueness across the pool -------------------------------------
  if (opts.seenIds?.has(id)) issues.push(err('duplicate_id', `Duplicate id "${id}".`));
  if (opts.seenAnswers?.has(answer.toLowerCase())) {
    issues.push(err('duplicate_answer', `"${answer}" already appears in this pool.`));
  }

  // --- answer and options ---------------------------------------------
  if (answer.length > ANSWER_MAX_LENGTH) {
    issues.push(err('answer_too_long', `The answer is longer than ${ANSWER_MAX_LENGTH} characters.`));
  }
  if (title.length > TITLE_MAX_LENGTH) {
    issues.push(warn('title_too_long', `The title is longer than ${TITLE_MAX_LENGTH} characters.`));
  }

  if (options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) {
    issues.push(
      err('option_count', `Expected between ${OPTIONS_MIN} and ${OPTIONS_MAX} options, got ${options.length}.`),
    );
  }
  if (!options.every((o) => typeof o === 'string' && o.trim().length > 0)) {
    issues.push(err('empty_option', 'One of the options is empty.'));
  } else {
    const normalised = options.map((o) => o.trim().toLowerCase());
    if (new Set(normalised).size !== normalised.length) {
      issues.push(err('duplicate_options', 'The options contain a duplicate.'));
    }
    if (!normalised.includes(answer.toLowerCase())) {
      issues.push(err('answer_not_in_options', 'The answer is not one of the options.'));
    }
    for (const o of options) {
      if (UNSAFE.test(o)) issues.push(err('unsafe_option', 'An option contains unsafe characters.'));
    }
  }

  // --- clues -----------------------------------------------------------
  if (clues.length !== CLUE_COUNT) {
    issues.push(err('clue_count', `Expected exactly ${CLUE_COUNT} clues, got ${clues.length}.`));
  }

  clues.forEach((clue, i) => {
    const n = i + 1;
    if (typeof clue !== 'string' || clue.trim().length === 0) {
      issues.push(err('empty_clue', `Clue ${n} is empty.`));
      return;
    }
    const text = clue.trim();
    if (text.length < CLUE_MIN_LENGTH) {
      issues.push(err('clue_too_short', `Clue ${n} is too short to be a real clue.`));
    }
    if (text.length > CLUE_MAX_LENGTH) {
      issues.push(err('clue_too_long', `Clue ${n} is longer than ${CLUE_MAX_LENGTH} characters.`));
    }
    if (UNSAFE.test(text)) {
      issues.push(err('unsafe_clue', `Clue ${n} contains unsafe characters.`));
    }

    // Naming the answer outright is only allowed on the last clue, which is
    // supposed to give it away.
    if (n < CLUE_COUNT && containsPhrase(text, answer)) {
      issues.push(err('answer_revealed', `Clue ${n} names the answer outright.`));
    }

    // A distinctive word from the answer in the first two clues is a tell,
    // but not always a fatal one - "in Sydney" on clue 4 of a Sydney
    // landmark is fine, so this is the host's call, not the validator's.
    if (n <= 2) {
      const tell = distinctiveTokens(answer).find((t) => words(text).includes(t));
      if (tell) {
        issues.push(warn('early_tell', `Clue ${n} uses "${tell}" from the answer.`));
      }
    }

    // Another option being named would hand players an elimination.
    for (const o of options) {
      if (typeof o === 'string' && o.trim().toLowerCase() !== answer.toLowerCase()) {
        if (containsPhrase(text, o)) {
          issues.push(warn('names_distractor', `Clue ${n} names another option, "${o}".`));
        }
      }
    }
  });

  if (UNSAFE.test(title) || UNSAFE.test(answer)) {
    issues.push(err('unsafe_text', 'The title or answer contains unsafe characters.'));
  }

  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
