/**
 * The socket itself: who is allowed on, what a socket is handed when it
 * arrives, and how the room behaves when a client misbehaves.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { createHarness, type Harness } from './support/env';
import { connect, createEvent, joinEvent, request } from './support/client';
import {
  lastErrorOn,
  releaseFakeClock,
  seatTable,
  useFakeClock,
  type Table,
} from './support/game';

describe('the upgrade handshake', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('lets a projector on with no credentials at all', async () => {
    const event = await createEvent(harness);
    const opened = await connect(harness, event.eventCode, { role: 'display' });

    assert.equal(opened.status, 101);
    assert.equal(opened.socket!.client.lastOfType('welcome')!.role, 'display');
    assert.equal(opened.socket!.client.lastOfType('welcome')!.self, null);
  });

  it('turns a host away without the host token', async () => {
    const event = await createEvent(harness);
    for (const hostToken of ['', 'wrong', 'f'.repeat(48)]) {
      const opened = await connect(harness, event.eventCode, { role: 'host', hostToken });
      assert.equal(opened.status, 403, `for ${JSON.stringify(hostToken)}`);
      assert.deepEqual(opened.body, { error: 'unauthorised' });
    }
  });

  it('turns a player away without a matching token', async () => {
    const event = await createEvent(harness);
    const joined = await joinEvent(harness, event.eventCode, { nickname: 'Ada' });

    const forged = await connect(harness, event.eventCode, {
      role: 'player',
      playerId: joined.body.playerId,
      playerToken: 'f'.repeat(48),
    });
    assert.equal(forged.status, 403);

    const ghost = await connect(harness, event.eventCode, {
      role: 'player',
      playerId: 'p_doesnotexist',
      playerToken: joined.body.playerToken,
    });
    assert.equal(ghost.status, 403, 'an unknown player id must not be distinguishable');
  });

  it('hands a player their own private slice on arrival', async () => {
    const event = await createEvent(harness);
    const joined = await joinEvent(harness, event.eventCode, { nickname: 'Ada' });
    const opened = await connect(harness, event.eventCode, {
      role: 'player',
      playerId: joined.body.playerId,
      playerToken: joined.body.playerToken,
    });

    const welcome = opened.socket!.client.lastOfType('welcome')!;
    assert.equal(welcome.role, 'player');
    assert.equal((welcome.self as { nickname: string }).nickname, 'Ada');
    assert.ok(opened.socket!.client.lastOfType('snapshot'), 'a snapshot follows the welcome');
    assert.equal(
      opened.socket!.client.lastOfType('catalog'),
      undefined,
      'the mystery catalog is host-only',
    );
  });

  it('404s a socket for an event that was never created', async () => {
    const opened = await connect(harness, 'ZZZZZ', { role: 'display' });
    assert.equal(opened.status, 404);
  });

  it('400s a socket with a code that cannot be one', async () => {
    const reply = await request(harness, 'GET', '/ws?code=zz');
    assert.equal(reply.status, 400);
    assert.equal((reply.body as { error: string }).error, 'bad_code');
  });

  it('426s a plain GET on the socket path', async () => {
    const event = await createEvent(harness);
    const reply = await request(harness, 'GET', `/ws?code=${event.eventCode}&role=display`);
    assert.equal(reply.status, 426);
    assert.equal((reply.body as { error: string }).error, 'expected_websocket');
  });
});

describe('message handling', () => {
  let table: Table;
  beforeEach(async () => {
    useFakeClock();
    table = await seatTable(['Ada']);
  });
  afterEach(() => releaseFakeClock());

  it('answers a ping with the client stamp echoed back', async () => {
    await table.players.Ada.socket.say({ type: 'ping', clientTime: 1234 });

    const pong = table.players.Ada.socket.client.lastOfType('pong')!;
    assert.equal(pong.clientTime, 1234);
    assert.equal(pong.serverTime, Date.now());
  });

  it('ignores a message that is not JSON', async () => {
    const socket = table.players.Ada.socket;
    const before = socket.client.received.length;
    await table.harness.roomFor(table.eventCode).webSocketMessage(socket.server as never, 'nonsense');
    assert.equal(socket.client.received.length, before);
  });

  it('ignores an unknown message type', async () => {
    const socket = table.players.Ada.socket;
    const before = socket.client.received.length;
    await socket.say({ type: 'definitely_not_a_thing' });
    assert.equal(socket.client.received.length, before);
  });

  it('drops an oversized frame without parsing it', async () => {
    const socket = table.players.Ada.socket;
    const before = socket.client.received.length;
    const huge = JSON.stringify({ type: 'ping', clientTime: 1, pad: 'x'.repeat(5000) });
    await table.harness.roomFor(table.eventCode).webSocketMessage(socket.server as never, huge);
    assert.equal(socket.client.received.length, before);
  });

  it('drops a binary frame', async () => {
    const socket = table.players.Ada.socket;
    const before = socket.client.received.length;
    await table.harness
      .roomFor(table.eventCode)
      .webSocketMessage(socket.server as never, new ArrayBuffer(8));
    assert.equal(socket.client.received.length, before);
  });

  it('rate limits a flood, and forgives it once the window rolls', async () => {
    const socket = table.players.Ada.socket;

    for (let i = 0; i < 25; i++) await socket.say({ type: 'ping', clientTime: i });
    assert.equal(socket.client.messagesOfType('pong').length, 25, '25 in the window is allowed');
    assert.equal(socket.client.messagesOfType('error').length, 0);

    await socket.say({ type: 'ping', clientTime: 26 });
    assert.equal(lastErrorOn(socket), 'rate_limited');
    assert.equal(socket.client.messagesOfType('pong').length, 25);

    table.advance(5_001);
    await socket.say({ type: 'ping', clientTime: 27 });
    assert.equal(socket.client.messagesOfType('pong').length, 26);
  });

  it('refuses a host action from a player socket', async () => {
    await table.players.Ada.socket.say({ type: 'host', action: 'start_round' });
    assert.equal(lastErrorOn(table.players.Ada.socket), 'forbidden');
    assert.equal(table.snapshot().phase, 'lobby', 'a player must not be able to start a round');
  });

  it('refuses a host action from a projector socket', async () => {
    await table.display.say({ type: 'host', action: 'end_event' });
    assert.equal(lastErrorOn(table.display), 'forbidden');
    assert.equal(table.snapshot().phase, 'lobby');
  });

  it('ignores a host action it does not recognise', async () => {
    await table.host.say({ type: 'host', action: 'self_destruct' });
    assert.equal(table.snapshot().phase, 'lobby');
    assert.equal(lastErrorOn(table.host), undefined);
  });
});

describe('presence', () => {
  let table: Table;
  beforeEach(async () => {
    useFakeClock();
    table = await seatTable(['Ada', 'Grace']);
  });
  afterEach(() => releaseFakeClock());

  it('shows everyone in the lobby as connected', async () => {
    const snapshot = table.snapshot();
    assert.deepEqual(
      snapshot.players.map((p) => p.nickname),
      ['Ada', 'Grace'],
      'the lobby lists players in join order',
    );
    assert.ok(snapshot.players.every((p) => p.connected));
  });

  it('marks a dropped player as disconnected without forgetting them', async () => {
    await table.players.Grace.socket.hangUp();

    const snapshot = table.snapshot();
    assert.equal(snapshot.players.length, 2, 'a drop is not a departure');
    assert.equal(snapshot.players.find((p) => p.nickname === 'Grace')!.connected, false);
    assert.equal(snapshot.leaderboard.find((e) => e.nickname === 'Grace')!.connected, false);
  });

  it('treats a socket error the same as a close', async () => {
    const socket = table.players.Grace.socket;
    socket.server.close(1006, 'abnormal');
    await table.harness.roomFor(table.eventCode).webSocketError(socket.server as never);

    assert.equal(table.snapshot().players.find((p) => p.nickname === 'Grace')!.connected, false);
  });

  it('flips a returning player back to connected', async () => {
    await table.players.Grace.socket.hangUp();
    const grace = table.players.Grace;

    await connect(table.harness, table.eventCode, {
      role: 'player',
      playerId: grace.playerId,
      playerToken: grace.playerToken,
    });

    assert.equal(table.snapshot().players.find((p) => p.nickname === 'Grace')!.connected, true);
  });
});
