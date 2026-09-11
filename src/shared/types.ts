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

/** Points for a correct answer, indexed by clue number (1-based). */
export const CLUE_POINTS: readonly number[] = [500, 400, 300, 200, 100];

/** Points a correct answer submitted during `clueNumber` is worth. */
export function pointsForClue(clueNumber: number): number {
  return CLUE_POINTS[clueNumber - 1] ?? 0;
}

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
  /** Server epoch ms at the moment the snapshot was built. */
  serverTime: number;
}

/** A mystery as offered to the host in the picker - no answer, no clues. */
export interface MysteryChoice {
  id: string;
  type: string;
  title: string;
  used: boolean;
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
  | { type: 'host'; action: HostAction; mysteryId?: string; playerId?: string };

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

export function typeLabel(type: string): { label: string; emoji: string } {
  return MYSTERY_TYPE_LABELS[type] ?? { label: type.replace(/_/g, ' '), emoji: '\u{1F50D}' };
}
