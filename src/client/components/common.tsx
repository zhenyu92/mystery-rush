import { useEffect, type ReactNode } from 'react';
import type { ConnectionStatus } from '../lib/useGameSocket';

export function Brand({ large = false, tagline }: { large?: boolean; tagline?: string }) {
  return (
    <div className={large ? 'brand brand--lg' : 'brand'}>
      <div className="brand__mark" aria-hidden="true">
        {'\u{1F50D}'}
      </div>
      <div>
        <div className="brand__name">
          MYSTERY <span>RUSH</span>
        </div>
        {tagline ? <div className="brand__tag">{tagline}</div> : null}
      </div>
    </div>
  );
}

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const label =
    status === 'open'
      ? 'Live'
      : status === 'failed'
        ? 'Offline'
        : status === 'closed'
          ? 'Disconnected'
          : 'Reconnecting';
  const cls = status === 'open' ? 'dot dot--on' : status === 'failed' ? 'dot dot--off' : 'dot dot--pulse';
  return (
    <span className="pill pill--muted" title={label}>
      <span className={cls} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Countdown ring. `fraction` is how much of the clue window is left, so the
 * arc drains clockwise as the clock runs down.
 */
export function TimerRing({
  seconds,
  fraction,
  size = 'md',
  paused = false,
}: {
  seconds: number;
  fraction: number;
  size?: 'md' | 'xl';
  paused?: boolean;
}) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const tone = paused ? '' : seconds <= 5 ? ' timer--danger' : seconds <= 10 ? ' timer--warn' : '';

  return (
    <div className={`timer__ring${size === 'xl' ? ' timer__ring--xl' : ''}${tone}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="timer__track" cx="50" cy="50" r={radius} strokeWidth="8" />
        <circle
          className="timer__progress"
          cx="50"
          cy="50"
          r={radius}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <div className="timer__value" role="timer" aria-live="off">
        {paused ? '⏸' : seconds}
      </div>
    </div>
  );
}

export function Modal({
  title,
  children,
  onCancel,
  confirmLabel,
  onConfirm,
  danger = false,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal__title">{title}</h2>
        <div className="modal__body">{children}</div>
        <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className={danger ? 'btn btn--danger' : 'btn btn--primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toast({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <div className={error ? 'toast toast--error' : 'toast'} role="status">
      {message}
    </div>
  );
}

export function formatXp(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Tiebreak times, as seconds to one decimal. Rounds a player never solved
 * are charged the full round length, so a big number here means "often did
 * not get there", which is exactly what it should mean.
 */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** "1 mystery" / "3 mysteries" - it shows up on every screen. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
