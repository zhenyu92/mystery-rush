import type { Difficulty } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 'offline', 0);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      (body.message as string) ?? 'Something went wrong.',
      (body.error as string) ?? 'error',
      res.status,
    );
  }
  return body as T;
}

export interface CreatedEvent {
  eventCode: string;
  eventName: string;
  hostToken: string;
  plannedRounds: number | null;
  categories: string[];
  difficulty: Difficulty;
}

/** One slice of pool preparation, as reported back to the lobby. */
export interface PoolProgress {
  added: number;
  rejected?: number;
  have: number;
  wanted: number;
  /** True when there is nothing further worth asking for. */
  done: boolean;
  /** Set when the two-minute budget ran out. Retrying cannot help. */
  timedOut?: boolean;
  error: string | null;
}

export interface JoinedEvent {
  playerId: string;
  playerToken: string;
  nickname: string;
  eventName: string;
  eventCode: string;
  resumed: boolean;
}

export const api = {
  createEvent: (body: {
    eventName: string;
    plannedRounds: number | null;
    categories: string[];
    difficulty: Difficulty;
  }) =>
    request<CreatedEvent>('/api/events', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Write the next few of this event's questions.
   *
   * One call is one small batch, so the lobby can show the pool filling up
   * rather than a spinner that might be stuck. What to write is decided by the
   * server from what the host chose at creation; all this sends is the
   * credential.
   */
  preparePool: (code: string, hostToken: string) =>
    request<PoolProgress>(`/api/events/${encodeURIComponent(code)}/pool`, {
      method: 'POST',
      body: JSON.stringify({ hostToken }),
    }),

  lookupEvent: (code: string) =>
    request<{ exists: boolean; eventName: string | null }>(`/api/events/${encodeURIComponent(code)}`),

  join: (code: string, payload: { nickname?: string; playerId?: string; playerToken?: string }) =>
    request<JoinedEvent>(`/api/events/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  mysteryStats: () => request<{ total: number; byType: Record<string, number> }>('/api/mysteries'),
};
