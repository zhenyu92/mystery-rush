/**
 * The deterministic corners of `src/worker/game.ts` and the scoring table in
 * `src/shared/types.ts` - the bits with no I/O, where a regression is silent
 * until it costs somebody a round.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLUE_COUNT,
  CLUE_POINTS,
  EVENT_NAME_MAX,
  NICKNAME_MAX,
  pointsForClue,
  typeLabel,
  type Mystery,
} from '../src/shared/types';
import {
  MYSTERIES,
  buildOptions,
  generateEventCode,
  getMystery,
  hashToken,
  isCorrectAnswer,
  newToken,
  randomId,
  safeEqual,
  sanitizeNickname,
  sanitizeText,
  shuffle,
} from '../src/worker/game';

const ZERO_WIDTH = '\u200b';
const NUL = '\u0000';

describe('the question bank', () => {
  it('loads, and every entry is playable', () => {
    assert.ok(MYSTERIES.length > 0);
    for (const mystery of MYSTERIES) {
      assert.equal(mystery.clues.length, CLUE_COUNT, `${mystery.id} must have ${CLUE_COUNT} clues`);
      assert.ok(mystery.options.length >= 2, `${mystery.id} needs distractors`);
      assert.ok(mystery.options.includes(mystery.answer), `${mystery.id} must offer its own answer`);
      assert.ok(mystery.clues.every((c) => typeof c === 'string' && c.length > 0));
    }
  });

  it('has no duplicate ids, so the queue cannot serve one twice', () => {
    assert.equal(new Set(MYSTERIES.map((m) => m.id)).size, MYSTERIES.length);
  });

  it('looks a mystery up by id, and admits when it cannot', () => {
    assert.equal(getMystery(MYSTERIES[0].id)!.answer, MYSTERIES[0].answer);
    assert.equal(getMystery('nope'), undefined);
  });
});

describe('event codes', () => {
  it('avoids the characters that get misread off a projector', () => {
    const confusable = /[O01ILS2Z8B]/;
    for (let i = 0; i < 400; i++) {
      const code = generateEventCode();
      assert.equal(code.length, 5);
      assert.ok(!confusable.test(code), `${code} contains a confusable character`);
      assert.match(code, /^[A-Z0-9]{4,8}$/, 'must satisfy the router pattern');
    }
  });

  it('honours a requested length', () => {
    assert.equal(generateEventCode(8).length, 8);
    assert.equal(generateEventCode(4).length, 4);
  });

  it('does not obviously repeat itself', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateEventCode()));
    assert.ok(codes.size > 480, `only ${codes.size} distinct codes in 500 draws`);
  });
});

describe('ids and tokens', () => {
  it('prefixes an id and keeps it url-safe', () => {
    const id = randomId('p');
    assert.match(id, /^p_[0-9a-f]{16}$/);
    assert.notEqual(randomId('p'), randomId('p'));
  });

  it('mints a 24-byte token as hex', () => {
    const token = newToken();
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.notEqual(newToken(), newToken());
  });

  it('hashes a token to a stable digest that is not the token', async () => {
    const token = 'a-secret';
    const digest = await hashToken(token);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, await hashToken(token), 'hashing must be stable across calls');
    assert.notEqual(digest, await hashToken('a-secrat'));
  });

  it('compares digests without short-circuiting on content', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false, 'different lengths are never equal');
    assert.equal(safeEqual('', ''), true);
  });
});

describe('shuffling', () => {
  it('keeps every element exactly once', () => {
    const input = Array.from({ length: 30 }, (_, i) => i);
    for (let attempt = 0; attempt < 50; attempt++) {
      const out = shuffle(input);
      assert.equal(out.length, input.length);
      assert.deepEqual([...out].sort((a, b) => a - b), input);
    }
  });

  it('leaves the input alone', () => {
    const input = ['a', 'b', 'c'];
    shuffle(input);
    assert.deepEqual(input, ['a', 'b', 'c']);
  });

  it('handles the degenerate sizes', () => {
    assert.deepEqual(shuffle([]), []);
    assert.deepEqual(shuffle(['only']), ['only']);
  });

  it('actually reorders, given enough attempts', () => {
    const input = Array.from({ length: 10 }, (_, i) => i);
    const orders = new Set(Array.from({ length: 60 }, () => shuffle(input).join(',')));
    assert.ok(orders.size > 1, 'a shuffle that never moves anything is not a shuffle');
  });
});

describe('building the options for a round', () => {
  const mystery: Mystery = {
    id: 'm',
    type: 'thing',
    title: 'Thing',
    answer: 'Right',
    options: ['Right', 'A', 'B', 'C', 'D', 'E', 'F', 'G'],
    clues: ['1', '2', '3', '4', '5'],
  };

  it('always includes the answer and caps the list', () => {
    for (let i = 0; i < 50; i++) {
      const options = buildOptions(mystery);
      assert.ok(options.includes('Right'), 'the answer must always be on screen');
      assert.equal(options.length, 6);
      assert.equal(new Set(options).size, 6, 'no option may appear twice');
    }
  });

  it('honours a smaller cap', () => {
    const options = buildOptions(mystery, 3);
    assert.equal(options.length, 3);
    assert.ok(options.includes('Right'));
  });

  it('copes with a mystery that has barely any distractors', () => {
    const thin: Mystery = { ...mystery, options: ['Right', 'A'] };
    const options = buildOptions(thin);
    assert.deepEqual([...options].sort(), ['A', 'Right']);
  });

  it('does not park the answer in a predictable slot', () => {
    const slots = new Set(Array.from({ length: 80 }, () => buildOptions(mystery).indexOf('Right')));
    assert.ok(slots.size > 1, 'the answer sitting in one slot would give the round away');
  });

  it('marks only the answer correct', () => {
    assert.equal(isCorrectAnswer(mystery, 'Right'), true);
    assert.equal(isCorrectAnswer(mystery, 'A'), false);
    assert.equal(isCorrectAnswer(mystery, 'right'), false, 'matching is exact');
  });
});

describe('sanitising what players type', () => {
  it('keeps an ordinary nickname as it was typed', () => {
    assert.equal(sanitizeNickname('Ada', NICKNAME_MAX), 'Ada');
    assert.equal(sanitizeNickname('Ada Lovelace', NICKNAME_MAX), 'Ada Lovelace');
  });

  it('collapses runs of whitespace and trims the ends', () => {
    assert.equal(sanitizeNickname('  Ada   L  ', NICKNAME_MAX), 'Ada L');
    assert.equal(sanitizeNickname('Ada\u00a0\u00a0L', NICKNAME_MAX), 'Ada L');
  });

  it('treats an invisible separator as a gap, not as nothing', () => {
    // These arrive whenever someone pastes from a chat client or a
    // spreadsheet. Deleting them instead of folding them welds the words on
    // either side together.
    assert.equal(sanitizeNickname('Ada\u0009Lovelace', NICKNAME_MAX), 'Ada Lovelace', 'tab');
    assert.equal(sanitizeNickname('Ada\u000aL', NICKNAME_MAX), 'Ada L', 'line feed');
    assert.equal(sanitizeNickname('Ada\u000d\u000aL', NICKNAME_MAX), 'Ada L', 'carriage return');
    assert.equal(sanitizeNickname('Ada\u000bL', NICKNAME_MAX), 'Ada L', 'vertical tab');
    assert.equal(sanitizeNickname('Ada\u000cL', NICKNAME_MAX), 'Ada L', 'form feed');
    assert.equal(sanitizeNickname('Ada\u0085L', NICKNAME_MAX), 'Ada L', 'next line');
    assert.equal(sanitizeNickname('Ada\u2028L', NICKNAME_MAX), 'Ada L', 'line separator');
    assert.equal(sanitizeNickname('Ada\u2029L', NICKNAME_MAX), 'Ada L', 'paragraph separator');
  });

  it('does not let a separator become padding of its own', () => {
    assert.equal(sanitizeNickname('\u000a\u0009Ada\u000a', NICKNAME_MAX), 'Ada');
    assert.equal(sanitizeNickname('Ada\u000a\u000a\u000aL', NICKNAME_MAX), 'Ada L', 'a run is one gap');
    assert.equal(sanitizeNickname('\u000a\u0009\u000d', NICKNAME_MAX), null, 'gaps are not a name');
  });

  it('strips invisible characters used to smuggle padding', () => {
    assert.equal(sanitizeNickname(`Ada${ZERO_WIDTH}`, NICKNAME_MAX), 'Ada');
    assert.equal(sanitizeNickname(`Ad${NUL}a`, NICKNAME_MAX), 'Ada');
    assert.equal(sanitizeNickname(`${ZERO_WIDTH}${NUL}`, NICKNAME_MAX), null, 'nothing is left');
    assert.equal(
      sanitizeNickname(`Ada${ZERO_WIDTH}L`, NICKNAME_MAX),
      'AdaL',
      'a zero-width joiner is not a gap, so it must not leave one behind',
    );
  });

  it('rejects anything that is not a non-empty string', () => {
    for (const raw of [undefined, null, 42, {}, [], '', '   ']) {
      assert.equal(sanitizeNickname(raw, NICKNAME_MAX), null, `for ${JSON.stringify(raw)}`);
    }
  });

  it('never returns more than the maximum', () => {
    assert.equal(sanitizeNickname('N'.repeat(100), NICKNAME_MAX)!.length, NICKNAME_MAX);
  });

  it('does not leave a space behind when the cut lands in a gap', () => {
    // 17 characters, then the space that the truncation cuts on.
    assert.equal(sanitizeNickname('abcdefghijklmnopq rs', NICKNAME_MAX), 'abcdefghijklmnopq');
    assert.equal(sanitizeNickname('ab cdefghijklmnop qr', NICKNAME_MAX), 'ab cdefghijklmnop');
    assert.equal(sanitizeNickname('a'.repeat(NICKNAME_MAX) + ' b', NICKNAME_MAX), 'a'.repeat(NICKNAME_MAX));
  });

  it('falls back rather than returning nothing, for text that must exist', () => {
    assert.equal(sanitizeText('  Party  ', 20, 'Default'), 'Party');
    assert.equal(sanitizeText('', 20, 'Default'), 'Default');
    assert.equal(sanitizeText(undefined, 20, 'Default'), 'Default');
  });

  it('keeps an event name readable when it arrives with a line break', () => {
    assert.equal(
      sanitizeText('Friday\u000aSocial', EVENT_NAME_MAX, 'Default'),
      'Friday Social',
    );
  });
});

describe('scoring', () => {
  it('pays less the later you guess', () => {
    const awarded = Array.from({ length: CLUE_COUNT }, (_, i) => pointsForClue(i + 1));
    assert.deepEqual(awarded, [...CLUE_POINTS]);
    for (let i = 1; i < awarded.length; i++) {
      assert.ok(awarded[i] < awarded[i - 1], 'each clue must be worth less than the last');
    }
  });

  it('pays nothing for a clue number that is not on the board', () => {
    assert.equal(pointsForClue(0), 0, 'the get-ready window is worth nothing');
    assert.equal(pointsForClue(CLUE_COUNT + 1), 0);
    assert.equal(pointsForClue(-1), 0);
  });
});

describe('category labels', () => {
  it('labels every type the bundled bank actually uses', () => {
    for (const type of new Set(MYSTERIES.map((m) => m.type))) {
      const { label, emoji } = typeLabel(type);
      assert.ok(label.length > 0 && emoji.length > 0, `${type} has no label`);
      assert.ok(!label.includes('_'), `${type} falls through to the raw slug`);
    }
  });

  it('falls back readably for a type it has never seen', () => {
    assert.deepEqual(typeLabel('deep_sea_creature'), { label: 'deep sea creature', emoji: '\u{1F50D}' });
  });
});
