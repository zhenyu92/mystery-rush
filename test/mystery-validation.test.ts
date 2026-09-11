/**
 * Deterministic validation of generated mysteries.
 *
 * These are the rules that decide whether AI output is allowed anywhere near
 * a projector, so they are tested against both directions: every way a
 * generated mystery can be wrong, and the twenty-five hand-written ones,
 * which must all pass. A rule that rejects good human content is a broken
 * rule, not a strict one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import bank from '../data/mysteries.json' with { type: 'json' };
import { MYSTERY_TYPES, type Mystery } from '../src/shared/types';
import { hasErrors, validateMystery } from '../src/worker/mystery-validation';

/** A mystery that passes everything, so each test can break exactly one thing. */
function good(overrides: Partial<Mystery> = {}): Mystery {
  return {
    id: 'ai_test_1',
    type: 'landmark',
    title: 'Famous Landmark',
    answer: 'Eiffel Tower',
    options: ['Eiffel Tower', 'Big Ben', 'Colosseum', 'Taj Mahal', 'Sydney Opera House'],
    clues: [
      'I was built for a large international exhibition.',
      'Critics of my day signed a letter asking for my removal.',
      'I am made of wrought iron and I sway slightly in the wind.',
      'I stand beside a river in a European capital.',
      'I am the most visited paid monument in the world, in Paris.',
    ],
    ...overrides,
  };
}

const opts = { allowedCategories: ['landmark', 'movie', 'food'] };
const codes = (m: unknown, o = opts) => validateMystery(m, o).map((i) => i.code);

describe('deterministic validation', () => {
  it('accepts a well-formed mystery', () => {
    assert.deepEqual(validateMystery(good(), opts), []);
  });

  it('accepts every hand-written mystery in the shipped bank', () => {
    // The calibration test. If these rules reject the bank the game already
    // plays, the rules are wrong.
    const seenIds = new Set<string>();
    const seenAnswers = new Set<string>();
    for (const m of bank as Mystery[]) {
      const issues = validateMystery(m, { allowedCategories: MYSTERY_TYPES, seenIds, seenAnswers });
      assert.deepEqual(issues, [], `${m.id} (${m.answer}) should be clean`);
      seenIds.add(m.id);
      seenAnswers.add(m.answer.toLowerCase());
    }
  });

  describe('shape', () => {
    it('rejects a non-object', () => {
      assert.deepEqual(codes('nope'), ['not_an_object']);
      assert.deepEqual(codes(null), ['not_an_object']);
      assert.deepEqual(codes([good()]), ['not_an_object']);
    });

    it('rejects a missing answer', () => {
      assert.ok(codes({ ...good(), answer: '' }).includes('missing_answer'));
    });

    it('rejects missing required fields', () => {
      const { clues: _clues, ...noClues } = good();
      assert.ok(codes(noClues).includes('missing_clues'));
      const { options: _options, ...noOptions } = good();
      assert.ok(codes(noOptions).includes('missing_options'));
    });
  });

  describe('clues', () => {
    it('rejects fewer than five', () => {
      assert.ok(codes(good({ clues: good().clues.slice(0, 4) })).includes('clue_count'));
    });

    it('rejects more than five', () => {
      assert.ok(codes(good({ clues: [...good().clues, 'One too many clues here.'] })).includes('clue_count'));
    });

    it('rejects an empty clue', () => {
      const clues = good().clues;
      clues[2] = '   ';
      assert.ok(codes(good({ clues })).includes('empty_clue'));
    });

    it('rejects a clue too short to be a clue', () => {
      const clues = good().clues;
      clues[0] = 'Tall.';
      assert.ok(codes(good({ clues })).includes('clue_too_short'));
    });

    it('rejects a clue longer than the limit', () => {
      const clues = good().clues;
      clues[1] = `I am ${'very '.repeat(60)}long.`;
      assert.ok(codes(good({ clues })).includes('clue_too_long'));
    });
  });

  describe('giving the answer away', () => {
    it('rejects an early clue that names the answer', () => {
      const clues = good().clues;
      clues[1] = 'I am the Eiffel Tower, standing in the middle of Paris.';
      assert.ok(codes(good({ clues })).includes('answer_revealed'));
    });

    it('allows the last clue to name the answer, since it is meant to', () => {
      const clues = good().clues;
      clues[4] = 'I am the Eiffel Tower.';
      assert.ok(!codes(good({ clues })).includes('answer_revealed'));
    });

    it('warns, but does not fail, when an early clue uses part of the answer', () => {
      // Only part of the answer appears, so this is a tell rather than a
      // giveaway - the kind of call the host should make, not the validator.
      const withTell = good({
        answer: 'Great Pyramid of Giza',
        options: ['Great Pyramid of Giza', 'Colosseum', 'Parthenon', 'Stonehenge', 'Machu Picchu'],
      });
      withTell.clues[0] = 'I stand on a dusty plateau at Giza, west of a great river.';

      const issues = validateMystery(withTell, opts);
      assert.ok(issues.some((i) => i.code === 'early_tell' && i.severity === 'warning'));
      assert.ok(!hasErrors(issues), 'a partial tell is a warning, not a hard failure');
    });

    it('warns when a clue names one of the other options', () => {
      const clues = good().clues;
      clues[2] = 'I am not Big Ben, though we are often confused.';
      const issues = validateMystery(good({ clues }), opts);
      assert.ok(issues.some((i) => i.code === 'names_distractor'));
    });
  });

  describe('answer and options', () => {
    it('rejects an answer that is not among the options', () => {
      assert.ok(codes(good({ answer: 'Mount Fuji' })).includes('answer_not_in_options'));
    });

    it('rejects duplicate options', () => {
      const options = ['Eiffel Tower', 'Big Ben', 'Big Ben', 'Taj Mahal', 'Colosseum'];
      assert.ok(codes(good({ options })).includes('duplicate_options'));
    });

    it('rejects too few options', () => {
      assert.ok(codes(good({ options: ['Eiffel Tower', 'Big Ben'] })).includes('option_count'));
    });

    it('rejects an empty option', () => {
      const options = ['Eiffel Tower', 'Big Ben', '', 'Taj Mahal', 'Colosseum'];
      assert.ok(codes(good({ options })).includes('empty_option'));
    });
  });

  describe('category', () => {
    it('rejects a type the game does not know', () => {
      // Exactly what the model returned on the first real call.
      assert.ok(codes(good({ type: 'multiple choice' })).includes('unknown_type'));
    });

    it('rejects a real category the host did not ask for', () => {
      assert.ok(codes(good({ type: 'sport' })).includes('category_not_requested'));
    });
  });

  describe('pool-level duplicates', () => {
    it('rejects an id already used', () => {
      const seenIds = new Set(['ai_test_1']);
      assert.ok(codes(good(), { ...opts, seenIds }).includes('duplicate_id'));
    });

    it('rejects an answer already in the pool, case-insensitively', () => {
      const seenAnswers = new Set(['eiffel tower']);
      assert.ok(codes(good(), { ...opts, seenAnswers }).includes('duplicate_answer'));
    });
  });

  describe('content safety', () => {
    it('rejects markup in a clue', () => {
      const clues = good().clues;
      clues[3] = 'I am famous <img src=x onerror=alert(1)> for my ironwork.';
      assert.ok(codes(good({ clues })).includes('unsafe_clue'));
    });

    it('rejects markup in an option', () => {
      const options = ['Eiffel Tower', '<script>alert(1)</script>', 'Colosseum', 'Taj Mahal', 'Big Ben'];
      assert.ok(codes(good({ options })).includes('unsafe_option'));
    });

    it('rejects markup in the title or answer', () => {
      assert.ok(codes(good({ title: '<b>Landmark</b>' })).includes('unsafe_text'));
    });
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const broken = good({
      type: 'sport',
      answer: 'Mount Fuji',
      clues: good().clues.slice(0, 3),
    });
    const found = codes(broken);
    assert.ok(found.includes('category_not_requested'));
    assert.ok(found.includes('answer_not_in_options'));
    assert.ok(found.includes('clue_count'));
  });

  it('hasErrors ignores warnings', () => {
    assert.equal(hasErrors([{ code: 'x', severity: 'warning', message: 'm' }]), false);
    assert.equal(hasErrors([{ code: 'x', severity: 'error', message: 'm' }]), true);
  });
});
