/**
 * Pure game helpers. No I/O, no Durable Object state - everything here is
 * deterministic given its arguments, which keeps the interesting rules
 * (scoring, option shuffling, code generation) easy to reason about.
 */

import mysteriesData from '../../data/mysteries.json';
import { CLUE_COUNT, type Mystery } from '../shared/types';

/**
 * The question bank, loaded from data/mysteries.json at build time. Game logic
 * never hard-codes a mystery, so swapping the JSON swaps the whole quiz.
 * Anything malformed is dropped loudly at module load rather than blowing up
 * mid-event.
 */
export const MYSTERIES: Mystery[] = (mysteriesData as Mystery[]).filter((m) => {
  const ok =
    typeof m?.id === 'string' &&
    typeof m?.answer === 'string' &&
    Array.isArray(m?.clues) &&
    m.clues.length === CLUE_COUNT &&
    Array.isArray(m?.options) &&
    m.options.length >= 2 &&
    m.options.includes(m.answer);
  if (!ok) console.error('Skipping malformed mystery in mysteries.json:', m?.id ?? m);
  return ok;
});

const MYSTERY_BY_ID = new Map(MYSTERIES.map((m) => [m.id, m]));

export function getMystery(id: string): Mystery | undefined {
  return MYSTERY_BY_ID.get(id);
}

/**
 * Event codes have to be read off a projector and typed on a phone, so the
 * alphabet drops characters that get confused for one another (0/O, 1/I/L,
 * 5/S, 2/Z, 8/B).
 */
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';

export function generateEventCode(length = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Fisher-Yates with a crypto-grade source. */
export function shuffle<T>(input: readonly T[]): T[] {
  const out = input.slice();
  if (out.length < 2) return out;
  const rand = crypto.getRandomValues(new Uint32Array(out.length));
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build the dropdown for a round: the correct answer plus its distractors,
 * shuffled so the answer never sits in a predictable slot. Shuffled once per
 * round on the server, so every player sees the same order and the host's
 * answer distribution lines up with what players saw.
 */
export function buildOptions(mystery: Mystery, max = 6): string[] {
  const distractors = shuffle(mystery.options.filter((o) => o !== mystery.answer)).slice(0, max - 1);
  return shuffle([mystery.answer, ...distractors]);
}

export function isCorrectAnswer(mystery: Mystery, selectedOption: string): boolean {
  return selectedOption === mystery.answer;
}

/**
 * Invisible characters that nonetheless mean "there is a gap here": tab, the
 * newline family, and the Unicode line and paragraph separators. These are
 * turned into a plain space so the collapse below folds them - deleting them
 * outright would weld the words on either side together.
 */
const SEPARATOR = /[\t\n\v\f\r\u0085\u2028\u2029]/g;

// What is left of the control and format categories once the separators
// above are gone: zero-width joiners, bidi overrides and friends, which would
// otherwise let someone smuggle invisible padding into a nickname.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function sanitizeNickname(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(SEPARATOR, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return cleaned.length >= 1 ? cleaned : null;
}

export function sanitizeText(raw: unknown, max: number, fallback: string): string {
  return sanitizeNickname(raw, max) ?? fallback;
}

/** SHA-256 hex. Used so raw host/player tokens are never stored at rest. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent comparison for hex digests, to avoid leaking via timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
