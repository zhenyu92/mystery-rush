/**
 * The D1 write-through path. Two properties matter here: what lands in the
 * archive is right, and a D1 outage never reaches the room - gameplay is
 * supposed to carry on regardless.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { pointsForClue } from '../src/shared/types';
import {
  createEventRow,
  eventExists,
  recordRoundEnd,
  recordRoundStart,
  resetEventRows,
  setEventPhase,
  upsertPlayer,
} from '../src/worker/db';
import { FakeD1 } from './support/d1';
import {
  answerFor,
  muteLogs,
  releaseFakeClock,
  seatTable,
  useFakeClock,
  wrongOption,
  type Table,
} from './support/game';

describe('the write-through helpers in isolation', () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });
  afterEach(() => releaseFakeClock());

  const player = {
    id: 'p_1',
    nickname: 'Ada',
    score: 500,
    correctAnswers: 1,
    mysteriesPlayed: 1,
    joinedAt: 1000,
  };

  it('registers an event once and then leaves it alone', async () => {
    await createEventRow(db, {
      eventCode: 'ABCDE',
      eventName: 'First',
      hostTokenHash: 'hash1',
      createdAt: 1000,
    });
    await createEventRow(db, {
      eventCode: 'ABCDE',
      eventName: 'Second',
      hostTokenHash: 'hash2',
      createdAt: 2000,
    });

    assert.equal(db.events.size, 1);
    assert.equal(db.events.get('ABCDE')!.event_name, 'First', 'a re-init must not clobber the event');
  });

  it('answers whether a code is taken', async () => {
    assert.equal(await eventExists(db, 'ABCDE'), false);
    await createEventRow(db, { eventCode: 'ABCDE', eventName: 'x', hostTokenHash: 'h', createdAt: 1 });
    assert.equal(await eventExists(db, 'ABCDE'), true);
  });

  it('fails open when the registry is unreachable', async () => {
    muteLogs();
    db.failing = true;
    assert.equal(
      await eventExists(db, 'ABCDE'),
      true,
      'a D1 outage must degrade to a slower rejection, not an outage',
    );
  });

  it('swallows every write failure rather than throwing at the caller', async () => {
    muteLogs();
    db.failing = true;
    await createEventRow(db, { eventCode: 'A', eventName: 'x', hostTokenHash: 'h', createdAt: 1 });
    await setEventPhase(db, 'A', 'round');
    await upsertPlayer(db, 'A', player);
    await recordRoundStart(db, {
      id: 'r1',
      eventCode: 'A',
      mysteryId: 'm1',
      roundIndex: 1,
      startedAt: 1,
    });
    await recordRoundEnd(db, 'A', 'r1', 2, [], []);
    await resetEventRows(db, 'A');
    // Reaching here without throwing is the assertion.
    assert.equal(db.events.size, 0);
  });

  it('updates a player in place rather than duplicating them', async () => {
    await upsertPlayer(db, 'ABCDE', player);
    await upsertPlayer(db, 'ABCDE', { ...player, nickname: 'Ada L.', score: 900, joinedAt: 9999 });

    assert.equal(db.players.size, 1);
    const row = db.players.get('p_1')!;
    assert.equal(row.nickname, 'Ada L.');
    assert.equal(row.score, 900);
    assert.equal(row.joined_at, 1000, 'joining time is set once and never rewritten');
  });

  it('binds one prepared statement per row without them treading on each other', async () => {
    await recordRoundEnd(
      db,
      'ABCDE',
      'r1',
      5000,
      [
        {
          roundId: 'r1',
          playerId: 'p_1',
          selectedOption: 'Right',
          submittedAt: 10,
          clueNumber: 1,
          isCorrect: true,
          pointsAwarded: 500,
        },
        {
          roundId: 'r1',
          playerId: 'p_2',
          selectedOption: 'Wrong',
          submittedAt: 20,
          clueNumber: 3,
          isCorrect: false,
          pointsAwarded: 0,
        },
      ],
      [player, { ...player, id: 'p_2', nickname: 'Grace', score: 0, correctAnswers: 0 }],
    );

    assert.equal(db.answers.size, 2, 'each answer gets its own row');
    assert.equal(db.answers.get('r1::p_1')!.is_correct, 1);
    assert.equal(db.answers.get('r1::p_1')!.points_awarded, 500);
    assert.equal(db.answers.get('r1::p_2')!.is_correct, 0);
    assert.equal(db.answers.get('r1::p_2')!.clue_number, 3);
    assert.equal(db.players.size, 2);
  });

  it('does not double-archive a round that is written twice', async () => {
    const answer = {
      roundId: 'r1',
      playerId: 'p_1',
      selectedOption: 'Right',
      submittedAt: 10,
      clueNumber: 1,
      isCorrect: true,
      pointsAwarded: 500,
    };
    await recordRoundStart(db, {
      id: 'r1',
      eventCode: 'ABCDE',
      mysteryId: 'm1',
      roundIndex: 1,
      startedAt: 1,
    });
    await recordRoundEnd(db, 'ABCDE', 'r1', 5000, [answer], [player]);
    await recordRoundEnd(db, 'ABCDE', 'r1', 6000, [answer], [player]);

    assert.equal(db.answers.size, 1, 'a replayed write must not duplicate an answer');
    assert.equal(db.players.size, 1);
    assert.equal(db.rounds.size, 1);
    assert.equal(db.rounds.get('r1')!.status, 'ended');
  });
});

describe('what an event leaves behind', () => {
  let table: Table;

  beforeEach(async () => {
    useFakeClock();
    table = await seatTable(['Ada', 'Grace']);
  });
  afterEach(() => releaseFakeClock());

  it('archives the round, both answers and the running totals', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.settle();

    const roundId = table.round()!.roundId;
    const started = table.harness.db.rounds.get(roundId)!;
    assert.equal(started.status, 'active');
    assert.equal(started.round_index, 1);
    assert.equal(started.event_code, table.eventCode);
    assert.equal(started.ended_at, null);
    assert.equal(table.harness.db.events.get(table.eventCode)!.phase, 'round');

    await table.tickToAlarm();
    const answer = answerFor(table.host);
    const wrong = wrongOption(table.round()!, answer);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    await table.players.Grace.socket.say({ type: 'submit_answer', option: wrong });
    await table.settle();

    const ended = table.harness.db.rounds.get(roundId)!;
    assert.equal(ended.status, 'ended');
    assert.equal(ended.ended_at, Date.now());

    const ada = table.harness.db.answers.get(`${roundId}::${table.players.Ada.playerId}`)!;
    assert.equal(ada.selected_option, answer);
    assert.equal(ada.is_correct, 1);
    assert.equal(ada.clue_number, 1);
    assert.equal(ada.points_awarded, pointsForClue(1));
    assert.equal(ada.event_code, table.eventCode);

    const grace = table.harness.db.answers.get(`${roundId}::${table.players.Grace.playerId}`)!;
    assert.equal(grace.is_correct, 0);
    assert.equal(grace.points_awarded, 0);

    assert.equal(table.harness.db.players.get(table.players.Ada.playerId)!.score, pointsForClue(1));
    assert.equal(table.harness.db.players.get(table.players.Ada.playerId)!.correct_answers, 1);
    assert.equal(table.harness.db.players.get(table.players.Grace.playerId)!.mysteries_played, 1);
    assert.equal(table.harness.db.events.get(table.eventCode)!.phase, 'results');
  });

  it('writes no answer row for a player who never guessed', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answerFor(table.host) });
    await table.host.say({ type: 'host', action: 'end_round' });
    await table.settle();

    assert.equal(table.harness.db.answers.size, 1);
    assert.equal(
      table.harness.db.players.get(table.players.Grace.playerId)!.mysteries_played,
      1,
      'they still played the mystery, they just did not answer it',
    );
  });

  it('keeps the round running when D1 is down the whole time', async () => {
    muteLogs();
    table.harness.db.failing = true;

    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    const answer = answerFor(table.host);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    await table.players.Grace.socket.say({ type: 'submit_answer', option: answer });
    await table.settle();

    assert.equal(table.snapshot().phase, 'results', 'the room is the authority, not the archive');
    assert.equal(
      table.snapshot().leaderboard.find((e) => e.nickname === 'Ada')!.score,
      pointsForClue(1),
    );
  });
});

describe('surviving an eviction', () => {
  let table: Table;

  beforeEach(async () => {
    useFakeClock();
    table = await seatTable(['Ada', 'Grace']);
  });
  afterEach(() => releaseFakeClock());

  it('rebuilds a live round, its answers and the clock from storage', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    const answer = answerFor(table.host);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });

    const before = table.round()!;
    await table.harness.restart(table.eventCode);
    await table.display.say({ type: 'ping', clientTime: 1 });
    await table.host.say({ type: 'host', action: 'pause' });
    await table.host.say({ type: 'host', action: 'resume' });

    const after = table.round()!;
    assert.equal(after.roundId, before.roundId);
    assert.equal(after.mysteryId, before.mysteryId);
    assert.equal(after.currentClue, before.currentClue);
    assert.deepEqual(after.options, before.options);
    assert.equal(after.answeredCount, 1, 'a locked-in guess survives the object going away');
  });

  it('rebuilds scores and the roster', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    const answer = answerFor(table.host);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    await table.players.Grace.socket.say({ type: 'submit_answer', option: answer });

    await table.harness.restart(table.eventCode);
    await table.host.say({ type: 'host', action: 'show_leaderboard' });

    const snapshot = table.snapshot();
    assert.equal(snapshot.phase, 'leaderboard');
    assert.equal(snapshot.roundsPlayed, 1);
    assert.equal(snapshot.players.length, 2);
    assert.ok(snapshot.leaderboard.every((e) => e.score === pointsForClue(1)));
  });

  it('still knows the host token after a rebuild', async () => {
    await table.harness.restart(table.eventCode);
    const { connect } = await import('./support/client');

    const good = await connect(table.harness, table.eventCode, {
      role: 'host',
      hostToken: table.hostToken,
    });
    assert.equal(good.status, 101);

    const bad = await connect(table.harness, table.eventCode, { role: 'host', hostToken: 'nope' });
    assert.equal(bad.status, 403);
  });
});
