// Verifies the always-on optimisations actually took effect, and that the
// graphics settings do what they claim.
import { chromium } from 'playwright';

const URL = process.env.UI_URL || 'http://localhost:5173';
const failures = [];
const errs = [];
const check = (l, c, d = '') => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`); if (!c) failures.push(l); };

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function run(gfx, label) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1.5 });
  page.on('pageerror', (e) => errs.push(`[${label}] ${e.message}`));
  await page.addInitScript((g) => localStorage.setItem('cluckdown.gfx.v1', JSON.stringify(g)), gfx);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.fill('#name-input', 'Perf');
  await page.click('#practice-btn');
  await page.waitForTimeout(6000);
  // Make some debris so the particle path is exercised.
  // Emit debris and sample the live count straight away. Particles only live
  // ~0.9s, and a fixed wait is real time — so on a faster run more frames elapse
  // and they have all expired by the time we look, which reads as "no thin
  // instances" rather than "they came and went".
  const debrisPeak = await page.evaluate(() => new Promise((resolve) => {
    const g = window.__cluckdown.game;
    for (let i = 0; i < 6; i++) g.debris.emit('red', i - 3, 1, 0, 12, {});
    g.debris.feathers(0, 1.5, 0, 20);

    let peak = [0, 0, 0, 0];
    let frames = 0;
    const sample = () => {
      const now = Object.values(g.debris.kinds).map((k) => k.mesh.thinInstanceCount);
      peak = peak.map((n, i) => Math.max(n, now[i]));
      if (++frames < 10) return void requestAnimationFrame(sample);
      resolve(peak);
    };
    requestAnimationFrame(sample);
  }));
  const stats = await page.evaluate(() => {
    const g = window.__cluckdown.game;
    const s = g.scene;
    const chickens = s.meshes.filter((m) => m.name === 'chicken');
    return {
      drawCalls: s.getEngine()._drawCalls?.current ?? null,
      totalMeshes: s.meshes.length,
      chickenMeshes: chickens.length,
      chickenSubMeshes: chickens.reduce((a, m) => a + (m.subMeshes?.length ?? 0), 0),
      materials: s.materials.length,
      hasGlow: !!g.glow,
      scaling: +s.getEngine().getHardwareScalingLevel().toFixed(3),
      debrisThin: Object.values(g.debris.kinds).map((k) => k.mesh.thinInstanceCount),
      debrisPeak: null, // filled in below from the sampled peak
      debrisIsThin: Object.values(g.debris.kinds).every((k) => typeof k.mesh.thinInstanceCount === 'number'),
    };
  });
  await page.close();
  return { ...stats, debrisPeak };
}

const high = await run({ resolution: 1, glow: true, antialias: true }, 'high');
console.log('\nHIGH  ', JSON.stringify(high));
const low = await run({ resolution: 0.5, glow: false, antialias: false }, 'low');
console.log('LOW   ', JSON.stringify(low));

console.log('\n--- always-on optimisations ---');
check('each chicken is a single mesh', high.chickenMeshes > 0 && high.chickenSubMeshes === high.chickenMeshes,
  `${high.chickenMeshes} chickens / ${high.chickenSubMeshes} submeshes`);
check('debris uses thin instances', high.debrisIsThin, JSON.stringify(high.debrisThin));
check('debris particles actually render', high.debrisPeak.some((n) => n > 0),
  `peak thin-instance counts ${JSON.stringify(high.debrisPeak)}`);
// A ceiling to catch runaway duplication (every chicken minting its own beak
// material, every muzzle flash its own), not a pinned count. It grows when
// genuinely new visuals land — four tracer colours, five pickup colours and the
// burning flame all arrived with the ammo types.
check('material count stays lean', high.materials <= 34, `${high.materials} materials`);

console.log('\n--- settings ---');
check('glow disabled when turned off', high.hasGlow === true && low.hasGlow === false);
check('lower resolution raises hardware scaling', low.scaling > high.scaling * 1.9,
  `${high.scaling} -> ${low.scaling}`);
check('no exceptions', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
