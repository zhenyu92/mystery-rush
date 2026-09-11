/**
 * Driving a whole event from the outside: create it, sit some players and a
 * host on sockets, and step the clue clock by firing the alarm the room
 * scheduled - the same thing the runtime does, only on demand.
 */

import { mock } from 'node:test';

import type { PublicRound, Snapshot } from '../../src/shared/types';
import { createHarness, type FakeWebSocket, type Harness } from './env';
import { connect, createEvent, joinEvent, type Socket } from './client';

export interface Table {
  harness: Harness;
  eventCode: string;
  hostToken: string;
  host: Socket;
  /** A projector socket; read-only, so useful for leak assertions. */
  display: Socket;
  players: Record<string, Player>;
  /** Everyone, in join order. */
  roster: Player[];
  /** Run the alarm the room has armed, after moving the clock onto it. */
  tickToAlarm(): Promise<void>;
  /** Advance the fake clock without firing anything. */
  advance(ms: number): void;
  snapshot(): Snapshot;
  round(): PublicRound | null;
  settle(): Promise<void>;
}

export interface Player {
  nickname: string;
  playerId: string;
  playerToken: string;
  socket: Socket;
}

/** Fixed so that every test starts from the same wall clock. */
export const T0 = 1_767_225_600_000;

export function useFakeClock(now = T0): void {
  mock.timers.enable({ apis: ['Date'], now });
}

export function releaseFakeClock(): void {
  mock.timers.reset();
  mock.restoreAll();
}

/**
 * db.ts logs every swallowed D1 failure, which is the behaviour under test in
 * the outage cases and pure noise in the test output. Mute it for those.
 */
export function muteLogs(): void {
  mock.method(console, 'error', () => {});
}

export async function seatTable(
  nicknames: string[] = ['Ada', 'Grace'],
  /** Anything else the event should be created with, e.g. `plannedRounds`. */
  options: Record<string, unknown> = {},
): Promise<Table> {
  const harness = createHarness();
  const event = await createEvent(harness, 'Test Event', options);

  const host = (await connect(harness, event.eventCode, {
    role: 'host',
    hostToken: event.hostToken,
  })).socket!;
  const display = (await connect(harness, event.eventCode, { role: 'display' })).socket!;

  const players: Record<string, Player> = {};
  const roster: Player[] = [];
  for (const nickname of nicknames) {
    const joined = await joinEvent(harness, event.eventCode, { nickname });
    const socket = (await connect(harness, event.eventCode, {
      role: 'player',
      playerId: joined.body.playerId,
      playerToken: joined.body.playerToken,
    })).socket!;
    const player: Player = {
      nickname,
      playerId: joined.body.playerId,
      playerToken: joined.body.playerToken,
      socket,
    };
    players[nickname] = player;
    roster.push(player);
  }

  const table: Table = {
    harness,
    eventCode: event.eventCode,
    hostToken: event.hostToken,
    host,
    display,
    players,
    roster,
    advance(ms) {
      mock.timers.tick(ms);
    },
    async tickToAlarm() {
      const state = harness.stateFor(event.eventCode);
      const at = state.storage.alarm;
      if (at === null) throw new Error('no alarm is armed');
      const delta = at - Date.now();
      if (delta > 0) mock.timers.tick(delta);
      await harness.roomFor(event.eventCode).alarm();
    },
    snapshot() {
      const last = display.client.lastOfType('snapshot');
      if (!last) throw new Error('the projector has not been sent a snapshot');
      return last.snapshot as Snapshot;
    },
    round() {
      return table.snapshot().round;
    },
    settle: () => harness.settle(),
  };

  return table;
}

/** The option the round is showing that is not the right answer. */
export function wrongOption(round: PublicRound, answer: string): string {
  const option = round.options.find((o) => o !== answer);
  if (!option) throw new Error('the round has only one option');
  return option;
}

/** The answer for the running round, read off the host's private brief. */
export function answerFor(host: Socket): string {
  const brief = host.client.lastOfType('host_brief');
  if (!brief) throw new Error('the host has no brief for a running round');
  return brief.answer as string;
}

export function errorsOn(socket: Socket): string[] {
  return socket.client.messagesOfType('error').map((m) => m.code as string);
}

export function lastErrorOn(socket: Socket): string | undefined {
  return errorsOn(socket).at(-1);
}

export function selfOn(socket: Socket): Record<string, unknown> | null {
  const last = socket.client.lastOfType('snapshot');
  return (last?.self ?? null) as Record<string, unknown> | null;
}

export type { FakeWebSocket };
