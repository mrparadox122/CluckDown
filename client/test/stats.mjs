// Network / server stats test.
//
// Covers the menu's server panel (reachable, player count, ping) and the
// in-game readout (ping, fps, patch rate, expand/collapse), plus the offline
// case where there is no network to report.
//
//   npm run dev:server  &&  npm run dev:client
//   node client/test/stats.mjs

import { chromium } from 'playwright';
import { passLobby } from './_lobby.mjs';

const URL = process.env.UI_URL || 'http://localhost:5173';
const failures = [];
const pageErrors = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500); // let the first status poll land

// --- menu -----------------------------------------------------------------
const menu = await page.evaluate(() => ({
  cls: document.getElementById('server-status').className,
  text: document.getElementById('server-text').textContent,
  ping: document.getElementById('server-ping').textContent,
  pingCls: document.getElementById('server-ping').className,
}));
console.log('\n--- menu server panel ---');
console.log('  ', JSON.stringify(menu));

check('server reports online', menu.cls.includes('is-online'), menu.cls);
check('checking state cleared', !menu.cls.includes('is-checking'));
check('status text describes the server', /Online/.test(menu.text), menu.text);
check('menu shows a ping in ms', /^\d+ ms$/.test(menu.ping), menu.ping);
check('ping is graded', /good|fair|poor/.test(menu.pingCls), menu.pingCls);

// The /stats endpoint should reflect players once a match is running.
const before = await page.evaluate(async () => (await fetch('http://localhost:2567/stats')).json());
console.log('  /stats before:', JSON.stringify(before));

// --- in game, online ------------------------------------------------------
await page.fill('#name-input', 'Netty');
await page.click('#play-btn');
await passLobby(page);
await page.waitForTimeout(9000);

const readCompact = () => page.evaluate(() => document.getElementById('netstats').textContent);

// The readout refreshes on a 0.25s accumulated-delta timer. Under software
// rendering the page runs at a few frames per second with delta clamped to
// 0.1, so a repaint can take ~0.75s of real time — far longer than a naive
// fixed wait. Poll for the content instead.
const waitForReadout = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = await readCompact();
    if (predicate(text)) return text;
    await page.waitForTimeout(150);
  }
  return text;
};

const compact = await waitForReadout((t) => /\d+ ms/.test(t));
console.log('\n--- in-game readout (compact) ---');
console.log('  ', JSON.stringify(compact));
check('compact readout shows ping', /\d+ ms/.test(compact), compact);
check('compact readout shows fps', /\d+ fps/.test(compact), compact);

const after = await page.evaluate(async () => (await fetch('http://localhost:2567/stats')).json());
console.log('  /stats during match:', JSON.stringify(after));
check('server counts the live player', after.players >= 1, `players=${after.players}`);
check('server counts the room', after.rooms >= 1, `rooms=${after.rooms}`);
check('stats break down by mode', Object.keys(after.byMode).length >= 1, JSON.stringify(after.byMode));

// Tapping the readout expands it (the mobile path).
await page.evaluate(() => document.getElementById('netstats').click());
const expanded = await waitForReadout((t) => /jitter/.test(t));
console.log('\n--- in-game readout (expanded) ---');
console.log('  ', JSON.stringify(expanded));
check('expanded shows jitter', /jitter/.test(expanded), expanded);
check('expanded shows patch rate', /patch/.test(expanded), expanded);
// Sanity bounds, not a throughput measurement. The observed rate is capped by
// how fast this page can drain its socket callbacks — a few frames per second
// under software rendering — so it says more about the test rig than about the
// server. What matters is that patches arrive and never exceed the 40Hz cap.
const patchRate = Number(/patch\s+(\d+)/.exec(expanded)?.[1] ?? NaN);
check('patches arrive, and never above the 40Hz cap',
  patchRate > 0 && patchRate <= 45, `${patchRate}/s observed`);

// Tapping again collapses it. The 'N' shortcut does the same thing in a real
// browser, but synthetic keypresses don't reach the page reliably here, so it
// is verified by hand rather than asserted on.
await page.evaluate(() => document.getElementById('netstats').click());
const collapsed = await waitForReadout((t) => !/jitter/.test(t));
check('tapping again collapses', !/jitter/.test(collapsed), collapsed);

// --- offline practice reports no network ---------------------------------
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.fill('#name-input', 'Netty');
await page.click('#practice-btn');
await passLobby(page);
await page.waitForTimeout(4000);
const offline = await waitForReadout((t) => /offline/.test(t));
console.log('\n--- offline readout ---');
console.log('  ', JSON.stringify(offline));
check('offline says offline', /offline/.test(offline), offline);
check('offline still reports fps', /\d+ fps/.test(offline), offline);
check('offline shows no ping', !/ms/.test(offline), offline);

check('no exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
