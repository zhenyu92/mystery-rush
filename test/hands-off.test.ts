/**
 * The three things the host no longer has to do.
 *
 * Every one of these used to be a control on the sidebar, and each of them
 * had the same failure mode: the host is holding a microphone in front of a
 * room and forgets. So the rules are tested here rather than the buttons -
 * a button that is gone cannot be asserted on, but the behaviour it used to
 * arm can.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';

import worker from '../src/worker/index';
import {
  DOUBLE_MULTIPLIER,
  LEADERBOARD_AUTO_MS,
  POOL_DEADLINE_MS,
  pointsForClue,
  streakBonus,
} from '../src/shared/types';
import type { Env } from '../src/worker/db';
import { MYSTERIES } from '../src/worker/game';
import { buildMysteryPool, meetsAutoAcceptBar } from '../src/worker/mystery-pool';
import { createHarness, installWorkerGlobals, type Harness } from './support/env';
import {
  answerFor,
  lastErrorOn,
  releaseFakeClock,
  seatTable,
  useFakeClock,
  wrongOption,
  type Table,
} from './support/game';

installWorkerGlobals();

// --------------------------------------------------------------- fixtures

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

/** A second subject, so a two-mystery pool is not a duplicate by construction. */
function otherMystery(over: Record<string, unknown> = {}) {
  return mystery({
    answer: 'Machu Picchu',
    options: ['Machu Picchu', 'Chichen Itza', 'Petra', 'Angkor Wat', 'Borobudur'],
    clues: [
      'I sit on a ridge more than two kilometres above sea level.',
      'A railway and a long footpath are the usual ways to reach me.',
      'I was built in the fifteenth century and abandoned within a hundred years.',
      'Terraces cut into my slopes once grew crops for the people who lived here.',
      'I am the best known site of the Inca empire, in Peru.',
    ],
    ...over,
  });
}

const goodEvaluation = { approved: true, score: 88, ambiguity: 0.1, difficulty: 'medium', feedback: [] };

// ---------------------------------------------------------- double points

describe('the final mystery scores double on its own', () => {
  let table: Table;

  beforeEach(() => useFakeClock());
  afterEach(() => releaseFakeClock());

  /** Play one round through, with the named players answering correctly. */
  async function playRound(correct: string[]): Promise<void> {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    const answer = answerFor(table.host);
    const wrong = wrongOption(table.round()!, answer);
    for (const player of table.roster) {
      await table.players[player.nickname].socket.say({
        type: 'submit_answer',
        option: correct.includes(player.nickname) ? answer : wrong,
      });
    }
  }

  it('doubles the last planned round without anybody arming it', async () => {
    table = await seatTable(['Ada', 'Grace'], { plannedRounds: 2 });

    await playRound(['Ada']);
    const afterFirst = table.snapshot().leaderboard.find((e) => e.nickname === 'Ada')!.score;
    assert.equal(afterFirst, pointsForClue(1), 'an ordinary round pays face value');

    await table.host.say({ type: 'host', action: 'next_round' });
    await playRound(['Ada']);

    const gained = table.snapshot().leaderboard.find((e) => e.nickname === 'Ada')!.score - afterFirst;
    assert.equal(
      gained,
      (pointsForClue(1) + streakBonus(2)) * DOUBLE_MULTIPLIER,
      'the second of two planned mysteries is the final one, and it doubles the whole round',
    );
  });

  it('tells the room before the round, not after', async () => {
    table = await seatTable(['Ada', 'Grace'], { plannedRounds: 2 });
    assert.equal(table.snapshot().nextRoundMultiplier, 1, 'the first of two is ordinary');

    await playRound(['Ada']);
    assert.equal(
      table.snapshot().nextRoundMultiplier,
      DOUBLE_MULTIPLIER,
      'the standings announce the double round while there is still time to care',
    );
  });

  it('leaves an open-ended event alone', async () => {
    table = await seatTable(['Ada', 'Grace']);
    await playRound(['Ada']);
    assert.equal(table.snapshot().nextRoundMultiplier, 1);
    assert.equal(
      table.snapshot().leaderboard.find((e) => e.nickname === 'Ada')!.score,
      pointsForClue(1),
      'a host who never said how many gets no surprise double',
    );
  });

  it('has no way for a host to arm one by hand', async () => {
    table = await seatTable(['Ada', 'Grace'], { plannedRounds: 3 });
    // The action is gone from the protocol; the room must ignore it rather
    // than fall through to something else.
    await table.host.say({ type: 'host', action: 'set_double', enabled: true });
    assert.equal(table.snapshot().nextRoundMultiplier, 1);
  });
});

// ------------------------------------------------- the event has an ending

describe('a planned event ends itself', () => {
  let table: Table;

  beforeEach(() => useFakeClock());
  afterEach(() => releaseFakeClock());

  async function playRound(): Promise<void> {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    const answer = answerFor(table.host);
    for (const player of table.roster) {
      await table.players[player.nickname].socket.say({ type: 'submit_answer', option: answer });
    }
  }

  it('counts down to the podium after the last planned mystery', async () => {
    table = await seatTable(['Ada'], { plannedRounds: 1 });

    await playRound();
    await table.host.say({ type: 'host', action: 'show_leaderboard' });

    const auto = table.snapshot().autoAdvance;
    assert.equal(auto?.to, 'finished', 'the standings queue the winner, not a sixth mystery');

    await table.tickToAlarm();
    assert.equal(table.snapshot().phase, 'finished');
    assert.equal(table.snapshot().autoAdvance, null, 'and nothing is left counting down');
  });

  it('queues another mystery while the plan still has room', async () => {
    table = await seatTable(['Ada'], { plannedRounds: 2 });
    await playRound();
    await table.host.say({ type: 'host', action: 'show_leaderboard' });
    assert.equal(table.snapshot().autoAdvance?.to, 'round');
  });

  it('refuses a mystery past the number the host promised', async () => {
    table = await seatTable(['Ada'], { plannedRounds: 1 });
    await playRound();

    await table.host.say({ type: 'host', action: 'start_round' });
    assert.equal(lastErrorOn(table.host), 'event_complete');
    assert.notEqual(table.snapshot().phase, 'round');
  });

  it('leaves an open-ended event waiting for the host', async () => {
    table = await seatTable(['Ada']);
    await playRound();
    await table.host.say({ type: 'host', action: 'show_leaderboard' });
    assert.equal(
      table.snapshot().autoAdvance?.to,
      'round',
      'a host who never named a number is still running the night',
    );

    await table.tickToAlarm();
    assert.equal(table.snapshot().phase, 'round', 'the timer never decides a night is over');
  });
});

// ------------------------------------------------------------- the pacing

describe('pacing the host does not set', () => {
  let table: Table;

  beforeEach(async () => {
    useFakeClock();
    table = await seatTable(['Ada', 'Grace']);
  });
  afterEach(() => releaseFakeClock());

  it('holds the standings for eight seconds, not fifteen', async () => {
    assert.equal(LEADERBOARD_AUTO_MS, 8_000);

    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    const answer = answerFor(table.host);
    for (const player of table.roster) {
      await table.players[player.nickname].socket.say({ type: 'submit_answer', option: answer });
    }
    await table.host.say({ type: 'host', action: 'show_leaderboard' });

    const auto = table.snapshot().autoAdvance;
    assert.ok(auto, 'the standings count themselves down');
    assert.equal(auto.to, 'round');
    assert.equal(auto.durationMs, LEADERBOARD_AUTO_MS);
  });

  it('still lets the host freeze the clock for the whole room', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();

    await table.host.say({ type: 'host', action: 'pause' });
    assert.equal(table.round()!.status, 'paused');

    await table.host.say({ type: 'host', action: 'resume' });
    assert.equal(table.round()!.status, 'active');
  });
});

// --------------------------------------------------------- the question pool

describe('the automatic question pool', () => {
  let harness: Harness;
  let env: Env;

  beforeEach(() => {
    harness = createHarness();
    env = harness.env;
  });

  const post = (path: string, body: unknown) =>
    worker.fetch(
      new Request(`https://x${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );

  async function createEvent(over: Record<string, unknown> = {}) {
    const res = await post('/api/events', {
      eventName: 'Pool Test',
      plannedRounds: 1,
      categories: ['landmark'],
      difficulty: 'medium',
      ...over,
    });
    return (await res.json()) as { eventCode: string; hostToken: string };
  }

  describe('the bar a question has to clear', () => {
    it('takes a clean, well-scored mystery', () => {
      assert.equal(
        meetsAutoAcceptBar({
          mystery: { ...mystery(), id: 'ai_1' },
          difficulty: 'medium',
          issues: [],
          evaluation: { ...goodEvaluation, difficulty: 'medium' } as never,
          status: 'pending',
        }),
        true,
      );
    });

    it('refuses one the model never got to judge', () => {
      assert.equal(
        meetsAutoAcceptBar({
          mystery: { ...mystery(), id: 'ai_1' },
          difficulty: 'medium',
          issues: [],
          evaluation: null,
          status: 'pending',
        }),
        false,
        'nobody has read it, so the built-in bank is the better answer',
      );
    });

    it('refuses one the rules only warned about', () => {
      assert.equal(
        meetsAutoAcceptBar({
          mystery: { ...mystery(), id: 'ai_1' },
          difficulty: 'medium',
          issues: [{ code: 'early_tell', severity: 'warning', message: 'clue 1 gives it away' }],
          evaluation: { ...goodEvaluation, difficulty: 'medium' } as never,
          status: 'pending',
        }),
        false,
        'a warning was a judgement call for a host who is no longer reading these',
      );
    });

    it('refuses one the model liked but could not separate', () => {
      assert.equal(
        meetsAutoAcceptBar({
          mystery: { ...mystery(), id: 'ai_1' },
          difficulty: 'medium',
          issues: [],
          evaluation: { ...goodEvaluation, ambiguity: 0.8, difficulty: 'medium' } as never,
          status: 'pending',
        }),
        false,
      );
    });
  });

  it('replaces a candidate that missed the bar instead of shipping it', async () => {
    harness.ai
      .push({ mysteries: [mystery()] })
      .push({ ...goodEvaluation, score: 40 })
      .push({ mysteries: [otherMystery()] })
      .push(goodEvaluation);

    const pool = await buildMysteryPool(env, {
      categories: ['landmark'],
      difficulty: 'medium',
      count: 1,
      autoAccept: true,
    });

    assert.equal(pool.candidates.length, 1);
    assert.equal(pool.candidates[0]!.mystery.answer, 'Machu Picchu');
    assert.equal(pool.rejected.length, 1);
    assert.ok(pool.rejected[0]!.issues.some((i) => i.code === 'low_score'));
  });

  it('frees the subject a rejected candidate was using', async () => {
    harness.ai
      .push({ mysteries: [mystery()] })
      .push({ ...goodEvaluation, approved: false })
      .push({ mysteries: [mystery()] })
      .push(goodEvaluation);

    const pool = await buildMysteryPool(env, {
      categories: ['landmark'],
      difficulty: 'medium',
      count: 1,
      autoAccept: true,
    });

    assert.equal(pool.candidates.length, 1, 'a better question about the same thing is still allowed');
    assert.equal(pool.candidates[0]!.mystery.answer, 'Golden Gate Bridge');
  });

  it('makes what it accepts playable without anyone approving it', async () => {
    const { eventCode, hostToken } = await createEvent();
    harness.ai.push({ mysteries: [mystery()] }).push(goodEvaluation);

    const res = await post(`/api/events/${eventCode}/pool`, { hostToken });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { added: number; have: number; done: boolean };
    assert.equal(body.added, 1);
    assert.equal(body.have, 1);
    assert.equal(body.done, true, 'one planned mystery, one written, nothing left to ask for');

    const room = harness.roomFor(eventCode);
    const check = await room.fetch(
      new Request('https://room/verify-host', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostToken }),
      }),
    );
    const seen = (await check.json()) as { existingAnswers: string[] };
    assert.ok(seen.existingAnswers.includes('Golden Gate Bridge'));
  });

  it('plays what it wrote before it reaches the built-in bank', async () => {
    const { eventCode, hostToken } = await createEvent();
    harness.ai.push({ mysteries: [mystery()] }).push(goodEvaluation);
    await post(`/api/events/${eventCode}/pool`, { hostToken });

    const table = await seatTableOn(harness, eventCode, hostToken);
    await table.host.say({ type: 'host', action: 'start_round' });

    assert.equal(
      table.round()!.title,
      'Famous Landmark',
      'the built-ins are a fallback, so they sit behind anything written for the night',
    );
  });

  it('takes the host token rather than the caller’s word for it', async () => {
    const { eventCode } = await createEvent();
    const res = await post(`/api/events/${eventCode}/pool`, { hostToken: 'not-the-host' });
    assert.equal(res.status, 403);
    assert.equal(harness.ai.calls.length, 0, 'no inference is spent on a stranger');
  });

  it('reads the categories off the room, not off the request', async () => {
    const { eventCode, hostToken } = await createEvent({ categories: ['space'] });
    harness.ai.push({ mysteries: [mystery({ type: 'space' })] }).push(goodEvaluation);

    await post(`/api/events/${eventCode}/pool`, { hostToken, categories: ['food'] });

    const schema = JSON.stringify(harness.ai.calls[0]!.response_format);
    assert.ok(schema.includes('space'));
    assert.ok(!schema.includes('food'), 'the night was settled when the event was created');
  });

  it('does nothing at all for an event with no categories', async () => {
    const { eventCode, hostToken } = await createEvent({ categories: [] });
    const res = await post(`/api/events/${eventCode}/pool`, { hostToken });
    assert.equal(res.status, 200);
    assert.equal(harness.ai.calls.length, 0);
  });

  it('gives up rather than looping when nothing clears the bar', async () => {
    const { eventCode, hostToken } = await createEvent({ plannedRounds: 4 });
    for (let i = 0; i < 6; i++) {
      harness.ai.push({ mysteries: [mystery()] }).push({ ...goodEvaluation, approved: false });
    }

    const res = await post(`/api/events/${eventCode}/pool`, { hostToken });
    const body = (await res.json()) as { added: number; done: boolean; error: string | null };
    assert.equal(body.added, 0);
    assert.equal(body.done, true, 'asking again would only cost the host more lobby time');
    assert.ok(body.error);
  });

  it('gives up once writing has run past its budget', async () => {
    useFakeClock();
    try {
      const { eventCode, hostToken } = await createEvent({ plannedRounds: 3 });
      harness.ai.push({ mysteries: [mystery()] }).push(goodEvaluation);

      // First request starts the clock and writes one.
      const first = await post(`/api/events/${eventCode}/pool`, { hostToken });
      assert.equal(((await first.json()) as { added: number }).added, 1);

      // The room waited too long. Anything queued for the model is moot.
      mock.timers.tick(POOL_DEADLINE_MS + 1_000);
      harness.ai.push({ mysteries: [otherMystery()] }).push(goodEvaluation);
      const spentBefore = harness.ai.calls.length;

      const res = await post(`/api/events/${eventCode}/pool`, { hostToken });
      const body = (await res.json()) as {
        added: number;
        done: boolean;
        timedOut?: boolean;
        error: string | null;
      };
      assert.equal(body.added, 0);
      assert.equal(body.timedOut, true);
      assert.equal(body.done, true, 'the lobby stops asking');
      assert.ok(body.error);
      assert.equal(harness.ai.calls.length, spentBefore, 'and no further inference is spent');
    } finally {
      releaseFakeClock();
    }
  });

  it('starts that budget at the first request, not at creation', async () => {
    useFakeClock();
    try {
      const { eventCode, hostToken } = await createEvent();
      // The host made the event and walked away before opening the console.
      mock.timers.tick(POOL_DEADLINE_MS * 3);
      harness.ai.push({ mysteries: [mystery()] }).push(goodEvaluation);

      const res = await post(`/api/events/${eventCode}/pool`, { hostToken });
      const body = (await res.json()) as { added: number; timedOut?: boolean };
      assert.equal(body.added, 1, 'nothing timed out while nobody was asking');
      assert.notEqual(body.timedOut, true);
    } finally {
      releaseFakeClock();
    }
  });

  it('publishes the deadline so the lobby can count it down', async () => {
    const { eventCode, hostToken } = await createEvent();
    harness.ai.push({ mysteries: [mystery()] }).push(goodEvaluation);

    const table = await seatTableOn(harness, eventCode, hostToken);
    assert.equal(table.snapshot().pool.expiresAt, null, 'no clock before anyone asks');

    await post(`/api/events/${eventCode}/pool`, { hostToken });
    assert.ok(
      (table.snapshot().pool.expiresAt ?? 0) > Date.now(),
      'the first request starts it, and the host is told when it runs out',
    );
  });

  it('survives an AI outage and says so on the host snapshot', async () => {
    const { eventCode, hostToken } = await createEvent();
    harness.ai.pushError(new Error('model is down'));

    const res = await post(`/api/events/${eventCode}/pool`, { hostToken });
    const body = (await res.json()) as { added: number; error: string | null };
    assert.equal(body.added, 0);
    assert.ok(body.error);

    const table = await seatTableOn(harness, eventCode, hostToken);
    const pool = table.snapshot().pool;
    assert.ok(pool.lastError, 'the host is told, on the screen they are already looking at');
    assert.equal(pool.ai, 0);
    assert.equal(pool.wanted, 1);
  });

  it('still plays a full event when the model never answers', async () => {
    const { eventCode, hostToken } = await createEvent();
    harness.ai.pushError(new Error('model is down'));
    await post(`/api/events/${eventCode}/pool`, { hostToken });

    const table = await seatTableOn(harness, eventCode, hostToken);
    await table.host.say({ type: 'host', action: 'start_round' });
    assert.equal(table.snapshot().phase, 'round', 'the built-in bank carries the night');
  });
});

// A table on an event that already exists, so the pool can be prepared first.
import { connect, joinEvent } from './support/client';
import type { PublicRound, Snapshot } from '../src/shared/types';

async function seatTableOn(
  harness: Harness,
  eventCode: string,
  hostToken: string,
): Promise<{
  host: Awaited<ReturnType<typeof connect>>['socket'] & object;
  snapshot(): Snapshot;
  round(): PublicRound | null;
}> {
  const host = (await connect(harness, eventCode, { role: 'host', hostToken })).socket!;
  const joined = await joinEvent(harness, eventCode, { nickname: 'Ada' });
  await connect(harness, eventCode, {
    role: 'player',
    playerId: joined.body.playerId,
    playerToken: joined.body.playerToken,
  });

  const snapshot = () => host.client.lastOfType('snapshot')!.snapshot as Snapshot;
  return { host, snapshot, round: () => snapshot().round };
}

// ------------------------------------------------- keeping the host's brief

/**
 * The categories are the one thing the host chooses about the *content* of
 * the night, and the console promises the room "will not be able to tell"
 * when the written pool comes up short. That promise is only kept if the
 * built-in bank is drawn on in the host's chosen categories first.
 */
describe('the categories the host chose', () => {
  afterEach(() => releaseFakeClock());

  it('draws the built-in bank on topic before it drifts', async () => {
    useFakeClock();
    const onTopic = MYSTERIES.filter((m) => m.type === 'landmark');
    assert.ok(onTopic.length >= 2, 'the fixture needs a category with more than one entry');

    // No AI is scripted here, so every round comes from the built-in bank -
    // exactly the case where the promise used to break.
    const table = await seatTable(['Ada'], {
      plannedRounds: onTopic.length,
      categories: ['landmark'],
      autoAdvance: false,
    });

    const played: string[] = [];
    for (let r = 0; r < onTopic.length; r++) {
      await table.host.say({ type: 'host', action: 'start_round' });
      await table.tickToAlarm();
      played.push(table.round()!.mysteryType);
      await table.players.Ada.socket.say({ type: 'submit_answer', option: answerFor(table.host) });
    }

    assert.deepEqual(
      played,
      onTopic.map(() => 'landmark'),
      `asked for landmarks and got ${JSON.stringify(played)}`,
    );
  });

  it('still has something to play once the chosen categories run out', async () => {
    useFakeClock();
    const spaceCount = MYSTERIES.filter((m) => m.type === 'space').length;
    const table = await seatTable(['Ada'], {
      plannedRounds: spaceCount + 1,
      categories: ['space'],
      autoAdvance: false,
    });

    for (let r = 0; r <= spaceCount; r++) {
      await table.host.say({ type: 'host', action: 'start_round' });
      await table.tickToAlarm();
      assert.equal(table.snapshot().phase, 'round', 'running out of topic must not end the night');
      await table.players.Ada.socket.say({ type: 'submit_answer', option: answerFor(table.host) });
    }
    assert.equal(table.snapshot().roundsPlayed, spaceCount + 1);
  });

  it('shuffles the whole bank when the host narrowed nothing', async () => {
    useFakeClock();
    const table = await seatTable(['Ada'], { plannedRounds: 4, autoAdvance: false });
    const types = new Set<string>();
    for (let r = 0; r < 4; r++) {
      await table.host.say({ type: 'host', action: 'start_round' });
      await table.tickToAlarm();
      types.add(table.round()!.mysteryType);
      await table.players.Ada.socket.say({ type: 'submit_answer', option: answerFor(table.host) });
    }
    assert.ok(types.size > 1, 'an open-ended night should range across the bank');
  });
});
