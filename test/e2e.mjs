// End-to-end exercise of the real game loop against a running Worker.
//
//   npm run test:e2e              against `wrangler dev` on :8787
//   npm run test:e2e -- <host>    against a deployed Worker
//
// Expectations are computed from the real constants rather than hard-coded, so
// the scoring and pacing can be retuned without editing this file.
import {
  CLUE_COUNT,
  CLUE_DURATION_MS,
  CLUE_POINTS,
  INTRO_DURATION_MS,
} from '../src/shared/types.ts';

const HOST = process.argv[2] ?? '127.0.0.1:8787';
const SECURE = !HOST.startsWith('127.') && !HOST.startsWith('localhost');
const BASE = `${SECURE ? 'https' : 'http'}://${HOST}`;
const WSB = `${SECURE ? 'wss' : 'ws'}://${HOST}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function connect(query) {
  const ws = new WebSocket(`${WSB}/ws?${query}`);
  const s = { ws, last: null, briefs: [], errors: [], clueLog: [], open: false, closed: false };
  ws.addEventListener('open', () => { s.open = true; });
  ws.addEventListener('close', () => { s.closed = true; });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
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
async function waitFor(s, pred, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (s.last && pred(s.last.snapshot, s.last)) return true; await sleep(60); }
  console.log(`  (timeout waiting for ${what})`);
  return false;
}
const send = (s, m) => s.ws.send(JSON.stringify(m));
// Messages to different sockets arrive independently, so waiting on one
// client's snapshot says nothing about another's. Poll the condition itself.
async function waitUntil(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await sleep(60); }
  console.log(`  (timeout waiting for ${what})`);
  return false;
}

const run = async () => {
console.log(`\n=== 1. Event creation and joining (${HOST}) ===`);
const created = await post('/api/events', { eventName: 'E2E Test Night' });
check('event created', created.status === 201 && /^[A-Z0-9]{5}$/.test(created.body.eventCode), JSON.stringify(created.body));
const CODE = created.body.eventCode, HOSTTOK = created.body.hostToken;
console.log(`  code=${CODE}`);

const lookup = await fetch(`${BASE}/api/events/${CODE}`).then((r) => r.json());
check('event findable by code', lookup.exists === true);
check('unknown code rejected', (await fetch(`${BASE}/api/events/ZZZZZ`)).status === 404);

const alice = (await post(`/api/events/${CODE}/join`, { nickname: 'Alice' })).body;
const bob = (await post(`/api/events/${CODE}/join`, { nickname: 'Bob' })).body;
const cara = (await post(`/api/events/${CODE}/join`, { nickname: 'Cara' })).body;
check('three players joined', Boolean(alice.playerId && bob.playerId && cara.playerId));
check('duplicate nickname rejected', (await post(`/api/events/${CODE}/join`, { nickname: 'alice' })).status === 409);
check('blank nickname rejected', (await post(`/api/events/${CODE}/join`, { nickname: '   ' })).status === 400);

console.log('\n=== 2. Authentication ===');
const badHost = connect(`code=${CODE}&role=host&hostToken=deadbeef`);
const badPlayer = connect(`code=${CODE}&role=player&playerId=${alice.playerId}&playerToken=nope`);
await sleep(900);
check('bad host token refused', !badHost.open || badHost.closed);
check('bad player token refused', !badPlayer.open || badPlayer.closed);

const host = connect(`code=${CODE}&role=host&hostToken=${HOSTTOK}`);
let pa = connect(`code=${CODE}&role=player&playerId=${alice.playerId}&playerToken=${alice.playerToken}`);
const pb = connect(`code=${CODE}&role=player&playerId=${bob.playerId}&playerToken=${bob.playerToken}`);
let pc = connect(`code=${CODE}&role=player&playerId=${cara.playerId}&playerToken=${cara.playerToken}`);
const disp = connect(`code=${CODE}&role=display`);
await Promise.all([waitOpen(host), waitOpen(pa), waitOpen(pb), waitOpen(pc), waitOpen(disp)]);
check('host, players and display connected', host.open && pa.open && pb.open && pc.open && disp.open);
await sleep(500);
check('lobby shows 3 players', pa.last?.snapshot.players.length === 3);
send(pa, { type: 'host', action: 'start_round' });
await sleep(500);
check('player host-action refused', pa.errors.some((e) => e.code === 'forbidden'));
check('still in lobby', pa.last?.snapshot.phase === 'lobby');

// ---------------------------------------------------------------- round 1
console.log('\n=== 3. Round opens with a 10s get-ready window ===');
const t0 = Date.now();
send(host, { type: 'host', action: 'start_round' });
await waitFor(pa, (s) => s.phase === 'round', 4000, 'round start');
check('round started in intro', pa.last?.snapshot.round.status === 'intro');
check('no clue revealed yet', pa.last?.snapshot.round.clues.length === 0);
check('clue counter at zero', pa.last?.snapshot.round.currentClue === 0);
check('answers closed during intro', pa.last?.snapshot.round.acceptingAnswers === false);
check('intro window matches INTRO_DURATION_MS', pa.last?.snapshot.round.windowMs === INTRO_DURATION_MS, `got ${pa.last?.snapshot.round.windowMs}`);
check('category exposed during intro', typeof pa.last?.snapshot.round.mysteryType === 'string');
check('answer still withheld', pa.last?.snapshot.result === null);
await waitUntil(() => host.briefs.length >= 1, 4000, 'host brief');
check('host got the answer sheet', host.briefs.length === 1);
check('players did not', pa.briefs.length === 0 && disp.briefs.length === 0);
const ANSWER = host.briefs[0].answer;

send(pa, { type: 'submit_answer', option: ANSWER });
await sleep(500);
check('answering during intro refused', pa.errors.some((e) => e.code === 'round_not_started'));
check('nothing locked in', pa.last?.self.hasAnswered === false);

console.log('\n=== 4. Clue 1 arrives after the intro ===');
await waitFor(pa, (s) => s.round?.currentClue === 1, INTRO_DURATION_MS + 5000, 'clue 1');
const clue1Gap = Date.now() - t0;
check(
  `clue 1 landed at ~${INTRO_DURATION_MS / 1000}s (${(clue1Gap / 1000).toFixed(1)}s)`,
  clue1Gap > INTRO_DURATION_MS - 1000 && clue1Gap < INTRO_DURATION_MS + 3000,
);
check('now active', pa.last?.snapshot.round.status === 'active');
check('exactly one clue revealed', pa.last?.snapshot.round.clues.length === 1);
check('answers now open', pa.last?.snapshot.round.acceptingAnswers === true);
check('clue window matches CLUE_DURATION_MS', pa.last?.snapshot.round.windowMs === CLUE_DURATION_MS);
const WRONG = pa.last.snapshot.round.options.find((o) => o !== ANSWER);
check('same option order for everyone',
  JSON.stringify(pa.last.snapshot.round.options) === JSON.stringify(pc.last.snapshot.round.options));

console.log('\n=== 5. One guess each, scored by clue number ===');
send(pa, { type: 'submit_answer', option: ANSWER });
send(pb, { type: 'submit_answer', option: WRONG });
await sleep(700);
check('Alice locked in at clue 1', pa.last?.self.hasAnswered && pa.last?.self.answeredAtClue === 1);
check('score withheld until round end', pa.last?.self.score === 0);
send(pa, { type: 'submit_answer', option: WRONG });
await sleep(400);
check('second guess refused', pa.errors.some((e) => e.code === 'already_answered'));
send(pc, { type: 'submit_answer', option: 'Not An Option' });
await sleep(400);
check('off-menu answer refused', pc.errors.some((e) => e.code === 'bad_option'));
check('round still running (Cara has not answered)', pa.last?.snapshot.phase === 'round');

console.log('\n=== 6. Round ends the moment everyone has answered ===');
const beforeEnd = Date.now();
send(pc, { type: 'submit_answer', option: ANSWER });
const endedEarly = await waitFor(pa, (s) => s.phase === 'results', 6000, 'early end');
check('last answer ended the round immediately', endedEarly);
check(`ended in under 3s (${((Date.now() - beforeEnd) / 1000).toFixed(1)}s)`, Date.now() - beforeEnd < 3000);
check('did not wait out the clock', Date.now() - t0 < 60000);
const r1 = pa.last.snapshot.result;
check('answer revealed', r1?.answer === ANSWER);
const lb1 = Object.fromEntries(pa.last.snapshot.leaderboard.map((e) => [e.nickname, e]));
check(`Alice ${CLUE_POINTS[0]} for clue 1`, lb1.Alice.score === CLUE_POINTS[0], `got ${lb1.Alice.score}`);
check('Bob 0 for a wrong answer', lb1.Bob.score === 0);
const caraClue = pc.last.self.answeredAtClue;
check(
  `Cara ${CLUE_POINTS[caraClue - 1]} for clue ${caraClue}`,
  lb1.Cara.score === CLUE_POINTS[caraClue - 1],
  `got ${lb1.Cara.score}`,
);
check('scores now visible', pa.last?.self.score === CLUE_POINTS[0]);

// ---------------------------------------------------------------- round 2
console.log('\n=== 7. A disconnect can also complete the room ===');
send(host, { type: 'host', action: 'next_round' });
await waitFor(pb, (s) => s.phase === 'round', 4000, 'round 2');
await waitUntil(() => host.briefs.length >= 2, 5000, 'round 2 brief');
await waitFor(pb, (s) => s.round?.currentClue === 1, INTRO_DURATION_MS + 5000, 'round 2 clue 1');
const ANSWER2 = host.briefs.at(-1).answer;
send(pa, { type: 'submit_answer', option: ANSWER2 });
send(pb, { type: 'submit_answer', option: ANSWER2 });
await sleep(800);
check('two of three answered, round continues', pb.last?.snapshot.phase === 'round');
pc.ws.close(); // Cara drops out without answering
const endedOnDisconnect = await waitFor(pb, (s) => s.phase === 'results', 8000, 'end on disconnect');
check('round ended when the last unanswered player left', endedOnDisconnect);
check('absent player scored zero',
  pb.last.snapshot.leaderboard.find((e) => e.nickname === 'Cara').lastRoundPoints === 0);

// ---------------------------------------------------------------- round 3
console.log('\n=== 8. Full-length round when someone never answers (~110s) ===');
pc = connect(`code=${CODE}&role=player&playerId=${cara.playerId}&playerToken=${cara.playerToken}`);
await waitOpen(pc);
await sleep(500);
const t3 = Date.now();
send(host, { type: 'host', action: 'next_round' });
await waitFor(pb, (s) => s.phase === 'round', 4000, 'round 3');
pb.clueLog.length = 0;
await waitUntil(() => host.briefs.length >= 3, 5000, 'round 3 brief');
const ANSWER3 = host.briefs.at(-1).answer;

// Only Alice answers, so the clock has to run its full course.
await waitFor(pb, (s) => s.round?.currentClue === 1, INTRO_DURATION_MS + 5000, 'r3 clue 1');
send(pa, { type: 'submit_answer', option: ANSWER3 });
await sleep(400);

await waitFor(pb, (s) => s.round?.currentClue === 2, CLUE_DURATION_MS + 6000, 'clue 2');
const clue2Gap = Date.now() - t3;
const expectClue2 = INTRO_DURATION_MS + CLUE_DURATION_MS;
check(
  `clue 2 at ~${expectClue2 / 1000}s from start (${(clue2Gap / 1000).toFixed(1)}s)`,
  clue2Gap > expectClue2 - 2000 && clue2Gap < expectClue2 + 4000,
);
check('all clients advanced together', pc.last?.snapshot.round.currentClue === 2);

console.log('  (pausing 4s to confirm the clock freezes)');
send(host, { type: 'host', action: 'pause' });
await waitFor(pb, (s) => s.round?.status === 'paused', 3000, 'pause');
const frozen = pb.last.snapshot.round.remainingMs;
send(pc, { type: 'submit_answer', option: ANSWER3 });
await sleep(400);
check('answers refused while paused', pc.errors.some((e) => e.code === 'round_paused'));
await sleep(4000);
check('clock did not move while paused', pb.last.snapshot.round.remainingMs === frozen);
send(host, { type: 'host', action: 'resume' });
await waitFor(pb, (s) => s.round?.status === 'active', 3000, 'resume');

const fullRoundMs = INTRO_DURATION_MS + CLUE_COUNT * CLUE_DURATION_MS;
const ended = await waitFor(pb, (s) => s.phase === 'results', fullRoundMs + 20000, 'round end');
check('round ran itself out and ended', ended);
console.log(`  clue timeline: ${pb.clueLog.map((c, i) => i ? `${c.clue}(+${((c.at - pb.clueLog[i-1].at)/1000).toFixed(1)}s)` : `${c.clue}`).join(' -> ')}`);
check(`all ${CLUE_COUNT} clues revealed`, pb.clueLog.map((c) => c.clue).includes(CLUE_COUNT) && pb.clueLog.length === CLUE_COUNT);
check('full clue list published at the end', pb.last.snapshot.result.clues.length === CLUE_COUNT);
check('non-answerers scored zero',
  pb.last.snapshot.leaderboard.find((e) => e.nickname === 'Bob').lastRoundPoints === 0);

console.log('\n=== 9. Reconnect, leaderboard, reset, kick ===');
pa.ws.close();
await sleep(600);
pa = connect(`code=${CODE}&role=player&playerId=${alice.playerId}&playerToken=${alice.playerToken}`);
await waitOpen(pa);
await sleep(600);
check('reconnect restores the player', pa.last?.self.nickname === 'Alice' && pa.last?.self.score > 0);

send(host, { type: 'host', action: 'show_leaderboard' });
await waitFor(pb, (s) => s.phase === 'leaderboard', 3000, 'leaderboard');
check('host can show the leaderboard', pb.last?.snapshot.phase === 'leaderboard');
check('three mysteries played', pb.last?.snapshot.roundsPlayed === 3);

send(host, { type: 'host', action: 'end_event' });
await waitFor(pb, (s) => s.phase === 'finished', 3000, 'finish');
check('host can end the event', pb.last?.snapshot.phase === 'finished');

send(host, { type: 'host', action: 'reset_event' });
await waitFor(pb, (s) => s.phase === 'lobby', 4000, 'reset');
check('reset returns to lobby', pb.last?.snapshot.phase === 'lobby');
check('reset zeroes every score', pb.last.snapshot.leaderboard.every((e) => e.score === 0));
check('reset keeps the players', pb.last.snapshot.players.length === 3);
check('reset restores the question bank', pb.last.snapshot.mysteriesRemaining === pb.last.snapshot.totalMysteries);

send(host, { type: 'host', action: 'kick_player', playerId: bob.playerId });
await sleep(900);
check('player removed', pc.last.snapshot.players.every((p) => p.nickname !== 'Bob'));
check('their socket closed', pb.closed);

console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
[host, pa, pb, pc, disp].forEach((s) => { try { s.ws.close(); } catch {} });
console.log(`TEST_EVENT_CODE=${CODE}`);
process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
