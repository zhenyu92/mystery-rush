import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientMessage,
  MysteryChoice,
  PlayerSelf,
  ServerMessage,
  Snapshot,
} from '../../shared/types';

export interface HostBrief {
  roundId: string;
  answer: string;
  clues: string[];
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed';

export interface GameSocket {
  status: ConnectionStatus;
  snapshot: Snapshot | null;
  self: PlayerSelf | null;
  catalog: MysteryChoice[];
  /** Host sockets only: the answer sheet for the live round. */
  hostBrief: HostBrief | null;
  /** Add to Date.now() to get the server's clock. */
  clockOffset: number;
  lastError: { code: string; message: string; at: number } | null;
  fatal: string | null;
  send: (message: ClientMessage) => void;
  clearError: () => void;
}

export interface SocketConfig {
  code: string;
  role: 'player' | 'host' | 'display';
  playerId?: string;
  playerToken?: string;
  hostToken?: string;
  /** Set false to hold off connecting until credentials exist. */
  enabled?: boolean;
}

const PING_INTERVAL_MS = 12_000;
const MAX_SILENT_RETRIES = 6;

/**
 * One WebSocket to the event's Durable Object, with reconnection and a
 * running estimate of the server clock.
 *
 * The offset matters: the countdown is drawn from the server's `clueEndsAt`,
 * so a phone whose clock is a minute fast would otherwise show the wrong
 * time remaining (or miss the round entirely). We keep the sample from the
 * fastest round trip we have seen, which is the least polluted by jitter.
 */
export function useGameSocket(config: SocketConfig): GameSocket {
  const { code, role, playerId, playerToken, hostToken, enabled = true } = config;

  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [self, setSelf] = useState<PlayerSelf | null>(null);
  const [catalog, setCatalog] = useState<MysteryChoice[]>([]);
  const [hostBrief, setHostBrief] = useState<HostBrief | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [lastError, setLastError] = useState<GameSocket['lastError']>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const bestRttRef = useRef(Number.POSITIVE_INFINITY);
  const retriesRef = useRef(0);
  const closedByUsRef = useRef(false);

  useEffect(() => {
    if (!enabled || !code) return;
    if (role === 'player' && (!playerId || !playerToken)) return;
    if (role === 'host' && !hostToken) return;

    closedByUsRef.current = false;
    bestRttRef.current = Number.POSITIVE_INFINITY;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;

    const url = () => {
      const params = new URLSearchParams({ code, role });
      if (role === 'player') {
        params.set('playerId', playerId!);
        params.set('playerToken', playerToken!);
      }
      if (role === 'host') params.set('hostToken', hostToken!);
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${window.location.host}/ws?${params.toString()}`;
    };

    const connect = () => {
      if (disposed) return;
      setStatus(retriesRef.current === 0 ? 'connecting' : 'reconnecting');

      let ws: WebSocket;
      try {
        ws = new WebSocket(url());
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        retriesRef.current = 0;
        setStatus('open');
        setFatal(null);
        ping(ws);
        pingTimer = setInterval(() => ping(ws), PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string') return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handle(msg);
      };

      ws.onclose = (event) => {
        if (pingTimer) clearInterval(pingTimer);
        if (disposed || closedByUsRef.current) return;
        if (event.code === 4003) {
          setFatal('The host removed you from this event.');
          setStatus('closed');
          return;
        }
        scheduleReconnect();
      };

      ws.onerror = () => {
        // `onclose` always follows, and handles the retry.
      };
    };

    const handle = (msg: ServerMessage) => {
      switch (msg.type) {
        case 'welcome':
          if (msg.self) setSelf(msg.self);
          return;
        case 'snapshot':
          setSnapshot(msg.snapshot);
          setSelf(msg.self);
          return;
        case 'catalog':
          setCatalog(msg.mysteries);
          return;
        case 'host_brief':
          setHostBrief({ roundId: msg.roundId, answer: msg.answer, clues: msg.clues });
          return;
        case 'pong': {
          const now = Date.now();
          const rtt = now - msg.clientTime;
          if (rtt >= 0 && rtt < bestRttRef.current) {
            bestRttRef.current = rtt;
            // Assume a symmetric round trip: the server's "now" when it replied
            // was msg.serverTime, which lands at now - rtt/2 on our clock.
            setClockOffset(msg.serverTime + rtt / 2 - now);
          }
          return;
        }
        case 'error':
          setLastError({ code: msg.code, message: msg.message, at: Date.now() });
          return;
        default:
          return;
      }
    };

    const ping = (ws: WebSocket) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() } satisfies ClientMessage));
      }
    };

    const scheduleReconnect = () => {
      retriesRef.current += 1;
      if (retriesRef.current > MAX_SILENT_RETRIES) {
        setStatus('failed');
      } else {
        setStatus('reconnecting');
      }
      // Exponential backoff with jitter, capped so a projector left running
      // overnight still recovers reasonably quickly.
      const delay = Math.min(800 * 2 ** (retriesRef.current - 1), 10_000);
      reconnectTimer = setTimeout(connect, delay + Math.random() * 400);
    };

    connect();

    return () => {
      disposed = true;
      closedByUsRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [code, role, playerId, playerToken, hostToken, enabled]);

  // A phone coming back from the lock screen should not sit on a stale view.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() } satisfies ClientMessage));
      } else if (ws && ws.readyState === WebSocket.CLOSED) {
        retriesRef.current = 0;
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    else setLastError({ code: 'offline', message: 'Reconnecting - try again in a moment.', at: Date.now() });
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  return { status, snapshot, self, catalog, hostBrief, clockOffset, lastError, fatal, send, clearError };
}
