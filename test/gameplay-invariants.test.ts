/**
 * Invariants that hold across the whole of a live round, and are cheap to
 * break by accident.
 *
 * The first one is structural rather than behavioural: it reads the source.
 * That is deliberate. "No model call while a round is running" cannot be
 * proved by exercising the object - a test only ever covers the paths it
 * happens to walk - but it can be proved by the import graph, and the import
 * graph is what would change if somebody added one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { connect, joinEvent } from './support/client';
import {
  answerFor,
  lastErrorOn,
  releaseFakeClock,
  seatTable,
  selfOn,
  useFakeClock,
  wrongOption,
  type Table,
} from './support/game';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('no AI on the gameplay path', () => {
  it('never lets the Durable Object reach the model', () => {
    const source = read('src/worker/event-room.ts');

    // The object that runs rounds must not import the model client, directly
    // or through the pool builder that wraps it. Generation takes tens of
    // seconds and the object is single-threaded, so one call here stalls the
    // clue clock for the whole room.
    for (const forbidden of ['./llm', './mystery-pool']) {
      assert.ok(
        !source.includes(`from '${forbidden}'`),
        `event-room.ts must not import ${forbidden}`,
      );
    }
    assert.ok(!/\benv\.AI\b/.test(source), 'event-room.ts must not touch the AI binding');
    assert.ok(
      !/\bthis\.env\.AI\b/.test(source),
      'event-room.ts must not touch the AI binding through this.env',
    );
  });

  it('keeps the model client reachable from exactly one place', () => {
    // mystery-pool is the only caller, and it is only ever invoked from the
    // Worker's fetch handler - never from inside the room.
    const importers = ['src/worker/index.ts', 'src/worker/mystery-pool.ts', 'src/worker/game.ts', 'src/worker/db.ts']
      .filter((f) => read(f).includes("from './llm'"));
    assert.deepEqual(importers, ['src/worker/mystery-pool.ts']);
  });

  it('validates generated content with a module that does no I/O', () => {
    const source = read('src/worker/mystery-validation.ts');
    assert.ok(!source.includes("from './llm'"), 'the rules must not consult the model');
    assert.ok(!/\bfetch\(/.test(source), 'the rules must not reach the network');
  });
});

describe('one guess, whatever the client does', () => {
  let table: Table;
  beforeEach(async () => {
    useFakeClock();
    table = await seatTable(['Ada', 'Grace'], { autoAdvance: false });
  });
  afterEach(() => releaseFakeClock());

  async function toClue(n: number): Promise<void> {
    await table.host.say({ type: 'host', action: 'start_round' });
    for (let i = 0; i < n; i++) await table.tickToAlarm();
  }

  it('keeps the first of two submissions that race each other', async () => {
    await toClue(1);
    const answer = answerFor(table.host);
    const wrong = wrongOption(table.round()!, answer);
    const sock = table.players.Ada.socket;

    await Promise.all([
      sock.say({ type: 'submit_answer', option: answer }),
      sock.say({ type: 'submit_answer', option: wrong }),
    ]);

    assert.equal(selfOn(sock)!.selectedOption, answer, 'the first guess is the one that counts');
    assert.equal(lastErrorOn(sock), 'already_answered');
    assert.equal(table.round()!.answeredCount, 1);
  });

  it('scores two players who answer at the same instant independently', async () => {
    await toClue(1);
    const answer = answerFor(table.host);
    const wrong = wrongOption(table.round()!, answer);

    await Promise.all([
      table.players.Ada.socket.say({ type: 'submit_answer', option: answer }),
      table.players.Grace.socket.say({ type: 'submit_answer', option: wrong }),
    ]);

    const board = table.snapshot().leaderboard;
    assert.equal(board.find((e) => e.nickname === 'Ada')!.correctAnswers, 1);
    assert.equal(board.find((e) => e.nickname === 'Grace')!.correctAnswers, 0);
    assert.equal(table.snapshot().result!.totalAnswers, 2, 'both guesses are on the record');
  });

  it('counts an answer locked in on the final instant of the last clue', async () => {
    await toClue(5);
    const round = table.round()!;
    assert.equal(round.currentClue, 5);

    table.advance(round.remainingMs - 1);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answerFor(table.host) });

    assert.equal(lastErrorOn(table.players.Ada.socket), undefined, 'a last-instant guess must count');
    assert.equal(selfOn(table.players.Ada.socket)!.answeredAtClue, 5);
  });
});

describe('a phone that drops out mid-round', () => {
  let table: Table;
  beforeEach(async () => {
    useFakeClock();
    table = await seatTable(['Ada', 'Grace'], { autoAdvance: false });
  });
  afterEach(() => releaseFakeClock());

  it('gives a reconnecting player their locked answer back, not another go', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    const answer = answerFor(table.host);
    const ada = table.players.Ada;

    await ada.socket.say({ type: 'submit_answer', option: answer });
    await ada.socket.hangUp();

    const again = (await connect(table.harness, table.eventCode, {
      role: 'player',
      playerId: ada.playerId,
      playerToken: ada.playerToken,
    })).socket!;

    const self = again.client.lastOfType('welcome')!.self as Record<string, unknown>;
    assert.equal(self.hasAnswered, true, 'a refresh must not look like a fresh chance');
    assert.equal(self.selectedOption, answer);

    await again.say({ type: 'submit_answer', option: wrongOption(table.round()!, answer) });
    assert.equal(lastErrorOn(again), 'already_answered');
    assert.equal(table.round()!.answeredCount, 1);
  });

  it('does not wait for someone who walked in after the round started', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();

    const late = await joinEvent(table.harness, table.eventCode, { nickname: 'Late' });
    const lateSocket = (await connect(table.harness, table.eventCode, {
      role: 'player',
      playerId: late.body.playerId,
      playerToken: late.body.playerToken,
    })).socket!;

    const answer = answerFor(table.host);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    await table.players.Grace.socket.say({ type: 'submit_answer', option: answer });

    assert.equal(table.snapshot().phase, 'results', 'a latecomer must not hold the room hostage');
    assert.equal(lateSocket.client.lastOfType('snapshot') !== undefined, true);
  });

  it('still lets a latecomer answer the round they walked into', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();

    const late = await joinEvent(table.harness, table.eventCode, { nickname: 'Late' });
    const lateSocket = (await connect(table.harness, table.eventCode, {
      role: 'player',
      playerId: late.body.playerId,
      playerToken: late.body.playerToken,
    })).socket!;

    await lateSocket.say({ type: 'submit_answer', option: answerFor(table.host) });
    assert.equal(lastErrorOn(lateSocket), undefined, 'they may play, they are just not waited for');
  });
});

describe('the host clicking at the wrong moment', () => {
  let table: Table;
  beforeEach(async () => {
    useFakeClock();
    table = await seatTable(['Ada'], { autoAdvance: false });
  });
  afterEach(() => releaseFakeClock());

  it('banks a round exactly once when end_round races the clue alarm', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    for (let i = 0; i < 5; i++) await table.tickToAlarm();
    table.advance(table.round()!.remainingMs);

    await Promise.all([
      table.host.say({ type: 'host', action: 'end_round' }),
      table.harness.roomFor(table.eventCode).alarm(),
    ]);

    assert.equal(table.snapshot().roundsPlayed, 1, 'a round must be banked exactly once');
  });

  it('ignores end_event fired twice rather than re-banking the round', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    await table.host.say({ type: 'host', action: 'end_event' });
    await table.host.say({ type: 'host', action: 'end_event' });

    assert.equal(table.snapshot().phase, 'finished');
    assert.equal(table.snapshot().roundsPlayed, 1);
  });

  it('leaves nothing half-live when the host resets mid-round', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    await table.host.say({ type: 'host', action: 'reset_event' });

    const s = table.snapshot();
    assert.equal(s.phase, 'lobby');
    assert.equal(s.round, null, 'a reset must not leave a round on the wire');
    assert.equal(s.roundsPlayed, 0);
    assert.equal(table.harness.stateFor(table.eventCode).storage.alarm, null, 'and no clock running');
  });

  it('does nothing when end_round arrives before any round exists', async () => {
    await table.host.say({ type: 'host', action: 'end_round' });
    assert.equal(table.snapshot().phase, 'lobby');
    assert.equal(table.snapshot().roundsPlayed, 0);
  });
});
