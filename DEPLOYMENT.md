# Deploying Mystery Rush to Cloudflare

One Worker serves everything: the React app as static assets, the JSON API, and the WebSocket
upgrade that hands off to a Durable Object. There is no separate frontend deployment, no origin
server, and nothing to keep warm.

**You need:** a Cloudflare account with Workers **Paid** ($5/month). Durable Objects are not
available on the free plan.

---

## 1. Log in

```bash
npm install
npx wrangler login
```

## 2. Create the D1 database

```bash
npx wrangler d1 create mystery-rush-db
```

Copy the `database_id` it prints into `wrangler.jsonc`, replacing the placeholder:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "mystery-rush-db",
    "database_id": "PASTE-THE-UUID-HERE"   // <- was REPLACE_WITH_YOUR_D1_DATABASE_ID
  }
]
```

## 3. Create the tables

```bash
npm run db:init:remote
```

(That is `wrangler d1 execute mystery-rush-db --remote --file=./schema.sql`. The schema is
idempotent — every statement is `CREATE TABLE IF NOT EXISTS` — so it is safe to re-run.)

## 4. Deploy

```bash
npm run deploy
```

This builds the client into `dist/client` and runs `wrangler deploy`. The first deploy also
applies the `v1` migration that creates the `EventRoom` Durable Object class.

You will get a URL like `https://mystery-rush.<your-subdomain>.workers.dev`. Open it, create an
event, and you are live.

---

## What gets deployed

| Binding | Resource | Why |
| --- | --- | --- |
| `ASSETS` | Static assets from `dist/client` | The React SPA. `not_found_handling: single-page-application` serves `index.html` for client routes like `/host`. |
| `EVENT_ROOM` | Durable Object (`EventRoom`, SQLite-backed) | One instance per event code. Owns the clock, the clues, the answer and the scoring. |
| `DB` | D1 (`mystery-rush-db`) | Event registry and post-event archive. |

`run_worker_first` is set to `["/api/*", "/ws"]` so the SPA fallback can never swallow API or
WebSocket traffic, while ordinary asset requests are served without invoking the Worker at all.

### About the routing of a WebSocket

`/ws?code=ABCDE&role=player&...` hits the Worker, which resolves the code with
`EVENT_ROOM.idFromName(code)` and forwards the upgrade. Because `idFromName` is deterministic,
every player typing the same code lands on the same object — that is what makes the room
authoritative without any coordination between Worker invocations.

---

## Continuous deployment from GitHub

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) deploys on every push to `main`.
It needs one secret.

**1. Create a Cloudflare API token.** Dashboard → **My Profile** → **API Tokens** → **Create
Token** → use the **Edit Cloudflare Workers** template. That template already covers Workers
Scripts, D1 and the account read this project needs. Scope it to your account and, if offered,
to the specific zone. Copy the token — Cloudflare shows it exactly once.

**2. Add it to GitHub.** Repo → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**, named exactly:

```
CLOUDFLARE_API_TOKEN
```

Paste the token there and nowhere else. Never commit it, and never paste it into a chat or an
issue — a leaked token can deploy to your account.

The account ID is set as a plain value in the workflow rather than a secret. It is an identifier,
visible in every dashboard URL; it grants nothing without the token.

### After that

| Action | Result |
| --- | --- |
| `git commit` | Nothing. Commits are local. |
| `git push` (to `main`) | Typecheck, build, deploy. ~2 minutes. |
| Push to any other branch | Nothing deploys. |
| Actions tab → **Run workflow** | Re-deploys the current `main` without a new commit. |

Two pushes in a row queue rather than race, so a slower older build cannot overwrite a newer one.

### If you want a safety margin

Deploying on `main` means a typo reaches the room about a minute after you push. To keep a
deliberate step, change the trigger branch in the workflow to `release`, and ship with:

```bash
git push                        # safe: saves work, deploys nothing
git push origin main:release    # deliberate: this is the one that goes live
```

### Rolling back

```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```

That reverts the running Worker immediately without touching git — the fastest way out of a bad
deploy mid-event. Fix the code and push afterwards.

---

## Custom domain

Add a route in `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "mystery.yourcompany.com", "custom_domain": true }
]
```

Then `npm run deploy`. Nothing in the app hard-codes an origin — the client derives the WebSocket
URL from `window.location`, and picks `wss://` automatically when the page is served over HTTPS.

---

## Operating an event

- **Question bank changes require a redeploy.** `data/mysteries.json` is bundled at build time.
  This is deliberate: the question bank is content, and content changes should be reviewable.
- **A Durable Object hibernates between rounds** and wakes on the next message or alarm. State is
  written to its own durable storage on every change, so hibernation, eviction and redeploys do
  not lose an event in progress.
- **Deploying mid-event is safe but disruptive**: sockets drop and clients reconnect within a few
  seconds, resuming at the correct clue with their answers intact. Still, avoid it during a round.
- **Event codes are permanent.** A code stays valid until you stop using it; there is no expiry
  job. If you run events regularly, prune old rows from D1 yourself.

### Costs

For a single company event this rounds to nothing beyond the $5/month plan floor. A 100-player,
20-round event is on the order of tens of thousands of Worker requests, a few hundred thousand
Durable Object messages, and a handful of D1 writes.

### Looking at the results afterwards

```bash
npx wrangler d1 execute mystery-rush-db --remote --command \
  "SELECT p.nickname, p.score, p.correct_answers, p.mysteries_played
   FROM players p WHERE p.event_code = 'ABCDE' ORDER BY p.score DESC"
```

Per-answer detail — who answered what, on which clue, for how many points — is in `answers`.

---

## Troubleshooting

**`Cannot create binding for class EventRoom because it is not currently configured`**
The migration did not run. Check the `migrations` block in `wrangler.jsonc` still contains the
`v1` entry with `new_sqlite_classes: ["EventRoom"]`, and redeploy.

**`D1_ERROR: no such table: events`**
Step 3 was skipped, or was run against the local database. Re-run `npm run db:init:remote`.

**Players can join but the WebSocket never opens**
Check that `run_worker_first` in `wrangler.jsonc` includes `"/ws"`. Without it the asset handler
answers first and the upgrade never reaches the Worker.

**The host console says it is not signed in**
Host credentials are stored per browser in `localStorage`, deliberately — there are no accounts.
Reopen the console on the device that created the event, or create a fresh event.
