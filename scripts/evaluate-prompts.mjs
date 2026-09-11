/**
 * Prompt A vs Prompt B, scored the same way production scores.
 *
 *   node --experimental-strip-types --no-warnings scripts/evaluate-prompts.mjs [n]
 *
 * Generates `n` mysteries per prompt (20 by default) across a fixed set of
 * categories, runs each through the real deterministic validator, then scores
 * each with the same evaluator prompt the product uses, and writes
 * docs/mystery-evaluation.md.
 *
 * This calls Workers AI directly over the REST API rather than through the
 * Worker, because the production endpoint deliberately does not let a caller
 * choose which prompt to use. The prompts, the schema, the model and the
 * validator are all imported from the shipped source, so the only thing that
 * differs from production is the transport.
 *
 * It costs real inference. Run it when you mean to.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import {
  EVALUATION_SCHEMA,
  MODEL,
  buildBasicGenerationPrompt,
  buildEvaluationPrompt,
  buildGenerationPrompt,
  clampEvaluation,
  mysterySchema,
} from '../src/worker/llm.ts';
import { validateMystery } from '../src/worker/mystery-validation.ts';

const ACCOUNT = process.env.CF_ACCOUNT_ID ?? 'ecea8c533d0c8d1e9fb34436557b962b';
const CATEGORIES = ['landmark', 'movie', 'food', 'animal', 'space'];
const DIFFICULTY = 'medium';
const BATCH = 5;
const TARGET = Number(process.argv[2] ?? 20);

function token() {
  const cfg = process.env.APPDATA
    ? `${process.env.APPDATA}/xdg.config/.wrangler/config/default.toml`
    : `${process.env.HOME}/.config/.wrangler/config/default.toml`;
  const m = readFileSync(cfg, 'utf8').match(/^oauth_token\s*=\s*"(.*)"/m);
  if (!m) throw new Error('No wrangler OAuth token found. Run `npx wrangler login`.');
  return m[1];
}
const TOKEN = token();

async function run(body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  const raw = json.result.response;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function generate(variant, categories, count) {
  const prompt =
    variant === 'A'
      ? buildBasicGenerationPrompt(categories, DIFFICULTY, count)
      : buildGenerationPrompt(categories, DIFFICULTY, count, []);
  const out = await run({
    messages: [
      { role: 'system', content: 'You write quiz content. You reply with JSON and nothing else.' },
      { role: 'user', content: prompt },
    ],
    // Prompt A gets the same schema, so the comparison is about the prompt
    // wording and not about one variant being handed structured output.
    response_format: { type: 'json_schema', json_schema: mysterySchema(categories, count) },
    max_tokens: 700 + count * 550,
    temperature: 0.8,
  });
  return Array.isArray(out?.mysteries) ? out.mysteries : [];
}

async function judge(mystery) {
  const parsed = await run({
    messages: [
      { role: 'system', content: 'You are a strict quiz editor. You reply with JSON and nothing else.' },
      { role: 'user', content: buildEvaluationPrompt(mystery, DIFFICULTY) },
    ],
    response_format: { type: 'json_schema', json_schema: EVALUATION_SCHEMA },
    max_tokens: 600,
    temperature: 0.2,
  });
  return clampEvaluation(parsed, DIFFICULTY);
}

async function evaluateVariant(variant) {
  const raws = [];
  let batchIndex = 0;
  while (raws.length < TARGET) {
    // Rotate the category slice so neither variant is judged on one subject.
    const slice = [CATEGORIES[batchIndex % CATEGORIES.length], CATEGORIES[(batchIndex + 1) % CATEGORIES.length]];
    batchIndex += 1;
    try {
      const batch = await generate(variant, slice, Math.min(BATCH, TARGET - raws.length));
      raws.push(...batch.map((m) => ({ raw: m, allowed: slice })));
    } catch (err) {
      console.error(`  [${variant}] generation failed:`, err.message);
      break;
    }
    process.stdout.write(`  [${variant}] ${raws.length}/${TARGET}\r`);
  }

  const seenIds = new Set();
  const seenAnswers = new Set();
  const rows = [];

  for (const [i, { raw, allowed }] of raws.entries()) {
    const mystery = {
      id: `eval_${variant}_${i}`,
      type: typeof raw?.type === 'string' ? raw.type.trim() : '',
      title: typeof raw?.title === 'string' ? raw.title.trim() : '',
      answer: typeof raw?.answer === 'string' ? raw.answer.trim() : '',
      options: Array.isArray(raw?.options) ? raw.options.map((o) => String(o).trim()) : [],
      clues: Array.isArray(raw?.clues) ? raw.clues.map((c) => String(c).trim()) : [],
    };
    const issues = validateMystery(mystery, { allowedCategories: allowed, seenIds, seenAnswers });
    seenIds.add(mystery.id);
    if (mystery.answer) seenAnswers.add(mystery.answer.toLowerCase());

    const errors = issues.filter((x) => x.severity === 'error');
    let evaluation = null;
    // Only score what a host could actually have played.
    if (errors.length === 0) {
      try {
        evaluation = await judge(mystery);
      } catch (err) {
        console.error(`  [${variant}] evaluation failed:`, err.message);
      }
    }
    rows.push({ mystery, issues, evaluation });
    process.stdout.write(`  [${variant}] scored ${rows.length}/${raws.length}\r`);
  }
  console.log(`  [${variant}] done: ${rows.length} mysteries              `);
  return rows;
}

function summarise(rows) {
  const has = (r, code) => r.issues.some((i) => i.code === code);
  const errored = rows.filter((r) => r.issues.some((i) => i.severity === 'error'));
  const valid = rows.filter((r) => !r.issues.some((i) => i.severity === 'error'));
  const scored = valid.filter((r) => r.evaluation);
  const ambiguous = scored.filter((r) => r.evaluation.ambiguity >= 0.3);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    total: rows.length,
    valid: valid.length,
    invalid: errored.length,
    categoryViolations: rows.filter((r) => has(r, 'unknown_type') || has(r, 'category_not_requested')).length,
    clueCount: rows.filter((r) => has(r, 'clue_count')).length,
    answerNotInOptions: rows.filter((r) => has(r, 'answer_not_in_options')).length,
    duplicateOptions: rows.filter((r) => has(r, 'duplicate_options')).length,
    duplicateAnswers: rows.filter((r) => has(r, 'duplicate_answer')).length,
    answerRevealed: rows.filter((r) => has(r, 'answer_revealed')).length,
    earlyTell: rows.filter((r) => has(r, 'early_tell')).length,
    emptyOrShort: rows.filter((r) => has(r, 'empty_clue') || has(r, 'clue_too_short')).length,
    ambiguous: ambiguous.length,
    avgScore: Math.round(avg(scored.map((r) => r.evaluation.score))),
    avgAmbiguity: Number(avg(scored.map((r) => r.evaluation.ambiguity)).toFixed(3)),
    approved: scored.filter((r) => r.evaluation.approved).length,
    scored: scored.length,
    examples: rows
      .filter((r) => r.issues.length > 0 || (r.evaluation && r.evaluation.ambiguity >= 0.3))
      .slice(0, 4)
      .map((r) => ({
        answer: r.mystery.answer || '(none)',
        type: r.mystery.type,
        clue1: r.mystery.clues[0] ?? '',
        clue2: r.mystery.clues[1] ?? '',
        issues: r.issues.map((i) => `${i.code}: ${i.message}`),
        feedback: r.evaluation?.feedback ?? [],
        ambiguity: r.evaluation?.ambiguity,
      })),
  };
}

console.log(`Evaluating ${TARGET} mysteries per prompt with ${MODEL}\n`);
const started = Date.now();
const a = summarise(await evaluateVariant('A'));
const b = summarise(await evaluateVariant('B'));
const minutes = ((Date.now() - started) / 60000).toFixed(1);

mkdirSync('docs', { recursive: true });
writeFileSync('docs/evaluation-results.json', JSON.stringify({ a, b, model: MODEL, minutes }, null, 2));
console.log('\nwrote docs/evaluation-results.json');
console.table({
  'Prompt A (basic)': {
    valid: `${a.valid}/${a.total}`,
    ambiguous: a.ambiguous,
    'category violations': a.categoryViolations,
    'answer revealed early': a.answerRevealed,
    'avg score': a.avgScore,
  },
  'Prompt B (production)': {
    valid: `${b.valid}/${b.total}`,
    ambiguous: b.ambiguous,
    'category violations': b.categoryViolations,
    'answer revealed early': b.answerRevealed,
    'avg score': b.avgScore,
  },
});
