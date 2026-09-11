/**
 * An in-memory stand-in for D1.
 *
 * Small on purpose: it understands only the statements `src/worker/db.ts`
 * actually issues, matched by shape. That is enough to assert what lands in
 * the archive, and it reproduces the two D1 behaviours the code leans on -
 * `bind()` returning a *new* statement (db.ts binds one prepared statement
 * once per row) and `batch()` running everything or nothing.
 */

export interface EventRow {
  event_code: string;
  event_name: string;
  host_token_hash: string;
  phase: string;
  created_at: number;
  updated_at: number;
}

export interface PlayerRow {
  id: string;
  event_code: string;
  nickname: string;
  score: number;
  correct_answers: number;
  mysteries_played: number;
  best_streak: number;
  total_response_ms: number;
  joined_at: number;
}

export interface RoundRow {
  id: string;
  event_code: string;
  mystery_id: string;
  round_index: number;
  points_multiplier: number;
  status: string;
  started_at: number;
  ended_at: number | null;
}

export interface AnswerRow {
  round_id: string;
  player_id: string;
  event_code: string;
  selected_option: string;
  submitted_at: number;
  clue_number: number;
  is_correct: number;
  points_awarded: number;
  bonus_points: number;
  multiplier: number;
  response_ms: number;
}

export class FakeD1 {
  readonly events = new Map<string, EventRow>();
  readonly players = new Map<string, PlayerRow>();
  readonly rounds = new Map<string, RoundRow>();
  readonly answers = new Map<string, AnswerRow>();

  /** Every statement executed, in order, for assertions about the hot path. */
  readonly log: string[] = [];
  /** When set, every statement throws - a stand-in for a D1 outage. */
  failing = false;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql, []);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    if (this.failing) throw new Error('D1 unavailable');
    // All or nothing: apply to a copy, then swap in.
    const snapshot = this.snapshot();
    try {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    } catch (err) {
      this.restore(snapshot);
      throw err;
    }
  }

  private snapshot() {
    return {
      events: new Map(this.events),
      players: new Map(this.players),
      rounds: new Map(this.rounds),
      answers: new Map(this.answers),
    };
  }

  private restore(s: ReturnType<FakeD1['snapshot']>) {
    for (const [key, table] of [
      ['events', s.events],
      ['players', s.players],
      ['rounds', s.rounds],
      ['answers', s.answers],
    ] as const) {
      const live = this[key] as Map<string, unknown>;
      live.clear();
      for (const [k, v] of table as Map<string, unknown>) live.set(k, v);
    }
  }
}

export class FakeStatement {
  readonly db: FakeD1;
  readonly sql: string;
  readonly args: unknown[];

  constructor(db: FakeD1, sql: string, args: unknown[]) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  /** D1's `bind` returns a new statement; it never mutates the prepared one. */
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    if (this.db.failing) throw new Error('D1 unavailable');
    this.db.log.push(this.sql);
    if (/SELECT 1 AS ok FROM events/.test(this.sql)) {
      return this.db.events.has(String(this.args[0])) ? ({ ok: 1 } as T) : null;
    }
    throw new Error(`FakeD1: unsupported first(): ${this.sql}`);
  }

  async run(): Promise<{ success: true }> {
    if (this.db.failing) throw new Error('D1 unavailable');
    this.db.log.push(this.sql);
    const a = this.args;

    if (/^INSERT INTO events/.test(this.sql)) {
      const code = String(a[0]);
      if (!this.db.events.has(code)) {
        this.db.events.set(code, {
          event_code: code,
          event_name: String(a[1]),
          host_token_hash: String(a[2]),
          phase: 'lobby',
          created_at: Number(a[3]),
          updated_at: Number(a[4]),
        });
      }
      return { success: true };
    }

    if (/^UPDATE events SET phase = \?/.test(this.sql)) {
      const row = this.db.events.get(String(a[2]));
      if (row) {
        row.phase = String(a[0]);
        row.updated_at = Number(a[1]);
      }
      return { success: true };
    }

    if (/^UPDATE events SET phase = 'lobby'/.test(this.sql)) {
      const row = this.db.events.get(String(a[1]));
      if (row) {
        row.phase = 'lobby';
        row.updated_at = Number(a[0]);
      }
      return { success: true };
    }

    if (/^INSERT INTO players/.test(this.sql)) {
      const id = String(a[0]);
      const existing = this.db.players.get(id);
      this.db.players.set(id, {
        id,
        event_code: String(a[1]),
        nickname: String(a[2]),
        score: Number(a[3]),
        correct_answers: Number(a[4]),
        mysteries_played: Number(a[5]),
        best_streak: Number(a[6]),
        total_response_ms: Number(a[7]),
        // ON CONFLICT does not touch joined_at, matching the real statement.
        joined_at: existing ? existing.joined_at : Number(a[8]),
      });
      return { success: true };
    }

    // The real statement spans lines, so match across whitespace.
    if (/^UPDATE players\s+SET score = 0/.test(this.sql)) {
      for (const row of this.db.players.values()) {
        if (row.event_code === String(a[0])) {
          row.score = 0;
          row.correct_answers = 0;
          row.mysteries_played = 0;
          row.best_streak = 0;
          row.total_response_ms = 0;
        }
      }
      return { success: true };
    }

    if (/^INSERT INTO rounds/.test(this.sql)) {
      const id = String(a[0]);
      if (!this.db.rounds.has(id)) {
        this.db.rounds.set(id, {
          id,
          event_code: String(a[1]),
          mystery_id: String(a[2]),
          round_index: Number(a[3]),
          points_multiplier: Number(a[4]),
          status: 'active',
          started_at: Number(a[5]),
          ended_at: null,
        });
      }
      return { success: true };
    }

    if (/^UPDATE rounds SET status = 'ended'/.test(this.sql)) {
      const row = this.db.rounds.get(String(a[1]));
      if (row) {
        row.status = 'ended';
        row.ended_at = Number(a[0]);
      }
      return { success: true };
    }

    if (/^INSERT INTO\s+answers/.test(this.sql)) {
      const key = `${String(a[0])}::${String(a[1])}`;
      if (!this.db.answers.has(key)) {
        this.db.answers.set(key, {
          round_id: String(a[0]),
          player_id: String(a[1]),
          event_code: String(a[2]),
          selected_option: String(a[3]),
          submitted_at: Number(a[4]),
          clue_number: Number(a[5]),
          is_correct: Number(a[6]),
          points_awarded: Number(a[7]),
          bonus_points: Number(a[8]),
          multiplier: Number(a[9]),
          response_ms: Number(a[10]),
        });
      }
      return { success: true };
    }

    if (/^DELETE FROM answers/.test(this.sql)) {
      for (const [key, row] of this.db.answers) {
        if (row.event_code === String(a[0])) this.db.answers.delete(key);
      }
      return { success: true };
    }

    if (/^DELETE FROM rounds/.test(this.sql)) {
      for (const [key, row] of this.db.rounds) {
        if (row.event_code === String(a[0])) this.db.rounds.delete(key);
      }
      return { success: true };
    }

    throw new Error(`FakeD1: unsupported run(): ${this.sql}`);
  }
}
