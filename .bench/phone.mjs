// The phone case: what a touch device actually gets now, vs what it got before.
import { chromium } from 'playwright';
import { passLobby } from '../client/test/_lobby.mjs';
const THROTTLE = Number(process.env.THROTTLE || 6);
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });

async function run(gfx, label) {
  // hasTouch + isMobile make matchMedia('(pointer: coarse)') true, so the tier
  // detection sees what a real phone would.
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 3,
    hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  if (gfx) await page.addInitScript((g) => localStorage.setItem('cluckdown.gfx.v1', JSON.stringify(g)), gfx);
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.fill('#name-input', 'Phone');
  await page.tap('#practice-btn');
  if (!await passLobby(page, { timeout: 60000 })) { await ctx.close(); return null; }
  await page.waitForTimeout(4000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await page.waitForTimeout(2500);
  const grab = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await page.evaluate(() => { window.__f = 0; const g = window.__cluckdown.game; const f = g.frame; g.frame = function (...a) { window.__f++; return f.apply(this, a); }; });
  const a = await grab();
  // Drive the left stick so the sim is doing real work, like a thumb would.
  await page.evaluate(() => { const g = window.__cluckdown.game; g.controls.usingTouch = true; g.controls.stickX = 0.7; g.controls.stickZ = 0.7; });
  await page.waitForTimeout(8000);
  const b = await grab();
  const frames = await page.evaluate(() => window.__f);
  const extra = await page.evaluate(() => {
    const g = window.__cluckdown.game;
    return {
      relax: +g.adaptive.relaxation.toFixed(2), base: +g.adaptive.base.toFixed(2),
      level: +g.engine.getHardwareScalingLevel().toFixed(2),
      rw: g.engine.getRenderWidth(), rh: g.engine.getRenderHeight(),
      glow: !!g.glow, tier: window.__cluckdown.gfx.tier,
      meshes: g.scene.meshes.length, mats: g.scene.materials.length,
    };
  });
  const wall = b.Timestamp - a.Timestamp;
  const d = (k) => ((b[k] ?? 0) - (a[k] ?? 0)) * 1000 / wall;
  await ctx.close();
  return { label, fps: frames / wall, js: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration'), task: d('TaskDuration'), nodes: b.Nodes, ...extra };
}

const OLD = { resolution: 1, glow: true, antialias: true, view: 'fps' }; // no `tier` = pre-change blob
console.log(`TOUCH DEVICE — CPU throttle ${THROTTLE}x, 412x915 @dpr3\n`);
console.log(`${'variant'.padEnd(34)} ${'fps'.padStart(6)} ${'JS'.padStart(6)} ${'style'.padStart(6)} ${'layout'.padStart(7)} ${'task'.padStart(6)} ${'nodes'.padStart(7)}`);
for (const [g, label] of [
  [null, 'new: auto tier (fresh install)'],
  [OLD, 'old blob, corrected on load'],
  [{ ...OLD, tier: 'high' }, 'forced HIGH (the old behaviour)'],
]) {
  const r = await run(g, label);
  if (!r) { console.log(`${label.padEnd(34)} FAILED`); continue; }
  console.log(`${r.label.padEnd(34)} ${r.fps.toFixed(1).padStart(6)} ${r.js.toFixed(0).padStart(6)} ${r.style.toFixed(0).padStart(6)} ${r.layout.toFixed(0).padStart(7)} ${r.task.toFixed(0).padStart(6)} ${String(r.nodes).padStart(7)}`);
  console.log(`${''.padEnd(34)}   tier=${r.tier} glow=${r.glow} target=${r.rw}x${r.rh} scaling ${r.base}->${r.level} (relax ${r.relax}) meshes=${r.meshes} mats=${r.mats}`);
}
await browser.close();
