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
| **`data/mysteries.json`** | The question bank. 25 mysteries across 14 categories. Game logic never hard-codes a question. |

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
| `npm run deploy` | Build, then `wrangler deploy`. |

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
```
