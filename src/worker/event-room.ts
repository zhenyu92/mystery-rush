/**
 * EventRoom - one Durable Object per event code, and the single authority for
 * everything that decides a score.
 *
 * The client is told what to draw and nothing more. In particular the object
 * owns:
 *   - the clock. Clue progression runs off Durable Object alarms, never off a
 *     browser timer, so every phone in the room flips to clue 3 together and
 *     a player who freezes their tab gains nothing.
 *   - the answer. Unrevealed clues and the correct answer are simply absent
 *     from the snapshots sent during a live round.
 *   - the scoring. Points come from the clue number the *server* had active
 *     when the submission arrived, and a player gets exactly one submission.
 *
 * Scores earned in a round are held back until the round ends, so a player
 * cannot infer correctness early by watching their own XP tick up.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  CLUE_COUNT,
  CLUE_DURATION_MS,
  DOUBLE_MULTIPLIER,
  EVENT_NAME_MAX,
  INTRO_DURATION_MS,
  isDifficulty,
  LEADERBOARD_AUTO_MS,
  MAX_RESPONSE_MS,
  POOL_DEADLINE_MS,
  RESULTS_AUTO_MS,
  RESPONSE_BUCKET_MS,
  streakBonus,
  NICKNAME_MAX,
  pointsForClue,
  type ClientMessage,
  type Difficulty,
  type EventPhase,
  type LeaderboardEntry,
  type LobbyPlayer,
  type Mystery,
  type MysteryChoice,
  type PlayerRoundResult,
  type PlayerSelf,
  type PublicRound,
  type RoundResult,
  type RoundStatus,
  type AutoAdvance,
  type AutoAdvanceTarget,
  type ServerMessage,
  type Snapshot,
} from '../shared/types';
import {
  MYSTERIES,
  buildOptions,
  getMystery,
  hashToken,
  isCorrectAnswer,
  newToken,
  randomId,
  safeEqual,
  sanitizeNickname,
  sanitizeText,
  shuffle,
} from './game';
import {
  createEventRow,
  recordRoundEnd,
  recordRoundStart,
  resetEventRows,
  setEventPhase,
  upsertPlayer,
  type ArchivedAnswer,
  type ArchivedPlayer,
  type Env,
} from './db';

interface EventMeta {
  eventCode: string;
  eventName: string;
  hostTokenHash: string;
  createdAt: number;
  phase: EventPhase;
  roundsPlayed: number;
  /** Categories and difficulty the host chose when creating the event. */
  poolCategories: string[];
  poolDifficulty: Difficulty;
  /** Why the last pool preparation failed, if it did. */
  poolError: string | null;
  /** When the first preparation request arrived, for the deadline. */
  poolStartedAt: number | null;
  /** Whether the event advances between phases on its own. */
  autoAdvanceEnabled: boolean;
  /** How many mysteries the host intends to run, if they said so up front. */
  plannedRounds: number | null;
}

interface PlayerRecord {
  id: string;
  nickname: string;
  tokenHash: string;
  score: number;
  correctAnswers: number;
  mysteriesPlayed: number;
  streak: number;
  bestStreak: number;
  lastRoundPoints: number;
  /** Cumulative tiebreak time. See MAX_RESPONSE_MS. */
  totalResponseMs: number;
  joinedAt: number;
}

interface AnswerRecord {
  selectedOption: string;
  submittedAt: number;
  clueNumber: number;
  isCorrect: boolean;
  pointsAwarded: number;
  /**
   * Time from the start of clue 1 to this submission, on a virtual clock.
   * Computed at submission because `clueStartedAt` moves with every clue -
   * by the time the round ends, the reference point for a clue-1 answer is
   * long gone.
   */
  responseMs: number;
}

interface RoundRecord {
  roundId: string;
  mysteryId: string;
  roundIndex: number;
  status: RoundStatus;
  /**
   * When the round began, i.e. the start of the intro. Fixed for the life of
   * the round, unlike `clueStartedAt`, which moves with every clue.
   */
  startedAt: number;
  /** Committed when the round starts, so arming later cannot change it. */
  pointsMultiplier: number;
  currentClue: number;
  clueStartedAt: number;
  clueEndsAt: number;
  /**
   * Length of the window currently running: the intro is shorter than a clue.
   * Kept on the record so pause/resume restores the right proportion.
   */
  windowMs: number;
  /** Set only while paused: the clock is frozen with this much left. */
  pausedRemainingMs: number | null;
  /** What the round goes back to when un-paused. */
  statusBeforePause: 'intro' | 'active' | null;
  options: string[];
  answers: Record<string, AnswerRecord>;
}

/**
 * What the single Durable Object alarm is currently for.
 *
 * The alarm used to infer its own meaning from `this.round`, which is exactly
 * why a second use of it would have clobbered clue progression. One record,
 * one alarm, last write wins, and the handler never has to guess.
 */
interface Scheduled {
  kind: 'clue' | 'advance';
  at: number;
  /** Only for `advance`. */
  to?: AutoAdvanceTarget;
}

type Role = 'player' | 'host' | 'display';

interface SocketMeta {
  role: Role;
  playerId?: string;
}

/** Crude per-socket flood guard: max messages inside a rolling window. */
const RATE_LIMIT_MAX = 25;
const RATE_LIMIT_WINDOW_MS = 5_000;

export class EventRoom extends DurableObject<Env> {
  private meta: EventMeta | null = null;
  private players: Record<string, PlayerRecord> = {};
  private round: RoundRecord | null = null;
  private lastResult: RoundResult | null = null;
  private queue: string[] = [];
  /** Ranks going into the current round, used for the leaderboard arrows. */
  private previousRanks: Record<string, number> = {};
  private scheduled: Scheduled | null = null;
  /**
   * Mysteries the host generated and approved for this event, keyed by id.
   * Held here rather than in D1 because the round loop resolves a mystery
   * synchronously on the hot path; this is already persisted and survives
   * hibernation, so an approved mystery cannot vanish mid-round.
   */
  private library: Record<string, Mystery> = {};

  private readonly rate = new WeakMap<WebSocket, { count: number; windowStart: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<{
        meta: EventMeta;
        players: Record<string, PlayerRecord>;
        round: RoundRecord | null;
        lastResult: RoundResult | null;
        queue: string[];
        previousRanks: Record<string, number>;
        scheduled: Scheduled | null;
        library: Record<string, Mystery>;
      }>('state');
      if (stored) {
        this.meta = {
          ...stored.meta,
          poolCategories: stored.meta.poolCategories ?? [],
          poolDifficulty: stored.meta.poolDifficulty ?? 'medium',
          poolError: stored.meta.poolError ?? null,
          poolStartedAt: stored.meta.poolStartedAt ?? null,
          autoAdvanceEnabled: stored.meta.autoAdvanceEnabled ?? true,
          plannedRounds: stored.meta.plannedRounds ?? null,
        };
        // A room restored from a blob written before these fields existed has
        // `undefined` for them, and `undefined + n` is NaN, which would poison
        // the comparator silently. Default everything on the way in.
        this.players = Object.fromEntries(
          Object.entries(stored.players ?? {}).map(([id, p]) => [
            id,
            { ...p, totalResponseMs: p.totalResponseMs ?? 0, bestStreak: p.bestStreak ?? 0 },
          ]),
        );
        this.round = stored.round ?? null;
        this.lastResult = stored.lastResult ?? null;
        this.queue = stored.queue ?? [];
        this.previousRanks = stored.previousRanks ?? {};
        this.scheduled = stored.scheduled ?? null;
        this.library = stored.library ?? {};
      }
    });
  }

  /**
   * A mystery by id, approved-for-this-event first, then the built-in bank.
   * Every round-time lookup goes through here so an AI mystery behaves
   * exactly like a hand-written one once the host has approved it.
   */
  private resolveMystery(id: string): Mystery | undefined {
    return this.library[id] ?? getMystery(id);
  }

  /** Built-in bank plus whatever this host approved. */
  private allMysteries(): Mystery[] {
    return [...MYSTERIES, ...Object.values(this.library)];
  }

  private async persist(): Promise<void> {
    if (!this.meta) return;
    await this.ctx.storage.put('state', {
      meta: this.meta,
      players: this.players,
      round: this.round,
      lastResult: this.lastResult,
      queue: this.queue,
      previousRanks: this.previousRanks,
      scheduled: this.scheduled,
      library: this.library,
    });
  }

  /**
   * Arm the object's single alarm, recording what it is for.
   *
   * Persist before arming, deliberately. A crash between the two leaves an
   * alarm with no record, which the handler no-ops on and the host clicks
   * past - today's behaviour. The reverse leaves a record with no alarm, i.e.
   * a countdown on the projector that reaches zero and does nothing.
   */
  private async schedule(s: Scheduled): Promise<void> {
    this.scheduled = s;
    await this.persist();
    await this.ctx.storage.setAlarm(s.at);
  }

  private async cancelSchedule(): Promise<void> {
    this.scheduled = null;
    await this.persist();
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * True once the room has played everything the host said it would.
   *
   * A host who named a number was making a promise to the room, so the room
   * keeps it: no sixth mystery in a five-mystery night. A host who did not
   * name one is running an open-ended night and this is never true.
   */
  private planComplete(): boolean {
    if (!this.meta || this.meta.plannedRounds === null) return false;
    return this.meta.roundsPlayed >= this.meta.plannedRounds;
  }

  /** What should follow the standings: another mystery, or the podium. */
  private afterLeaderboard(): AutoAdvanceTarget {
    return this.planComplete() ? 'finished' : 'round';
  }

  /** Queue the next phase hop, unless the host has switched that off. */
  private async scheduleAdvance(to: AutoAdvanceTarget, durationMs: number): Promise<void> {
    if (!this.meta?.autoAdvanceEnabled) {
      await this.cancelSchedule();
      return;
    }
    await this.schedule({ kind: 'advance', at: Date.now() + durationMs, to });
  }

  // ---------------------------------------------------------------- routing

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/init':
        return this.handleInit(request);
      case '/exists':
        return json({ exists: this.meta !== null, eventName: this.meta?.eventName ?? null });
      case '/join':
        return this.handleJoin(request);
      case '/verify-host':
        return this.handleVerifyHost(request);
      case '/library':
        return this.handleLibraryAdd(request);
      case '/pool-begin':
        return this.handlePoolBegin(request);
      case '/ws':
        return this.handleWebSocketUpgrade(request, url);
      default:
        return json({ error: 'not_found' }, 404);
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      eventCode?: string;
      eventName?: string;
      hostToken?: string;
      plannedRounds?: number;
      categories?: unknown;
      difficulty?: unknown;
      /** Tests turn this off so they can drive the phases themselves. */
      autoAdvance?: boolean;
    };
    if (this.meta) return json({ error: 'already_initialised' }, 409);
    if (!body.eventCode || !body.hostToken) return json({ error: 'bad_request' }, 400);

    this.meta = {
      eventCode: body.eventCode,
      eventName: sanitizeText(body.eventName, EVENT_NAME_MAX, 'Mystery Rush Night'),
      hostTokenHash: await hashToken(body.hostToken),
      createdAt: Date.now(),
      phase: 'lobby',
      roundsPlayed: 0,
      poolCategories: Array.isArray(body.categories)
        ? body.categories.filter((c): c is string => typeof c === 'string')
        : [],
      poolDifficulty: isDifficulty(body.difficulty) ? body.difficulty : 'medium',
      poolError: null,
      poolStartedAt: null,
      autoAdvanceEnabled: body.autoAdvance !== false,
      plannedRounds:
        typeof body.plannedRounds === 'number' && body.plannedRounds > 0
          ? Math.min(Math.floor(body.plannedRounds), MYSTERIES.length)
          : null,
    };
    this.queue = shuffle(this.allMysteries().map((m) => m.id));
    await this.persist();

    this.ctx.waitUntil(
      createEventRow(this.env.DB, {
        eventCode: this.meta.eventCode,
        eventName: this.meta.eventName,
        hostTokenHash: this.meta.hostTokenHash,
        createdAt: this.meta.createdAt,
      }),
    );

    return json({ ok: true, eventCode: this.meta.eventCode, eventName: this.meta.eventName });
  }

  /**
   * Join or re-join. Presenting a valid playerId + token resumes the existing
   * player (so a dropped phone keeps its score); otherwise a new player is
   * created. Nicknames are unique per event so the leaderboard is readable.
   */
  private async handleJoin(request: Request): Promise<Response> {
    if (!this.meta) return json({ error: 'no_such_event' }, 404);

    const body = (await request.json()) as {
      nickname?: string;
      playerId?: string;
      playerToken?: string;
    };

    if (body.playerId && body.playerToken) {
      const existing = this.players[body.playerId];
      if (existing && safeEqual(existing.tokenHash, await hashToken(body.playerToken))) {
        return json({
          playerId: existing.id,
          playerToken: body.playerToken,
          nickname: existing.nickname,
          eventName: this.meta.eventName,
          eventCode: this.meta.eventCode,
          resumed: true,
        });
      }
    }

    const nickname = sanitizeNickname(body.nickname, NICKNAME_MAX);
    if (!nickname) return json({ error: 'bad_nickname', message: 'Pick a nickname.' }, 400);

    const taken = Object.values(this.players).some(
      (p) => p.nickname.toLowerCase() === nickname.toLowerCase(),
    );
    if (taken) {
      return json({ error: 'nickname_taken', message: 'Someone already grabbed that name.' }, 409);
    }

    if (Object.keys(this.players).length >= 400) {
      return json({ error: 'event_full', message: 'This event is full.' }, 409);
    }

    const token = newToken();
    const player: PlayerRecord = {
      id: randomId('p'),
      nickname,
      tokenHash: await hashToken(token),
      score: 0,
      correctAnswers: 0,
      mysteriesPlayed: 0,
      streak: 0,
      bestStreak: 0,
      lastRoundPoints: 0,
      totalResponseMs: 0,
      joinedAt: Date.now(),
    };
    this.players[player.id] = player;
    await this.persist();

    this.ctx.waitUntil(upsertPlayer(this.env.DB, this.meta.eventCode, toArchivedPlayer(player)));
    this.broadcast();

    return json({
      playerId: player.id,
      playerToken: token,
      nickname: player.nickname,
      eventName: this.meta.eventName,
      eventCode: this.meta.eventCode,
      resumed: false,
    });
  }

  /**
   * Confirm a host token without opening a socket.
   *
   * The Worker needs this before it spends a model call on someone's behalf,
   * and it must stay cheap: the AI request itself runs in the Worker, not
   * here, so that a thirty-second generation cannot occupy this object's
   * input gate while a round is running.
   */
  private async handleVerifyHost(request: Request): Promise<Response> {
    if (!this.meta) return json({ error: 'no_such_event' }, 404);
    const body = (await request.json()) as { hostToken?: string };
    const ok = safeEqual(this.meta.hostTokenHash, await hashToken(body.hostToken ?? ''));
    if (!ok) return json({ error: 'unauthorised' }, 403);
    return json({
      ok: true,
      eventName: this.meta.eventName,
      // So the generator can avoid answers the room will already have seen.
      existingAnswers: this.allMysteries().map((m) => m.answer),
      // The pool spec lives here, not in the request: the categories and the
      // size were settled when the event was created, and a later caller does
      // not get to change what this event is about.
      poolCategories: this.meta.poolCategories,
      poolDifficulty: this.meta.poolDifficulty,
      wanted: this.meta.plannedRounds ?? 0,
      have: Object.keys(this.library).length,
    });
  }

  /**
   * Open (or re-open) the window in which this event's questions get written.
   *
   * The clock starts at the first request rather than at creation, so a host
   * who makes the event and walks away does not come back to a pool that
   * already timed out while nobody was asking for anything.
   */
  private async handlePoolBegin(request: Request): Promise<Response> {
    if (!this.meta) return json({ error: 'no_such_event' }, 404);
    const body = (await request.json()) as { hostToken?: string };
    if (!safeEqual(this.meta.hostTokenHash, await hashToken(body.hostToken ?? ''))) {
      return json({ error: 'unauthorised' }, 403);
    }

    const now = Date.now();
    if (this.meta.poolStartedAt === null) {
      this.meta.poolStartedAt = now;
      await this.persist();
      this.broadcast();
    }

    return json({
      ok: true,
      poolCategories: this.meta.poolCategories,
      poolDifficulty: this.meta.poolDifficulty,
      wanted: this.meta.plannedRounds ?? 0,
      have: Object.keys(this.library).length,
      existingAnswers: this.allMysteries().map((m) => m.answer),
      elapsedMs: now - this.meta.poolStartedAt,
    });
  }

  /**
   * Take a host-approved mystery into this event's library.
   *
   * Validation happened in the Worker before this point, but this is the
   * boundary where content becomes playable, so the shape is checked again
   * here rather than trusted across the hop.
   */
  private async handleLibraryAdd(request: Request): Promise<Response> {
    if (!this.meta) return json({ error: 'no_such_event' }, 404);
    const body = (await request.json()) as {
      hostToken?: string;
      mystery?: Mystery;
      /** A batch, for the automatic pool. Same rules, one hop. */
      mysteries?: Mystery[];
      /** What to show the host if preparing the pool went wrong. */
      poolError?: string | null;
    };
    if (!safeEqual(this.meta.hostTokenHash, await hashToken(body.hostToken ?? ''))) {
      return json({ error: 'unauthorised' }, 403);
    }

    if (body.poolError !== undefined) {
      this.meta.poolError = typeof body.poolError === 'string' ? body.poolError.slice(0, 200) : null;
    }

    const incoming = Array.isArray(body.mysteries)
      ? body.mysteries
      : body.mystery !== undefined
        ? [body.mystery]
        : [];

    // Check the whole batch before taking any of it, so a bad entry cannot
    // leave half a pool in memory that never reaches storage.
    for (const one of incoming) {
      const bad = this.rejectMystery(one);
      if (bad) return bad;
    }
    for (const one of incoming) this.addToLibrary(one as Mystery);

    await this.persist();
    this.broadcastCatalog();
    this.broadcast();
    return json({ ok: true, librarySize: Object.keys(this.library).length });
  }

  /** Why this mystery cannot be taken in, or null if it can. */
  private rejectMystery(m: Mystery | undefined): Response | null {
    const shapeOk =
      m !== undefined &&
      typeof m.id === 'string' &&
      typeof m.type === 'string' &&
      typeof m.title === 'string' &&
      typeof m.answer === 'string' &&
      Array.isArray(m.options) &&
      m.options.length >= 2 &&
      m.options.includes(m.answer) &&
      Array.isArray(m.clues) &&
      m.clues.length === CLUE_COUNT &&
      m.clues.every((c) => typeof c === 'string' && c.length > 0);
    if (!shapeOk) return json({ error: 'bad_mystery' }, 400);

    if (Object.keys(this.library).length >= 60) {
      return json({ error: 'library_full', message: 'This event already has plenty of mysteries.' }, 409);
    }
    return null;
  }

  /** Make one mystery playable in this event. Shape already checked. */
  private addToLibrary(m: Mystery): void {
    const wasNew = !this.library[m.id];
    this.library[m.id] = {
      id: m.id,
      type: m.type,
      title: m.title,
      answer: m.answer,
      options: m.options,
      clues: m.clues,
    };
    // Written-for-this-event mysteries go to the front. The built-in bank
    // stays behind them as a fallback, so it is only ever reached when the
    // pool came up short.
    if (wasNew && !this.queue.includes(m.id)) this.queue.unshift(m.id);
  }

  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'expected_websocket' }, 426);
    }
    if (!this.meta) return json({ error: 'no_such_event' }, 404);

    const roleParam = url.searchParams.get('role');
    let meta: SocketMeta;

    if (roleParam === 'host') {
      const token = url.searchParams.get('hostToken') ?? '';
      if (!safeEqual(this.meta.hostTokenHash, await hashToken(token))) {
        return json({ error: 'unauthorised' }, 403);
      }
      meta = { role: 'host' };
    } else if (roleParam === 'display') {
      // The projector view is read-only, so it needs no credentials.
      meta = { role: 'display' };
    } else {
      const playerId = url.searchParams.get('playerId') ?? '';
      const token = url.searchParams.get('playerToken') ?? '';
      const player = this.players[playerId];
      if (!player || !safeEqual(player.tokenHash, await hashToken(token))) {
        return json({ error: 'unauthorised' }, 403);
      }
      meta = { role: 'player', playerId };
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);

    send(server, {
      type: 'welcome',
      role: meta.role,
      serverTime: Date.now(),
      self: meta.playerId ? this.selfFor(meta.playerId) : null,
    });
    send(server, { type: 'snapshot', snapshot: this.buildSnapshot(), self: meta.playerId ? this.selfFor(meta.playerId) : null });
    if (meta.role === 'host') {
      send(server, { type: 'catalog', mysteries: this.catalog() });
      const brief = this.hostBrief();
      if (brief) send(server, brief);
    }

    // A player rejoining flips their lobby dot back to connected for everyone.
    if (meta.role === 'player') this.broadcast();

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------- websockets

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 4096) return;
    if (!this.allowMessage(ws)) {
      send(ws, { type: 'error', code: 'rate_limited', message: 'Slow down a moment.' });
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    const meta = (ws.deserializeAttachment() ?? { role: 'display' }) as SocketMeta;

    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
        return;
      case 'submit_answer':
        await this.handleSubmit(ws, meta, msg.option);
        return;
      case 'host':
        if (meta.role !== 'host') {
          send(ws, { type: 'error', code: 'forbidden', message: 'Host controls only.' });
          return;
        }
        await this.handleHostAction(ws, msg);
        return;
      default:
        return;
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (meta?.role !== 'player') return;
    // Someone dropping out can be what makes everyone who is left "done", so
    // re-check the early-end condition rather than only redrawing the lobby.
    if (await this.endEarlyIfEveryoneAnswered()) return;
    this.broadcast();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private allowMessage(ws: WebSocket): boolean {
    const now = Date.now();
    const bucket = this.rate.get(ws);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.rate.set(ws, { count: 1, windowStart: now });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= RATE_LIMIT_MAX;
  }

  // ------------------------------------------------------------- gameplay

  /**
   * One guess per player per round, scored at the clue the server currently
   * has open. Everything the client sent other than the chosen string is
   * ignored.
   */
  private async handleSubmit(ws: WebSocket, meta: SocketMeta, option: unknown): Promise<void> {
    if (meta.role !== 'player' || !meta.playerId) {
      send(ws, { type: 'error', code: 'forbidden', message: 'Only players can answer.' });
      return;
    }
    const player = this.players[meta.playerId];
    const round = this.round;
    if (!player) {
      send(ws, { type: 'error', code: 'unknown_player', message: 'Rejoin the event.' });
      return;
    }
    if (!round || this.meta?.phase !== 'round' || round.status === 'ended') {
      send(ws, { type: 'error', code: 'round_closed', message: 'No round is accepting answers.' });
      return;
    }
    if (round.status === 'paused') {
      send(ws, { type: 'error', code: 'round_paused', message: 'The host paused the round.' });
      return;
    }
    if (round.status === 'intro') {
      // No clue is on screen yet, so there is no clue number to score against.
      send(ws, { type: 'error', code: 'round_not_started', message: 'Wait for the first clue.' });
      return;
    }
    if (round.answers[player.id]) {
      send(ws, { type: 'error', code: 'already_answered', message: 'Your answer is already locked in.' });
      return;
    }
    if (typeof option !== 'string' || !round.options.includes(option)) {
      send(ws, { type: 'error', code: 'bad_option', message: 'That is not one of the options.' });
      return;
    }

    const mystery = this.resolveMystery(round.mysteryId);
    if (!mystery) {
      send(ws, { type: 'error', code: 'bad_round', message: 'This mystery is unavailable.' });
      return;
    }

    // Server-side clue number. The client never gets a say in what a guess is worth.
    const clueNumber = round.currentClue;
    const correct = isCorrectAnswer(mystery, option);
    const submittedAt = Date.now();
    round.answers[player.id] = {
      selectedOption: option,
      submittedAt,
      clueNumber,
      responseMs: computeResponseMs(round, clueNumber, submittedAt),
      isCorrect: correct,
      // Banked now, added to the visible score only when the round ends.
      pointsAwarded: correct ? pointsForClue(clueNumber) : 0,
    };

    await this.persist();

    // Everyone who could answer has: no reason to make the room watch an
    // empty clock run down.
    if (await this.endEarlyIfEveryoneAnswered()) return;

    this.broadcast();
  }

  /**
   * End the round the moment every connected player has locked in.
   *
   * Deliberately counts *connected* players: waiting on someone whose phone
   * dropped would stall the room for the rest of the round. Players who are
   * offline when it ends simply score zero, exactly as they would have by
   * letting the clock expire.
   *
   * Returns true if it ended the round (in which case the caller must not
   * broadcast again - endRound already did).
   */
  private async endEarlyIfEveryoneAnswered(): Promise<boolean> {
    const round = this.round;
    if (!round || round.status !== 'active' || this.meta?.phase !== 'round') return false;

    const connected = this.connectedPlayerIds();
    if (connected.size === 0) return false;

    let eligible = 0;
    for (const playerId of connected) {
      // Someone who walked in halfway through does not get to hold the room
      // hostage: they may still answer, they just are not waited for.
      const player = this.players[playerId];
      if (!player || player.joinedAt > round.startedAt) continue;
      eligible += 1;
      if (!round.answers[playerId]) return false;
    }
    if (eligible === 0) return false;

    await this.endRound();
    return true;
  }

  private async handleHostAction(ws: WebSocket, msg: Extract<ClientMessage, { type: 'host' }>): Promise<void> {
    switch (msg.action) {
      case 'start_round':
      case 'next_round':
        await this.startRound(ws, msg.mysteryId);
        return;
      case 'hold_auto':
        // Stop the countdown without turning the feature off for the night.
        await this.cancelSchedule();
        this.broadcast();
        return;
      case 'set_auto_advance': {
        if (!this.meta) return;
        this.meta.autoAdvanceEnabled = msg.enabled ?? !this.meta.autoAdvanceEnabled;
        if (!this.meta.autoAdvanceEnabled) await this.cancelSchedule();
        else await this.persist();
        this.broadcast();
        return;
      }
      case 'pause':
        await this.pauseRound();
        return;
      case 'resume':
        await this.resumeRound();
        return;
      case 'end_round':
        if (this.round && this.round.status !== 'ended') await this.endRound();
        return;
      case 'show_leaderboard':
        if (this.meta) {
          this.meta.phase = this.meta.roundsPlayed > 0 ? 'leaderboard' : 'lobby';
          if (this.meta.phase === 'leaderboard') {
            await this.scheduleAdvance(this.afterLeaderboard(), LEADERBOARD_AUTO_MS);
          } else {
            await this.cancelSchedule();
          }
          this.syncPhaseToD1();
          this.broadcast();
        }
        return;
      case 'end_event':
        if (this.meta) {
          if (this.round && this.round.status !== 'ended') await this.endRound();
          this.meta.phase = 'finished';
          await this.cancelSchedule();
          this.syncPhaseToD1();
          this.broadcast();
        }
        return;
      case 'reset_event':
        await this.resetEvent();
        return;
      case 'kick_player':
        await this.kickPlayer(msg.playerId);
        return;
      default:
        return;
    }
  }

  private async startRound(ws: WebSocket | null, requestedMysteryId?: string): Promise<void> {
    if (!this.meta) return;
    if (this.meta.phase === 'round' && this.round && this.round.status !== 'ended') {
      sendMaybe(ws, { type: 'error', code: 'round_running', message: 'A round is already running.' });
      return;
    }
    if (Object.keys(this.players).length === 0) {
      sendMaybe(ws, { type: 'error', code: 'no_players', message: 'Nobody has joined yet.' });
      return;
    }
    if (this.planComplete()) {
      sendMaybe(ws, {
        type: 'error',
        code: 'event_complete',
        message: `All ${this.meta.plannedRounds} mysteries have been played.`,
      });
      return;
    }

    let mysteryId = requestedMysteryId;
    if (mysteryId) {
      if (!this.resolveMystery(mysteryId)) {
        sendMaybe(ws, { type: 'error', code: 'no_such_mystery', message: 'That mystery does not exist.' });
        return;
      }
      this.queue = this.queue.filter((id) => id !== mysteryId);
    } else {
      mysteryId = this.queue.shift();
      if (!mysteryId) {
        sendMaybe(ws, {
          type: 'error',
          code: 'out_of_mysteries',
          message: 'Every mystery has been played. Reset the event or end it.',
        });
        return;
      }
    }

    const mystery = this.resolveMystery(mysteryId)!;
    const now = Date.now();

    // The last planned mystery always scores double. There is nothing for the
    // host to arm, because the only way that goes wrong is forgetting to.
    const isPlannedFinal =
      this.meta.plannedRounds !== null && this.meta.roundsPlayed + 1 === this.meta.plannedRounds;
    const multiplier = isPlannedFinal ? DOUBLE_MULTIPLIER : 1;

    // Freeze the standings now so the post-round leaderboard can show movement.
    this.previousRanks = Object.fromEntries(this.rankings().map((e) => [e.playerId, e.rank]));

    // Rounds open with a get-ready window: category on screen, no clue yet,
    // no answering. Clue 1 (and the clock that costs points) starts after it.
    this.round = {
      roundId: randomId('round'),
      mysteryId: mystery.id,
      roundIndex: this.meta.roundsPlayed + 1,
      status: 'intro',
      startedAt: now,
      pointsMultiplier: multiplier,
      currentClue: 0,
      clueStartedAt: now,
      clueEndsAt: now + INTRO_DURATION_MS,
      windowMs: INTRO_DURATION_MS,
      pausedRemainingMs: null,
      statusBeforePause: null,
      options: buildOptions(mystery),
      answers: {},
    };
    this.lastResult = null;
    this.meta.phase = 'round';

    await this.schedule({ kind: 'clue', at: this.round.clueEndsAt });

    this.ctx.waitUntil(
      recordRoundStart(this.env.DB, {
        id: this.round.roundId,
        eventCode: this.meta.eventCode,
        mysteryId: mystery.id,
        roundIndex: this.round.roundIndex,
        startedAt: now,
        pointsMultiplier: this.round.pointsMultiplier,
      }),
    );
    this.syncPhaseToD1();
    this.broadcast();
    this.broadcastHostBrief();
    // The drawn mystery has left the queue, so the host's picker needs to know
    // it is spent - otherwise it stays selectable for the rest of the event.
    this.broadcastCatalog();
  }

  private async pauseRound(): Promise<void> {
    const round = this.round;
    if (!round || (round.status !== 'active' && round.status !== 'intro')) return;
    round.statusBeforePause = round.status;
    round.status = 'paused';
    round.pausedRemainingMs = Math.max(0, round.clueEndsAt - Date.now());
    await this.cancelSchedule();
    this.broadcast();
  }

  private async resumeRound(): Promise<void> {
    const round = this.round;
    if (!round || round.status !== 'paused') return;
    const remaining = round.pausedRemainingMs ?? round.windowMs;
    const now = Date.now();
    round.status = round.statusBeforePause ?? 'active';
    // Back-date the start so the ring picks up exactly where it froze.
    round.clueStartedAt = now - (round.windowMs - remaining);
    round.clueEndsAt = now + remaining;
    round.pausedRemainingMs = null;
    round.statusBeforePause = null;
    await this.schedule({ kind: 'clue', at: round.clueEndsAt });
    this.broadcast();
  }

  /**
   * The clue clock. Fires at the end of each 20-second window: reveal the next
   * clue, or close the round once clue five has had its turn.
   */
  override async alarm(): Promise<void> {
    const s = this.scheduled;
    if (!s) return;

    const now = Date.now();
    if (now < s.at - 250) {
      // Woke early, or a pause moved the deadline. Re-arm and wait.
      await this.ctx.storage.setAlarm(s.at);
      return;
    }

    this.scheduled = null;
    if (s.kind === 'clue') await this.advanceClue(now);
    else await this.runAutoAdvance(s, now);
  }

  private async advanceClue(now: number): Promise<void> {
    const round = this.round;
    if (!round || (round.status !== 'active' && round.status !== 'intro')) return;

    if (round.status === 'active' && round.currentClue >= CLUE_COUNT) {
      await this.endRound();
      return;
    }

    // Anchor the next window to the scheduled deadline rather than to "now",
    // so alarm jitter cannot make the round drift longer clue after clue.
    const base = now - round.clueEndsAt < 5_000 ? round.clueEndsAt : now;
    round.status = 'active'; // the intro, if that is what just expired, is over
    round.currentClue += 1;
    round.clueStartedAt = base;
    round.clueEndsAt = base + CLUE_DURATION_MS;
    round.windowMs = CLUE_DURATION_MS;

    await this.schedule({ kind: 'clue', at: round.clueEndsAt });
    this.broadcast();
  }

  /**
   * The between-rounds hops. Re-validates the phase because the host may have
   * clicked in the meantime - Cloudflare's input gate means an alarm cannot
   * interleave with a message, so "the host already moved us on" is the only
   * real race, and comparing the phase catches exactly that.
   */
  private async runAutoAdvance(s: Scheduled, _now: number): Promise<void> {
    if (!this.meta || !this.meta.autoAdvanceEnabled) return;

    if (s.to === 'leaderboard') {
      if (this.meta.phase !== 'results') return;
      this.meta.phase = 'leaderboard';
      await this.scheduleAdvance(this.afterLeaderboard(), LEADERBOARD_AUTO_MS);
      this.syncPhaseToD1();
      this.broadcast();
      return;
    }

    if (this.meta.phase !== 'leaderboard') return;

    // The host asked for a set number of mysteries and the room has played
    // them. Ending here is keeping the promise, not the timer overreaching.
    if (s.to === 'finished') {
      this.meta.phase = 'finished';
      await this.cancelSchedule();
      this.syncPhaseToD1();
      this.broadcast();
      return;
    }

    if (this.queue.length === 0 || Object.keys(this.players).length === 0) {
      // Out of mysteries, or an empty room. Sit on the standings; ending the
      // event is the host's moment, never the timer's.
      await this.cancelSchedule();
      this.broadcast();
      return;
    }
    await this.startRound(null);
  }

  /**
   * Close the round: bank the points that were held back, update streaks,
   * build the result (the first payload that contains the answer) and move
   * everyone to the results screen.
   */
  private async endRound(): Promise<void> {
    const round = this.round;
    if (!round || !this.meta || round.status === 'ended') return;

    const mystery = this.resolveMystery(round.mysteryId);
    round.status = 'ended';

    const perPlayer: PlayerRoundResult[] = [];
    const archivedAnswers: ArchivedAnswer[] = [];

    for (const player of Object.values(this.players)) {
      const answer = round.answers[player.id];
      player.mysteriesPlayed += 1;

      // The tiebreak clock is banked here for the same reason points are:
      // nothing about timing may reach a client mid-round.
      player.totalResponseMs += answer?.isCorrect ? answer.responseMs : MAX_RESPONSE_MS;

      let basePoints = 0;
      let bonus = 0;
      if (answer) {
        // pointsAwarded on the AnswerRecord is the clue value, fixed at
        // submission from the server's clue number. The bonus and the
        // multiplier are derived here, at round end, from state the client
        // cannot touch - which is also what keeps them hidden until now.
        basePoints = answer.pointsAwarded;
        if (answer.isCorrect) {
          player.correctAnswers += 1;
          player.streak += 1;
          player.bestStreak = Math.max(player.bestStreak, player.streak);
          bonus = streakBonus(player.streak);
        } else {
          player.streak = 0;
        }
        const total = (basePoints + bonus) * round.pointsMultiplier;
        player.score += total;
        player.lastRoundPoints = total;
        archivedAnswers.push({
          roundId: round.roundId,
          playerId: player.id,
          selectedOption: answer.selectedOption,
          submittedAt: answer.submittedAt,
          clueNumber: answer.clueNumber,
          isCorrect: answer.isCorrect,
          pointsAwarded: answer.pointsAwarded,
          bonusPoints: bonus,
          multiplier: round.pointsMultiplier,
          responseMs: answer.responseMs,
        });
      } else {
        player.lastRoundPoints = 0;
        player.streak = 0;
      }

      perPlayer.push({
        playerId: player.id,
        nickname: player.nickname,
        selectedOption: answer?.selectedOption ?? null,
        isCorrect: answer?.isCorrect ?? false,
        clueNumber: answer?.clueNumber ?? null,
        basePoints,
        streakBonus: bonus,
        multiplier: round.pointsMultiplier,
        streakAfter: player.streak,
        pointsAwarded: player.lastRoundPoints,
      });
    }

    const counts = new Map<string, number>(round.options.map((o) => [o, 0]));
    for (const a of Object.values(round.answers)) {
      counts.set(a.selectedOption, (counts.get(a.selectedOption) ?? 0) + 1);
    }

    this.lastResult = {
      roundId: round.roundId,
      mysteryId: round.mysteryId,
      roundIndex: round.roundIndex,
      mysteryType: mystery?.type ?? 'unknown',
      title: mystery?.title ?? 'Mystery',
      clues: mystery?.clues ?? [],
      answer: mystery?.answer ?? 'Unknown',
      options: round.options,
      distribution: round.options.map((option) => ({ option, count: counts.get(option) ?? 0 })),
      totalAnswers: Object.keys(round.answers).length,
      correctCount: Object.values(round.answers).filter((a) => a.isCorrect).length,
      players: perPlayer.sort((a, b) => b.pointsAwarded - a.pointsAwarded),
    };

    this.meta.roundsPlayed += 1;
    this.meta.phase = 'results';

    // Straight onto the results countdown - which also overwrites the clue
    // schedule, so there is nothing left to cancel.
    await this.scheduleAdvance('leaderboard', RESULTS_AUTO_MS);

    const eventCode = this.meta.eventCode;
    this.ctx.waitUntil(
      recordRoundEnd(
        this.env.DB,
        eventCode,
        round.roundId,
        Date.now(),
        archivedAnswers,
        Object.values(this.players).map(toArchivedPlayer),
      ),
    );
    this.syncPhaseToD1();
    this.broadcast();
  }

  private async resetEvent(): Promise<void> {
    if (!this.meta) return;
    for (const player of Object.values(this.players)) {
      player.score = 0;
      player.correctAnswers = 0;
      player.mysteriesPlayed = 0;
      player.streak = 0;
      player.bestStreak = 0;
      player.lastRoundPoints = 0;
      player.totalResponseMs = 0;
    }
    this.round = null;
    this.lastResult = null;
    this.previousRanks = {};
    this.meta.roundsPlayed = 0;
    this.meta.phase = 'lobby';
    this.queue = shuffle(this.allMysteries().map((m) => m.id));

    await this.cancelSchedule();
    this.ctx.waitUntil(resetEventRows(this.env.DB, this.meta.eventCode));
    this.broadcast();
    this.broadcastCatalog();
  }

  private async kickPlayer(playerId?: string): Promise<void> {
    if (!playerId || !this.players[playerId]) return;
    delete this.players[playerId];
    if (this.round) delete this.round.answers[playerId];
    delete this.previousRanks[playerId];
    await this.persist();
    if (await this.endEarlyIfEveryoneAnswered()) return;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      if (meta?.playerId === playerId) {
        try {
          ws.close(4003, 'removed_by_host');
        } catch {
          /* already gone */
        }
      }
    }
    this.broadcast();
  }

  private syncPhaseToD1(): void {
    if (!this.meta) return;
    this.ctx.waitUntil(setEventPhase(this.env.DB, this.meta.eventCode, this.meta.phase));
  }

  // ------------------------------------------------------------ projections

  private connectedPlayerIds(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      // A socket being torn down is still listed while its close handler runs,
      // so check the state rather than trusting the list.
      if (ws.readyState !== WebSocket.OPEN) continue;
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      if (meta?.playerId) ids.add(meta.playerId);
    }
    return ids;
  }

  /**
   * Cumulative time to solve, with rounds the player was absent for charged
   * at the full rate. Without that, joining late would be an advantage on the
   * tiebreak: fewer rounds played means less accumulated time.
   */
  /**
   * What the next round would score at. Armed explicitly by the host, or
   * implicitly when the planned final mystery is the one coming up.
   */
  /** The pending phase hop, for clients to draw a countdown from. */
  private publicAutoAdvance(): AutoAdvance | null {
    const s = this.scheduled;
    if (!s || s.kind !== 'advance' || !s.to) return null;
    return {
      to: s.to,
      at: s.at,
      durationMs: s.to === 'leaderboard' ? RESULTS_AUTO_MS : LEADERBOARD_AUTO_MS,
    };
  }

  private nextRoundMultiplier(): number {
    if (!this.meta) return 1;
    if (this.meta.plannedRounds === null) return 1;
    // A round still in flight has not incremented roundsPlayed yet, so the
    // next one to *start* is two ahead, not one. Without this the console
    // would go on claiming the next round is double all the way through the
    // double round itself.
    const inFlight = this.meta.phase === 'round' && this.round !== null && this.round.status !== 'ended';
    const nextIndex = this.meta.roundsPlayed + (inFlight ? 2 : 1);
    return nextIndex === this.meta.plannedRounds ? DOUBLE_MULTIPLIER : 1;
  }

  private tiebreakMs(p: PlayerRecord): number {
    const missed = Math.max(0, (this.meta?.roundsPlayed ?? 0) - p.mysteriesPlayed);
    return p.totalResponseMs + missed * MAX_RESPONSE_MS;
  }

  private rankings(): LeaderboardEntry[] {
    const connected = this.connectedPlayerIds();

    // Score first, then who got there faster. There is a prize on this, so
    // the order has to be defensible out loud, not alphabetical by accident.
    const sorted = Object.values(this.players).sort(
      (a, b) =>
        b.score - a.score ||
        this.tiebreakMs(a) - this.tiebreakMs(b) ||
        b.correctAnswers - a.correctAnswers ||
        a.nickname.localeCompare(b.nickname),
    );

    // Who shares a score with somebody else, so the podium can say why it
    // split them. Only meaningful above zero - in the lobby everyone is tied.
    const scoreCounts = new Map<number, number>();
    for (const p of sorted) scoreCounts.set(p.score, (scoreCounts.get(p.score) ?? 0) + 1);

    const entries: LeaderboardEntry[] = [];
    let lastKey: string | null = null;
    let lastRank = 0;

    sorted.forEach((player, index) => {
      // The rank must be keyed on everything the sort ordered by, minus the
      // nickname. Keying it on score alone - as it used to be - displays rows
      // in an order the rank numbers then contradict.
      const key = `${player.score}|${this.tiebreakMs(player)}|${player.correctAnswers}`;
      const rank = key === lastKey ? lastRank : index + 1;
      lastKey = key;
      lastRank = rank;

      const previous = this.previousRanks[player.id];
      entries.push({
        playerId: player.id,
        nickname: player.nickname,
        score: player.score,
        correctAnswers: player.correctAnswers,
        mysteriesPlayed: player.mysteriesPlayed,
        streak: player.streak,
        bestStreak: player.bestStreak,
        totalResponseMs: player.totalResponseMs,
        avgResponseMs:
          player.mysteriesPlayed > 0
            ? Math.round(player.totalResponseMs / player.mysteriesPlayed)
            : null,
        tiedOnScore: player.score > 0 && (scoreCounts.get(player.score) ?? 0) > 1,
        rank,
        rankDelta: previous === undefined ? 0 : previous - rank,
        lastRoundPoints: player.lastRoundPoints,
        connected: connected.has(player.id),
      });
    });

    return entries;
  }

  private publicRound(): PublicRound | null {
    const round = this.round;
    if (!round || !this.meta || this.meta.phase !== 'round') return null;
    const mystery = this.resolveMystery(round.mysteryId);
    if (!mystery) return null;

    const remainingMs =
      round.status === 'paused'
        ? (round.pausedRemainingMs ?? 0)
        : Math.max(0, round.clueEndsAt - Date.now());

    return {
      roundId: round.roundId,
      mysteryId: round.mysteryId,
      roundIndex: round.roundIndex,
      mysteryType: mystery.type,
      title: mystery.title,
      status: round.status,
      currentClue: round.currentClue,
      clueCount: CLUE_COUNT,
      // Only the clues that have actually been revealed leave the server -
      // during the intro that is none of them.
      clues: mystery.clues.slice(0, round.currentClue),
      options: round.options,
      clueStartedAt: round.clueStartedAt,
      clueEndsAt: round.clueEndsAt,
      durationPerClue: CLUE_DURATION_MS,
      pointsMultiplier: round.pointsMultiplier,
      windowMs: round.windowMs,
      remainingMs,
      acceptingAnswers: round.status === 'active',
      answeredCount: Object.keys(round.answers).length,
      playerCount: Object.keys(this.players).length,
    };
  }

  private buildSnapshot(): Snapshot {
    const meta = this.meta!;
    const connected = this.connectedPlayerIds();
    const players: LobbyPlayer[] = Object.values(this.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        playerId: p.id,
        nickname: p.nickname,
        score: p.score,
        connected: connected.has(p.id),
        joinedAt: p.joinedAt,
      }));

    return {
      eventCode: meta.eventCode,
      eventName: meta.eventName,
      phase: meta.phase,
      players,
      round: this.publicRound(),
      // The answer only travels once the round is over.
      result: meta.phase === 'round' || meta.phase === 'lobby' ? null : this.lastResult,
      leaderboard: this.rankings(),
      roundsPlayed: meta.roundsPlayed,
      mysteriesRemaining: this.queue.length,
      totalMysteries: this.allMysteries().length,
      nextRoundMultiplier: this.nextRoundMultiplier(),
      plannedRounds: meta.plannedRounds,
      pool: {
        wanted: meta.plannedRounds ?? 0,
        ai: Object.keys(this.library).length,
        categories: meta.poolCategories,
        difficulty: meta.poolDifficulty,
        lastError: meta.poolError,
        expiresAt: meta.poolStartedAt === null ? null : meta.poolStartedAt + POOL_DEADLINE_MS,
      },
      autoAdvance: this.publicAutoAdvance(),
      autoAdvanceEnabled: meta.autoAdvanceEnabled,
      serverTime: Date.now(),
    };
  }

  private selfFor(playerId: string): PlayerSelf | null {
    const player = this.players[playerId];
    if (!player) return null;
    const answer = this.round?.answers[playerId];
    return {
      playerId: player.id,
      nickname: player.nickname,
      score: player.score,
      streak: player.streak,
      bestStreak: player.bestStreak,
      correctAnswers: player.correctAnswers,
      mysteriesPlayed: player.mysteriesPlayed,
      hasAnswered: Boolean(answer),
      selectedOption: answer?.selectedOption ?? null,
      answeredAtClue: answer?.clueNumber ?? null,
    };
  }

  private catalog(): MysteryChoice[] {
    const remaining = new Set(this.queue);
    return this.allMysteries().map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      used: !remaining.has(m.id),
      source: this.library[m.id] ? 'ai' : 'builtin',
    }));
  }

  /** One snapshot, personalised per socket with that player's private slice. */
  private broadcast(): void {
    if (!this.meta) return;
    const snapshot = this.buildSnapshot();
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      send(ws, {
        type: 'snapshot',
        snapshot,
        self: meta?.playerId ? this.selfFor(meta.playerId) : null,
      });
    }
  }

  /** The answer sheet for the live round. Host sockets only. */
  private hostBrief(): Extract<ServerMessage, { type: 'host_brief' }> | null {
    const round = this.round;
    if (!round || this.meta?.phase !== 'round') return null;
    const mystery = this.resolveMystery(round.mysteryId);
    if (!mystery) return null;
    return { type: 'host_brief', roundId: round.roundId, answer: mystery.answer, clues: mystery.clues };
  }

  private broadcastHostBrief(): void {
    const brief = this.hostBrief();
    if (!brief) return;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      if (meta?.role === 'host') send(ws, brief);
    }
  }

  private broadcastCatalog(): void {
    const catalog = this.catalog();
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      if (meta?.role === 'host') send(ws, { type: 'catalog', mysteries: catalog });
    }
  }
}

/**
 * Time to solve, on a virtual clock that starts when clue 1 opens.
 *
 * Deliberately *not* time-within-the-current-clue, which is non-monotone:
 * one second into clue 5 would look faster than nineteen seconds into clue 1,
 * inverting the thing the scoring already rewards. Completed windows
 * contribute their nominal duration, so a late alarm cannot inflate one
 * player's number relative to another's, and because `resumeRound`
 * back-dates `clueStartedAt`, a pause is excluded for free.
 */
function computeResponseMs(round: RoundRecord, clueNumber: number, submittedAt: number): number {
  const raw = (clueNumber - 1) * CLUE_DURATION_MS + (submittedAt - round.clueStartedAt);
  const clamped = Math.min(MAX_RESPONSE_MS, Math.max(0, raw));
  return Math.round(clamped / RESPONSE_BUCKET_MS) * RESPONSE_BUCKET_MS;
}

function toArchivedPlayer(p: PlayerRecord): ArchivedPlayer {
  return {
    id: p.id,
    nickname: p.nickname,
    score: p.score,
    correctAnswers: p.correctAnswers,
    mysteriesPlayed: p.mysteriesPlayed,
    bestStreak: p.bestStreak,
    totalResponseMs: p.totalResponseMs,
    joinedAt: p.joinedAt,
  };
}

/** No-op when there is no socket: the auto-advance path has nobody to tell. */
function sendMaybe(ws: WebSocket | null, message: ServerMessage): void {
  if (ws) send(ws, message);
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Socket already closing; the close handler will tidy up.
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
