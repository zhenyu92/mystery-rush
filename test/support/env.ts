/**
 * A miniature Cloudflare runtime: enough of `DurableObjectState`, the
 * namespace binding, the hibernatable-WebSocket API and the assets fetcher to
 * run the real Worker and the real EventRoom in-process.
 *
 * Nothing here reimplements game logic - the object under test is always the
 * shipped one.
 */

import { EventRoom } from '../../src/worker/event-room';
import type { Env } from '../../src/worker/db';
import { FakeD1 } from './d1';

// -------------------------------------------------------------- websockets

/** A socket pair whose two halves are wired to each other, as Workers does. */
export class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 1;
  peer: FakeWebSocket | null = null;
  /** Everything the server sent down this socket, parsed. */
  readonly received: Record<string, unknown>[] = [];
  closedWith: { code: number; reason: string } | null = null;

  private attachment: unknown = null;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.peer?.received.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    if (this.peer && this.peer.readyState === 1) this.peer.readyState = 3;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment === null ? null : structuredClone(this.attachment);
  }

  /** Messages of a given type that arrived on this socket. */
  messagesOfType(type: string): Record<string, unknown>[] {
    return this.received.filter((m) => m.type === type);
  }

  /** The most recent message of a given type, or undefined. */
  lastOfType(type: string): Record<string, unknown> | undefined {
    return this.messagesOfType(type).at(-1);
  }
}

/**
 * Workers' `Response` accepts `101` plus a `webSocket`; the WHATWG one Node
 * ships rejects any status below 200. Everything else defers to the native
 * class, so only the upgrade handshake takes this path.
 */
export interface UpgradeResponse {
  status: 101;
  webSocket: FakeWebSocket;
  headers: Headers;
  ok: false;
}

export function installWorkerGlobals(): void {
  const g = globalThis as Record<string, unknown>;

  g.WebSocketPair = function WebSocketPair() {
    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    client.peer = server;
    server.peer = client;
    return { 0: client, 1: server };
  };

  // EventRoom reads `WebSocket.OPEN`; Node's global WebSocket has it, but be
  // explicit so the tests do not depend on that.
  if (typeof g.WebSocket !== 'function') g.WebSocket = FakeWebSocket;

  const NativeResponse = g.Response as typeof Response;
  if ((NativeResponse as { patched?: boolean }).patched) return;

  function WorkerResponse(this: unknown, body?: BodyInit | null, init: ResponseInit = {}) {
    if (init.status === 101) {
      return {
        status: 101,
        webSocket: (init as { webSocket?: FakeWebSocket }).webSocket ?? null,
        headers: new Headers(init.headers),
        ok: false,
      };
    }
    return new NativeResponse(body, init);
  }

  WorkerResponse.prototype = NativeResponse.prototype;
  Object.setPrototypeOf(WorkerResponse, NativeResponse);
  (WorkerResponse as unknown as { patched: boolean }).patched = true;
  g.Response = WorkerResponse;
}

installWorkerGlobals();

// ------------------------------------------------------------ object state

class FakeStorage {
  private readonly map = new Map<string, unknown>();
  alarm: number | null = null;
  /** How many times an alarm has been scheduled, for timing assertions. */
  alarmsSet = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
    this.alarmsSet += 1;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
}

export class FakeDurableObjectState {
  readonly storage = new FakeStorage();
  readonly sockets: FakeWebSocket[] = [];
  /** Promises handed to waitUntil, so tests can await background writes. */
  readonly background: Promise<unknown>[] = [];

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  waitUntil(promise: Promise<unknown>): void {
    // Swallow rejections here the way the runtime does; db.ts logs its own.
    this.background.push(Promise.resolve(promise).catch(() => undefined));
  }

  acceptWebSocket(ws: FakeWebSocket): void {
    this.sockets.push(ws);
  }

  getWebSockets(): FakeWebSocket[] {
    return this.sockets.filter((ws) => ws.closedWith === null);
  }

  async settle(): Promise<void> {
    await Promise.all(this.background);
  }
}

// ------------------------------------------------------------- environment

/**
 * Scripted Workers AI. Real inference is never called from the unit suite -
 * it costs money, needs credentials and is not deterministic - so tests push
 * the exact response (or error) they want the model to give.
 */
export class FakeAi {
  /** Queued replies, consumed in order. A function may throw to simulate failure. */
  readonly queue: Array<unknown | (() => unknown)> = [];
  /** Every input the worker sent, for asserting on prompts and schemas. */
  readonly calls: Array<Record<string, unknown>> = [];

  /** Reply with an already-parsed object, as JSON-schema mode really does. */
  push(response: unknown): this {
    this.queue.push(response);
    return this;
  }

  /** Reply with a raw string, as plain text mode does. */
  pushRaw(text: string): this {
    this.queue.push({ __raw: text });
    return this;
  }

  pushError(message = 'model exploded'): this {
    this.queue.push(() => {
      throw new Error(message);
    });
    return this;
  }

  async run(model: string, input: Record<string, unknown>): Promise<{ response: unknown }> {
    this.calls.push({ model, ...input });
    if (this.queue.length === 0) throw new Error('FakeAi: no queued response');
    const next = this.queue.shift()!;
    if (typeof next === 'function') return (next as () => never)();
    if (next && typeof next === 'object' && '__raw' in (next as object)) {
      return { response: (next as { __raw: string }).__raw };
    }
    return { response: next };
  }
}

export interface Harness {
  env: Env;
  db: FakeD1;
  ai: FakeAi;
  /** Every room the worker has touched, keyed by event code. */
  rooms: Map<string, { room: EventRoom; state: FakeDurableObjectState }>;
  /** Requests the assets fetcher was asked for (everything non-API). */
  assetRequests: Request[];
  /** Wait for all D1 write-through work queued by every room. */
  settle(): Promise<void>;
  /** Reconstruct a room from its storage, as a Durable Object eviction would. */
  restart(eventCode: string): Promise<void>;
  roomFor(eventCode: string): EventRoom;
  stateFor(eventCode: string): FakeDurableObjectState;
}

export function createHarness(): Harness {
  const db = new FakeD1();
  const ai = new FakeAi();
  const rooms = new Map<string, { room: EventRoom; state: FakeDurableObjectState }>();
  const assetRequests: Request[] = [];

  const env = {
    DB: db,
    AI: ai,
    EVENT_ROOM: {
      idFromName(name: string) {
        return { name, toString: () => name };
      },
      get(id: { name: string }) {
        return {
          fetch(request: Request): Promise<Response> {
            let entry = rooms.get(id.name);
            if (!entry) {
              const state = new FakeDurableObjectState();
              entry = { room: new EventRoom(state as never, env as Env), state };
              rooms.set(id.name, entry);
            }
            return entry.room.fetch(request);
          },
        };
      },
    },
    ASSETS: {
      fetch(request: Request): Promise<Response> {
        assetRequests.push(request);
        return Promise.resolve(new Response('<!doctype html>', { status: 200 }));
      },
    },
  } as unknown as Env;

  const harness: Harness = {
    env,
    db,
    ai,
    rooms,
    assetRequests,
    async settle() {
      for (const { state } of rooms.values()) await state.settle();
    },
    async restart(eventCode) {
      const entry = rooms.get(eventCode);
      if (!entry) throw new Error(`no room for ${eventCode}`);
      const room = new EventRoom(entry.state as never, env);
      // The constructor restores state inside blockConcurrencyWhile; give it
      // a turn to finish before anyone looks at the rebuilt room.
      await Promise.resolve();
      rooms.set(eventCode, { room, state: entry.state });
    },
    roomFor(eventCode) {
      const entry = rooms.get(eventCode);
      if (!entry) throw new Error(`no room for ${eventCode}`);
      return entry.room;
    },
    stateFor(eventCode) {
      const entry = rooms.get(eventCode);
      if (!entry) throw new Error(`no room for ${eventCode}`);
      return entry.state;
    },
  };

  return harness;
}
