import { chromium } from 'playwright';
import { passLobby } from '../client/test/_lobby.mjs';
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
console.log('device:', JSON.stringify(await page.evaluate(() => ({
  coarse: matchMedia('(pointer: coarse)').matches,
  fine: matchMedia('(pointer: fine)').matches,
  mem: navigator.deviceMemory, cores: navigator.hardwareConcurrency, dpr: devicePixelRatio,
}))));
await page.fill('#name-input', 'Smoke2');
await page.click('#practice-btn');
await passLobby(page, { timeout: 60000 });
for (const wait of [4000, 6000, 6000]) {
  await page.waitForTimeout(wait);
  const r = await page.evaluate(() => {
    const g = window.__cluckdown.game;
    const s = g.snap.self;
    return {
      t: Math.round(performance.now() / 1000),
      phase: g.snap.phase, players: g.snap.players.length,
      self: s ? { alive: s.alive, hp: s.hp, respawnIn: s.respawnIn, role: s.role, lvl: s.level } : null,
      vitals: !document.getElementById('vitals').classList.contains('hidden'),
      crosshair: getComputedStyle(document.getElementById('crosshair')).opacity,
      hp: document.getElementById('hp-num').textContent,
      crop: document.getElementById('crop').childElementCount,
      badges: g.scene.meshes.filter((m) => ['aura','crown','grudge','spot','flame','shield'].includes(m.name)).map((m) => m.name),
      relax: +g.adaptive.relaxation.toFixed(3),
    };
  });
  console.log(JSON.stringify(r));
}
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
