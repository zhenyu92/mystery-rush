# Mystery Rush

**Live at [play.mystery-rush.workers.dev](https://play.mystery-rush.workers.dev)**

A live, multiplayer "guess the mystery" game show for company events. Five clues, twenty seconds
each, one guess per player — and the earlier you commit, the more it is worth.

Players join from their phones with a five-character code. The host drives the show from a laptop.
A third screen is built for the projector at the front of the room.

```
GET READY  ->  CLUE 1 (500 XP)  ->  CLUE 2 (400)  ->  CLUE 3 (300)  ->  CLUE 4 (200)  ->  CLUE 5 (100)
   10s             20s                 20s               20s               20s               20s
   ^                                                                                          |
   category on screen,                                 or the round ends early, the moment  <-+
   no clue, answering closed                           every connected player has locked in
```

Every round opens with a **10-second get-ready window**: the category is on screen, no clue is, and
answering is closed. It gives the room time to look up from their phones before the clock that
costs them points starts running.

A round need not run its full 100 seconds. **The moment every connected player has locked in, it
ends and the answer is revealed** — there is no reason to make a room watch an empty clock.
Connected is the operative word: waiting on someone whose phone dropped would stall everyone, so
players who are offline when a round ends simply score zero, exactly as they would have by letting
the clock expire.

---

## The shape of it

| Piece | What it does |
| --- | --- |
| **React SPA** (`src/client`) | Four screens: join, player, host console, projector. Mobile-first for players, desktop-first for the host. |
| **Cloudflare Worker** (`src/worker/index.ts`) | Serves the SPA, exposes a small JSON API, and routes WebSockets to the right room. Holds no game state. |
| **`EventRoom` Durable Object** (`src/worker/event-room.ts`) | One per event code. The single authority for the clock, the clues, the answer and the scoring. |
| **D1** (`schema.sql`) | The event registry plus an archive of players, rounds and answers for after the party. |
| **`data/mysteries.json`** | The built-in question bank. 25 mysteries across 14 categories. Game logic never hard-codes a question. |
| **Workers AI** (`src/worker/llm.ts`) | Writes candidate mysteries and grades them. Host-side preparation only — never on the path of a live round. |

### Why the Durable Object owns the clock

Everything that decides a score lives on the server, because a browser can be paused, throttled or
lied to:

- **The clue clock is a Durable Object alarm**, not a `setInterval`. Every phone in the room flips
  to clue 3 at the same moment, and freezing a tab gains a player nothing. The browser runs an
  interval purely to *draw* the countdown, re-reading the server's `clueEndsAt` on every tick.
- **Unrevealed clues and the answer are never sent.** A snapshot during a live round contains only
  the clues that have actually been revealed; `result` (which carries the answer) is `null` until
  the round is over. Reading devtools tells a player nothing they cannot already see.
- **Points come from the server's clue number**, taken at the instant the submission arrives. The
  client does not send, and could not usefully forge, what a guess is worth.
- **One guess per player per round** is enforced in the object, not the UI.
- **Answering is refused during the intro**, since no clue is on screen and there is therefore no
  clue number to score a guess against.
- **Scores earned in a round are held back until the round ends**, so a player cannot infer that
  they were right by watching their own XP tick up early.

Clients measure their offset from the server clock with a ping/pong handshake and keep the sample
from the fastest round trip, so a phone with a badly set clock still sees the right countdown.

### Scoring, and how a tie is broken

Points come from the clue number the server had open when the submission
arrived: 500, 400, 300, 200, 100. Two rules sit on top, each deliberately
sayable in one sentence:

- **Streaks pay.** Two correct in a row is **+100**, three or more in a row is
  **+200**, and one miss resets it. Flat and capped rather than a multiplier on
  purpose: a multiplier scales with the base, so it would pay the leader (who
  answers early, for 500) more than the chaser (who answers on clue 4, for 200)
  — the wrong shape for a game that should stay live to the last question.
- **The final mystery scores double.** Say how many mysteries you plan to run
  when creating the event and the last one simply is the double round. There is
  no toggle: the only way the mechanic ever failed was a host with a microphone
  in their hand forgetting to arm it. It is announced *before* the round,
  because someone 800 behind needs to know the gap can still be closed.

Both are applied at round end as `(base + streakBonus) × multiplier`, never at
submission — which is what keeps a player from inferring they were right by
watching their own XP move.

Equal scores are separated by **total time to solve**, accumulated across the
event. The clock is virtual and starts when clue 1 opens:

```
responseMs = (clueNumber - 1) x CLUE_DURATION_MS + (submittedAt - clueStartedAt)
```

Deliberately *not* time-within-the-current-clue, which is non-monotone: one
second into clue 5 would beat nineteen seconds into clue 1, inverting what the
scoring already rewards. Completed windows contribute their nominal length, so
a late alarm cannot inflate one player's number against another's, and because
`resumeRound` back-dates `clueStartedAt`, a pause is excluded for free.

It is computed **at submission**, not at the end of the round - `clueStartedAt`
moves with every clue, so by then the reference point for a clue-1 answer is
gone. It is banked into the player's total only at round end, alongside the
points, so no timing information reaches a client mid-round.

A round the player did not solve - no answer, or a wrong one - costs
`MAX_RESPONSE_MS`, exactly what a correct answer on the final millisecond of the
last clue would cost. Never worse than any real answer, never better. Counting a
fast wrong answer as fast would rank a confidently-wrong player above someone
right on clue 3. Times are bucketed to 100ms so venue wifi cannot decide a prize,
and players who joined late are charged for the rounds they missed, so arriving
late is never an advantage.

The rank number is keyed on the whole comparator, so the displayed order and the
rank can never disagree. When the score alone did not decide first place, the
podium says so: **"Won on speed - 6.1s avg vs 8.4s"**.

### Pacing

Nothing used to move between rounds until the host clicked, twice. The room now
advances itself — 20s on the answer, then 8s on the standings — with the
countdown drawn from server timestamps like everything else. The host is not
asked to configure any of it: **Pause** freezes the clock for the whole room for
as long as they are talking, and **Hold** stops a between-round countdown. Those
are the only two pacing controls, and neither has to be set up in advance.

Eight seconds on the standings rather than fifteen because the standings are a
beat, not a scene — long enough to find your own name, short enough that the room
does not start talking.

A host who said how many mysteries they were running gets the podium after the
last one, without pressing anything — the count was a promise to the room, and
the room keeps it. `start_round` refuses a mystery past that number, so nothing
can run long by accident. A host who *didn't* name a count is running an
open-ended night, and there the timer never decides it is over: the standings
just sit there until someone says otherwise.

All of it rides one explicit scheduled-timer record. The alarm used to infer
its purpose from whether a round existed, which is exactly why adding a second
use of it would have clobbered clue progression; now there is one record, one
alarm, and the handler never guesses. The record is persisted *before* the
alarm is armed — a crash between the two then leaves an alarm with no meaning,
which no-ops, rather than a countdown that reaches zero and does nothing.

### Sound

The projector can make noise: clue stings, a tick in the last five seconds, a
drumroll into the answer, a winner fanfare. It is synthesised with the Web
Audio API — no files, no CDN, no dependency — and is **projector-only by
construction**: `enable()` refuses unless `arm('display')` was called, and only
`Display` calls it. Thirty phones drifting a few hundred milliseconds apart
would be mush; the phone's channel is haptics.

Everything is scheduled against `ctx.currentTime`, never `setTimeout`, because
a backgrounded tab clamps timers to about 1Hz and the host will alt-tab to
their console. Nothing in [`audio.ts`](src/client/lib/audio.ts) may throw.

Browsers need a gesture, so the projector shows a one-time prompt that plays a
confirmation tone — which doubles as a way to check the projector is actually
routed to speakers before the room arrives.

### Reconnection

Player credentials live in `localStorage`. A phone that locks, drops signal or reloads mid-round
comes back to its seat with its score and its locked-in answer intact — the server tells it the
current clue, the time remaining, whether answers are open, and what that player already submitted.

---

## Running it locally

```bash
npm install
npm run db:init:local     # create the local D1 tables (once)
npm run dev               # wrangler on :8787, Vite on :5173
```

Open **http://localhost:5173**.

`npm run dev` runs the Worker and the Vite dev server together; Vite proxies `/api` and `/ws`
through to the Worker, so hot reload works while the real game engine is running behind it.

To exercise the production path instead — the built SPA served by the Worker, exactly as it
deploys — use `npm run preview` and open http://localhost:8787.

### Trying it with one person

1. Open `/host` in one window, create an event, and note the code.
2. Open `/display?code=YOURCODE` in a second window — that is the projector view.
3. Open `/` in a couple of private windows and join with the code.
4. Hit **Start game** on the host console.

### Other scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the client into `dist/client`. |
| `npm run typecheck` | Typecheck the client and the Worker (they have separate tsconfigs). |
| `npm test` | Run the Worker test suite. |
| `npm run test:coverage` | The same, with a coverage report for `src/worker` and `src/shared`. |
| `npm run test:e2e` | Drive a real game against `wrangler dev`. Slower, needs a server. |
| `npm run test:smoke` | Short run against the live deployment. Leaves one event in D1. |
| `npm run test:screens` | Screenshot every screen through a real browser. |
| `npm run deploy` | Build, then `wrangler deploy`. |

---

## Tests

Two layers, and they catch different things.

```bash
npm test          # fast, no server, gates the deploy
npm run test:e2e  # slow, needs `wrangler dev`, plays a real game
```

### The unit suite

```bash
npm test
```

The suite covers the Worker: the HTTP API, the WebSocket protocol, and the
whole round lifecycle inside the Durable Object. It has **no dependencies of
its own** - it is Node's built-in test runner reading the TypeScript sources
directly via Node's type stripping, so there is no build step, no test
framework to keep in sync, and nothing extra in `package-lock.json`.

Three things the Cloudflare runtime provides are stood in for, in
[`test/support/`](test/support/): the `cloudflare:workers` module, a
`DurableObjectState` with storage, alarms and hibernatable sockets, and an
in-memory D1. Everything else under test is the shipped code - the Worker's
own `fetch` handler and a real `EventRoom`.

| File | What it covers |
| --- | --- |
| `test/api-routes.test.ts` | `/api/mysteries`, event creation, lookup, join, routing |
| `test/websocket-protocol.test.ts` | the upgrade handshake, auth, rate limiting, presence |
| `test/round-lifecycle.test.ts` | the clue clock, scoring, pause/resume, what leaves the server |
| `test/host-controls.test.ts` | leaderboard, kick, reset, end event |
| `test/archive.test.ts` | D1 write-through, outage behaviour, surviving an eviction |
| `test/game-helpers.test.ts` | codes, tokens, shuffling, option building, sanitising |

The test files are not part of either `tsconfig`: they are checked by running
them, since typechecking them would mean adding `@types/node`.

### The end-to-end suite

```bash
npm run dev       # in one terminal
npm run test:e2e  # in another
```

[`test/e2e.mjs`](test/e2e.mjs) plays four mysteries against a running Worker over real WebSockets,
with real twenty-second clues — the get-ready window, all three ways a round can end, the
tiebreak, streak bonuses, a double-points round, pause, reconnect, reset and kick. It is the layer
that catches things the stubs cannot: that a Durable Object alarm actually fires, that clue two
lands thirty seconds after the round starts, that a dropped socket really does release the round.

It imports the real constants from [`src/shared/types.ts`](src/shared/types.ts) and computes its
expectations, so retuning the clue clock or the points table does not mean editing tests — which is
why the script passes `--experimental-strip-types`.

[`test/screens.mjs`](test/screens.mjs) drives the same game through a real browser and screenshots
every screen into `test/screens/`. Some of this UI is only wrong in ways you have to look at.

---

## AI Mystery Master

Writing ten mysteries by hand takes an organiser about half an hour. Creating an event asks three
questions instead — a name, how many mysteries, and what they should be about — and the questions
write themselves in the lobby while the room is still scanning the QR code.

```
host: name, how many, which categories
        |
   Worker  ->  Workers AI          generation, in the Worker and never in the
        |                          Durable Object: object requests are
        |                          serialised, so a 30s call there would stall
        |                          a live round
        v
   deterministic validation        everything a rule can decide
        |                          category, exactly five clues, answer among
        |                          unique options, no clue naming the answer
        |                          before the last, length bounds, no markup,
        v                          no repeated answers
   AI evaluation                   only what survived, and only the things
        |                          rules cannot judge: is the progression
        |                          real, could another option be right
        v
   the auto-accept bar             zero warnings, approved, score >= 75,
        |                          ambiguity <= 0.3 - anything short is
        |                          replaced, not shipped
        v
   the existing game engine        accepted mysteries go to the FRONT of the
                                   queue, so the 25 built-ins are a fallback
```

The order is the point. Anything a rule can settle is settled by a rule, because the alternative is
asking the same kind of system that produced the content whether the content is good. The model
only gets asked about the parts that need judgement.

**Why the bar is stricter than a host would be.** A host reading a candidate could weigh a warning
and wave it through. Nobody is reading now, so the deterministic rules carry the veto and the
evaluator can only ever lower the verdict, never rescue a candidate: a validation *warning* is
disqualifying, and a mystery the evaluator could not be reached about is treated as a fail. That is
a direct consequence of [`docs/mystery-evaluation.md`](docs/mystery-evaluation.md) §7, which found
the model rating a thin two-clue question 96/100 — an evaluator that generous cannot be the last
word on its own.

**A shortfall is not a failure.** Accepted mysteries are pushed to the front of the round queue and
the built-in bank stays behind them, so an event that asked for ten and got seven simply plays three
built-ins, and an event where Workers AI never answers plays exactly as it did before any of this
existed. The lobby says which happened; nothing blocks on it.

**And it is bounded.** Preparation gets `POOL_DEADLINE_MS` — two minutes, measured from the first
request rather than from when the event was created, so a host who makes an event and walks away
does not come back to a window that expired while nobody was asking. Past it the endpoint stops
spending inference, says so, and the built-in bank covers the rest. Starting a game whose pool is
still short is allowed and takes one confirmation — the host is the one who can see the room.

**The AI never touches the running game.** The clock, clue progression, one-guess enforcement,
scoring, the leaderboard and the hidden answer all stay exactly where they were. If Workers AI is
unavailable the host loses the generator and nothing else — the 25 built-in mysteries and any
running event are untouched.

Accepted mysteries live in the event's own library in Durable Object storage, not D1: the round
loop resolves a mystery synchronously, so it has to survive hibernation without a round trip.
`resolveMystery` checks that library and falls back to the built-in bank, so a hand-written mystery
behaves exactly as it always did.

Everything provider-specific is in [`src/worker/llm.ts`](src/worker/llm.ts) — model, prompts,
schemas, parsing, timeouts. The rest of the app calls `generateMysteries` and `evaluateMystery` and
does not know Cloudflare is involved.

The prompt in production was chosen by measurement, not taste — see
[`docs/mystery-evaluation.md`](docs/mystery-evaluation.md).

### Cost and local development

Workers AI has no local emulation: the binding is marked `remote` and reaches real inference even
under `wrangler dev`, so generating while developing bills your account. The unit suite mocks the
binding and never spends a neuron; `npm run eval:prompts` deliberately does.

---

## Editing the question bank

Everything lives in [`data/mysteries.json`](data/mysteries.json):

```json
{
  "id": "mystery-001",
  "type": "landmark",
  "title": "Famous Landmark",
  "answer": "Eiffel Tower",
  "options": ["Eiffel Tower", "Statue of Liberty", "Big Ben", "Colosseum", "Taj Mahal"],
  "clues": ["...", "...", "...", "...", "..."]
}
```

Rules the server enforces at load time (malformed entries are logged and skipped, not fatal):

- exactly **five** clues, ordered vague → obvious;
- `options` must contain `answer`;
- `id` unique.

The options are re-shuffled by the server at the start of every round, so the answer never sits in
a predictable slot, and every player sees the same order.

`type` drives the category pill. Known types get an emoji and a label from
`MYSTERY_TYPE_LABELS` in `src/shared/types.ts`; anything else falls back to a magnifying glass and
the raw type, so adding a new category works without touching the UI.

---

## Host controls

Clue progression is automatic — the host never clicks through clues, and a round everyone has
answered closes itself. The controls are for the things a live room actually needs:

| Control | Effect |
| --- | --- |
| **Start game / Next mystery** | Draws the next mystery, or a specific one you picked from the list. |
| **Pause / Resume** | Freezes the clock and the clue progression for everyone; answers are refused while paused. |
| **End round & reveal** | Ends early and reveals the answer immediately. (Happens on its own once everyone has answered.) |
| **Show leaderboard** | Moves every screen to the standings. |
| **End event** | Jumps to the final podium and the winner celebration. |
| **Reset event** | Clears all scores and results, keeps the event and its players, restores the full question bank. Asks for confirmation. |
| **Remove player** | Kicks someone and closes their socket. |

The host console also shows the answer to the running mystery, labelled **host only**, so whoever
is on the microphone can build tension knowingly. It is gated on the host token — the same
credential that can start and end rounds — and is never sent to a player or projector socket.

---

## Deployment

Pushing to `main` deploys, via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):
typecheck → build → `wrangler deploy`. A failing typecheck stops the deploy, which is the only
thing standing between a typo and the room.

```
git push        ->  GitHub Actions  ->  Cloudflare      (~2 min, gated on typecheck)
npm run deploy  ->  Cloudflare directly                 (~20 s, no gate)
```

Both still work. Reach for `npm run deploy` when you need a fix live *now* — on event night the
CI round trip is the slow path.

Full setup, including the one-time API token, is in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Project layout

```
data/mysteries.json      the question bank
schema.sql               D1 tables
src/shared/types.ts      wire protocol + scoring constants, shared by both sides
src/worker/
  index.ts               Worker: routing, event creation, WebSocket upgrade
  event-room.ts          Durable Object: the authoritative game engine
  game.ts                pure helpers (scoring, shuffling, codes, hashing)
  db.ts                  best-effort D1 write-through
src/client/
  App.tsx                route switch
  screens/               Landing, Play, Host, Display
  components/            clue stack, leaderboard, podium, timer, confetti
  lib/useGameSocket.ts   WebSocket + reconnection + server clock sync
  lib/useCountdown.ts    display-only countdown
  styles.css             the design system
test/
  support/               a miniature Workers runtime (DO state, sockets, D1)
  *.test.ts              the Worker suite - see "Tests" above
```
