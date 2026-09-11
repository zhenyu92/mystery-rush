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
  createEvent: (eventName: string, plannedRounds: number | null) =>
    request<CreatedEvent>('/api/events', {
      method: 'POST',
      body: JSON.stringify({ eventName, plannedRounds }),
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
