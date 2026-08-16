// Mobile behaviour test, on an iPhone SE in landscape.
//
// Every player report so far has come from a phone held sideways, and an SE at
// 667x375 is the worst case: wide enough to miss a max-width breakpoint, short
// enough that oversized HUD text eats the play area.
//
//   npm run dev:client
//   node client/test/mobile.mjs

import { chromium, devices } from 'playwright';
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

// iPhone SE landscape: 667x375, dpr 2, touch, no mouse.
const context = await browser.newContext({
  viewport: { width: 667, height: 375 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'SE');
await page.click('#practice-btn');
await passLobby(page);
await page.waitForTimeout(5000);

// --- 1. pinch / zoom suppression -----------------------------------------
console.log('\n--- zoom suppression ---');
const gestures = await page.evaluate(() => {
  const results = {};
  // Fire the events a real pinch produces and see whether they were cancelled.
  const fire = (type, init) => {
    const e = new Event(type, { bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  };
  results.gesturestart = fire('gesturestart');
  results.gesturechange = fire('gesturechange');

  // Two-finger touchmove is the Android pinch path.
  const touch = (n) => {
    const list = Array.from({ length: n }, (_, i) => new Touch({
      identifier: i, target: document.body, clientX: 100 + i * 50, clientY: 100,
    }));
    const e = new TouchEvent('touchmove', {
      bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: list,
    });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  };
  results.twoFinger = touch(2);
  results.oneFinger = touch(1);

  results.bodyTouchAction = getComputedStyle(document.body).touchAction;
  results.stageTouchAction = getComputedStyle(document.getElementById('stage')).touchAction;
  results.stickTouchAction = getComputedStyle(document.getElementById('stick-left')).touchAction;
  results.viewport = document.querySelector('meta[name=viewport]')?.content ?? '';
  return results;
});
console.log('  ', JSON.stringify(gestures));

check('Safari pinch (gesturestart) is cancelled', gestures.gesturestart);
check('Safari pinch (gesturechange) is cancelled', gestures.gesturechange);
check('two-finger touchmove is cancelled', gestures.twoFinger);
check('one-finger touchmove still works (that is the joystick)', !gestures.oneFinger);
// pan-y, not none: it must still forbid pinch-zoom (pinch isn't in the list)
// while permitting the vertical scrolling the menu and scoreboard need.
// touch-action resolves up the ancestor chain, so `none` here would block
// scrolling on every screen beneath it.
check('root permits scrolling but forbids pinch', gestures.bodyTouchAction === 'pan-y',
  gestures.bodyTouchAction);
check('the game canvas blocks all touch gestures', gestures.stageTouchAction === 'none',
  gestures.stageTouchAction);
check('joystick zones block all touch gestures', gestures.stickTouchAction === 'none',
  gestures.stickTouchAction);
check('viewport meta still disables scaling', /user-scalable=no/.test(gestures.viewport));

// --- 2. HUD actually fits ------------------------------------------------
console.log('\n--- HUD footprint at 667x375 ---');
const layout = await page.evaluate(() => {
  const px = (sel, prop = 'fontSize') => {
    const el = document.querySelector(sel);
    return el ? parseFloat(getComputedStyle(el)[prop]) : null;
  };
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    clock: px('#match-clock'),
    killfeed: px('.kf-row'),
    modePill: px('#mode-pill'),
    scoreboard: px('.sb-row'),
    nameplate: px('.np-name'),
    killfeedBox: box('#killfeed'),
    chatBox: box('#chat-panel'),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
});
console.log('  ', JSON.stringify(layout));

check('match clock is compact', layout.clock <= 18, `${layout.clock}px`);
check('kill feed text is compact', layout.killfeed <= 10, `${layout.killfeed}px`);
check('mode pill is compact', layout.modePill <= 9, `${layout.modePill}px`);
check('scoreboard text is compact', layout.scoreboard <= 10, `${layout.scoreboard}px`);
check('nameplates are compact', layout.nameplate <= 9.5, `${layout.nameplate}px`);
check('kill feed takes under a third of the width',
  layout.killfeedBox.w < layout.vw / 3, `${layout.killfeedBox.w}px of ${layout.vw}`);
check('chat panel takes under a third of the width',
  layout.chatBox.w < layout.vw / 3, `${layout.chatBox.w}px of ${layout.vw}`);

// --- 3. camera view modes ------------------------------------------------
console.log('\n--- camera views ---');
const readRig = () => page.evaluate(() => {
  const r = window.__cluckdown.game.rig;
  const c = r.camera.position;
  return {
    view: r.view,
    zoomTarget: +r.zoomTarget.toFixed(2),
    dist: +Math.hypot(c.x - r.focus.x, c.y - r.focus.y, c.z - r.focus.z).toFixed(1),
    focus: [+r.focus.x.toFixed(1), +r.focus.z.toFixed(1)],
  };
});

const settle = async () => {
  await page.evaluate(() => new Promise((res) => {
    const r = window.__cluckdown.game.rig;
    const deadline = performance.now() + 12000;
    const tick = () => {
      const done = Math.abs(r.zoom - r.zoomTarget) < 0.01;
      if (done || performance.now() > deadline) return res();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  return readRig();
};

const close = await settle();
console.log('  close:', JSON.stringify(close));
await page.evaluate(() => document.getElementById('hud-view').click());
const mid = await settle();
console.log('  mid:  ', JSON.stringify(mid));
await page.evaluate(() => document.getElementById('hud-view').click());
const full = await settle();
console.log('  full: ', JSON.stringify(full));

check('starts close', close.view === 'close');
check('cycles close -> mid', mid.view === 'mid');
check('cycles mid -> full', full.view === 'full');
check('mid is further out than close', mid.dist > close.dist * 1.2, `${close.dist} -> ${mid.dist}`);
check('full is further out than mid', full.dist > mid.dist, `${mid.dist} -> ${full.dist}`);
check('full stops following the player', full.focus[0] === 0, `focus ${JSON.stringify(full.focus)}`);

// Does the whole arena actually fit in full view?
const fits = await page.evaluate(() => {
  const g = window.__cluckdown.game;
  const half = g.session.arenaSize / 2;
  const corners = [[-half, -half], [half, -half], [-half, half], [half, half]];
  return corners.map(([x, z]) => {
    const p = g.projectFn(x, 0, z);
    return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
  });
});
console.log('  arena corners on screen:', JSON.stringify(fits));
check('every arena corner is on screen in full view',
  fits.every((p) => p && p.x >= -20 && p.x <= layout.vw + 20 && p.y >= -20 && p.y <= layout.vh + 20),
  JSON.stringify(fits));

// The map should sit in the middle of the screen, not hug an edge.
const cx = fits.reduce((a, p) => a + p.x, 0) / fits.length;
const cy = fits.reduce((a, p) => a + p.y, 0) / fits.length;
check('the map is centred in the viewport',
  Math.abs(cx - layout.vw / 2) < layout.vw * 0.1 && Math.abs(cy - layout.vh / 2) < layout.vh * 0.15,
  `map centre (${cx.toFixed(0)}, ${cy.toFixed(0)}) vs viewport (${layout.vw / 2}, ${layout.vh / 2})`);

// Cycles back round.
await page.evaluate(() => document.getElementById('hud-view').click());
check('cycles full -> close', (await readRig()).view === 'close');

// --- 4. the choice survives a reload -------------------------------------
await page.evaluate(() => document.getElementById('hud-view').click());
await page.waitForTimeout(400);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cluckdown.gfx.v1') ?? '{}').view);
check('camera choice is remembered', saved === 'mid', String(saved));

// --- 5. portrait shows the rotate prompt ---------------------------------
console.log('\n--- orientation ---');
await page.setViewportSize({ width: 375, height: 667 });
await page.waitForTimeout(600);
const portrait = await page.evaluate(() => {
  const el = document.getElementById('rotate-prompt');
  return { display: getComputedStyle(el).display, inMatch: document.body.classList.contains('in-match') };
});
check('portrait during a match prompts to rotate', portrait.display !== 'none', JSON.stringify(portrait));

await page.setViewportSize({ width: 667, height: 375 });
await page.waitForTimeout(600);
const back = await page.evaluate(() => getComputedStyle(document.getElementById('rotate-prompt')).display);
check('landscape hides the prompt again', back === 'none', back);

// --- 6. the results screen must scroll on a short viewport ---------------
// This is the reported bug: after a match, on a landscape phone, the scoreboard
// could not be scrolled. touch-action is evaluated up the ancestor chain, so a
// `none` on the root silently blocked panning everywhere beneath it.
console.log('\n--- results scrolling ---');
const scrollability = await page.evaluate(() => {
  const chain = [];
  for (let el = document.getElementById('results'); el; el = el.parentElement) {
    chain.push({ tag: el.tagName.toLowerCase(), touchAction: getComputedStyle(el).touchAction });
  }
  return chain;
});
console.log('  touch-action chain:', JSON.stringify(scrollability));
check('no ancestor of the results screen blocks panning',
  scrollability.every((n) => n.touchAction !== 'none'),
  scrollability.map((n) => `${n.tag}:${n.touchAction}`).join(' '));

// Force a finished match and confirm the page can actually be scrolled.
await page.evaluate(() => { window.__cluckdown.session.world.clock = 1; });
for (let i = 0; i < 100; i++) {
  const shown = await page.evaluate(() => !document.getElementById('results').classList.contains('hidden'));
  if (shown) break;
  await page.waitForTimeout(200);
}
const results = await page.evaluate(() => {
  const el = document.getElementById('results');
  const before = el.scrollTop;
  el.scrollTop = 400;
  const after = el.scrollTop;
  el.scrollTop = before;
  return {
    visible: !el.classList.contains('hidden'),
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
    canScroll: after > before,
    overflowY: getComputedStyle(el).overflowY,
    inMatch: document.body.classList.contains('in-match'),
  };
});
console.log('  ', JSON.stringify(results));
check('the results screen is showing', results.visible);
check('match-end clears the in-match flag (so no rotate prompt)', !results.inMatch);
check('results content overflows a short phone viewport', results.scrollH > results.clientH,
  `${results.scrollH} > ${results.clientH}`);
check('the results screen actually scrolls', results.canScroll, `overflowY=${results.overflowY}`);

check('no exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
