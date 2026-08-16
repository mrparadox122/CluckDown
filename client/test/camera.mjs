// Dynamic camera test.
//
// Checks the three framing states are actually distinct and transition in the
// right direction: close while alive, wide while dead, and a tight punch-in on
// respawn so you can tell you're back.
//
//   npm run dev:client
//   node client/test/camera.mjs

import { chromium } from 'playwright';
import { passLobby } from './_lobby.mjs';

const URL = process.env.UI_URL || 'http://localhost:5173';

const failures = [];
const pageErrors = [];
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// Non-1 DPR on purpose: render-px vs CSS-px bugs are invisible at 1.
const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1.5 });
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Beaky');
await page.click('#practice-btn');
await passLobby(page);
await page.waitForTimeout(3500);

// Distance from the camera to its focus point is the honest measure of framing —
// it accounts for both the height and the pull-back together.
const rig = () => page.evaluate(() => {
  const r = window.__cluckdown.game.rig;
  const c = r.camera.position;
  return {
    zoom: +r.zoom.toFixed(3),
    zoomTarget: +r.zoomTarget.toFixed(3),
    dist: +Math.hypot(c.x - r.focus.x, c.y - r.focus.y, c.z - r.focus.z).toFixed(2),
    alive: window.__cluckdown.game.session.players.find((p) => p.isSelf)?.alive,
  };
});

const alive = await rig();
console.log('\nalive:  ', JSON.stringify(alive));
check('starts in the close framing', alive.zoom < 1, `zoom=${alive.zoom}`);

// Record every frame from inside the page. The respawn punch eases away in
// well under a second, and polling over the CDP bridge is far too coarse to
// catch its peak reliably.
await page.evaluate(() => {
  const g = window.__cluckdown.game;
  window.__rec = { deadMax: 0, aliveMin: Infinity, sawDead: false, sawRespawn: false };
  const tick = () => {
    const r = g.rig;
    const c = r.camera.position;
    const d = Math.hypot(c.x - r.focus.x, c.y - r.focus.y, c.z - r.focus.z);
    const me = g.session.players.find((p) => p.isSelf);
    if (me && !me.alive) {
      window.__rec.sawDead = true;
      window.__rec.deadMax = Math.max(window.__rec.deadMax, d);
    } else if (window.__rec.sawDead) {
      window.__rec.sawRespawn = true;
      window.__rec.aliveMin = Math.min(window.__rec.aliveMin, d);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Force death directly rather than waiting on a bot to land the shot — the sim
// still runs its real respawn path from here, emitting a genuine respawn event.
await page.evaluate(() => {
  const w = window.__cluckdown.session.world;
  const me = w.players.get('you');
  me.hp = 0;
  me.alive = false;
  me.respawnAt = w.time + 2.5;
});

// Wait for the pull-back to develop, then for the respawn to land and settle.
await page.waitForTimeout(2500);
const dead = await rig();
console.log('dead:   ', JSON.stringify(dead));
check('player is dead', dead.alive === false, `alive=${dead.alive}`);
check('dead framing targets the wide zoom', dead.zoomTarget > alive.zoomTarget,
  `${alive.zoomTarget} → ${dead.zoomTarget}`);

for (let i = 0; i < 200 && !(await page.evaluate(() => window.__rec.sawRespawn)); i++) {
  await page.waitForTimeout(100);
}
// Make the player immortal before measuring the settled framing. Bots kill
// them again within a few seconds, and a second respawn punch mid-measurement
// makes this read a half-finished zoom.
await page.evaluate(() => {
  const w = window.__cluckdown.session.world;
  const me = w.players.get('you');
  const keep = () => {
    me.alive = true;
    me.hp = 100;
    me.invulnUntil = w.time + 999;
    requestAnimationFrame(keep);
  };
  requestAnimationFrame(keep);
});

// Wait for the zoom to actually reach its target rather than for a fixed time.
for (let i = 0; i < 100; i++) {
  const done = await page.evaluate(() => {
    const r = window.__cluckdown.game.rig;
    return Math.abs(r.zoom - r.zoomTarget) < 0.005;
  });
  if (done) break;
  await page.waitForTimeout(100);
}

const rec = await page.evaluate(() => window.__rec);
const settled = await rig();
console.log('recorded:', JSON.stringify({ deadMax: +rec.deadMax.toFixed(2), punchMin: +rec.aliveMin.toFixed(2) }));
console.log('settled:', JSON.stringify(settled));

check('camera pulled back while dead', rec.deadMax > alive.dist * 1.2,
  `alive ${alive.dist} → dead ${rec.deadMax.toFixed(2)}`);
check('respawn punched in tighter than normal play', rec.sawRespawn && rec.aliveMin < alive.dist,
  rec.sawRespawn ? `punch ${rec.aliveMin.toFixed(2)} vs alive ${alive.dist}` : 'never respawned');
check('settles back to the alive framing', Math.abs(settled.dist - alive.dist) < 1.5,
  `${settled.dist} vs ${alive.dist}`);
check('player is alive again', settled.alive === true);

// --- centring ---
// Teleport into each corner in turn. Corners are the hard case: this is where
// the old void-clamp stopped following and let the player slide off-centre.
console.log('\n--- centring at the arena extremes ---');
const offsets = [];
const corners = [[0, 0, 'centre'], [-1, -1, 'SW corner'], [1, 1, 'NE corner'], [1, -1, 'SE corner'], [-1, 1, 'NW corner']];

for (const [cx, cz, label] of corners) {
  const off = await page.evaluate(([sx, sz]) => new Promise((resolve) => {
    const g = window.__cluckdown.game;
    const w = window.__cluckdown.session.world;
    const me = w.players.get('you');
    const half = g.session.arenaSize / 2 - 1;
    const tx = sx * half;
    const tz = sz * half;

    // Pin the player there every frame. Left alone they get shot, knocked
    // about and respawned elsewhere, which is what made the first attempt at
    // this measurement meaningless.
    //
    // Wait for the camera to actually converge rather than for a fixed time:
    // the software renderer here runs at a couple of frames per second, and a
    // fixed delay just measures a half-finished pan.
    const start = performance.now();
    const pin = () => {
      me.alive = true;
      me.hp = 100;
      me.invulnUntil = w.time + 999;
      me.x = tx; me.z = tz; me.kx = 0; me.kz = 0;
      g.pred.x = tx; g.pred.z = tz;

      const err = Math.hypot(g.rig.focus.x - tx, g.rig.focus.z - tz);
      const settled = err < 0.03 && g.rig.shake < 0.01;
      if (!settled && performance.now() - start < 20000) return requestAnimationFrame(pin);

      // Project the ground directly under the player. If the camera is truly
      // centred on them this lands exactly on the middle of the render target.
      // projectFn returns CSS pixels, so compare against the CSS viewport —
      // not the render buffer, which differs whenever devicePixelRatio != 1.
      const p = g.projectFn(tx, 0, tz);
      resolve(p
        ? { dx: p.x - window.innerWidth / 2, dy: p.y - window.innerHeight / 2, err, settled }
        : null);
    };
    requestAnimationFrame(pin);
  }), [cx, cz]);

  console.log(`  ${label.padEnd(10)} dx=${off.dx.toFixed(1)}px  dy=${off.dy.toFixed(1)}px  (focus err ${off.err.toFixed(3)}u, settled=${off.settled})`);
  offsets.push({ label, ...off });
}

const worst = Math.max(...offsets.map((o) => Math.hypot(o.dx, o.dy)));
check('player is centred everywhere, corners included', worst < 6,
  `worst offset ${worst.toFixed(1)}px from screen centre`);
check('no exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
