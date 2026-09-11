/**
 * Wire protocol and domain types shared by the Cloudflare Worker / Durable
 * Object and the React client.
 *
 * Rule of the house: anything the client is told is already safe to show.
 * The Durable Object never puts an unrevealed clue or an unrevealed answer
 * into a snapshot, so a player poking at devtools learns nothing.
 */

/** Every mystery has exactly this many clues. */
export const CLUE_COUNT = 5;

/** Each clue is on screen for this long before the next one is revealed. */
export const CLUE_DURATION_MS = 20_000;

/**
 * A "get ready" window at the top of every round. The category is on screen
 * but no clue is, so the room can settle, read what kind of mystery it is and
 * look up from their phones before the clock that costs them points starts.
 */
export const INTRO_DURATION_MS = 10_000;

/**
 * What a round costs a player who never solved it, on the response-time
 * tiebreak. Deliberately equal to a correct answer on the final millisecond
 * of the last clue: never worse than any real answer, never better.
 */
export const MAX_RESPONSE_MS = CLUE_COUNT * CLUE_DURATION_MS;

/**
 * Response times are rounded to this before being banked. The timestamp is
 * server-receive time, so it carries venue-wifi latency; rounding off the
 * last tenth of a second stops one network hiccup from deciding a prize.
 */
export const RESPONSE_BUCKET_MS = 100;

/** Points for a correct answer, indexed by clue number (1-based). */
export const CLUE_POINTS: readonly number[] = [500, 400, 300, 200, 100];

/** Points a correct answer submitted during `clueNumber` is worth. */
export function pointsForClue(clueNumber: number): number {
  return CLUE_POINTS[clueNumber - 1] ?? 0;
}

export const STREAK_BONUS_STEP = 100;
export const STREAK_BONUS_MAX = 200;

/**
 * Bonus XP for a correct answer that extends a streak to `streak`.
 * Two in a row is +100, three or more is +200, one miss resets it.
 *
 * Flat and capped rather than a multiplier on purpose. A multiplier scales
 * with the base, so it would pay the leader (who answers early, for 500)
 * more than the chaser (who answers on clue 4, for 200) - the wrong shape
 * for a game that wants to stay live to the last question. The cap also
 * keeps the arithmetic doable on a projector.
 */
export function streakBonus(streak: number): number {
  return streak < 2 ? 0 : Math.min(STREAK_BONUS_MAX, (streak - 1) * STREAK_BONUS_STEP);
}

/**
 * What the final round multiplies the whole round's XP by. Always the last
 * planned mystery - the host does not arm it, because forgetting to is the
 * only way it goes wrong.
 */
export const DOUBLE_MULTIPLIER = 2;

export interface Mystery {
  id: string;
  type: string;
  title: string;
  answer: string;
  options: string[];
  clues: string[];
}

/** What the whole event is doing right now. Drives which screen everyone sees. */
export type EventPhase =
  | 'lobby' // waiting for the host to start
  | 'round' // a mystery is running
  | 'results' // round over, answer revealed
  | 'leaderboard' // standings between mysteries
  | 'finished'; // final podium

/** `intro` is the get-ready window: category shown, no clue, no answering. */
export type RoundStatus = 'intro' | 'active' | 'paused' | 'ended';

/**
 * The live round as the client is allowed to see it. `clues` only ever holds
 * clues that have actually been revealed.
 */
export interface PublicRound {
  roundId: string;
  mysteryId: string;
  roundIndex: number;
  mysteryType: string;
  title: string;
  status: RoundStatus;
  /** 1-based, 1..CLUE_COUNT. Zero during the intro, before any clue exists. */
  currentClue: number;
  clueCount: number;
  /** Revealed clues, in order. Length === currentClue while active. */
  clues: string[];
  /** Shuffled once per round on the server, identical for every player. */
  options: string[];
  /** Server epoch ms when the current clue was revealed. */
  clueStartedAt: number;
  /** Server epoch ms when the current clue expires. */
  clueEndsAt: number;
  durationPerClue: number;
  /** 2 on a double-points round, otherwise 1. Public - it leaks nothing. */
  pointsMultiplier: number;
  /**
   * Length of the window currently running - the intro is shorter than a
   * clue. The countdown ring fills against this, not `durationPerClue`.
   */
  windowMs: number;
  /** Milliseconds left on the clock, frozen while paused. */
  remainingMs: number;
  acceptingAnswers: boolean;
  answeredCount: number;
  playerCount: number;
}

export interface AnswerTally {
  option: string;
  count: number;
}

export interface PlayerRoundResult {
  playerId: string;
  nickname: string;
  selectedOption: string | null;
  isCorrect: boolean;
  clueNumber: number | null;
  /** Clue points before any bonus or multiplier. */
  basePoints: number;
  streakBonus: number;
  multiplier: number;
  /** The player's streak after this round resolved. */
  streakAfter: number;
  /** The grand total actually banked: (basePoints + streakBonus) * multiplier. */
  pointsAwarded: number;
}

/** Published once a round ends. This is the first time the answer is sent out. */
export interface RoundResult {
  roundId: string;
  mysteryId: string;
  roundIndex: number;
  mysteryType: string;
  title: string;
  /** All five clues, now that the round is over. */
  clues: string[];
  answer: string;
  options: string[];
  distribution: AnswerTally[];
  totalAnswers: number;
  correctCount: number;
  players: PlayerRoundResult[];
}

export interface LeaderboardEntry {
  playerId: string;
  nickname: string;
  score: number;
  correctAnswers: number;
  mysteriesPlayed: number;
  streak: number;
  bestStreak: number;
  /**
   * Cumulative time to solve, used to break score ties. Rounds the player
   * did not solve are charged MAX_RESPONSE_MS, so this is "total time to find
   * the answer, with a full round charged for a round you never found it".
   */
  totalResponseMs: number;
  /** Per round played. Null until they have played one. */
  avgResponseMs: number | null;
  /** Another player holds this exact score. Only ever true above zero. */
  tiedOnScore: boolean;
  rank: number;
  /** Rank change since the previous round: positive means moved up. */
  rankDelta: number;
  /** Points gained in the most recent round. */
  lastRoundPoints: number;
  connected: boolean;
}

/** The private slice of state for the connected player. */
export interface PlayerSelf {
  playerId: string;
  nickname: string;
  score: number;
  streak: number;
  bestStreak: number;
  correctAnswers: number;
  mysteriesPlayed: number;
  /** Has this player already used their single guess this round? */
  hasAnswered: boolean;
  /** What they locked in, echoed back so a reconnect restores the UI. */
  selectedOption: string | null;
  /** Clue number they answered on, for the "locked at clue 2 / 400 XP" badge. */
  answeredAtClue: number | null;
}

export interface LobbyPlayer {
  playerId: string;
  nickname: string;
  score: number;
  connected: boolean;
  joinedAt: number;
}

/** Everything the UI renders from. Sent whole on every state change. */
export interface Snapshot {
  eventCode: string;
  eventName: string;
  phase: EventPhase;
  players: LobbyPlayer[];
  round: PublicRound | null;
  /** Present during `results`, `leaderboard` and `finished`. */
  result: RoundResult | null;
  leaderboard: LeaderboardEntry[];
  roundsPlayed: number;
  mysteriesRemaining: number;
  totalMysteries: number;
  /**
   * What the *next* round will multiply by. Teased on the projector during
   * the leaderboard - someone 800 behind needs to know the gap can be closed
   * before the round starts, not after.
   */
  nextRoundMultiplier: number;
  /** How many mysteries the host planned, if they said up front. */
  plannedRounds: number | null;
  /** The pool the host asked for at creation, and how it is coming along. */
  pool: PoolStatus;
  /** A countdown to the next phase, or null if the room is waiting on the host. */
  autoAdvance: AutoAdvance | null;
  /** Whether the event advances itself at all. Host can switch it off. */
  autoAdvanceEnabled: boolean;
  /** Server epoch ms at the moment the snapshot was built. */
  serverTime: number;
}

/**
 * What the room is counting down to between rounds.
 *
 * `finished` only ever follows the last of a planned set. A host who never
 * said how many mysteries they were running still ends the event by hand -
 * the timer is not allowed to guess that a night is over.
 */
export type AutoAdvanceTarget = 'leaderboard' | 'round' | 'finished';

export interface AutoAdvance {
  to: AutoAdvanceTarget;
  /** Server epoch ms. Clients draw the countdown from this, as with clues. */
  at: number;
  durationMs: number;
}

/** How long the answer and the distribution stay up before the standings. */
export const RESULTS_AUTO_MS = 20_000;
/** How long the standings stay up before the next mystery starts itself. */
export const LEADERBOARD_AUTO_MS = 8_000;

/** A mystery as offered to the host in the picker - no answer, no clues. */
export interface MysteryChoice {
  id: string;
  type: string;
  title: string;
  used: boolean;
  /** Where it came from, so the host picker can label AI mysteries. */
  source: 'builtin' | 'ai';
}

export type ServerMessage =
  | { type: 'welcome'; role: 'player' | 'host' | 'display'; serverTime: number; self: PlayerSelf | null }
  | { type: 'snapshot'; snapshot: Snapshot; self: PlayerSelf | null }
  | { type: 'catalog'; mysteries: MysteryChoice[] }
  /**
   * Host-only. The answer and the full clue list for the running round, so
   * whoever is on the microphone can build tension knowingly. Gated on the
   * host token - the same credential that can start and end rounds - and
   * never sent to a player or projector socket.
   */
  | { type: 'host_brief'; roundId: string; answer: string; clues: string[] }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'error'; code: string; message: string };

export type HostAction =
  | 'hold_auto'
  | 'set_auto_advance'
  | 'start_round'
  | 'pause'
  | 'resume'
  | 'end_round'
  | 'show_leaderboard'
  | 'next_round'
  | 'end_event'
  | 'reset_event'
  | 'kick_player';

export type ClientMessage =
  | { type: 'ping'; clientTime: number }
  | { type: 'submit_answer'; option: string }
  | {
      type: 'host';
      action: HostAction;
      mysteryId?: string;
      playerId?: string;
      /** For `set_auto_advance`. Omit to toggle. */
      enabled?: boolean;
    };

export const NICKNAME_MAX = 18;
export const EVENT_NAME_MAX = 48;

/** Category label + emoji for the little pill above the clue. */
export const MYSTERY_TYPE_LABELS: Record<string, { label: string; emoji: string }> = {
  landmark: { label: 'Landmark', emoji: '\u{1F3DB}️' },
  place: { label: 'Place', emoji: '\u{1F30E}' },
  city: { label: 'City', emoji: '\u{1F3D9}️' },
  country: { label: 'Country', emoji: '\u{1F5FA}️' },
  animal: { label: 'Animal', emoji: '\u{1F43C}' },
  food: { label: 'Food', emoji: '\u{1F355}' },
  invention: { label: 'Invention', emoji: '\u{1F4A1}' },
  movie: { label: 'Movie', emoji: '\u{1F3AC}' },
  object: { label: 'Object', emoji: '\u{1F9E9}' },
  company: { label: 'Company', emoji: '\u{1F3E2}' },
  historical_event: { label: 'History', emoji: '\u{1F4DC}' },
  technology: { label: 'Technology', emoji: '\u{1F4E1}' },
  space: { label: 'Space', emoji: '\u{1F680}' },
  sport: { label: 'Sport', emoji: '\u{1F3C0}' },
};

/**
 * The canonical category list, derived from the labels above so the two can
 * never drift. The game itself still treats `type` as a free string - this
 * is the allow-list for *generated* mysteries, which are untrusted input.
 */
export const MYSTERY_TYPES = Object.keys(MYSTERY_TYPE_LABELS);

export function isMysteryType(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(MYSTERY_TYPE_LABELS, value);
}

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
}

/** How much AI-generated text we are willing to render. */
export const CLUE_MIN_LENGTH = 10;
export const CLUE_MAX_LENGTH = 200;
export const ANSWER_MAX_LENGTH = 60;
export const TITLE_MAX_LENGTH = 48;
export const OPTIONS_MIN = 4;
export const OPTIONS_MAX = 6;

/** Worst-case bound on one generation request, so a host cannot spend the day. */
export const MAX_POOL_SIZE = 10;

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
}

/** The evaluator's verdict. Advisory: it never gates the game, only the host. */
export interface MysteryEvaluation {
  approved: boolean;
  /** 0-100. */
  score: number;
  /** 0-1, higher means more than one option could defensibly be right. */
  ambiguity: number;
  difficulty: Difficulty;
  feedback: string[];
}

export type CandidateStatus = 'pending' | 'approved' | 'rejected';

/**
 * A generated mystery on its way through review. `mystery` is exactly the
 * shape the game already plays, so approving one is a copy, not a conversion.
 */
export interface MysteryCandidate {
  mystery: Mystery;
  difficulty: Difficulty;
  issues: ValidationIssue[];
  evaluation: MysteryEvaluation | null;
  status: CandidateStatus;
}

/**
 * Progress of the automatic question pool.
 *
 * `ai` counts mysteries written and accepted for this event; the shortfall
 * against `wanted` is covered by the built-in bank, which is why the game
 * still runs when the model is having a bad day.
 */
export interface PoolStatus {
  wanted: number;
  ai: number;
  categories: string[];
  difficulty: Difficulty;
  /** Set when the last preparation attempt failed, for the host to see. */
  lastError: string | null;
  /**
   * Server epoch ms at which preparation gives up, or null before it starts.
   * On the wire rather than computed on the client so the lobby countdown
   * uses the same clock as the game's.
   */
  expiresAt: number | null;
}

/**
 * How long the pool gets before it is declared a failure and the built-in
 * bank takes over.
 *
 * Two minutes is about as long as a room will wait while the host stands
 * there, and the fallback is a complete, hand-written game rather than a
 * degraded one - so the cost of giving up early is much lower than the cost
 * of a lobby that never resolves.
 */
export const POOL_DEADLINE_MS = 120_000;

export interface GenerationRequest {
  categories: string[];
  difficulty: Difficulty;
  count: number;
}

export function typeLabel(type: string): { label: string; emoji: string } {
  return MYSTERY_TYPE_LABELS[type] ?? { label: type.replace(/_/g, ' '), emoji: '\u{1F50D}' };
}
