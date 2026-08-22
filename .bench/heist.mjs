import { chromium } from 'playwright';
import { passLobby } from '../client/test/_lobby.mjs';
const b = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 900, height: 600 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Heist');
await page.click('.mode-btn[data-mode="heist"]');
await page.click('#practice-btn');
await passLobby(page, { timeout: 60000 });
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const s = window.__cluckdown.session;
    const w = s.world;
    return {
      real: Math.round(performance.now() / 1000),
      phase: s.phase, clock: +s.clock.toFixed(1), simTime: +w.time.toFixed(1),
      eggs: s.nests.map((n) => n.eggs), carried: s.players.reduce((a, p) => a + (p.carrying ?? 0), 0),
      loose: s.looseEggs.length,
      roles: s.players.map((p) => p.role).join(','),
      alive: s.players.filter((p) => p.alive).length,
      fps: Math.round(window.__cluckdown.game.engine.getFps()),
    };
  });
  console.log(JSON.stringify(r));
}
console.log('errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
