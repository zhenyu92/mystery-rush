import { useEffect, useState } from 'react';
import { stageAudio } from '../lib/audio';
import { session } from '../lib/session';

/**
 * The opt-in for projector sound, and afterwards the mute.
 *
 * Browsers will not start audio without a gesture, and the projector page is
 * typically opened and then abandoned — so the prompt has to catch the host
 * while they are still setting up, and get out of the way before the room
 * arrives. It sits bottom-right rather than in a centre modal, because the
 * lobby's whole job is the join code and the QR, and covering those costs
 * join time.
 */
export function SoundGate() {
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);
  const [pref, setPref] = useState<'on' | 'off' | null>(null);

  useEffect(() => {
    if (!stageAudio.isSupported()) return;
    // Big screens only. Someone who opens /display on a phone gets silence.
    if (!window.matchMedia('(min-width: 1000px)').matches) return;
    stageAudio.arm('display');
    setPref(session.soundPref());
    setReady(true);

    // A saved preference cannot auto-start - the gesture requirement still
    // applies on every load - so take the host's first click anywhere.
    if (session.soundPref() === 'on') {
      const wake = () => {
        void stageAudio.enable().then((ok) => setOn(ok));
      };
      document.addEventListener('pointerdown', wake, { once: true });
      return () => document.removeEventListener('pointerdown', wake);
    }
    return;
  }, []);

  if (!ready) return null;

  const turnOn = async () => {
    const ok = await stageAudio.enable();
    setOn(ok);
    if (ok) {
      session.saveSoundPref('on');
      setPref('on');
      // Immediate confirmation, so the host can check the projector is
      // actually routed to speakers before the room fills up.
      stageAudio.play('lb-move');
    }
  };

  const toggle = async () => {
    if (on) {
      stageAudio.disable();
      session.saveSoundPref('off');
      setPref('off');
      setOn(false);
    } else {
      await turnOn();
    }
  };

  if (stageAudio.isEnabled() || on) {
    return (
      <button className="pill soundtoggle" onClick={toggle} aria-pressed={on} title="Sound">
        {'\u{1F50A}'} Sound on
      </button>
    );
  }

  if (pref === 'off') {
    return (
      <button className="pill soundtoggle" onClick={toggle} aria-pressed={false} title="Sound">
        {'\u{1F507}'} Muted
      </button>
    );
  }

  return (
    <div className="soundgate">
      <div className="soundgate__title">{'\u{1F50A}'} Sound for the room</div>
      <p className="soundgate__body">
        Clue stings, a ticking clock and a winner fanfare. Plays on this screen only, never on
        players' phones.
      </p>
      <div className="row">
        <button className="btn btn--go btn--sm" onClick={turnOn}>
          Turn on sound
        </button>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => {
            stageAudio.disable();
            session.saveSoundPref('off');
            setPref('off');
            setOn(false);
          }}
        >
          Play muted
        </button>
      </div>
    </div>
  );
}
