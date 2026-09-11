/**
 * Calling conventions for the Worker under test: build a real Request, run
 * the real `fetch` handler, and hand back the status plus the parsed body.
 */

import worker from '../../src/worker/index';
import type { Harness } from './env';

export interface Reply<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
  raw: Response;
}

const ORIGIN = 'https://play.mystery-rush.workers.dev';

export async function request<T = Record<string, unknown>>(
  harness: Harness,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply<T>> {
  const req = new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body),
  });
  const raw = await worker.fetch(req, harness.env);
  const text = await raw.clone().text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { status: raw.status, headers: raw.headers, body, raw };
}

export interface CreatedEvent {
  eventCode: string;
  eventName: string;
  hostToken: string;
}

export async function createEvent(
  harness: Harness,
  eventName?: string,
  extra: Record<string, unknown> = {},
): Promise<CreatedEvent> {
  const reply = await request<CreatedEvent>(harness, 'POST', '/api/events', {
    body: eventName === undefined ? { ...extra } : { eventName, ...extra },
  });
  if (reply.status !== 201) throw new Error(`create failed: ${reply.status}`);
  await harness.settle();
  return reply.body;
}

export interface JoinedPlayer {
  playerId: string;
  playerToken: string;
  nickname: string;
  eventCode: string;
  eventName: string;
  resumed: boolean;
}

export async function joinEvent(
  harness: Harness,
  eventCode: string,
  body: Record<string, unknown>,
): Promise<Reply<JoinedPlayer>> {
  const reply = await request<JoinedPlayer>(harness, 'POST', `/api/events/${eventCode}/join`, { body });
  await harness.settle();
  return reply;
}

// -------------------------------------------------------------- websockets

import type { FakeWebSocket } from './env';

export interface Socket {
  /** The half the Durable Object holds; drive it to act as the client. */
  server: FakeWebSocket;
  /** The half the browser would hold; read `received` off it. */
  client: FakeWebSocket;
  /** Deliver a message as if the browser sent it. */
  say(message: unknown): Promise<void>;
  /** Close from the client side and let the room react. */
  hangUp(): Promise<void>;
}

/**
 * Open a socket through the real `/ws` route. Workers hands the client half
 * back on the Response, which Node's Response cannot carry, so the pair is
 * recovered from the room that accepted it.
 */
export async function connect(
  harness: Harness,
  eventCode: string,
  params: Record<string, string>,
): Promise<{ status: number; socket: Socket | null; body: unknown }> {
  const query = new URLSearchParams({ code: eventCode, ...params });
  const raw = await worker.fetch(
    new Request(`${ORIGIN}/ws?${query}`, { headers: { Upgrade: 'websocket' } }),
    harness.env,
  );

  if (raw.status !== 101) {
    return { status: raw.status, socket: null, body: await raw.json().catch(() => null) };
  }

  const client = (raw as unknown as { webSocket: FakeWebSocket }).webSocket;
  const server = client.peer!;

  return {
    status: raw.status,
    body: null,
    socket: {
      server,
      client,
      // Looked up per call, so a socket keeps working across an eviction.
      async say(message: unknown) {
        await harness.roomFor(eventCode).webSocketMessage(server as never, JSON.stringify(message));
      },
      async hangUp() {
        server.close(1000, 'client went away');
        await harness.roomFor(eventCode).webSocketClose(server as never);
      },
    },
  };
}
