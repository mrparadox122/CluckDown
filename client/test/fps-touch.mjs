// First-person touch controls, on an emulated phone.
//
// The player report was "FPS controls are harder on mobile", and the cause was
// structural rather than a sensitivity number: the right stick was a RATE
// control, so hitting a specific angle meant holding a direction for exactly
// the right number of milliseconds. Every shipped mobile shooter uses a swipe
// surface instead, because a swipe is a positional mapping — you move your
// thumb by the amount you want to turn.
//
// This proves the new scheme: swipe to look, a separate fire button, both
// thumbs usable at once, and pitch that actually exists.
//
//   npm run dev:client
//   node client/test/fps-touch.mjs

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

async function until(page, fn, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn);
    if (last) return last;
    await page.waitForTimeout(150);
  }
  return last;
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// A phone in landscape, which is how the game is actually played.
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  // This test drives offline practice, so it does not need the game server.
  // The menu still polls it for the status panel, and a refused connection
  // there says nothing about the controls under test.
  if (m.type() !== 'error') return;
  const text = m.text();
  if (/ERR_CONNECTION_REFUSED|Failed to load resource/.test(text)) return;
  pageErrors.push(text);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.fill('#name-input', 'Thumbs');
await page.click('#practice-btn');
await passLobby(page);
await until(page, () => window.__cluckdown?.session?.phase === 'live');
await page.waitForTimeout(600);

// --- there is only one camera -------------------------------------------
console.log('\n--- camera ---');
const start = await until(page, () => {
  const g = window.__cluckdown?.game;
  if (!g || g.camera.position.y > 3) return null;
  return { camY: +g.camera.position.y.toFixed(2) };
});
console.log('  ', JSON.stringify(start));
check('the match starts in first person', !!start, `camY=${start?.camY}`);

// --- the right furniture is present ---------------------------------------
console.log('\n--- touch surfaces ---');
const surfaces = await page.evaluate(() => {
  const vis = (id) => {
    const el = document.getElementById(id);
    if (!el || el.classList.contains('hidden')) return false;
    return getComputedStyle(el).display !== 'none';
  };
  const at = (x, y) => document.elementFromPoint(x, y)?.id ?? 'none';
  const fire = document.getElementById('fire-btn').getBoundingClientRect();
  return {
    look: vis('look-zone'),
    fire: vis('fire-btn'),
    // The aim stick element is gone from the document entirely now.
    noAimStick: !document.getElementById('stick-right'),
    leftStickTop: at(110, 300),
    lookTop: at(600, 300),
    // closest(), because the button has a <span> label inside it that is
    // what elementFromPoint actually returns.
    fireCentre: document.elementFromPoint(fire.left + fire.width / 2, fire.top + fire.height / 2)
      ?.closest('#fire-btn')?.id ?? 'none',
  };
});
console.log('  ', JSON.stringify(surfaces));
check('the swipe-to-look surface exists', surfaces.look);
check('the fire button exists', surfaces.fire);
check('the old aim stick is gone', surfaces.noAimStick);
check('the movement stick still owns the left thumb', surfaces.leftStickTop === 'stick-left',
  surfaces.leftStickTop);
check('the look surface receives the right thumb', surfaces.lookTop === 'look-zone', surfaces.lookTop);
check('the fire button sits above the look surface', surfaces.fireCentre === 'fire-btn',
  surfaces.fireCentre);

// --- swiping turns you, proportionally ------------------------------------
console.log('\n--- swipe to look ---');
const cdp = await context.newCDPSession(page);

/** Drags one finger across the look surface and reports the yaw/pitch change. */
async function swipe(dx, dy, id = 1) {
  const from = { x: 600, y: 250 };
  const before = await page.evaluate(() => {
    const c = window.__cluckdown.game.controls;
    return { yaw: c.yaw, pitch: c.pitch };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id }] });
  await page.waitForTimeout(60);
  for (let i = 1; i <= 4; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (dx * i) / 4, y: from.y + (dy * i) / 4, id }],
    });
    await page.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => {
    const c = window.__cluckdown.game.controls;
    return { yaw: c.yaw, pitch: c.pitch };
  });
  return { dYaw: after.yaw - before.yaw, dPitch: after.pitch - before.pitch };
}

const small = await swipe(60, 0);
const big = await swipe(120, 0);
console.log(`  swipe 60px → ${small.dYaw.toFixed(3)} rad | 120px → ${big.dYaw.toFixed(3)} rad`);
check('swiping right turns right', small.dYaw > 0.05, small.dYaw.toFixed(3));
// The defining property of a positional control: twice the swipe, twice the
// turn. A rate control would give you "twice the swipe, same turn per second".
check('turn is proportional to swipe distance — this is what a stick could not do',
  Math.abs(big.dYaw / small.dYaw - 2) < 0.35, `${(big.dYaw / small.dYaw).toFixed(2)}x for 2x the distance`);

const back = await swipe(-60, 0);
check('swiping left turns left', back.dYaw < -0.05, back.dYaw.toFixed(3));

// --- pitch: the thing that made it "only left and right" ------------------
console.log('\n--- look up and down ---');
const up = await swipe(0, -70);
const down = await swipe(0, 70);
console.log(`  swipe up → ${up.dPitch.toFixed(3)} rad | down → ${down.dPitch.toFixed(3)} rad`);
check('swiping up looks up', up.dPitch > 0.05, up.dPitch.toFixed(3));
check('swiping down looks down', down.dPitch < -0.05, down.dPitch.toFixed(3));

// The camera must actually follow the pitch, not just store it.
//
// Everything below polls for a rendered frame rather than sleeping. Under
// SwiftShader the render loop runs at two or three frames a second, so a fixed
// 300ms wait routinely measures a frame that has not happened yet.
// Measured from the camera's target rather than getForwardRay(), which needs a
// Babylon side-effect import the game no longer has any reason to pull in —
// mouse ray-picking went away with the top-down aim.
const drop = () => {
  const c = window.__cluckdown.game.camera;
  return +(c.getTarget().y - c.position.y).toFixed(3);
};
// Stay alive for this: the spectator camera sits 9 units up looking down, so a
// dead player reads as permanently tilted and the measurement means nothing.
const alive = () => {
  const S = window.__cluckdown;
  const me = S.session.world.players.get(S.session.selfId);
  if (me) { me.hp = 100; me.invulnUntil = S.session.world.time + 60; }
  return !!me?.alive;
};
await until(page, alive, 15000);
const level = await page.evaluate(drop);
await page.evaluate(() => { window.__cluckdown.game.controls.pitch = -0.6; });
const tilted = await until(page, () => {
  const S = window.__cluckdown;
  const me = S.session.world.players.get(S.session.selfId);
  if (me) { me.hp = 100; me.invulnUntil = S.session.world.time + 60; }
  if (!me?.alive) return null;
  const c = S.game.camera;
  const d = c.getTarget().y - c.position.y;
  return d < -3 ? +d.toFixed(3) : null;
}, 12000);
console.log(`  camera aims this far below eye level: ${level} → ${tilted}`);
check('the camera really tilts down when you look down', tilted !== null && tilted < level - 2,
  `${level} → ${tilted}`);

// Pitch is clamped, or you end up looking at the inside of your own skull.
await page.evaluate(() => { window.__cluckdown.game.controls.pitch = 99; });
const high = await until(page, () => {
  const p = window.__cluckdown.game.controls.pitch;
  return p < 90 ? +p.toFixed(2) : null;
}, 12000);
await page.evaluate(() => { window.__cluckdown.game.controls.pitch = -99; });
const low = await until(page, () => {
  const p = window.__cluckdown.game.controls.pitch;
  return p > -90 ? +p.toFixed(2) : null;
}, 12000);
console.log('  clamped to:', JSON.stringify({ high, low }));
check('pitch is clamped both ways', high !== null && low !== null && high < 1 && low > -2,
  JSON.stringify({ high, low }));

// --- fire button, and both thumbs at once ---------------------------------
console.log('\n--- fire ---');
const fireRect = await page.evaluate(() => {
  const r = document.getElementById('fire-btn').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart', touchPoints: [{ x: fireRect.x, y: fireRect.y, id: 7 }],
});
// input.shoot is only written when sample() runs, which is once per rendered
// frame — a couple per second here. Poll rather than sleep.
const firing = await until(page, () => {
  const c = window.__cluckdown.game.controls;
  return c.input.shoot ? { shoot: c.input.shoot, touchFiring: c.touchFiring } : null;
}, 12000);
check('holding the fire button shoots', firing?.shoot === true, JSON.stringify(firing));

// ...while a SECOND thumb swipes to look. This is the reason fire is its own
// button rather than living on the look surface.
const beforeYaw = await page.evaluate(() => window.__cluckdown.game.controls.yaw);
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: fireRect.x, y: fireRect.y, id: 7 }, { x: 560, y: 200, id: 8 }],
});
await page.waitForTimeout(60);
for (let i = 1; i <= 3; i++) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: fireRect.x, y: fireRect.y, id: 7 }, { x: 560 + i * 25, y: 200, id: 8 }],
  });
  await page.waitForTimeout(50);
}
const both = await until(page, () => {
  const c = window.__cluckdown.game.controls;
  return c.input.shoot ? { shoot: true, yaw: c.yaw } : null;
}, 12000) ?? await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  return { shoot: c.input.shoot, yaw: c.yaw };
});
console.log(`  yaw ${beforeYaw.toFixed(3)} → ${both.yaw.toFixed(3)} while firing=${both.shoot}`);
check('you can look and fire at the same time',
  both.shoot === true && Math.abs(both.yaw - beforeYaw) > 0.05,
  `shoot=${both.shoot} dYaw=${(both.yaw - beforeYaw).toFixed(3)}`);

await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const released = await until(page, () => {
  const c = window.__cluckdown.game.controls;
  return c.input.shoot === false ? 'stopped' : null;
}, 12000);
check('releasing stops firing', released === 'stopped', String(released));

// --- movement is still full 360, relative to facing -----------------------
console.log('\n--- movement ---');
const moved = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  const out = [];
  c.usingTouch = true;
  for (const yaw of [0, Math.PI / 2]) {
    c.yaw = yaw;
    c.stickX = 0; c.stickZ = 1;            // stick pushed straight "up"
    const f = c.sample({ x: 0, z: 0 }, 1 / 60);
    out.push({ yaw: +yaw.toFixed(2), mx: +f.mx.toFixed(2), mz: +f.mz.toFixed(2) });
  }
  c.yaw = 0;
  c.stickX = 1; c.stickZ = 0;              // stick pushed right = strafe
  const s = c.sample({ x: 0, z: 0 }, 1 / 60);
  c.stickX = 0; c.stickZ = 0;
  return { fwd: out, strafe: { mx: +s.mx.toFixed(2), mz: +s.mz.toFixed(2) } };
});
console.log('  ', JSON.stringify(moved));
check('stick forward walks the way you face (north)',
  Math.abs(moved.fwd[0].mz - 1) < 0.05, JSON.stringify(moved.fwd[0]));
check('...and still forward after turning 90 degrees',
  Math.abs(moved.fwd[1].mx - 1) < 0.05, JSON.stringify(moved.fwd[1]));
check('stick sideways strafes', Math.abs(moved.strafe.mx - 1) < 0.05, JSON.stringify(moved.strafe));

// --- the fire button can be moved -----------------------------------------
console.log('\n--- repositioning fire ---');
const dragged = await page.evaluate(async () => {
  const c = window.__cluckdown.game.controls;
  c.setFireEdit(true);
  const btn = document.getElementById('fire-btn');
  const before = btn.getBoundingClientRect().left;
  c.onFireDown({ pointerId: 3, clientX: 700, clientY: 300, preventDefault() {} });
  c.onFireMove({ pointerId: 3, clientX: 500, clientY: 200 });
  c.onFireUp({ pointerId: 3 });
  const after = btn.getBoundingClientRect().left;
  const stored = JSON.parse(localStorage.getItem('cluckdown.fire.v1') ?? 'null');
  c.setFireEdit(false);
  return { before: Math.round(before), after: Math.round(after), stored, editing: c.fireEdit };
});
console.log('  ', JSON.stringify(dragged));
check('edit mode moves the fire button', Math.abs(dragged.after - dragged.before) > 40,
  `${dragged.before} → ${dragged.after}`);
check('the new position is saved', !!dragged.stored, JSON.stringify(dragged.stored));
check('edit mode turns back off', dragged.editing === false);

await shot(page, `${OUT}/16-fps-touch.png`);
check('no exceptions anywhere', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
