/**
 * Worker entry point.
 *
 * Thin on purpose: it resolves an event code to its Durable Object and gets
 * out of the way. All game rules live in EventRoom. Anything that is not
 * /api/* or /ws is served from the built React app.
 */

import { EVENT_NAME_MAX, MAX_POOL_SIZE, isDifficulty, isMysteryType } from '../shared/types';
import { eventExists } from './db';
import type { Env } from './db';
import { MYSTERIES, generateEventCode, newToken, sanitizeText } from './game';
import { buildMysteryPool } from './mystery-pool';

export { EventRoom } from './event-room';

const CODE_PATTERN = /^[A-Z0-9]{4,8}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/ws') return await handleSocket(request, env, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
    } catch (err) {
      console.error('[worker] unhandled error:', err);
      return json({ error: 'internal_error', message: 'Something went wrong.' }, 500);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function room(env: Env, eventCode: string): DurableObjectStub {
  // idFromName keeps one room per code, so every player typing the same code
  // lands on the same authoritative object.
  return env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName(eventCode));
}

function normaliseCode(raw: string | null): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/**
 * Percent-decode a path segment. A malformed escape (`%zz`, a truncated
 * multi-byte sequence) makes `decodeURIComponent` throw, and a code that
 * cannot be decoded is simply not a code - so it is a 400 like any other bad
 * one, not an unhandled error.
 */
function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function handleSocket(request: Request, env: Env, url: URL): Promise<Response> {
  const code = normaliseCode(url.searchParams.get('code'));
  if (!code) return json({ error: 'bad_code' }, 400);

  const target = new URL('https://room/ws');
  target.search = url.search;
  return room(env, code).fetch(new Request(target, request));
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '');

  // GET /api/mysteries - how big the question bank is, for the landing page.
  if (path === '/api/mysteries' && request.method === 'GET') {
    const byType: Record<string, number> = {};
    for (const m of MYSTERIES) byType[m.type] = (byType[m.type] ?? 0) + 1;
    return json({ total: MYSTERIES.length, byType });
  }

  // POST /api/events - create an event and mint the host credential.
  if (path === '/api/events' && request.method === 'POST') {
    const body = await readJson<{
      eventName?: string;
      plannedRounds?: number;
      autoAdvance?: boolean;
    }>(request);
    const eventName = sanitizeText(body?.eventName, EVENT_NAME_MAX, 'Mystery Rush Night');
    // How many mysteries the host intends to run. Lets the room be told which
    // one is the last, and auto-arms it for double points.
    const plannedRounds =
      typeof body?.plannedRounds === 'number' && body.plannedRounds > 0
        ? Math.min(Math.floor(body.plannedRounds), MYSTERIES.length)
        : null;
    const hostToken = newToken();

    const code = await allocateCode(env);
    const res = await room(env, code).fetch(
      new Request('https://room/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventCode: code,
          eventName,
          hostToken,
          plannedRounds,
          autoAdvance: body?.autoAdvance,
        }),
      }),
    );
    if (!res.ok) return json({ error: 'init_failed', message: 'Could not create the event.' }, 500);

    return json({ eventCode: code, eventName, hostToken, plannedRounds }, 201);
  }

  const match = path.match(/^\/api\/events\/([^/]+)(\/join|\/mysteries|\/mysteries\/generate)?$/);
  if (match) {
    const code = normaliseCode(decodePathSegment(match[1]));
    if (!code) return json({ error: 'bad_code', message: 'That code does not look right.' }, 400);

    // GET /api/events/:code - does this event exist, and what is it called?
    if (!match[2] && request.method === 'GET') {
      if (!(await eventExists(env.DB, code))) {
        return json({ exists: false, message: 'No event with that code.' }, 404);
      }
      const res = await room(env, code).fetch(new Request('https://room/exists'));
      const info = (await res.json()) as { exists: boolean; eventName: string | null };
      return info.exists ? json(info) : json({ exists: false, message: 'No event with that code.' }, 404);
    }

    // POST /api/events/:code/mysteries/generate - the AI prep workflow.
    //
    // The model call happens here in the Worker, never inside the Durable
    // Object: generation takes tens of seconds, and the object is
    // single-threaded, so doing it there would stall a live round.
    if (match[2] === '/mysteries/generate' && request.method === 'POST') {
      return handleGenerate(request, env, code);
    }

    // POST /api/events/:code/mysteries - host approves one into the event.
    if (match[2] === '/mysteries' && request.method === 'POST') {
      const body = await readJson<Record<string, unknown>>(request);
      const res = await room(env, code).fetch(
        new Request('https://room/library', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }),
      );
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // POST /api/events/:code/join
    if (match[2] === '/join' && request.method === 'POST') {
      const body = await readJson<Record<string, unknown>>(request);
      const res = await room(env, code).fetch(
        new Request('https://room/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }),
      );
      // Keep the room's status and payload; it owns nickname and capacity rules.
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    return json({ error: 'method_not_allowed' }, 405);
  }

  return json({ error: 'not_found' }, 404);
}

/**
 * Generate a pool of candidate mysteries for a host to review.
 *
 * Nothing this returns is playable yet - the host approves each one
 * separately. An AI outage is reported and nothing else changes, so the
 * built-in bank and any running game carry on untouched.
 */
async function handleGenerate(request: Request, env: Env, code: string): Promise<Response> {
  const body = await readJson<{
    hostToken?: string;
    categories?: unknown;
    difficulty?: unknown;
    count?: unknown;
  }>(request);

  // Authorise before spending a model call on someone's behalf.
  const verify = await room(env, code).fetch(
    new Request('https://room/verify-host', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostToken: body?.hostToken ?? '' }),
    }),
  );
  if (!verify.ok) {
    return json({ error: 'unauthorised', message: 'Host credentials required.' }, 403);
  }
  const { existingAnswers } = (await verify.json()) as { existingAnswers?: string[] };

  const categories = Array.isArray(body?.categories)
    ? body.categories.filter((c): c is string => typeof c === 'string' && isMysteryType(c))
    : [];
  if (categories.length === 0) {
    return json({ error: 'no_categories', message: 'Pick at least one category.' }, 400);
  }

  const difficulty = isDifficulty(body?.difficulty) ? body.difficulty : 'medium';
  const requested = Number(body?.count);
  const count = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_POOL_SIZE, Math.floor(requested)))
    : 1;

  try {
    const pool = await buildMysteryPool(env, {
      categories,
      difficulty,
      count,
      existingAnswers,
    });
    return json(pool);
  } catch (err) {
    console.error('[ai] generation failed:', err);
    return json(
      {
        candidates: [],
        rejected: [],
        error: 'AI generation is temporarily unavailable.',
        attempts: 0,
      },
      503,
    );
  }
}

/**
 * Pick a code that is not already taken. With ~9.7M possible codes a
 * collision is unlikely; if the registry cannot answer we hand back a fresh
 * code anyway and let the room's own "already initialised" check catch the
 * one-in-a-million case.
 */
async function allocateCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateEventCode();
    if (!(await eventExists(env.DB, code))) return code;
  }
  return generateEventCode();
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
