/**
 * Credentials live in localStorage so a player who backgrounds their phone,
 * loses signal or reloads mid-round comes straight back to their seat with
 * their score and their locked-in answer intact.
 */

export interface PlayerSession {
  eventCode: string;
  playerId: string;
  playerToken: string;
  nickname: string;
  eventName: string;
}

export interface HostSession {
  eventCode: string;
  hostToken: string;
  eventName: string;
}

const PLAYER_KEY = (code: string) => `mysteryrush.player.${code}`;
const HOST_KEY = (code: string) => `mysteryrush.host.${code}`;
const LAST_PLAYER = 'mysteryrush.lastPlayerCode';
const LAST_HOST = 'mysteryrush.lastHostCode';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Private browsing, disabled storage, or corrupt JSON: behave as a fresh visitor.
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable - the session just will not survive a reload */
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

export const session = {
  savePlayer(s: PlayerSession): void {
    write(PLAYER_KEY(s.eventCode), s);
    write(LAST_PLAYER, s.eventCode);
  },
  getPlayer(code: string): PlayerSession | null {
    return read<PlayerSession>(PLAYER_KEY(code));
  },
  clearPlayer(code: string): void {
    drop(PLAYER_KEY(code));
  },
  lastPlayerCode(): string | null {
    return read<string>(LAST_PLAYER);
  },

  saveHost(s: HostSession): void {
    write(HOST_KEY(s.eventCode), s);
    write(LAST_HOST, s.eventCode);
  },
  getHost(code: string): HostSession | null {
    return read<HostSession>(HOST_KEY(code));
  },
  clearHost(code: string): void {
    drop(HOST_KEY(code));
  },
  lastHostCode(): string | null {
    return read<string>(LAST_HOST);
  },

  soundPref(): 'on' | 'off' | null {
    return read<'on' | 'off'>(SOUND_KEY);
  },
  saveSoundPref(value: 'on' | 'off'): void {
    write(SOUND_KEY, value);
  },
};

const SOUND_KEY = 'mysteryrush.sound';

