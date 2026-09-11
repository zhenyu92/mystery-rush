/**
 * The buttons on the host's sidebar: the leaderboard, kicking someone,
 * resetting the event and ending it - plus the standings those screens read
 * from.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { pointsForClue } from '../src/shared/types';
import { connect } from './support/client';
import {
  answerFor,
  releaseFakeClock,
  seatTable,
  useFakeClock,
  wrongOption,
  type Table,
} from './support/game';

let table: Table;

beforeEach(async () => {
  useFakeClock();
  table = await seatTable(['Ada', 'Grace', 'Linus']);
});

afterEach(() => releaseFakeClock());

/** Run one round to completion with a chosen outcome per player. */
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

describe('the leaderboard', () => {
  it('stays on the lobby until a round has actually been played', async () => {
    await table.host.say({ type: 'host', action: 'show_leaderboard' });
    assert.equal(table.snapshot().phase, 'lobby');
  });

  it('moves the room to the standings after a round', async () => {
    await playRound(['Ada']);
    assert.equal(table.snapshot().phase, 'results');

    await table.host.say({ type: 'host', action: 'show_leaderboard' });
    assert.equal(table.snapshot().phase, 'leaderboard');
    assert.equal(table.snapshot().result !== null, true, 'the last result stays available');
  });

  it('shares a rank between equal scores and skips the next one', async () => {
    await playRound(['Ada', 'Grace']);

    const board = table.snapshot().leaderboard;
    assert.deepEqual(
      board.map((e) => [e.nickname, e.score, e.rank]),
      [
        ['Ada', pointsForClue(1), 1],
        ['Grace', pointsForClue(1), 1],
        ['Linus', 0, 3],
      ],
    );
  });

  it('breaks a score tie on correct answers, then on nickname', async () => {
    const board = table.snapshot().leaderboard;
    assert.deepEqual(
      board.map((e) => e.nickname),
      ['Ada', 'Grace', 'Linus'],
      'an all-zero board is alphabetical, not arbitrary',
    );
    assert.ok(board.every((e) => e.rank === 1), 'nobody is ahead before a round');
  });

  it('reports movement since the previous round', async () => {
    await playRound(['Linus']);
    let board = table.snapshot().leaderboard;
    assert.equal(board[0].nickname, 'Linus');
    assert.equal(board[0].rankDelta, 0, 'everyone started level, so nobody moved');

    await playRound(['Ada', 'Grace']);
    board = table.snapshot().leaderboard;
    const linus = board.find((e) => e.nickname === 'Linus')!;
    assert.equal(linus.rank, 1, 'still tied at the top');
    assert.equal(
      board.find((e) => e.nickname === 'Ada')!.rankDelta,
      1,
      'Ada climbed from second to first',
    );
  });

  it('reports what each player gained in the last round only', async () => {
    await playRound(['Ada']);
    await playRound(['Grace']);

    const board = table.snapshot().leaderboard;
    assert.equal(board.find((e) => e.nickname === 'Grace')!.lastRoundPoints, pointsForClue(1));
    assert.equal(board.find((e) => e.nickname === 'Ada')!.lastRoundPoints, 0);
    assert.equal(board.find((e) => e.nickname === 'Ada')!.score, pointsForClue(1));
  });
});

describe('kicking a player', () => {
  it('removes them, closes their socket and tells the room', async () => {
    const linus = table.players.Linus;
    await table.host.say({ type: 'host', action: 'kick_player', playerId: linus.playerId });

    assert.equal(linus.socket.server.closedWith?.code, 4003);
    assert.equal(linus.socket.server.closedWith?.reason, 'removed_by_host');

    const snapshot = table.snapshot();
    assert.equal(snapshot.players.length, 2);
    assert.ok(!snapshot.players.some((p) => p.nickname === 'Linus'));
    assert.ok(!snapshot.leaderboard.some((e) => e.nickname === 'Linus'));
  });

  it('takes their answer out of the running round', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    const answer = answerFor(table.host);
    await table.players.Linus.socket.say({ type: 'submit_answer', option: answer });
    assert.equal(table.round()!.answeredCount, 1);

    await table.host.say({ type: 'host', action: 'kick_player', playerId: table.players.Linus.playerId });

    assert.equal(table.round()!.answeredCount, 0);
    assert.equal(table.round()!.playerCount, 2);
  });

  it('frees their nickname for someone else', async () => {
    await table.host.say({ type: 'host', action: 'kick_player', playerId: table.players.Ada.playerId });

    const { joinEvent } = await import('./support/client');
    const rejoined = await joinEvent(table.harness, table.eventCode, { nickname: 'Ada' });
    assert.equal(rejoined.status, 200);
    assert.notEqual(rejoined.body.playerId, table.players.Ada.playerId);
  });

  it('shrugs at an unknown or missing player id', async () => {
    const before = table.snapshot().players.length;
    await table.host.say({ type: 'host', action: 'kick_player', playerId: 'p_nobody' });
    await table.host.say({ type: 'host', action: 'kick_player' });
    assert.equal(table.snapshot().players.length, before);
  });
});

describe('resetting the event', () => {
  it('zeroes the scoreboard but keeps everyone in the room', async () => {
    await playRound(['Ada', 'Grace']);
    await table.host.say({ type: 'host', action: 'reset_event' });

    const snapshot = table.snapshot();
    assert.equal(snapshot.phase, 'lobby');
    assert.equal(snapshot.roundsPlayed, 0);
    assert.equal(snapshot.result, null);
    assert.equal(snapshot.round, null);
    assert.equal(snapshot.players.length, 3, 'a reset is not a kick');
    assert.ok(snapshot.leaderboard.every((e) => e.score === 0 && e.streak === 0));
    assert.ok(snapshot.leaderboard.every((e) => e.mysteriesPlayed === 0));
  });

  it('refills the mystery queue and disarms the clock', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.host.say({ type: 'host', action: 'reset_event' });

    const snapshot = table.snapshot();
    assert.equal(snapshot.mysteriesRemaining, snapshot.totalMysteries);
    assert.equal(table.harness.stateFor(table.eventCode).storage.alarm, null);

    const catalog = table.host.client.lastOfType('catalog')!.mysteries as { used: boolean }[];
    assert.ok(catalog.every((m) => !m.used), 'every mystery is selectable again');
  });

  it('wipes the archived results while keeping the players', async () => {
    await playRound(['Ada']);
    await table.settle();
    assert.ok(table.harness.db.answers.size > 0);
    assert.ok(table.harness.db.rounds.size > 0);

    await table.host.say({ type: 'host', action: 'reset_event' });
    await table.settle();

    assert.equal(table.harness.db.answers.size, 0);
    assert.equal(table.harness.db.rounds.size, 0);
    assert.equal(table.harness.db.players.size, 3, 'identities survive a reset');
    assert.ok([...table.harness.db.players.values()].every((p) => p.score === 0));
    assert.equal(table.harness.db.events.get(table.eventCode)!.phase, 'lobby');
  });
});

describe('ending the event', () => {
  it('moves everyone to the podium', async () => {
    await playRound(['Ada']);
    await table.host.say({ type: 'host', action: 'end_event' });

    assert.equal(table.snapshot().phase, 'finished');
    assert.equal(table.snapshot().leaderboard[0].nickname, 'Ada');
  });

  it('closes a live round first, so the last answer still counts', async () => {
    await table.host.say({ type: 'host', action: 'start_round' });
    await table.tickToAlarm();
    await table.players.Ada.socket.say({ type: 'submit_answer', option: answerFor(table.host) });

    await table.host.say({ type: 'host', action: 'end_event' });

    const snapshot = table.snapshot();
    assert.equal(snapshot.phase, 'finished');
    assert.equal(snapshot.roundsPlayed, 1);
    assert.equal(snapshot.leaderboard.find((e) => e.nickname === 'Ada')!.score, pointsForClue(1));
    assert.equal(table.harness.stateFor(table.eventCode).storage.alarm, null);
  });

  it('records the final phase in the registry', async () => {
    await table.host.say({ type: 'host', action: 'end_event' });
    await table.settle();
    assert.equal(table.harness.db.events.get(table.eventCode)!.phase, 'finished');
  });

  it('still admits a late arrival to the podium view', async () => {
    await playRound(['Ada']);
    await table.host.say({ type: 'host', action: 'end_event' });

    const projector = await connect(table.harness, table.eventCode, { role: 'display' });
    assert.equal(projector.status, 101);
    const snapshot = projector.socket!.client.lastOfType('snapshot')!.snapshot as { phase: string };
    assert.equal(snapshot.phase, 'finished');
  });
});
