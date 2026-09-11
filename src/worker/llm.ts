/**
 * Everything that knows Workers AI exists.
 *
 * The rest of the application calls `generateMysteries` and `evaluateMystery`
 * and never learns which model answered, what the prompt said, or that
 * Cloudflare is involved at all. Swapping providers should be a change to
 * this file only.
 *
 * Nothing here is on the path of a live round. The game engine never calls
 * into this module, so an AI outage degrades the host's prep workflow and
 * leaves the running game untouched.
 */

import {
  CLUE_COUNT,
  MAX_POOL_SIZE,
  isDifficulty,
  type Difficulty,
  type Mystery,
  type MysteryEvaluation,
  typeLabel,
} from '../shared/types';
import type { Env } from './db';

/**
 * Llama 3.3 70B, the fp8 "fast" build. Chosen because it is one of the
 * Workers AI models that supports JSON schema mode, which is what lets us
 * skip prose parsing entirely, and because a 70B model writes noticeably
 * better clues than the 8B ones at a latency the host will still sit through.
 */
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** A single request should never hang the host's console. */
const TIMEOUT_MS = 45_000;

export class LlmUnavailableError extends Error {
  // Declared and assigned rather than a constructor parameter property:
  // Node's type stripping, which the test runner uses to read these sources
  // directly, cannot erase parameter properties.
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.reason = reason;
  }
}

function requireAi(env: Env): Ai {
  if (!env.AI) {
    throw new LlmUnavailableError('Workers AI is not configured for this deployment.');
  }
  return env.AI;
}

/** Workers AI has no abort parameter, so bound it from the outside. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LlmUnavailableError('The model took too long to answer.')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * In JSON-schema mode the runtime hands back an already-parsed object, but
 * plain text mode returns a string, and a model can still wrap JSON in a
 * fenced block when it drifts. Accept all three rather than trusting one.
 */
function coerceJson(response: unknown): unknown {
  if (response && typeof response === 'object') return response;
  if (typeof response !== 'string') {
    throw new LlmUnavailableError('The model returned an unexpected response shape.');
  }
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : response).trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmUnavailableError('The model returned something that is not JSON.');
  }
}

async function runModel(env: Env, input: Record<string, unknown>): Promise<unknown> {
  const ai = requireAi(env);
  let result: { response?: unknown };
  try {
    result = (await withTimeout(
      ai.run(MODEL as Parameters<Ai['run']>[0], input as never) as Promise<{ response?: unknown }>,
      TIMEOUT_MS,
    )) as { response?: unknown };
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err;
    // The host gets a calm sentence; the operator needs the real reason.
    console.error('[ai] model call failed:', err);
    // Rate limits, capacity, network - all the same to the caller.
    throw new LlmUnavailableError('The model could not be reached.', err);
  }
  return coerceJson(result?.response);
}

// ---------------------------------------------------------------- prompts

/** Human-readable category list for the prompt, e.g. `landmark (Landmark)`. */
function describeCategories(categories: string[]): string {
  return categories.map((c) => `"${c}" (${typeLabel(c).label})`).join(', ');
}

const DIFFICULTY_GUIDE: Record<Difficulty, string> = {
  easy: 'Most people in a room would know the answer by clue 3. Use widely famous subjects.',
  medium: 'A well-read adult should get it around clue 2 or 3. Avoid specialist knowledge.',
  hard: 'Rewards genuine knowledge. Still fair - the answer must be recognisable once revealed.',
};

/**
 * The production prompt. Phase 4's evaluation compares this against a
 * deliberately basic one; this is the version that won, and the rules below
 * are here because the basic prompt broke each of them.
 */
export function buildGenerationPrompt(
  categories: string[],
  difficulty: Difficulty,
  count: number,
  avoidAnswers: string[],
): string {
  const avoid =
    avoidAnswers.length > 0
      ? `\nDo NOT use any of these answers, they are already taken: ${avoidAnswers.join(', ')}.`
      : '';

  return `You are writing questions for Mystery Rush, a live quiz played on a projector at a company dinner.

HOW THE GAME WORKS
The room sees one clue at a time. Clue 1 appears first and is worth 500 points; each later clue is
worth less (400, 300, 200, 100). Players lock in a single answer from a dropdown at any point. So a
clue that gives the answer away immediately destroys the game: the whole tension is that an early
guess is worth more but is riskier.

WRITE ${count} MYSTERY OBJECT${count === 1 ? '' : 'S'}.

CATEGORY
Use only these categories: ${describeCategories(categories)}.
The "type" field must be exactly one of those identifier strings.
${categories.length > 1 ? 'Spread the mysteries across the categories rather than using only one.' : ''}

DIFFICULTY: ${difficulty}
${DIFFICULTY_GUIDE[difficulty]}

THE FIVE CLUES - the part that matters most
Write exactly ${CLUE_COUNT} clues that get steadily more revealing:
  Clue 1: genuinely vague. True of the answer but also of many other things.
  Clue 2: narrows the field, still no giveaway.
  Clue 3: a useful, concrete detail.
  Clue 4: strong - someone who knows the subject is now sure.
  Clue 5: obvious. It is meant to give it away.
Each clue must add NEW information the previous ones did not. Never make clue 2 vaguer than clue 1.
Write clues in the first person, as the subject speaking, e.g. "I was built for a world exhibition."
Do not name the answer in clues 1 to 4. Do not name any of the other options in any clue.

THE ANSWER AND OPTIONS
- Exactly one defensible answer. If two options could both honestly fit the clues, rewrite it.
- Give 5 options: the answer plus 4 distractors from the same category, all plausible enough to
  tempt someone, none of them also satisfying the clues.
- Options must be unique, and the answer must appear among them verbatim.
- Only state facts you are confident are true. A wrong fact on a projector is worse than a dull one.
- Pick subjects people will enjoy recognising. No obscure trivia, nothing grim or offensive.${avoid}
${count > 1 ? '- Every mystery must have a different answer and subject.' : ''}

Reply with JSON only.`;
}

/** The deliberately basic prompt, kept so the evaluation stays reproducible. */
export function buildBasicGenerationPrompt(
  categories: string[],
  difficulty: Difficulty,
  count: number,
): string {
  return `Write ${count} quiz mystery question${count === 1 ? '' : 's'} for a party game, in the categor${
    categories.length === 1 ? 'y' : 'ies'
  } ${categories.join(', ')}, at ${difficulty} difficulty.
Each mystery needs a title, an answer, 5 answer options, and ${CLUE_COUNT} clues about the answer.
Reply with JSON only.`;
}

function mysterySchema(categories: string[], count: number) {
  const mystery = {
    type: 'object',
    properties: {
      // Constraining the category in the schema itself, because a plain
      // instruction was not enough: the model returned "multiple choice".
      type: { type: 'string', enum: categories },
      title: { type: 'string' },
      answer: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      clues: { type: 'array', items: { type: 'string' } },
    },
    required: ['type', 'title', 'answer', 'options', 'clues'],
  };
  return count === 1
    ? { type: 'object', properties: { mysteries: { type: 'array', items: mystery } }, required: ['mysteries'] }
    : { type: 'object', properties: { mysteries: { type: 'array', items: mystery } }, required: ['mysteries'] };
}

// ------------------------------------------------------------- generation

/** A mystery as the model returned it, before the app has validated anything. */
export type RawMystery = Omit<Mystery, 'id'> & { id?: string };

export interface GenerateOptions {
  categories: string[];
  difficulty: Difficulty;
  count: number;
  /** Answers already in the pool, so the model does not repeat them. */
  avoidAnswers?: string[];
  /** Swap in the basic prompt. Used by the offline evaluation only. */
  promptVariant?: 'production' | 'basic';
}

/**
 * Ask for `count` mysteries. Returns whatever the model produced, untouched
 * apart from being parsed - validation is deliberately somebody else's job,
 * so the rules live in one place and can be tested without a model.
 */
export async function generateMysteries(env: Env, opts: GenerateOptions): Promise<RawMystery[]> {
  const count = Math.max(1, Math.min(MAX_POOL_SIZE, Math.floor(opts.count)));
  if (opts.categories.length === 0) return [];

  const prompt =
    opts.promptVariant === 'basic'
      ? buildBasicGenerationPrompt(opts.categories, opts.difficulty, count)
      : buildGenerationPrompt(opts.categories, opts.difficulty, count, opts.avoidAnswers ?? []);

  const parsed = await runModel(env, {
    messages: [
      { role: 'system', content: 'You write quiz content. You reply with JSON and nothing else.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_schema', json_schema: mysterySchema(opts.categories, count) },
    max_tokens: 700 + count * 550,
    temperature: 0.8,
  });

  const list = (parsed as { mysteries?: unknown }).mysteries;
  if (!Array.isArray(list)) {
    throw new LlmUnavailableError('The model did not return a list of mysteries.');
  }
  return list.slice(0, count) as RawMystery[];
}

// ------------------------------------------------------------- evaluation

const EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    score: { type: 'number' },
    ambiguity: { type: 'number' },
    difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
    feedback: { type: 'array', items: { type: 'string' } },
  },
  required: ['approved', 'score', 'ambiguity', 'difficulty', 'feedback'],
};

/**
 * A second opinion on the things a rule cannot check: whether the clues
 * actually get more revealing, whether another option could honestly be
 * right, whether it is any fun.
 *
 * Advisory only. It gates nothing - the host decides, and the game engine
 * never consults it.
 */
export async function evaluateMystery(
  env: Env,
  mystery: Mystery,
  requestedDifficulty: Difficulty,
): Promise<MysteryEvaluation> {
  const clueList = mystery.clues.map((c, i) => `  Clue ${i + 1}: ${c}`).join('\n');

  const prompt = `Judge one question from Mystery Rush, a live quiz. Clues are revealed one at a time,
earlier guesses score more, and the player picks from a dropdown of options.

Category: ${mystery.type}
Intended difficulty: ${requestedDifficulty}
Answer: ${mystery.answer}
Options: ${mystery.options.join(', ')}
${clueList}

Assess honestly:
1. Given all five clues, is "${mystery.answer}" clearly the intended answer?
2. Could any OTHER option also honestly satisfy the clues? This is the most important question.
3. Is clue 1 vague enough that it is not an immediate giveaway?
4. Does every clue add new information, and do they get steadily more revealing?
5. Is clue 5 obvious enough to end the round fairly?
6. Does it match the intended difficulty?
7. Is everything stated factually correct?
8. Would this be fun at a company dinner, and are the distractors tempting?
9. Does it genuinely belong to the stated category?

Scoring: score 0-100 for overall quality. ambiguity 0-1, where 0 means exactly one defensible answer
and 1 means several options fit equally. Set approved to true only if you would be happy putting this
on a projector in front of a room. Put each concrete problem in feedback as a short sentence; return
an empty list if there is nothing wrong.

Reply with JSON only.`;

  const parsed = (await runModel(env, {
    messages: [
      { role: 'system', content: 'You are a strict quiz editor. You reply with JSON and nothing else.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_schema', json_schema: EVALUATION_SCHEMA },
    max_tokens: 600,
    temperature: 0.2,
  })) as Partial<MysteryEvaluation>;

  // The evaluator is as untrusted as the generator, so clamp everything.
  const score = Number(parsed.score);
  const ambiguity = Number(parsed.ambiguity);
  return {
    approved: parsed.approved === true,
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    ambiguity: Number.isFinite(ambiguity) ? Math.max(0, Math.min(1, ambiguity)) : 1,
    difficulty: isDifficulty(parsed.difficulty) ? parsed.difficulty : requestedDifficulty,
    feedback: Array.isArray(parsed.feedback)
      ? parsed.feedback.filter((f): f is string => typeof f === 'string').slice(0, 8)
      : [],
  };
}
