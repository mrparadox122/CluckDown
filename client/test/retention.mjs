// The between-match loop and the rivalry mechanics.
//
// These exist for one reason: the results screen used to make "do nothing" the
// default action, and death used to be a black screen with a number on it.
// Both are moments where people close the tab, so both are worth testing.
//
//   npm run dev:client
//   node client/test/retention.mjs

import { chromium } from 'playwright';
import { passLobby } from './_lobby.mjs';

const URL = process.env.UI_URL || 'http://localhost:5173';
const OUT = process.env.OUT_DIR || '.';
const failures = [];
const pageErrors = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

async function shot(page, path) {
  try {
    await page.screenshot({ path, animations: 'disabled', timeout: 15000 });
  } catch (err) {
    console.warn(`  (screenshot ${path} skipped: ${err.message.slice(0, 80)})`);
  }
}

async function until(page, fn, timeoutMs = 30000, arg = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await page.waitForTimeout(150);
  }
  return last;
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.fill('#name-input', 'Beaky');
await page.click('#practice-btn');
await passLobby(page);
await until(page, () => window.__cluckdown?.session?.phase === 'live');

// --- killed by ------------------------------------------------------------
console.log('\n--- killed by ---');

// The death has to come through the real damage path, or the kill event carries
// none of the attacker detail the panel reads — poking hp to 0 by hand skips
// killPlayer entirely and emits nothing.
//
// So: hold the player at 1 HP with no spawn shield, walk them into the nearest
// bot, and let a real bullet finish the job. Waiting passively for a bot to
// wander over is a coin flip, and bots use global Math.random.
const panel = await until(page, () => {
  const S = window.__cluckdown;
  const w = S.session.world;
  const me = w.players.get(S.session.selfId);
  if (me?.alive) {
    me.hp = 1;
    me.invulnUntil = 0;
    const foe = [...w.players.values()].find((p) => p.id !== me.id && p.alive);
    if (foe) { me.x = foe.x + 3; me.z = foe.z + 3; }
    return null;
  }

  const el = document.getElementById('killed-by');
  if (el.classList.contains('hidden')) return null;
  return {
    text: el.textContent,
    name: document.querySelector('.kb-name')?.textContent ?? null,
    hp: document.querySelector('.kb-hp')?.textContent ?? null,
    dist: document.querySelector('.kb-dist')?.textContent ?? null,
    revenge: !!document.querySelector('.kb-revenge'),
    nemesis: S.session.players.find((p) => p.isSelf)?.nemesis ?? null,
  };
}, 40000);

console.log('  ', JSON.stringify(panel));
check('the killed-by panel appears when you die', !!panel, panel ? 'shown' : 'never appeared');
check('it names your killer', !!panel?.name, panel?.name ?? '-');
check('it reports how much health they had left', /\d+ HP left/.test(panel?.hp ?? ''), panel?.hp ?? '-');
check('it reports the range', /\d/.test(panel?.dist ?? ''), panel?.dist ?? '-');
check('it marks them for revenge', panel?.revenge === true);
check('the sim agrees you have a nemesis', !!panel?.nemesis, String(panel?.nemesis));
await shot(page, `${OUT}/14-killed-by.png`);

// --- the nemesis is marked in the world ----------------------------------
console.log('\n--- nemesis marker ---');
const marked = await until(page, () => {
  const S = window.__cluckdown;
  const me = S.session.players.find((p) => p.isSelf);
  if (!me?.nemesis) return null;
  const view = S.game.views.get(me.nemesis);
  // Wait for the ring to actually be ON. Returning the object either way made
  // this resolve on the first poll — before a frame had rendered, and before
  // the nemesis had respawned if we caught them mid-death.
  if (!view?.grudge?.isEnabled()) return null;
  return { enabled: true, who: me.nemesis };
}, 25000);
console.log('  ', JSON.stringify(marked));
check('the nemesis wears a ring in the world', marked?.enabled === true, JSON.stringify(marked));

// Nobody else should be wearing one.
const others = await page.evaluate(() => {
  const S = window.__cluckdown;
  const me = S.session.players.find((p) => p.isSelf);
  let extra = 0;
  for (const [id, v] of S.game.views) {
    if (id === me.nemesis || id === S.session.selfId) continue;
    if (v.grudge?.isEnabled()) extra++;
  }
  return extra;
});
check('only the nemesis is marked, not everyone', others === 0, `${others} extra rings`);

// --- auto-requeue ---------------------------------------------------------
console.log('\n--- auto-requeue ---');
await page.evaluate(() => { window.__cluckdown.session.world.clock = 0.6; });

const results = await until(page, () => {
  const el = document.getElementById('results');
  if (el.classList.contains('hidden')) return null;
  return {
    label: document.getElementById('again-label').textContent,
    near: document.getElementById('results-near').textContent,
    title: document.getElementById('results-title').textContent,
  };
}, 40000);
// EVERYTHING that has to observe the countdown runs before anything slow.
// The window is 8 seconds, and a screenshot under software rendering can take
// 15 — put one in the middle and the requeue fires mid-measurement, dragging
// the browser into a fresh match. Correct behaviour, useless test.
const bar0 = await page.evaluate(() => document.getElementById('again-bar').style.transform);
await page.waitForTimeout(700);
const bar1 = await page.evaluate(() => document.getElementById('again-bar').style.transform);
const scale = (t) => Number(/scaleX\(([\d.]+)\)/.exec(t)?.[1] ?? NaN);

// ...and any interaction cancels it. Someone reading the scoreboard has not
// decided to leave, and yanking them into a new match is worse than waiting.
await page.mouse.move(500, 400);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(300);
const cancelled = await page.evaluate(() => ({
  label: document.getElementById('again-label').textContent,
  bar: document.getElementById('again-bar').style.transform,
  armed: !document.getElementById('results').classList.contains('hidden'),
}));

console.log('  ', JSON.stringify(results));
console.log(`  countdown bar: ${bar0} → ${bar1}`);
console.log('  after a click:', JSON.stringify(cancelled));

check('the results screen appears', !!results);
check('the play-again button counts down', /in \d+/.test(results?.label ?? ''), results?.label ?? '-');
check('the near-miss line says how close it was',
  /behind|breathing/.test(results?.near ?? ''), results?.near || '(empty — you may have tied)');
check('the countdown is running', scale(bar1) < scale(bar0), `${scale(bar0)} → ${scale(bar1)}`);
check('interacting cancels the countdown', cancelled.label === 'Play again', cancelled.label);
check('cancelling leaves you on the results screen', cancelled.armed);
await shot(page, `${OUT}/15-results.png`);

// Leaving to the menu must not leave a timer armed behind us.
await page.click('#menu-btn');
await page.waitForTimeout(2500);
const onMenu = await page.evaluate(() => ({
  menuVisible: !document.getElementById('menu').classList.contains('hidden'),
  resultsHidden: document.getElementById('results').classList.contains('hidden'),
  inGame: !!window.__cluckdown.game,
}));
console.log('  ', JSON.stringify(onMenu));
check('main menu stays put — no stray requeue fires',
  onMenu.menuVisible && !onMenu.inGame, JSON.stringify(onMenu));

check('no exceptions anywhere', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
