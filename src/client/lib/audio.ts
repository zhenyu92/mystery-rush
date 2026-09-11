/**
 * Game-show sound, synthesised in the browser.
 *
 * No audio files, no CDN, no dependency — the same choice the confetti makes,
 * for the same reason: a handful of oscillators is less to go wrong on the
 * night than assets that have to load over conference-centre wifi.
 *
 * Two rules run through all of it:
 *
 *   - Everything is scheduled against `ctx.currentTime`, never `setTimeout`.
 *     A backgrounded tab clamps timers to roughly 1Hz, and the host *will*
 *     alt-tab to their console, which would turn a drumroll into a series of
 *     unrelated thumps.
 *   - Nothing here may throw. Audio is decoration; if it fails, the game
 *     carries on silently.
 *
 * This is projector-only by construction — see `arm()`.
 */

export type Cue =
  | 'intro-tick'
  | 'intro-go'
  | 'clue'
  | 'urgent-tick'
  | 'round-end'
  | 'drumroll'
  | 'reveal'
  | 'lb-move'
  | 'fanfare';

/**
 * How long after the round-end stab the reveal chord lands. The results
 * scene is delayed by the same amount so the answer appears *with* the
 * chord — a reveal sound two seconds adrift of the reveal is worse than no
 * sound at all.
 */
export const REVEAL_LEAD_MS = 2050;

type Ctx = AudioContext & { resume(): Promise<void> };

let ctx: Ctx | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let enabled = false;
let armedBy: 'display' | null = null;

function AudioCtor(): typeof AudioContext | null {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function ensureContext(): boolean {
  if (ctx) return true;
  const Ctor = AudioCtor();
  if (!Ctor) return false;
  ctx = new Ctor() as Ctx;

  // The fanfare stacks six voices; without a compressor an HDMI output
  // clips audibly on the loudest moment of the night.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 12;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;

  master = ctx.createGain();
  master.gain.value = 0.75;
  master.connect(comp);
  comp.connect(ctx.destination);
  return true;
}

/** One buffer, reused. Building one per drumroll hit (28 of them) stutters. */
function ensureNoise(c: Ctx): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const frames = Math.floor(c.sampleRate);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

interface ToneOpts {
  freq: number;
  dur: number;
  type?: OscillatorType;
  peak?: number;
  detune?: number;
}

function tone(at: number, o: ToneOpts): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = o.type ?? 'triangle';
  osc.frequency.value = o.freq;
  if (o.detune) osc.detune.value = o.detune;
  const peak = o.peak ?? 0.3;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.006);
  // Ramping to exactly 0 throws; 0.0001 is inaudible and legal.
  gain.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
  osc.connect(gain);
  gain.connect(master);
  osc.start(at);
  osc.stop(at + o.dur + 0.02);
}

function sweep(at: number, o: { from: number; to: number; dur: number; type?: OscillatorType; peak?: number }): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.from, at);
  osc.frequency.exponentialRampToValueAtTime(o.to, at + o.dur);
  const peak = o.peak ?? 0.28;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
  osc.connect(gain);
  gain.connect(master);
  osc.start(at);
  osc.stop(at + o.dur + 0.02);
}

function noise(
  at: number,
  o: { dur: number; peak?: number; filter?: { type: BiquadFilterType; freq: number; q?: number } },
): void {
  if (!ctx || !master) return;
  const src = ctx.createBufferSource();
  src.buffer = ensureNoise(ctx);
  const gain = ctx.createGain();
  const peak = o.peak ?? 0.2;
  gain.gain.setValueAtTime(peak, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);

  let node: AudioNode = src;
  if (o.filter) {
    const biquad = ctx.createBiquadFilter();
    biquad.type = o.filter.type;
    biquad.frequency.value = o.filter.freq;
    if (o.filter.q) biquad.Q.value = o.filter.q;
    src.connect(biquad);
    node = biquad;
  }
  node.connect(gain);
  gain.connect(master);
  src.start(at);
  src.stop(at + o.dur + 0.02);
}

/** Slight per-voice detune so a chord reads as an ensemble, not a synth beep. */
function chord(at: number, freqs: number[], o: { dur: number; type?: OscillatorType; peak?: number }): void {
  freqs.forEach((freq, i) => tone(at, { freq, dur: o.dur, type: o.type, peak: o.peak, detune: i * 4 }));
}

function render(cue: Cue, at: number): void {
  switch (cue) {
    case 'intro-tick':
      tone(at, { freq: 660, dur: 0.09, peak: 0.25 });
      return;
    case 'intro-go':
      tone(at, { freq: 990, dur: 0.22, peak: 0.3 });
      tone(at + 0.04, { freq: 1320, dur: 0.2, peak: 0.24 });
      return;
    case 'clue':
      sweep(at, { from: 420, to: 880, dur: 0.16, peak: 0.26 });
      tone(at + 0.09, { freq: 1760, dur: 0.07, peak: 0.18 });
      noise(at, { dur: 0.12, peak: 0.07, filter: { type: 'bandpass', freq: 3000, q: 2 } });
      return;
    case 'urgent-tick':
      tone(at, { freq: 1200, dur: 0.045, type: 'square', peak: 0.18 });
      return;
    case 'round-end':
      tone(at, { freq: 587, dur: 0.16, peak: 0.3 });
      tone(at + 0.11, { freq: 440, dur: 0.16, peak: 0.3 });
      tone(at + 0.22, { freq: 294, dur: 0.3, peak: 0.32 });
      noise(at + 0.22, { dur: 0.25, peak: 0.16, filter: { type: 'lowpass', freq: 180 } });
      return;
    case 'drumroll': {
      let t = at;
      for (let i = 0; i < 28; i++) {
        noise(t, {
          dur: 0.06,
          peak: 0.09 + (i / 28) * 0.1,
          filter: { type: 'bandpass', freq: 900 + (i / 28) * 1300, q: 1.4 },
        });
        t += 0.09 * (1 - i / 34);
      }
      noise(t, { dur: 1.2, peak: 0.22, filter: { type: 'highpass', freq: 5000 } });
      return;
    }
    case 'reveal':
      chord(at, [523, 659, 784, 1047], { dur: 0.9, peak: 0.2 });
      return;
    case 'lb-move':
      tone(at, { freq: 784, dur: 0.08, peak: 0.18 });
      tone(at + 0.07, { freq: 988, dur: 0.08, peak: 0.18 });
      tone(at + 0.14, { freq: 1175, dur: 0.12, peak: 0.18 });
      return;
    case 'fanfare': {
      const lead: Array<[number, number, number]> = [
        [392, 0.0, 0.14],
        [392, 0.16, 0.14],
        [392, 0.32, 0.14],
        [523, 0.48, 0.34],
        [659, 0.86, 0.18],
        [784, 1.06, 0.18],
        [1047, 1.26, 1.1],
      ];
      for (const [freq, offset, dur] of lead) {
        tone(at + offset, { freq, dur, type: 'square', peak: 0.16 });
        tone(at + offset, { freq: freq / 1.5, dur, type: 'triangle', peak: 0.12 });
      }
      noise(at + 0.48, { dur: 0.8, peak: 0.16, filter: { type: 'highpass', freq: 4800 } });
      noise(at + 1.26, { dur: 1.6, peak: 0.2, filter: { type: 'highpass', freq: 4200 } });
      return;
    }
    default:
      return;
  }
}

export const stageAudio = {
  isSupported(): boolean {
    return AudioCtor() !== null;
  },

  isEnabled(): boolean {
    return enabled;
  },

  /**
   * Only the projector may make noise. Thirty phones drifting a few hundred
   * milliseconds apart over a jittery socket is mush, not atmosphere — the
   * phone's channel is haptics. `enable()` refuses until this has been
   * called, so a future copy-paste into the player screen fails silently
   * rather than chiming the whole room.
   */
  arm(owner: 'display'): void {
    armedBy = owner;
  },

  /** Must be called from a user gesture; browsers block audio otherwise. */
  async enable(): Promise<boolean> {
    try {
      if (armedBy !== 'display') return false;
      if (!ensureContext() || !ctx) return false;
      if (ctx.state === 'suspended') await ctx.resume();
      enabled = true;
      return true;
    } catch {
      return false;
    }
  },

  disable(): void {
    enabled = false;
  },

  setVolume(v: number): void {
    try {
      if (master) master.gain.value = Math.max(0, Math.min(1, v));
    } catch {
      /* decoration */
    }
  },

  /**
   * Chrome suspends a backgrounded context and will not resume it by itself.
   * Without this, one alt-tab to the host console kills sound for the night.
   */
  resumeIfSuspended(): void {
    try {
      if (enabled && ctx && ctx.state === 'suspended') void ctx.resume();
    } catch {
      /* decoration */
    }
  },

  play(cue: Cue): void {
    try {
      if (!enabled || !ctx) return;
      render(cue, ctx.currentTime + 0.02);
    } catch {
      /* decoration */
    }
  },

  /** The reveal is a three-beat moment, not one cue: stab, roll, chord. */
  playRevealSequence(): void {
    try {
      if (!enabled || !ctx) return;
      const t = ctx.currentTime + 0.02;
      render('round-end', t);
      render('drumroll', t + 0.25);
      render('reveal', t + REVEAL_LEAD_MS / 1000);
    } catch {
      /* decoration */
    }
  },
};
