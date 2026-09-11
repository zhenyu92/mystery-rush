import { useEffect, useRef } from 'react';
import type { PublicRound, Snapshot } from '../../shared/types';
import { stageAudio } from './audio';

/**
 * Turns snapshot changes into sound cues. Projector only — this module is
 * imported by Display and nothing else.
 *
 * Every piece of state here is a ref, never `useState`: the countdown
 * re-renders this component ten times a second, and a hook that re-rendered
 * on top of that would be a waste at best and a loop at worst.
 */
export function useStageAudio(args: {
  phase: Snapshot['phase'] | undefined;
  round: PublicRound | null;
  seconds: number;
  finaleStage: string;
  finaleTick: number;
  reducedMotion: boolean;
}): void {
  const { phase, round, seconds, finaleStage, finaleTick, reducedMotion } = args;

  const prevPhase = useRef<string | undefined>(undefined);
  const prevClue = useRef(0);
  const prevRoundId = useRef<string | null>(null);
  const prevIntroSecond = useRef(-1);
  const prevTickSecond = useRef(-1);
  const prevFinaleStage = useRef('');
  const prevFinaleTick = useRef(-1);
  const primed = useRef(false);

  useEffect(() => {
    const on = stageAudio.isEnabled();

    // Seed every edge from the current snapshot the first time round after
    // sound is switched on, so enabling mid-round does not fire a backlog.
    if (!on) {
      primed.current = false;
      return;
    }
    if (!primed.current) {
      primed.current = true;
      prevPhase.current = phase;
      prevClue.current = round?.currentClue ?? 0;
      prevRoundId.current = round?.roundId ?? null;
      prevIntroSecond.current = seconds;
      prevTickSecond.current = seconds;
      prevFinaleStage.current = finaleStage;
      prevFinaleTick.current = finaleTick;
      return;
    }

    const roundId = round?.roundId ?? null;
    if (roundId !== prevRoundId.current) {
      prevRoundId.current = roundId;
      prevClue.current = round?.currentClue ?? 0;
    }

    // --- the round -----------------------------------------------------
    if (round?.status === 'intro') {
      if (seconds <= 3 && seconds !== prevIntroSecond.current) {
        stageAudio.play(seconds === 0 ? 'intro-go' : 'intro-tick');
      }
    } else if (round && round.currentClue > prevClue.current) {
      stageAudio.play('clue');
    }
    if (round) prevClue.current = round.currentClue;
    prevIntroSecond.current = seconds;

    // The only repetitive cue, and the only one reduced-motion suppresses.
    if (round?.status === 'active' && !reducedMotion) {
      if (seconds >= 1 && seconds <= 5 && seconds !== prevTickSecond.current) {
        stageAudio.play('urgent-tick');
      }
    }
    prevTickSecond.current = seconds;

    // --- phase changes --------------------------------------------------
    if (phase !== prevPhase.current) {
      if (prevPhase.current === 'round' && phase === 'results') {
        stageAudio.playRevealSequence();
      } else if (phase === 'leaderboard') {
        stageAudio.play('lb-move');
      }
      prevPhase.current = phase;
    }

    // --- the finale -----------------------------------------------------
    if (phase === 'finished') {
      if (finaleTick !== prevFinaleTick.current && finaleStage === 'countdown') {
        stageAudio.play('intro-tick');
        prevFinaleTick.current = finaleTick;
      }
      if (finaleStage !== prevFinaleStage.current) {
        if (finaleStage === 'third') stageAudio.play('drumroll');
        else if (finaleStage === 'second' || finaleStage === 'first') stageAudio.play('lb-move');
        else if (finaleStage === 'celebrate') stageAudio.play('fanfare');
        prevFinaleStage.current = finaleStage;
      }
    }
  }, [phase, round, seconds, finaleStage, finaleTick, reducedMotion]);

  // A context suspended by a backgrounded tab will not resume itself.
  useEffect(() => {
    const wake = () => stageAudio.resumeIfSuspended();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, []);
}
