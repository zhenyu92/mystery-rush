/**
 * The rules that decide a score: the get-ready window, clue progression off
 * the alarm, one guess per player, points fixed by the clue the *server* had
 * open, and the answer never travelling early.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  CLUE_COUNT,
  CLUE_DURATION_MS,
  INTRO_DURATION_MS,
  pointsForClue,
  streakBonus,
} from '../src/shared/types';
import type { Snapshot } from '../src/shared/types';
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

let table: Table;

beforeEach(async () => {
  useFakeClock();
  table = await seatTable(['Ada', 'Grace']);
});

afterEach(() => {
  releaseFakeClock();
});

async function startRound(): Promise<void> {
  await table.host.say({ type: 'host', action: 'start_round' });
}

/** Get past the get-ready window and onto clue 1. */
async function toFirstClue(): Promise<void> {
  await startRound();
  await table.tickToAlarm();
}

describe('starting a round', () => {
  it('opens with a get-ready window that reveals nothing', async () => {
    await startRound();

    const round = table.round()!;
    assert.equal(round.status, 'intro');
    assert.equal(round.currentClue, 0);
    assert.deepEqual(round.clues, [], 'the intro must not leak a clue');
    assert.equal(round.acceptingAnswers, false);
    assert.equal(round.clueCount, CLUE_COUNT);
    assert.equal(round.windowMs, INTRO_DURATION_MS);
    assert.equal(round.roundIndex, 1);
    assert.equal(table.snapshot().phase, 'round');
  });

  it('arms the alarm for the end of the get-ready window', async () => {
    await startRound();
    const state = table.harness.stateFor(table.eventCode);
    assert.equal(state.storage.alarm, Date.now() + INTRO_DURATION_MS);
  });

  it('refuses to start a second round on top of a live one', async () => {
    await startRound();
    await table.host.say({ type: 'host', action: 'start_round' });
    assert.equal(lastErrorOn(table.host), 'round_running');
  });

  it('refuses to start with an empty room', async () => {
    const empty = await seatTable([]);
    await empty.host.say({ type: 'host', action: 'start_round' });
    assert.equal(lastErrorOn(empty.host), 'no_players');
  });

  it('refuses a mystery that does not exist', async () => {
    await table.host.say({ type: 'host', action: 'start_round', mysteryId: 'nope' });
    assert.equal(lastErrorOn(table.host), 'no_such_mystery');
  });

  it('honours an explicit pick and spends it from the queue', async () => {
    const before = table.snapshot().mysteriesRemaining;
    const catalog = table.host.client.lastOfType('catalog')!.mysteries as { id: string }[];
    const pick = catalog[3].id;

    await table.host.say({ type: 'host', action: 'start_round', mysteryId: pick });

    assert.equal(table.round()!.mysteryId, pick);
    assert.equal(table.snapshot().mysteriesRemaining, before - 1);

    const after = table.host.client.lastOfType('catalog')!.mysteries as { id: string; used: boolean }[];
    assert.equal(after.find((m) => m.id === pick)!.used, true, 'a spent mystery must stop being offered');
  });
});

describe('the clue clock', () => {
  it('reveals exactly one clue per window, and never more than five', async () => {
    await startRound();

    for (let expected = 1; expected <= CLUE_COUNT; expected++) {
      await table.tickToAlarm();
      const round = table.round()!;
      assert.equal(round.status, 'active');
      assert.equal(round.currentClue, expected);
      assert.equal(round.clues.length, expected, 'only revealed clues may leave the server');
      assert.equal(round.windowMs, CLUE_DURATION_MS);
      assert.equal(round.acceptingAnswers, true);
    }

    await table.tickToAlarm();
    assert.equal(table.snapshot().phase, 'results', 'the round closes after clue five has had its turn');
  });

  it('does not drift: each window is anchored to the last deadline', async () => {
    await startRound();
    const started = Date.now();

    for (let i = 0; i < CLUE_COUNT; i++) await table.tickToAlarm();

    const round = table.round()!;
    assert.equal(
      round.clueEndsAt,
      started + INTRO_DURATION_MS + CLUE_COUNT * CLUE_DURATION_MS,
      'alarm jitter must not stretch the round',
    );
  });

  it('re-arms instead of advancing when it wakes early', async () => {
    await startRound();
    const room = table.harness.roomFor(table.eventCode);
    const state = table.harness.stateFor(table.eventCode);

    table.advance(1_000);
    await room.alarm();

    assert.equal(table.round()!.currentClue, 0, 'an early wake must not burn a clue');
    assert.equal(state.storage.alarm, Date.now() + INTRO_DURATION_MS - 1_000);
  });

  it('does nothing once the round has ended', async () => {
    await toFirstClue();
    await table.host.say({ type: 'host', action: 'end_round' });
    const before = JSON.stringify(table.snapshot());

    await table.harness.roomFor(table.eventCode).alarm();
    assert.equal(JSON.stringify(table.snapshot()), before);
  });
});

describe('answering', () => {
  it('is refused during the get-ready window', async () => {
    await startRound();
    const round = table.round()!;
    await table.players.Ada.socket.say({ type: 'submit_answer', option: round.options[0] });

    assert.equal(lastErrorOn(table.players.Ada.socket), 'round_not_started');
    assert.equal(table.round()!.answeredCount, 0);
  });

  it('is refused before any round has been started', async () => {
    await table.players.Ada.socket.say({ type: 'submit_answer', option: 'anything' });
    assert.equal(lastErrorOn(table.players.Ada.socket), 'round_closed');
  });

  it('locks in one guess, and only one', async () => {
    await toFirstClue();
    const round = table.round()!;

    await table.players.Ada.socket.say({ type: 'submit_answer', option: round.options[0] });
    assert.equal(selfOn(table.players.Ada.socket)!.hasAnswered, true);
    assert.equal(selfOn(table.players.Ada.socket)!.selectedOption, round.options[0]);
    assert.equal(selfOn(table.players.Ada.socket)!.answeredAtClue, 1);

    await table.players.Ada.socket.say({ type: 'submit_answer', option: round.options[1] });
    assert.equal(lastErrorOn(table.players.Ada.socket), 'already_answered');
    assert.equal(selfOn(table.players.Ada.socket)!.selectedOption, round.options[0]);
  });

  it('rejects anything that is not one of the options on screen', async () => {
    await toFirstClue();
    for (const option of ['Atlantis', '', 42, null]) {
      await table.players.Ada.socket.say({ type: 'submit_answer', option });
      assert.equal(lastErrorOn(table.players.Ada.socket), 'bad_option', `for ${JSON.stringify(option)}`);
    }
    assert.equal(table.round()!.answeredCount, 0);
  });

  it('never lets a host or a projector answer', async () => {
    await toFirstClue();
    const option = table.round()!.options[0];

    await table.host.say({ type: 'submit_answer', option });
    assert.equal(lastErrorOn(table.host), 'forbidden');

    await table.display.say({ type: 'submit_answer', option });
    assert.equal(lastErrorOn(table.display), 'forbidden');

    assert.equal(table.round()!.answeredCount, 0);
  });

  it('holds points back until the round ends', async () => {
    await toFirstClue();
    const answer = answerFor(table.host);

    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });

    assert.equal(selfOn(table.players.Ada.socket)!.score, 0, 'a ticking score would leak correctness');
    assert.equal(table.snapshot().leaderboard.find((e) => e.nickname === 'Ada')!.score, 0);
  });

  it('scores against the clue the server had open, not the one the client claims', async () => {
    await startRound();
    await table.tickToAlarm(); // clue 1
    await table.tickToAlarm(); // clue 2
    await table.tickToAlarm(); // clue 3

    const answer = answerFor(table.host);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer, clueNumber: 1 });
    await table.players.Grace.socket.say({ type: 'submit_answer', option: answer });

    const scores = table.snapshot().leaderboard;
    assert.equal(scores.find((e) => e.nickname === 'Ada')!.score, pointsForClue(3));
    assert.equal(pointsForClue(3), 300);
  });
});

describe('ending a round', () => {
  it('ends early once every connected player has locked in', async () => {
    await toFirstClue();
    const answer = answerFor(table.host);

    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    assert.equal(table.snapshot().phase, 'round', 'one of two is not everybody');

    await table.players.Grace.socket.say({ type: 'submit_answer', option: answer });
    assert.equal(table.snapshot().phase, 'results');

    // The clue clock is done, but the alarm is not idle: it now holds the
    // countdown out of the results screen. What matters is that it is no
    // longer a clue timer.
    const snap = table.snapshot();
    assert.equal(snap.autoAdvance?.to, 'leaderboard', 'the results countdown is running');
    assert.equal(
      table.harness.stateFor(table.eventCode).storage.alarm,
      snap.autoAdvance?.at,
      'and the alarm is set for exactly that',
    );
  });

  it('ignores a player whose phone dropped when deciding everyone is done', async () => {
    await toFirstClue();
    const answer = answerFor(table.host);

    await table.players.Grace.socket.hangUp();
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });

    assert.equal(table.snapshot().phase, 'results', 'a dropped phone must not stall the room');
  });

  it('re-checks the early end when the last outstanding player drops', async () => {
    await toFirstClue();
    const answer = answerFor(table.host);

    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    assert.equal(table.snapshot().phase, 'round');

    await table.players.Grace.socket.hangUp();
    assert.equal(table.snapshot().phase, 'results');
  });

  it('publishes the answer, the spread and the per-player breakdown', async () => {
    await toFirstClue();
    const answer = answerFor(table.host);
    const wrong = wrongOption(table.round()!, answer);

    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    await table.players.Grace.socket.say({ type: 'submit_answer', option: wrong });

    const result = table.snapshot().result!;
    assert.equal(result.answer, answer);
    assert.equal(result.clues.length, CLUE_COUNT, 'every clue is fair game once it is over');
    assert.equal(result.totalAnswers, 2);
    assert.equal(result.correctCount, 1);
    assert.equal(
      result.distribution.reduce((sum, d) => sum + d.count, 0),
      2,
      'the spread must account for every guess',
    );
    assert.deepEqual(
      result.distribution.map((d) => d.option).sort(),
      [...result.options].sort(),
      'every option gets a bar, including the ones nobody picked',
    );
    assert.equal(result.players[0].nickname, 'Ada', 'highest scorer first');
    assert.equal(result.players[0].pointsAwarded, pointsForClue(1));
    assert.equal(result.players[1].pointsAwarded, 0);
    assert.equal(result.players[1].isCorrect, false);
  });

  it('banks points, counts the streak and zeroes it on a miss', async () => {
    await toFirstClue();
    let answer = answerFor(table.host);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    await table.players.Grace.socket.say({ type: 'submit_answer', option: wrongOption(table.round()!, answer) });

    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    answer = answerFor(table.host);
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answer });
    await table.players.Grace.socket.say({ type: 'submit_answer', option: answer });

    const board = table.snapshot().leaderboard;
    const ada = board.find((e) => e.nickname === 'Ada')!;
    const grace = board.find((e) => e.nickname === 'Grace')!;

    // Ada answered correctly twice running, so the second one also pays the
    // two-in-a-row bonus. Grace missed the first, so her streak is back to
    // one and she gets the clue value alone.
    assert.equal(ada.score, pointsForClue(1) * 2 + streakBonus(2));
    assert.equal(ada.streak, 2);
    assert.equal(ada.correctAnswers, 2);
    assert.equal(grace.score, pointsForClue(1));
    assert.equal(grace.streak, 1, 'a miss then a hit is a streak of one');
    assert.equal(grace.correctAnswers, 1);
    assert.equal(grace.mysteriesPlayed, 2);
  });

  it('gives a silent player zero and breaks their streak', async () => {
    await toFirstClue();
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answerFor(table.host) });
    await table.host.say({ type: 'host', action: 'end_round' });

    const grace = table.snapshot().leaderboard.find((e) => e.nickname === 'Grace')!;
    assert.equal(grace.score, 0);
    assert.equal(grace.streak, 0);
    assert.equal(grace.mysteriesPlayed, 1, 'sitting one out still counts as played');

    const entry = table.snapshot().result!.players.find((p) => p.nickname === 'Grace')!;
    assert.equal(entry.selectedOption, null);
    assert.equal(entry.clueNumber, null);
  });

  it('shuts the door on a late guess', async () => {
    await toFirstClue();
    await table.host.say({ type: 'host', action: 'end_round' });

    await table.players.Ada.socket.say({ type: 'submit_answer', option: 'anything' });
    assert.equal(lastErrorOn(table.players.Ada.socket), 'round_closed');
  });
});

describe('pause and resume', () => {
  it('freezes the clock and turns answers away', async () => {
    await toFirstClue();
    table.advance(6_000);
    await table.host.say({ type: 'host', action: 'pause' });

    const round = table.round()!;
    assert.equal(round.status, 'paused');
    assert.equal(round.acceptingAnswers, false);
    assert.equal(round.remainingMs, CLUE_DURATION_MS - 6_000);
    assert.equal(table.harness.stateFor(table.eventCode).storage.alarm, null);

    await table.players.Ada.socket.say({ type: 'submit_answer', option: round.options[0] });
    assert.equal(lastErrorOn(table.players.Ada.socket), 'round_paused');
  });

  it('picks the clock up exactly where it froze', async () => {
    await toFirstClue();
    table.advance(6_000);
    await table.host.say({ type: 'host', action: 'pause' });
    table.advance(60_000); // the host talks for a minute

    await table.host.say({ type: 'host', action: 'resume' });

    const round = table.round()!;
    assert.equal(round.status, 'active');
    assert.equal(round.remainingMs, CLUE_DURATION_MS - 6_000);
    assert.equal(round.clueEndsAt, Date.now() + CLUE_DURATION_MS - 6_000);
    assert.equal(round.clueStartedAt, Date.now() - 6_000, 'the ring must resume mid-fill');
    assert.equal(table.harness.stateFor(table.eventCode).storage.alarm, round.clueEndsAt);
  });

  it('can pause the get-ready window and resume back into it', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.host.say({ type: 'host', action: 'pause' });
    assert.equal(table.round()!.status, 'paused');

    await table.host.say({ type: 'host', action: 'resume' });
    assert.equal(table.round()!.status, 'intro', 'resuming must not skip the get-ready window');
    assert.equal(table.round()!.currentClue, 0);
  });

  it('ignores a pause when nothing is running and a resume when nothing is paused', async () => {
    await table.host.say({ type: 'host', action: 'pause' });
    assert.equal(table.snapshot().phase, 'lobby');

    await toFirstClue();
    await table.host.say({ type: 'host', action: 'resume' });
    assert.equal(table.round()!.status, 'active');
  });
});

describe('what the client is allowed to see', () => {
  it('keeps unrevealed clues and the answer off the wire during a round', async () => {
    await startRound();
    await table.tickToAlarm();
    await table.tickToAlarm(); // clue 2 of 5

    const answer = answerFor(table.host);
    for (const socket of [table.players.Ada.socket, table.display]) {
      const wire = JSON.stringify(socket.client.received);
      assert.ok(!wire.includes('"host_brief"'), 'only the host gets the answer sheet');
    }

    const snapshot: Snapshot = table.snapshot();
    assert.equal(snapshot.round!.clues.length, 2);
    assert.equal(snapshot.result, null, 'no result exists while the round is live');

    const playerWire = JSON.stringify(table.players.Ada.socket.client.received);
    const fullClueList = table.host.client.lastOfType('host_brief')!.clues as string[];
    assert.ok(
      !playerWire.includes(fullClueList[4]),
      'clue five must not reach a player before it is revealed',
    );
    assert.ok(answer.length > 0);
  });

  it('sends the host the answer sheet the moment a round starts', async () => {
    assert.equal(table.host.client.lastOfType('host_brief'), undefined);
    await startRound();

    const brief = table.host.client.lastOfType('host_brief')!;
    assert.equal(brief.roundId, table.round()!.roundId);
    assert.equal((brief.clues as string[]).length, CLUE_COUNT);
    assert.ok(typeof brief.answer === 'string' && (brief.answer as string).length > 0);
  });

  it('replays the brief to a host that connects mid-round', async () => {
    await toFirstClue();
    const { connect } = await import('./support/client');
    const second = (await connect(table.harness, table.eventCode, {
      role: 'host',
      hostToken: table.hostToken,
    })).socket!;

    assert.equal(second.client.lastOfType('host_brief')!.answer, answerFor(table.host));
  });
});
