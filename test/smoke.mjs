// Production smoke test against the deployed Worker.
// Verifies the things that can only really be proven on the real platform:
// Durable Object alarms, hibernatable WebSockets, remote D1, asset serving.
//
//   npm run test:smoke              against the live deployment
//   npm run test:smoke -- <host>    against somewhere else
//
// Leaves one event behind in D1; delete it afterwards.
import { CLUE_DURATION_MS, CLUE_POINTS, INTRO_DURATION_MS } from '../src/shared/types.ts';
import mysteries from '../data/mysteries.json' with { type: 'json' };

const HOST = process.argv[2] ?? 'play.mystery-rush.workers.dev';
const BASE = `https://${HOST}`;
const WSB = `wss://${HOST}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const res = await fetch(BASE + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

function conn(query) {
  const ws = new WebSocket(`${WSB}/ws?${query}`);
  const s = { ws, last: null, briefs: [], errors: [], clueLog: [], open: false };
  ws.addEventListener('open', () => { s.open = true; });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') {
      s.last = m;
      const c = m.snapshot.round?.currentClue;
      if (c && s.clueLog.at(-1)?.clue !== c) s.clueLog.push({ clue: c, at: Date.now() });
    } else if (m.type === 'host_brief') s.briefs.push(m);
    else if (m.type === 'error') s.errors.push(m);
  });
  return s;
}
const waitOpen = async (s) => { for (let i = 0; i < 200 && !s.open; i++) await sleep(50); };
async function waitUntil(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await sleep(60); }
  console.log(`  (timeout waiting for ${what})`);
  return false;
}
async function waitFor(s, pred, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (s.last && pred(s.last.snapshot)) return true; await sleep(80); }
  console.log(`  (timeout waiting for ${what})`);
  return false;
}

console.log(`\n=== Serving the app from ${HOST} ===`);
for (const path of ['/', '/host', '/play', '/display']) {
  const res = await fetch(BASE + path);
  const html = await res.text();
  check(`${path} serves the SPA`, res.ok && html.includes('<div id="root">'), `status ${res.status}`);
}
const stats = await fetch(BASE + '/api/mysteries').then((r) => r.json());
const expectTypes = new Set(mysteries.map((m) => m.type)).size;
check('question bank deployed', stats.total === mysteries.length && Object.keys(stats.byType).length === expectTypes,
  JSON.stringify(stats).slice(0, 120));

console.log('\n=== Event lifecycle on the real platform ===');
const ev = await post('/api/events', { eventName: 'Production smoke test' });
check('event created', ev.status === 201 && /^[A-Z0-9]{5}$/.test(ev.body.eventCode), JSON.stringify(ev.body));
const CODE = ev.body.eventCode;
console.log(`  code=${CODE}`);

const a = (await post(`/api/events/${CODE}/join`, { nickname: 'SmokeA' })).body;
const b = (await post(`/api/events/${CODE}/join`, { nickname: 'SmokeB' })).body;
// A third player who stays connected and never answers. Without them the
// round would end the moment A and B lock in - correct behaviour, but it
// would leave the clue clock itself untested, which is the whole point of
// running this against the real platform.
const c = (await post(`/api/events/${CODE}/join`, { nickname: 'SmokeC' })).body;
check('players joined', Boolean(a.playerId && b.playerId));

const host = conn(`code=${CODE}&role=host&hostToken=${ev.body.hostToken}`);
const pa = conn(`code=${CODE}&role=player&playerId=${a.playerId}&playerToken=${a.playerToken}`);
const pb = conn(`code=${CODE}&role=player&playerId=${b.playerId}&playerToken=${b.playerToken}`);
const pc = conn(`code=${CODE}&role=player&playerId=${c.playerId}&playerToken=${c.playerToken}`);
await Promise.all([waitOpen(host), waitOpen(pa), waitOpen(pb), waitOpen(pc)]);
check('WebSockets connected over wss', host.open && pa.open && pb.open && pc.open);
await sleep(600);
check('lobby synchronised', pa.last?.snapshot.players.length === 3);

console.log('\n=== The Durable Object alarm is the clock ===');
const t0 = Date.now();
host.ws.send(JSON.stringify({ type: 'host', action: 'start_round' }));
await waitFor(pa, (s) => s.phase === 'round', 8000, 'round start');
check('round opens in the get-ready window', pa.last?.snapshot.round.status === 'intro');
check('no clue revealed during intro', pa.last?.snapshot.round.clues.length === 0);
check('answers closed during intro', pa.last?.snapshot.round.acceptingAnswers === false);
check('answer withheld during round', pa.last?.snapshot.result === null);
await waitUntil(() => host.briefs.length >= 1, 5000, 'host brief');
const ANSWER = host.briefs[0]?.answer;
check('host got the answer sheet', typeof ANSWER === 'string');
check('players did not', pa.briefs.length === 0);

// The intro must expire before clue 1 exists at all.
await waitFor(pa, (s) => s.round?.currentClue === 1, INTRO_DURATION_MS + 6000, 'clue 1');
const clue1Gap = Date.now() - t0;
check(
  `clue 1 landed at ~${INTRO_DURATION_MS / 1000}s (${(clue1Gap / 1000).toFixed(1)}s)`,
  clue1Gap > INTRO_DURATION_MS - 1000 && clue1Gap < INTRO_DURATION_MS + 4000,
);
check('only clue 1 revealed', pa.last?.snapshot.round.clues.length === 1);

pa.ws.send(JSON.stringify({ type: 'submit_answer', option: ANSWER }));
const wrong = pa.last.snapshot.round.options.find((o) => o !== ANSWER);
pb.ws.send(JSON.stringify({ type: 'submit_answer', option: wrong }));
await sleep(1200);
check('answer locked at clue 1', pa.last?.self.hasAnswered && pa.last?.self.answeredAtClue === 1);
check('score withheld until round end', pa.last?.self.score === 0);
pa.ws.send(JSON.stringify({ type: 'submit_answer', option: wrong }));
await sleep(800);
check('second guess refused', pa.errors.some((e) => e.code === 'already_answered'));

const got2 = await waitFor(pa, (s) => s.round?.currentClue === 2, CLUE_DURATION_MS + 8000, 'clue 2');
const gap = Date.now() - t0;
const expectClue2 = INTRO_DURATION_MS + CLUE_DURATION_MS;
check('alarm advanced the clue in production', got2, '');
check(
  `clue 2 landed at ~${expectClue2 / 1000}s (${(gap / 1000).toFixed(1)}s)`,
  gap > expectClue2 - 2000 && gap < expectClue2 + 5000,
);
check('both clients advanced together', pb.last?.snapshot.round.currentClue === 2);

console.log('\n=== Scoring and reveal ===');
// With the clock proven, letting the last player answer should close the
// round on its own rather than needing the host.
pc.ws.send(JSON.stringify({ type: 'submit_answer', option: ANSWER }));
const closedItself = await waitFor(pa, (s) => s.phase === 'results', 6000, 'early end');
check('the round closed itself once everyone had answered', closedItself);
if (!closedItself) host.ws.send(JSON.stringify({ type: 'host', action: 'end_round' }));
await waitFor(pa, (s) => s.phase === 'results', 8000, 'results');
const result = pa.last.snapshot.result;
check('answer revealed after the round', result?.answer === ANSWER);
const lb = Object.fromEntries(pa.last.snapshot.leaderboard.map((e) => [e.nickname, e]));
check(`correct answer on clue 1 scored ${CLUE_POINTS[0]}`, lb.SmokeA.score === CLUE_POINTS[0], `got ${lb.SmokeA?.score}`);
check('wrong answer scored 0', lb.SmokeB.score === 0, `got ${lb.SmokeB?.score}`);
check('score now visible to the player', pa.last?.self.score === CLUE_POINTS[0]);

host.ws.send(JSON.stringify({ type: 'host', action: 'end_event' }));
await waitFor(pa, (s) => s.phase === 'finished', 8000, 'finish');
check('event finished with a winner', pa.last?.snapshot.leaderboard[0].nickname === 'SmokeA');

[host, pa, pb, pc].forEach((s) => { try { s.ws.close(); } catch {} });
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
console.log(`TEST_EVENT_CODE=${CODE}`);
process.exit(fail === 0 ? 0 : 1);
