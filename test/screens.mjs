// Visual check: drives a real game through a real browser and screenshots the
// states that matter, so UI regressions are caught by looking rather than by
// hoping. Writes PNGs to test/screens/ (git-ignored).
//
//   npm run test:screens            against `wrangler dev` on :8787
//   npm run test:screens -- <host>
//
// Uses the browser already installed on the machine rather than downloading
// one - playwright-core ships no binaries.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTRO_DURATION_MS } from '../src/shared/types.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'screens');
const HOST = process.argv[2] ?? '127.0.0.1:8787';
const SECURE = !HOST.startsWith('127.') && !HOST.startsWith('localhost');
const BASE = `${SECURE ? 'https' : 'http'}://${HOST}`;
const WSB = `${SECURE ? 'wss' : 'ws'}://${HOST}`;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, body) =>
  (await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })).json();

mkdirSync(OUT, { recursive: true });

const ev = await post('/api/events', { eventName: 'Adisseo Annual Dinner' });
const CODE = ev.eventCode;
console.log(`event ${CODE} on ${HOST}`);

const names = ['Derrick', 'Priya', 'Marcus', 'Aisha', 'Tomo'];
const players = [];
for (const n of names) players.push(await post(`/api/events/${CODE}/join`, { nickname: n }));

// A host socket purely to learn the answer, so the shots show real outcomes.
const briefs = [];
const spy = new WebSocket(`${WSB}/ws?code=${CODE}&role=host&hostToken=${ev.hostToken}`);
spy.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'host_brief') briefs.push(m);
});
// Bots, so the room looks populated and the distribution chart has data.
const bots = players.slice(1).map(
  (p) => new WebSocket(`${WSB}/ws?code=${CODE}&role=player&playerId=${p.playerId}&playerToken=${p.playerToken}`),
);
await sleep(900);

let browser;
for (const executablePath of BROWSERS) {
  try {
    browser = await chromium.launch({ executablePath });
    break;
  } catch {
    /* try the next one */
  }
}
if (!browser) {
  console.error('No Edge or Chrome found. Add your browser path to BROWSERS in this file.');
  process.exit(2);
}

const ctx = async (width, height, storage) => {
  const c = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: width < 500,
    hasTouch: width < 500,
  });
  if (storage) await c.addInitScript(([k, v]) => window.localStorage.setItem(k, v), storage);
  return c;
};
const shot = async (page, name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('  ', name);
};

const playCtx = await ctx(390, 844, [
  `mysteryrush.player.${CODE}`,
  JSON.stringify({
    eventCode: CODE,
    playerId: players[0].playerId,
    playerToken: players[0].playerToken,
    nickname: players[0].nickname,
    eventName: ev.eventName,
  }),
]);
const hostCtx = await ctx(1440, 940, [
  `mysteryrush.host.${CODE}`,
  JSON.stringify({ eventCode: CODE, hostToken: ev.hostToken, eventName: ev.eventName }),
]);
const dispCtx = await ctx(1600, 900);

const play = await playCtx.newPage();
const host = await hostCtx.newPage();
const display = await dispCtx.newPage();
await play.goto(`${BASE}/play?code=${CODE}`, { waitUntil: 'domcontentloaded' });
await host.goto(`${BASE}/host?code=${CODE}`, { waitUntil: 'domcontentloaded' });
await display.goto(`${BASE}/display?code=${CODE}`, { waitUntil: 'domcontentloaded' });
await sleep(1400);

await shot(display, 'lobby-display');
await shot(host, 'lobby-host');

// The kick confirmation: a misclick here used to delete a player outright.
await host.click('.chip__kick >> nth=1');
await host.waitForSelector('.modal', { timeout: 4000 });
await sleep(300);
await shot(host, 'host-confirm-kick');
await host.click('.modal button:has-text("Cancel")');
await sleep(300);

await host.click('button:has-text("Start game")');
await sleep(2200);
await shot(play, 'intro-player');
await shot(display, 'intro-display');
// The answer must be masked by default.
await shot(host, 'intro-host-answer-masked');
await host.click('button:has-text("Show")');
await sleep(300);
await shot(host, 'intro-host-answer-shown');
await host.click('button:has-text("Hide")');

await play.waitForSelector('.clue--current', { timeout: INTRO_DURATION_MS + 8000 });
await sleep(900);
await shot(play, 'clue1-player');
await shot(display, 'clue1-display');
await shot(host, 'clue1-host');

const answer = briefs.at(-1).answer;
const opts = await play.evaluate(() =>
  [...document.querySelectorAll('select.select option')].map((o) => o.value).filter(Boolean));
await play.selectOption('select.select', answer);
await play.click('button:has-text("Lock in")');
await play.waitForSelector('.locked', { timeout: 5000 });
await sleep(400);
await shot(play, 'locked-player');

// Bots answer, which also ends the round early now that everyone has locked in.
bots.forEach((ws, i) => {
  ws.send(JSON.stringify({ type: 'submit_answer', option: i % 2 === 0 ? answer : opts[(i + 1) % opts.length] }));
});
await play.waitForSelector('.verdict', { timeout: 10000 });
await sleep(1200);
await shot(play, 'results-player');
await shot(display, 'results-display');
await shot(host, 'results-host');

await host.click('button:has-text("Show leaderboard")');
await sleep(1000);
await shot(display, 'leaderboard-display');
await shot(play, 'leaderboard-player');

await host.click('button:has-text("End event")');
await host.waitForSelector('.modal', { timeout: 4000 });
await host.click('.modal button:has-text("End event")');
await sleep(3400);
await shot(display, 'finale-countdown');
await sleep(7000);
await shot(display, 'finale-winner');
await shot(play, 'finale-player');

console.log(`\nwrote screenshots to ${OUT}`);
console.log(`TEST_EVENT_CODE=${CODE}`);
await browser.close();
process.exit(0);
