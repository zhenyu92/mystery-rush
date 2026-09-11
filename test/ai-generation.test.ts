/**
 * The AI prep workflow, with the model scripted.
 *
 * No real inference here: it costs money, needs credentials, and would make
 * the suite non-deterministic. `harness.ai` queues exactly what the model
 * should say, including the ways it misbehaves in practice - the first real
 * call this project ever made returned `"type": "multiple choice"`, which is
 * why that specific failure has a test.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import worker from '../src/worker/index';
import type { Env } from '../src/worker/db';
import { buildMysteryPool } from '../src/worker/mystery-pool';
import { createHarness, installWorkerGlobals, type Harness } from './support/env';

installWorkerGlobals();

/**
 * Deliberately an answer the shipped bank does not already use. An earlier
 * draft of this fixture used the Eiffel Tower and every test failed, because
 * refusing to repeat an answer the room may already have played is exactly
 * what the pool builder is supposed to do.
 */
function mystery(over: Record<string, unknown> = {}) {
  return {
    type: 'landmark',
    title: 'Famous Landmark',
    answer: 'Golden Gate Bridge',
    options: ['Golden Gate Bridge', 'Tower Bridge', 'Brooklyn Bridge', 'Ponte Vecchio', 'Rialto Bridge'],
    clues: [
      'I was the longest structure of my kind in the world when I opened.',
      'Thick summer fog rolls over me most mornings.',
      'My paint has an official shade, International Orange.',
      'I span the mouth of a large bay on a western coast.',
      'I carry traffic from San Francisco north into Marin County.',
    ],
    ...over,
  };
}

const goodEvaluation = {
  approved: true,
  score: 88,
  ambiguity: 0.1,
  difficulty: 'medium',
  feedback: [],
};

describe('AI mystery generation', () => {
  let harness: Harness;
  let env: Env;

  beforeEach(() => {
    harness = createHarness();
    env = harness.env;
  });

  describe('buildMysteryPool', () => {
    it('validates and evaluates a generated mystery', async () => {
      harness.ai.push({ mysteries: [mystery()] }).push(goodEvaluation);

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      assert.equal(pool.error, null);
      assert.equal(pool.candidates.length, 1);
      assert.equal(pool.rejected.length, 0);

      const c = pool.candidates[0]!;
      assert.equal(c.mystery.answer, 'Golden Gate Bridge');
      assert.equal(c.mystery.clues.length, 5);
      assert.equal(c.status, 'pending', 'nothing is playable until the host says so');
      assert.equal(c.evaluation?.score, 88);
      assert.ok(c.mystery.id.startsWith('ai_'), 'the app assigns the id, not the model');
    });

    it('asks the model for JSON against a schema that pins the category', async () => {
      harness.ai.push({ mysteries: [mystery()] }).push(goodEvaluation);
      await buildMysteryPool(env, { categories: ['landmark', 'food'], difficulty: 'hard', count: 1 });

      const call = harness.ai.calls[0]!;
      const format = call.response_format as { type: string; json_schema: Record<string, never> };
      assert.equal(format.type, 'json_schema');
      const schema = JSON.stringify(format.json_schema);
      assert.ok(schema.includes('"enum":["landmark","food"]'), 'the schema constrains the category');
      const prompt = JSON.stringify(call.messages);
      assert.ok(prompt.includes('hard'), 'the requested difficulty reaches the model');
    });

    it('drops a mystery whose category the host did not ask for', async () => {
      // The real first-call failure: the model used the field for a format.
      harness.ai.push({ mysteries: [mystery({ type: 'multiple choice' })] });

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      assert.equal(pool.candidates.length, 0);
      assert.equal(pool.rejected.length, 1);
      assert.ok(pool.rejected[0]!.issues.some((i) => i.code === 'unknown_type'));
    });

    it('drops an invalid mystery but keeps the valid ones from the same batch', async () => {
      harness.ai
        .push({
          mysteries: [
            mystery(),
            mystery({ answer: 'Not In The Options', title: 'Broken' }),
          ],
        })
        .push(goodEvaluation);

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 2,
      });

      assert.equal(pool.candidates.length, 1, 'the good one survives');
      assert.equal(pool.rejected.length, 1);
      assert.ok(pool.rejected[0]!.issues.some((i) => i.code === 'answer_not_in_options'));
    });

    it('refuses a duplicate answer inside one pool', async () => {
      harness.ai
        .push({ mysteries: [mystery(), mystery({ title: 'Same answer again' })] })
        .push(goodEvaluation);

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 2,
      });

      assert.equal(pool.candidates.length, 1);
      assert.ok(pool.rejected.some((r) => r.issues.some((i) => i.code === 'duplicate_answer')));
    });

    it('refuses an answer the event already has', async () => {
      harness.ai.push({ mysteries: [mystery()] });

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
        existingAnswers: ['golden gate bridge'],
      });

      assert.equal(pool.candidates.length, 0);
      assert.ok(pool.rejected[0]!.issues.some((i) => i.code === 'duplicate_answer'));
    });

    it('will not repeat an answer from the built-in bank', async () => {
      // "Pizza" ships in data/mysteries.json.
      harness.ai.push({
        mysteries: [
          mystery({
            type: 'food',
            answer: 'Pizza',
            options: ['Pizza', 'Sushi', 'Tacos', 'Paella', 'Ramen'],
          }),
        ],
      });

      const pool = await buildMysteryPool(env, {
        categories: ['food'],
        difficulty: 'medium',
        count: 1,
      });

      assert.equal(pool.candidates.length, 0);
      assert.ok(pool.rejected[0]!.issues.some((i) => i.code === 'duplicate_answer'));
    });

    it('reports an AI outage without throwing', async () => {
      harness.ai.pushError('503 capacity');

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      assert.equal(pool.candidates.length, 0);
      assert.ok(pool.error, 'the host is told why');
    });

    it('survives a model that returns prose instead of JSON', async () => {
      harness.ai.pushRaw('Sure! Here are some mysteries for you.');

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      assert.equal(pool.candidates.length, 0);
      assert.match(pool.error ?? '', /JSON/i);
    });

    it('accepts JSON the model wrapped in a code fence', async () => {
      harness.ai
        .pushRaw('```json\n' + JSON.stringify({ mysteries: [mystery()] }) + '\n```')
        .push(goodEvaluation);

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      assert.equal(pool.candidates.length, 1);
    });

    it('stops retrying rather than looping for ever', async () => {
      // Always invalid, so the pool can never be filled.
      for (let i = 0; i < 10; i++) {
        harness.ai.push({ mysteries: [mystery({ type: 'not a category' })] });
      }

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 3,
      });

      assert.equal(pool.candidates.length, 0);
      assert.ok(pool.attempts <= 3, `gave up after ${pool.attempts} attempts`);
      assert.ok(harness.ai.queue.length > 0, 'it did not drain every queued reply');
    });

    it('keeps a mystery whose evaluation failed, without a score', async () => {
      harness.ai.push({ mysteries: [mystery()] }).pushError('evaluator down');

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      assert.equal(pool.candidates.length, 1, 'a failed opinion must not lose good content');
      assert.equal(pool.candidates[0]!.evaluation, null);
    });

    it('clamps a nonsense evaluation rather than trusting it', async () => {
      harness.ai.push({ mysteries: [mystery()] }).push({
        approved: true,
        score: 9999,
        ambiguity: -3,
        difficulty: 'impossible',
        feedback: 'not an array',
      });

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      const e = pool.candidates[0]!.evaluation!;
      assert.equal(e.score, 100);
      assert.equal(e.ambiguity, 0);
      assert.equal(e.difficulty, 'medium', 'falls back to what was asked for');
      assert.deepEqual(e.feedback, []);
    });

    it('passes an evaluator rejection through to the host', async () => {
      harness.ai.push({ mysteries: [mystery()] }).push({
        approved: false,
        score: 31,
        ambiguity: 0.8,
        difficulty: 'medium',
        feedback: ['Tower Bridge also fits clues 1 and 2.'],
      });

      const pool = await buildMysteryPool(env, {
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      const c = pool.candidates[0]!;
      assert.equal(c.evaluation?.approved, false);
      assert.equal(c.status, 'pending', 'a poor score still leaves the decision to the host');
      assert.match(c.evaluation!.feedback[0]!, /Tower Bridge/);
    });
  });

  // ------------------------------------------------------------ the API

  describe('POST /api/events/:code/mysteries', () => {
    async function createEvent(): Promise<{ code: string; hostToken: string }> {
      const res = await worker.fetch(
        new Request('https://x/api/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventName: 'AI Test' }),
        }),
        env,
      );
      const body = (await res.json()) as { eventCode: string; hostToken: string };
      return { code: body.eventCode, hostToken: body.hostToken };
    }

    const post = (path: string, body: unknown) =>
      worker.fetch(
        new Request(`https://x${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        env,
      );

    it('refuses to generate without the host token', async () => {
      const { code } = await createEvent();
      const res = await post(`/api/events/${code}/mysteries/generate`, {
        hostToken: 'wrong',
        categories: ['landmark'],
      });
      assert.equal(res.status, 403);
      assert.equal(harness.ai.calls.length, 0, 'no model call is spent on a stranger');
    });

    it('refuses to generate with no categories', async () => {
      const { code, hostToken } = await createEvent();
      const res = await post(`/api/events/${code}/mysteries/generate`, { hostToken, categories: [] });
      assert.equal(res.status, 400);
      assert.equal(harness.ai.calls.length, 0);
    });

    it('ignores a category the game does not know', async () => {
      const { code, hostToken } = await createEvent();
      const res = await post(`/api/events/${code}/mysteries/generate`, {
        hostToken,
        categories: ['landmark', 'definitely-not-real'],
      });
      assert.notEqual(res.status, 500);
      if (harness.ai.calls.length > 0) {
        const schema = JSON.stringify(harness.ai.calls[0]!.response_format);
        assert.ok(!schema.includes('definitely-not-real'));
      }
    });

    it('generates and returns candidates for review', async () => {
      const { code, hostToken } = await createEvent();
      harness.ai.push({ mysteries: [mystery()] }).push(goodEvaluation);

      const res = await post(`/api/events/${code}/mysteries/generate`, {
        hostToken,
        categories: ['landmark'],
        difficulty: 'medium',
        count: 1,
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as { candidates: unknown[]; error: string | null };
      assert.equal(body.candidates.length, 1);
      assert.equal(body.error, null);
    });

    it('refuses to add a mystery without the host token', async () => {
      const { code } = await createEvent();
      const res = await post(`/api/events/${code}/mysteries`, {
        hostToken: 'nope',
        mystery: { ...mystery(), id: 'ai_x' },
      });
      assert.equal(res.status, 403);
    });

    it('refuses a malformed mystery at the library boundary', async () => {
      const { code, hostToken } = await createEvent();
      const res = await post(`/api/events/${code}/mysteries`, {
        hostToken,
        mystery: { ...mystery({ clues: ['only one'] }), id: 'ai_x' },
      });
      assert.equal(res.status, 400, 'the shape is re-checked after the hop');
    });

    it('makes an approved mystery playable', async () => {
      const { code, hostToken } = await createEvent();
      const approved = { ...mystery(), id: 'ai_approved_1' };

      const res = await post(`/api/events/${code}/mysteries`, { hostToken, mystery: approved });
      assert.equal(res.status, 200);

      // It must survive an eviction, or it could vanish mid-event.
      await harness.restart(code);
      const room = harness.roomFor(code);
      const check = await room.fetch(
        new Request('https://room/verify-host', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hostToken }),
        }),
      );
      const info = (await check.json()) as { existingAnswers: string[] };
      assert.ok(
        info.existingAnswers.includes('Golden Gate Bridge'),
        'the approved mystery is in the event library after a restart',
      );
    });
  });
});
