/**
 * D1 write-through helpers.
 *
 * Every function here is best-effort: the Durable Object is the authority for
 * a running event, so a D1 hiccup must never stall a round. Failures are
 * logged and swallowed, and callers hand these to `waitUntil` rather than
 * awaiting them on the hot path.
 */

export interface Env {
  DB: D1Database;
  EVENT_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export interface ArchivedPlayer {
  id: string;
  nickname: string;
  score: number;
  correctAnswers: number;
  mysteriesPlayed: number;
  bestStreak: number;
  totalResponseMs: number;
  joinedAt: number;
}

export interface ArchivedAnswer {
  roundId: string;
  playerId: string;
  selectedOption: string;
  submittedAt: number;
  clueNumber: number;
  isCorrect: boolean;
  pointsAwarded: number;
  responseMs: number;
}

async function quiet(label: string, work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (err) {
    console.error(`[d1] ${label} failed:`, err);
  }
}

export async function createEventRow(
  db: D1Database,
  row: { eventCode: string; eventName: string; hostTokenHash: string; createdAt: number },
): Promise<void> {
  await quiet(
    'createEvent',
    db
      .prepare(
        `INSERT INTO events (event_code, event_name, host_token_hash, phase, created_at, updated_at)
         VALUES (?, ?, ?, 'lobby', ?, ?)
         ON CONFLICT (event_code) DO NOTHING`,
      )
      .bind(row.eventCode, row.eventName, row.hostTokenHash, row.createdAt, row.createdAt)
      .run(),
  );
}

/** Does this code belong to a real event? Cheap pre-check before waking a room. */
export async function eventExists(db: D1Database, eventCode: string): Promise<boolean> {
  try {
    const row = await db
      .prepare('SELECT 1 AS ok FROM events WHERE event_code = ?')
      .bind(eventCode)
      .first<{ ok: number }>();
    return row?.ok === 1;
  } catch (err) {
    console.error('[d1] eventExists failed:', err);
    // Fail open: the Durable Object re-checks that the room is initialised,
    // so a D1 outage degrades to "slightly slower rejection", not an outage.
    return true;
  }
}

export async function setEventPhase(db: D1Database, eventCode: string, phase: string): Promise<void> {
  await quiet(
    'setEventPhase',
    db
      .prepare('UPDATE events SET phase = ?, updated_at = ? WHERE event_code = ?')
      .bind(phase, Date.now(), eventCode)
      .run(),
  );
}

export async function upsertPlayer(db: D1Database, eventCode: string, p: ArchivedPlayer): Promise<void> {
  await quiet(
    'upsertPlayer',
    db
      .prepare(
        `INSERT INTO players
           (id, event_code, nickname, score, correct_answers, mysteries_played, best_streak, total_response_ms, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           nickname = excluded.nickname,
           score = excluded.score,
           correct_answers = excluded.correct_answers,
           mysteries_played = excluded.mysteries_played,
           best_streak = excluded.best_streak,
           total_response_ms = excluded.total_response_ms`,
      )
      .bind(
        p.id,
        eventCode,
        p.nickname,
        p.score,
        p.correctAnswers,
        p.mysteriesPlayed,
        p.bestStreak,
        p.totalResponseMs,
        p.joinedAt,
      )
      .run(),
  );
}

export async function recordRoundStart(
  db: D1Database,
  row: { id: string; eventCode: string; mysteryId: string; roundIndex: number; startedAt: number },
): Promise<void> {
  await quiet(
    'recordRoundStart',
    db
      .prepare(
        `INSERT INTO rounds (id, event_code, mystery_id, round_index, status, started_at)
         VALUES (?, ?, ?, ?, 'active', ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(row.id, row.eventCode, row.mysteryId, row.roundIndex, row.startedAt)
      .run(),
  );
}

/**
 * Archive a finished round: mark it ended, store every answer, and refresh the
 * players' running totals. Sent as one batch so the round lands atomically.
 */
export async function recordRoundEnd(
  db: D1Database,
  eventCode: string,
  roundId: string,
  endedAt: number,
  answers: ArchivedAnswer[],
  players: ArchivedPlayer[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE rounds SET status = 'ended', ended_at = ? WHERE id = ?`)
      .bind(endedAt, roundId),
  ];

  const answerStmt = db.prepare(
    `INSERT INTO answers
       (round_id, player_id, event_code, selected_option, submitted_at, clue_number, is_correct, points_awarded, response_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (round_id, player_id) DO NOTHING`,
  );
  for (const a of answers) {
    statements.push(
      answerStmt.bind(
        a.roundId,
        a.playerId,
        eventCode,
        a.selectedOption,
        a.submittedAt,
        a.clueNumber,
        a.isCorrect ? 1 : 0,
        a.pointsAwarded,
        a.responseMs,
      ),
    );
  }

  const playerStmt = db.prepare(
    `INSERT INTO players
       (id, event_code, nickname, score, correct_answers, mysteries_played, best_streak, total_response_ms, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       nickname = excluded.nickname,
       score = excluded.score,
       correct_answers = excluded.correct_answers,
       mysteries_played = excluded.mysteries_played,
       best_streak = excluded.best_streak,
       total_response_ms = excluded.total_response_ms`,
  );
  for (const p of players) {
    statements.push(
      playerStmt.bind(
        p.id,
        eventCode,
        p.nickname,
        p.score,
        p.correctAnswers,
        p.mysteriesPlayed,
        p.bestStreak,
        p.totalResponseMs,
        p.joinedAt,
      ),
    );
  }

  await quiet('recordRoundEnd', db.batch(statements));
}

/** Wipe an event's results while keeping the event and its players' identities. */
export async function resetEventRows(db: D1Database, eventCode: string): Promise<void> {
  await quiet(
    'resetEvent',
    db.batch([
      db.prepare('DELETE FROM answers WHERE event_code = ?').bind(eventCode),
      db.prepare('DELETE FROM rounds WHERE event_code = ?').bind(eventCode),
      db
        .prepare(
          `UPDATE players
             SET score = 0, correct_answers = 0, mysteries_played = 0,
                 best_streak = 0, total_response_ms = 0
           WHERE event_code = ?`,
        )
        .bind(eventCode),
      db.prepare(`UPDATE events SET phase = 'lobby', updated_at = ? WHERE event_code = ?`).bind(Date.now(), eventCode),
    ]),
  );
}
