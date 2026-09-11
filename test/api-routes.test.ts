/**
 * The HTTP surface in `src/worker/index.ts`: routing, code normalisation,
 * event creation and the join proxy. The real EventRoom is on the other side
 * of every one of these, so these are end-to-end through the Worker.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { MYSTERIES } from '../src/worker/game';
import { EVENT_NAME_MAX, NICKNAME_MAX } from '../src/shared/types';
import { createHarness, type Harness } from './support/env';
import { createEvent, joinEvent, request } from './support/client';

const ZERO_WIDTH = '\u200b';
const NUL = '\u0000';

let harness: Harness;
beforeEach(() => {
  harness = createHarness();
});

describe('GET /api/mysteries', () => {
  it('reports the size of the question bank', async () => {
    const reply = await request<{ total: number; byType: Record<string, number> }>(
      harness,
      'GET',
      '/api/mysteries',
    );

    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, MYSTERIES.length);
    assert.ok(reply.body.total > 0, 'the bundled bank should not be empty');

    const summed = Object.values(reply.body.byType).reduce((a, b) => a + b, 0);
    assert.equal(summed, reply.body.total, 'byType must account for every mystery');
    for (const mystery of MYSTERIES) {
      assert.ok(reply.body.byType[mystery.type] >= 1, `missing type ${mystery.type}`);
    }
  });

  it('is served without caching, so a stale count never sticks', async () => {
    const reply = await request(harness, 'GET', '/api/mysteries');
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.match(reply.headers.get('content-type') ?? '', /application\/json/);
  });

  it('tolerates a trailing slash', async () => {
    const reply = await request(harness, 'GET', '/api/mysteries/');
    assert.equal(reply.status, 200);
  });

  it('does not answer a write', async () => {
    const reply = await request(harness, 'POST', '/api/mysteries', { body: {} });
    assert.equal(reply.status, 404);
  });
});

describe('POST /api/events', () => {
  it('mints a code, a name and a host token, and registers the event', async () => {
    const reply = await request<{ eventCode: string; eventName: string; hostToken: string }>(
      harness,
      'POST',
      '/api/events',
      { body: { eventName: 'Friday Social' } },
    );

    assert.equal(reply.status, 201);
    assert.match(reply.body.eventCode, /^[A-Z0-9]{4,8}$/);
    assert.equal(reply.body.eventName, 'Friday Social');
    assert.match(reply.body.hostToken, /^[0-9a-f]{48}$/);

    await harness.settle();
    const row = harness.db.events.get(reply.body.eventCode);
    assert.ok(row, 'the event should be written through to D1');
    assert.equal(row.event_name, 'Friday Social');
    assert.equal(row.phase, 'lobby');
    assert.notEqual(row.host_token_hash, reply.body.hostToken, 'the raw token must not be stored');
    assert.match(row.host_token_hash, /^[0-9a-f]{64}$/);
  });

  it('falls back to a default name when none is usable', async () => {
    for (const eventName of [undefined, '', '   ', 42, null, ZERO_WIDTH + ZERO_WIDTH]) {
      const reply = await request<{ eventName: string }>(harness, 'POST', '/api/events', {
        body: { eventName },
      });
      assert.equal(reply.status, 201);
      assert.equal(reply.body.eventName, 'Mystery Rush Night', `for ${JSON.stringify(eventName)}`);
    }
  });

  it('truncates an overlong event name', async () => {
    const reply = await request<{ eventName: string }>(harness, 'POST', '/api/events', {
      body: { eventName: 'x'.repeat(EVENT_NAME_MAX + 30) },
    });
    assert.equal(reply.body.eventName.length, EVENT_NAME_MAX);
  });

  it('survives a body that is not JSON at all', async () => {
    const reply = await request<{ eventName: string }>(harness, 'POST', '/api/events', {
      body: 'not json {',
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.eventName, 'Mystery Rush Night');
  });

  it('hands out a distinct code each time', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 25; i++) codes.add((await createEvent(harness)).eventCode);
    assert.equal(codes.size, 25, 'allocateCode must not reissue a live code');
  });

  it('creates the event even when the registry is down', async () => {
    harness.db.failing = true;
    const reply = await request<{ eventCode: string }>(harness, 'POST', '/api/events', { body: {} });
    assert.equal(reply.status, 201, 'a D1 outage must not block a host from starting');
  });
});

describe('GET /api/events/:code', () => {
  it('describes an event that exists', async () => {
    const event = await createEvent(harness, 'Quarterly Offsite');
    const reply = await request<{ exists: boolean; eventName: string }>(
      harness,
      'GET',
      `/api/events/${event.eventCode}`,
    );

    assert.equal(reply.status, 200);
    assert.equal(reply.body.exists, true);
    assert.equal(reply.body.eventName, 'Quarterly Offsite');
  });

  it('accepts a lowercase or padded code', async () => {
    const event = await createEvent(harness);
    for (const variant of [event.eventCode.toLowerCase(), ` ${event.eventCode} `]) {
      const reply = await request<{ exists: boolean }>(
        harness,
        'GET',
        `/api/events/${encodeURIComponent(variant)}`,
      );
      assert.equal(reply.status, 200, `for ${JSON.stringify(variant)}`);
      assert.equal(reply.body.exists, true);
    }
  });

  it('404s a well-formed code with no event behind it', async () => {
    const reply = await request<{ exists: boolean }>(harness, 'GET', '/api/events/ZZZZZ');
    assert.equal(reply.status, 404);
    assert.equal(reply.body.exists, false);
  });

  it('400s a code that cannot be one', async () => {
    for (const bad of ['ab', 'toolongcode9', 'AB!DE']) {
      const reply = await request<{ error: string }>(
        harness,
        'GET',
        `/api/events/${encodeURIComponent(bad)}`,
      );
      assert.equal(reply.status, 400, `for ${bad}`);
      assert.equal(reply.body.error, 'bad_code');
    }
  });

  it('rejects an unsupported method on the event resource', async () => {
    const event = await createEvent(harness);
    const reply = await request<{ error: string }>(harness, 'DELETE', `/api/events/${event.eventCode}`);
    assert.equal(reply.status, 405);
    assert.equal(reply.body.error, 'method_not_allowed');
  });

  it('still answers when the registry is down', async () => {
    const event = await createEvent(harness);
    harness.db.failing = true;
    const reply = await request<{ exists: boolean }>(harness, 'GET', `/api/events/${event.eventCode}`);
    assert.equal(reply.status, 200, 'eventExists fails open, and the room confirms');
    assert.equal(reply.body.exists, true);
  });

  it('404s an unknown code even when the registry is down', async () => {
    harness.db.failing = true;
    const reply = await request(harness, 'GET', '/api/events/ZZZZZ');
    assert.equal(reply.status, 404, 'the room is the backstop for a fail-open registry');
  });
});

describe('POST /api/events/:code/join', () => {
  it('admits a player and archives them', async () => {
    const event = await createEvent(harness);
    const reply = await joinEvent(harness, event.eventCode, { nickname: 'Ada' });

    assert.equal(reply.status, 200);
    assert.match(reply.body.playerId, /^p_[0-9a-f]{16}$/);
    assert.match(reply.body.playerToken, /^[0-9a-f]{48}$/);
    assert.equal(reply.body.nickname, 'Ada');
    assert.equal(reply.body.eventCode, event.eventCode);
    assert.equal(reply.body.resumed, false);

    const row = harness.db.players.get(reply.body.playerId);
    assert.ok(row);
    assert.equal(row.nickname, 'Ada');
    assert.equal(row.score, 0);
  });

  it('resumes a returning player instead of duplicating them', async () => {
    const event = await createEvent(harness);
    const first = await joinEvent(harness, event.eventCode, { nickname: 'Ada' });

    const again = await joinEvent(harness, event.eventCode, {
      playerId: first.body.playerId,
      playerToken: first.body.playerToken,
    });

    assert.equal(again.status, 200);
    assert.equal(again.body.resumed, true);
    assert.equal(again.body.playerId, first.body.playerId);
    assert.equal(again.body.nickname, 'Ada');
    assert.equal(harness.db.players.size, 1);
  });

  it('ignores a resume attempt with the wrong token', async () => {
    const event = await createEvent(harness);
    const first = await joinEvent(harness, event.eventCode, { nickname: 'Ada' });

    const forged = await joinEvent(harness, event.eventCode, {
      playerId: first.body.playerId,
      playerToken: 'f'.repeat(48),
      nickname: 'Grace',
    });

    assert.equal(forged.status, 200);
    assert.equal(forged.body.resumed, false, 'a bad token must never resume someone else');
    assert.notEqual(forged.body.playerId, first.body.playerId);
  });

  it('rejects a duplicate nickname regardless of case', async () => {
    const event = await createEvent(harness);
    await joinEvent(harness, event.eventCode, { nickname: 'Ada' });

    const clash = await joinEvent(harness, event.eventCode, { nickname: '  aDa ' });
    assert.equal(clash.status, 409);
    assert.equal((clash.body as unknown as { error: string }).error, 'nickname_taken');
  });

  it('rejects an unusable nickname', async () => {
    const event = await createEvent(harness);
    for (const nickname of [undefined, '', '   ', 7, NUL + ZERO_WIDTH]) {
      const reply = await joinEvent(harness, event.eventCode, { nickname });
      assert.equal(reply.status, 400, `for ${JSON.stringify(nickname)}`);
      assert.equal((reply.body as unknown as { error: string }).error, 'bad_nickname');
    }
  });

  it('trims a nickname to the advertised maximum', async () => {
    const event = await createEvent(harness);
    const reply = await joinEvent(harness, event.eventCode, { nickname: 'N'.repeat(NICKNAME_MAX + 10) });
    assert.equal(reply.body.nickname.length, NICKNAME_MAX);
  });

  it('does not let a truncated nickname collide invisibly with a shorter one', async () => {
    const event = await createEvent(harness);
    // Truncated at NICKNAME_MAX this is 'abcdefghijklmnopq', with the space
    // the cut landed on. If the space survived, the two would be different
    // strings that look identical side by side on the leaderboard.
    const first = await joinEvent(harness, event.eventCode, { nickname: 'abcdefghijklmnopq rs' });
    assert.equal(first.body.nickname, 'abcdefghijklmnopq');

    const clash = await joinEvent(harness, event.eventCode, { nickname: 'abcdefghijklmnopq' });
    assert.equal(clash.status, 409);
    assert.equal((clash.body as unknown as { error: string }).error, 'nickname_taken');
  });

  it('404s a join against an event that does not exist', async () => {
    const reply = await joinEvent(harness, 'ZZZZZ', { nickname: 'Ada' });
    assert.equal(reply.status, 404);
  });

  it('400s a malformed code', async () => {
    const reply = await request(harness, 'POST', '/api/events/no/join', { body: { nickname: 'Ada' } });
    assert.equal(reply.status, 400);
  });

  it('rejects a GET on the join endpoint', async () => {
    const event = await createEvent(harness);
    const reply = await request<{ error: string }>(harness, 'GET', `/api/events/${event.eventCode}/join`);
    assert.equal(reply.status, 405);
  });

  it('answers with JSON even when the room refuses', async () => {
    const event = await createEvent(harness);
    await joinEvent(harness, event.eventCode, { nickname: 'Ada' });
    const clash = await joinEvent(harness, event.eventCode, { nickname: 'Ada' });
    assert.match(clash.raw.headers.get('content-type') ?? '', /application\/json/);
  });
});

describe('routing', () => {
  it('sends anything that is not an API call to the asset server', async () => {
    const reply = await request(harness, 'GET', '/host/ABCDE');
    assert.equal(reply.status, 200);
    assert.equal(harness.assetRequests.length, 1);
    assert.match(harness.assetRequests[0].url, /\/host\/ABCDE$/);
  });

  it('404s an unknown API path rather than serving the app shell', async () => {
    const reply = await request<{ error: string }>(harness, 'GET', '/api/nope');
    assert.equal(reply.status, 404);
    assert.equal(reply.body.error, 'not_found');
    assert.equal(harness.assetRequests.length, 0);
  });
});
