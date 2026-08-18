// Look at it. A screenshot tool, not a test.
//
// Lighting and a viewmodel cannot be asserted — "is it too dark" and "is the
// beak the right size" are answered by opening the image. Both of those went
// through several passes here: the first beak covered a quarter of the frame,
// and it took a picture to notice.
//
// Deliberately NOT wired into test:browser. It prints a few numbers worth
// sanity-checking (the beak is in its own rendering group, the lamps are thin
// instanced, brightness reaches the lights) and leaves two PNGs behind.
//
//   npm run dev:client
//   OUT_DIR=. node client/test/_look.mjs
import { chromium } from 'playwright';
import { passLobby } from './_lobby.mjs';

const URL = process.env.UI_URL || 'http://localhost:5174';
const OUT = process.env.OUT_DIR || '.';
const errors = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/ERR_CONNECTION_REFUSED|Failed to load resource/.test(t)) return;
  errors.push(t);
});

async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await page.evaluate(fn);
    if (last) return last;
    await page.waitForTimeout(150);
  }
  return last;
}

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.fill('#name-input', 'Look');
await page.click('#practice-btn');
await passLobby(page);
await until(() => window.__cluckdown?.session?.phase === 'live');

// Stand still and face the middle so the frame is comparable run to run.
await until(() => {
  const S = window.__cluckdown;
  const me = S.session.world.players.get(S.session.selfId);
  if (!me) return null;
  me.hp = 100;
  // On the z axis, which every map keeps clear of cover, looking at the middle.
  me.x = 0; me.z = 18;
  S.game.controls.yaw = Math.atan2(0, -18);
  S.game.controls.pitch = -0.05;
  return S.game.camera.position.y < 3;
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/20-lit-fps.png`, timeout: 20000 });

const info = await page.evaluate(() => {
  const S = window.__cluckdown;
  const g = S.game;
  const scene = g.scene;
  return {
    view: g.view,
    beakShown: g.beak.shown,
    beakGroup: g.beak.root.renderingGroupId,
    beakEnabled: g.beak.root.isEnabled(),
    tip: (() => { const t = g.beak.tipWorld(); return { x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2) }; })(),
    camY: +g.camera.position.y.toFixed(2),
    lamps: scene.meshes.filter((m) => /lamp/i.test(m.name)).map((m) => `${m.name}x${m.thinInstanceCount || 1}`),
    hemi: +scene.lights.find((l) => l.name === 'hemi').intensity.toFixed(3),
    key: +scene.lights.find((l) => l.name === 'key').intensity.toFixed(3),
    fog: scene.fogDensity,
    draws: scene.getActiveMeshes().length,
  };
});
console.log('FPS:', JSON.stringify(info, null, 1));

// --- firing, held open so the flash frame can actually be captured.
//
// The muzzle flash lasts 55ms and this runs at single-digit frames per second
// under SwiftShader, so waiting for one would never catch it. Pinned instead,
// with a live tracer alongside, because the thing being checked is how much of
// the screen the pair of them cover.
await page.evaluate(() => {
  const S = window.__cluckdown;
  const g = S.game;
  const me = S.session.players.find((p) => p.isSelf);
  g.handleFx([{
    type: 'shot', id: 991, x: me.x, y: me.y + 1.15, z: me.z,
    aim: g.controls.yaw, pitch: g.controls.pitch, owner: me.id, rapid: false, ammo: 'none',
  }]);
  // AFTER the shot: handleFx calls kick(), which would reset a timer set first.
  g.beak.flashFor = 999;
});
await page.waitForTimeout(120);
await page.screenshot({ path: `${OUT}/22-firing.png`, timeout: 20000 });

const flash = await page.evaluate(() => {
  const g = window.__cluckdown.game;
  const cam = g.camera.position;
  const f = g.beak.flash.getAbsolutePosition();
  const tracer = [...g.bullets.active.values()].pop();
  const tp = tracer ? tracer.mesh.position : null;
  const frameAt = (d) => 2 * d * Math.tan(g.camera.fov / 2); // visible height there
  const fd = Math.hypot(f.x - cam.x, f.y - cam.y, f.z - cam.z);
  const td = tp ? Math.hypot(tp.x - cam.x, tp.y - cam.y, tp.z - cam.z) : null;
  const proj = g.projectFn(f.x, f.y, f.z);
  return {
    enabled: g.beak.flash.isEnabled(),
    group: g.beak.flash.renderingGroupId,
    screen: proj ? { x: Math.round(proj.x), y: Math.round(proj.y) } : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    flashDist: +fd.toFixed(2),
    flashPctOfFrame: +((0.05 * g.beak.flash.scaling.x) / frameAt(fd) * 100).toFixed(1),
    tracerDist: td === null ? null : +td.toFixed(2),
    tracerPctOfFrame: td === null ? null : +(0.24 / frameAt(td) * 100).toFixed(1),
  };
});
console.log('flash/tracer screen coverage:', JSON.stringify(flash));
await page.evaluate(() => { window.__cluckdown.game.beak.flashFor = 0; });

// ...and third person, where the beak must be gone.
await page.evaluate(() => window.__cluckdown.game.setView('tpp'));
await until(() => window.__cluckdown.game.view === 'tpp' && !window.__cluckdown.game.beak.shown);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/21-lit-tpp.png`, timeout: 20000 });
console.log('TPP beak hidden:', await page.evaluate(() => !window.__cluckdown.game.beak.root.isEnabled()));

// Brightness setting reaches the lights.
const bright = await page.evaluate(() => {
  const scene = window.__cluckdown.game.scene;
  const before = scene.lights.find((l) => l.name === 'hemi').intensity;
  const el = document.getElementById('gfx-brightness');
  el.value = '160';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const after = scene.lights.find((l) => l.name === 'hemi').intensity;
  el.value = '100';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { before: +before.toFixed(3), after: +after.toFixed(3), restored: +scene.lights.find((l) => l.name === 'hemi').intensity.toFixed(3) };
});
console.log('brightness:', JSON.stringify(bright));

console.log('errors:', errors.length ? errors.slice(0, 4).join(' | ') : '(none)');
await browser.close();
process.exit(errors.length ? 1 : 0);
