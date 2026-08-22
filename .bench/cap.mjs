// Verifies the frame cap paces drawing WITHOUT slowing the simulation down.
import { chromium } from 'playwright';
import { passLobby } from '../client/test/_lobby.mjs';
const b = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
for (const cap of [0, 30]) {
  const page = await b.newPage({ viewport: { width: 900, height: 600 } });
  await page.addInitScript((c) => localStorage.setItem('cluckdown.gfx.v1', JSON.stringify({
    resolution: 1, glow: false, antialias: false, view: 'fps', tier: 'high', dynamicRes: false, fpsCap: c,
  })), cap);
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.fill('#name-input', 'Cap');
  await page.click('#practice-btn');
  await passLobby(page, { timeout: 60000 });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => new Promise((res) => {
    const g = window.__cluckdown.game;
    let frames = 0; const f = g.frame; g.frame = function (...a) { frames++; return f.apply(this, a); };
    const t0 = performance.now(); const c0 = g.session.clock; const s0 = g.session.world.time;
    setTimeout(() => {
      const secs = (performance.now() - t0) / 1000;
      g.frame = f;
      res({
        secs: +secs.toFixed(2), drawnFps: +(frames / secs).toFixed(1),
        simSecondsPerRealSecond: +((g.session.world.time - s0) / secs).toFixed(3),
        clockSecondsPerRealSecond: +((c0 - g.session.clock) / secs).toFixed(3),
        reportedFps: +g.fps.toFixed(1),
      });
    }, 6000);
  }));
  console.log(`cap=${cap || 'uncapped'}  ${JSON.stringify(r)}`);
  await page.close();
}
await b.close();
