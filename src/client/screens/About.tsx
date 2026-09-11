import { Brand } from '../components/common';

/**
 * The public project page.
 *
 * Deliberately a separate route rather than anything bolted onto the join
 * screen: a player who scans the QR wants a code box, not a product pitch.
 * This is for someone deciding whether to run the thing.
 */
export function About({ navigate }: { navigate: (to: string, replace?: boolean) => void }) {
  return (
    <div className="page page--wide">
      <header className="topbar">
        <Brand tagline="AI Mystery Master" />
        <button className="btn btn--primary btn--sm" onClick={() => navigate('/')}>
          Open the game
        </button>
      </header>

      <div className="center stack" style={{ alignItems: 'center', gap: 14, paddingBlock: 20 }}>
        <h1 className="title-xl">AI-powered live mystery game shows for company events.</h1>
        <p className="muted" style={{ maxWidth: 620 }}>
          Five clues, twenty seconds each, one guess per player. Everyone plays from their phone
          while the room watches the projector. The clues are written by AI; the game is not.
        </p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <a className="btn btn--go" href="https://play.mystery-rush.workers.dev">
            Play it
          </a>
          <a className="btn btn--ghost" href="https://github.com/zhenyu92/mystery-rush">
            Source
          </a>
        </div>
        <p className="tiny dim">Built by Derrick Chan.</p>
      </div>

      <div className="aboutgrid">
        <section className="card stack">
          <div className="card__title">The problem</div>
          <p className="small muted" style={{ margin: 0 }}>
            A good mystery needs a recognisable answer, five clues that reveal it gradually, one
            defensible solution and four tempting wrong options. Writing ten of them by hand takes
            an organiser around <strong>half an hour</strong> — which is why most company quizzes
            get thrown together from whatever was lying around.
          </p>
        </section>

        <section className="card stack">
          <div className="card__title">Who it is for</div>
          <p className="small muted" style={{ margin: 0 }}>
            The person running the event — the one holding the microphone and the prize. Everyone
            else in the room just plays.
          </p>
        </section>

        <section className="card stack">
          <div className="card__title">The outcome we measure</div>
          <p className="small muted" style={{ margin: 0 }}>
            Preparing ten playable mysteries should take <strong>under five minutes</strong>{' '}
            instead of about thirty. In practice a pool of six takes about half a minute to
            generate and evaluate, so the remaining time is the host reading them.
          </p>
        </section>

        <section className="card stack">
          <div className="card__title">The riskiest assumption</div>
          <p className="small muted" style={{ margin: 0 }}>
            That AI can reliably write clues which are <em>progressively</em> revealing and leave
            exactly one defensible answer. The very first live call returned a category of
            <em> "multiple choice"</em> and a second clue vaguer than its first — so the product
            assumes nothing and checks everything.
          </p>
        </section>
      </div>

      <section className="card stack">
        <div className="card__title">How the AI is used</div>
        <p className="small muted" style={{ margin: 0 }}>
          The AI writes mysteries and gives a second opinion on them. It never touches the running
          game: the clock, the clue progression, the scoring, the leaderboard and the answer all
          stay with the deterministic engine, exactly as they were before.
        </p>
        <pre className="aboutflow">{`  AI writes a pool
      ↓
  deterministic rules reject what rules can decide
      ↓   category, five clues, answer among unique options,
      ↓   no clue naming the answer early, no repeats, no markup
      ↓
  AI judges what rules cannot
      ↓   is the progression real? could another option be right?
      ↓
  the host reads it and presses a button
      ↓
  the existing game engine runs the night`}</pre>
        <p className="tiny dim" style={{ margin: 0 }}>
          Nothing generated is playable until a human approves it. If the model is unavailable the
          host loses the generator and nothing else — the twenty-five built-in mysteries and any
          running game are untouched.
        </p>
      </section>

      <section className="card stack">
        <div className="card__title">Evidence</div>
        <p className="small muted" style={{ margin: 0 }}>
          Two generation prompts were compared over forty generated mysteries, scored by the same
          rubric the product uses. The structured prompt is the one in production; the numbers,
          the failures it still produces and the limitations are written up in{' '}
          <a className="link" href="https://github.com/zhenyu92/mystery-rush/blob/main/docs/mystery-evaluation.md">
            docs/mystery-evaluation.md
          </a>
          .
        </p>
      </section>

      <section className="stack">
        <div className="card__title">What it looks like</div>
        <div className="shots">
          <figure className="shot">
            <img src="/screenshots/projector-clue.jpg" alt="The projector during a round, showing a clue and the countdown" />
            <figcaption className="tiny dim">The room watches the clue and the clock.</figcaption>
          </figure>
          <figure className="shot">
            <img src="/screenshots/player-result.jpg" alt="A player's phone showing their result and the answer" />
            <figcaption className="tiny dim">Everyone plays from their own phone.</figcaption>
          </figure>
          <figure className="shot">
            <img src="/screenshots/ai-generator.jpg" alt="The host console generating and reviewing AI mysteries" />
            <figcaption className="tiny dim">The host reviews every generated mystery first.</figcaption>
          </figure>
        </div>
      </section>

      <p className="tiny dim center" style={{ paddingBottom: 20 }}>
        Built on Cloudflare Workers, Durable Objects, D1 and Workers AI.
      </p>
    </div>
  );
}
