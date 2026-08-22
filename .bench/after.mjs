// Same measurement as the "before" run: main-thread budget under CPU throttling.
import { chromium } from 'playwright';
import { passLobby } from '../client/test/_lobby.mjs';
const URL = 'http://localhost:5173';
const THROTTLE = Number(process.env.THROTTLE || 6);
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });

async function run(gfxOverride, label, holdTab = false) {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3 });
  if (gfxOverride) await page.addInitScript((g) => localStorage.setItem('cluckdown.gfx.v1', JSON.stringify(g)), gfxOverride);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.fill('#name-input', 'After');
  await page.click('#practice-btn');
  if (!await passLobby(page, { timeout: 60000 })) { await page.close(); return null; }
  await page.waitForTimeout(4000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await page.waitForTimeout(2500);
  const grab = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await page.evaluate(() => { window.__f = 0; const g = window.__cluckdown.game; const f = g.frame; g.frame = function (...a) { window.__f++; return f.apply(this, a); }; });
  const a = await grab();
  if (holdTab) await page.keyboard.down('Tab');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(8000);
  await page.keyboard.up('KeyW');
  if (holdTab) await page.keyboard.up('Tab');
  const b = await grab();
  const frames = await page.evaluate(() => window.__f);
  const extra = await page.evaluate(() => {
    const g = window.__cluckdown.game;
    return { relax: +g.adaptive.relaxation.toFixed(2), meshes: g.scene.meshes.length, mats: g.scene.materials.length, tier: window.__cluckdown.gfx.tier };
  });
  const wall = b.Timestamp - a.Timestamp;
  const d = (k) => ((b[k] ?? 0) - (a[k] ?? 0)) * 1000 / wall;
  await page.close();
  return { label, fps: frames / wall, js: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration'), task: d('TaskDuration'), nodes: b.Nodes, ...extra };
}

console.log(`AFTER — CPU throttle ${THROTTLE}x, 412x915 @dpr3, offline practice\n`);
console.log(`${'variant'.padEnd(32)} ${'fps'.padStart(6)} ${'JS'.padStart(6)} ${'style'.padStart(6)} ${'layout'.padStart(7)} ${'task'.padStart(6)} ${'nodes'.padStart(7)} ${'relax'.padStart(6)}`);
for (const [g, label, hold] of [
  [null, 'new defaults (auto tier)', false],
  [null, 'new defaults + Tab held', true],
  [{ resolution: 1, glow: true, antialias: true, view: 'fps', tier: 'high', dynamicRes: true, fpsCap: 0 }, 'forced HIGH (old defaults)', false],
  [{ resolution: 1, glow: true, antialias: true, view: 'fps', tier: 'high', dynamicRes: false, fpsCap: 0 }, 'forced HIGH, no dyn-res', false],
]) {
  const r = await run(g, label, hold);
  if (!r) { console.log(`${label.padEnd(32)} FAILED`); continue; }
  console.log(`${r.label.padEnd(32)} ${r.fps.toFixed(1).padStart(6)} ${r.js.toFixed(0).padStart(6)} ${r.style.toFixed(0).padStart(6)} ${r.layout.toFixed(0).padStart(7)} ${r.task.toFixed(0).padStart(6)} ${String(r.nodes).padStart(7)} ${r.relax.toFixed(2).padStart(6)}  meshes=${r.meshes} mats=${r.mats} tier=${r.tier}`);
}
await browser.close();
