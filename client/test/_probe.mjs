// Does the renderer agree with the simulation about how big the arena is?
import { chromium } from 'playwright';

const URL = process.env.UI_URL || 'http://localhost:5173';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

for (const map of ['coop', 'squeeze', 'yard', 'dusk', 'frost']) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.fill('#name-input', 'Probe');
  await page.click('#practice-btn');

  // Force the vote onto this map, whatever the candidates are.
  await page.waitForFunction(() => window.__cluckdown?.session?.world);
  await page.evaluate((m) => {
    const w = window.__cluckdown.session.world;
    if (!w.mapCandidates.includes(m)) w.mapCandidates[0] = m;
    w.votes.clear();
    for (const p of w.players.values()) w.votes.set(p.id, m);
  }, map);

  const info = await page.waitForFunction(() => {
    const s = window.__cluckdown?.session;
    const g = window.__cluckdown?.game;
    if (!g || !s || s.phase === 'lobby') return null;
    const wall = g.scene.meshes.find((mm) => mm.name === 'wall2'); // +x wall
    return {
      map: s.map,
      simSize: s.world.arena.size,
      simHalf: s.world.arena.half,
      sessionArenaSize: s.arenaSize,
      rigHalf: g.rig.half,
      wallX: wall ? +wall.position.x.toFixed(2) : null,
    };
  }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);

  if (!info) { console.log(map.padEnd(9), 'timed out'); continue; }
  const rendered = info.rigHalf * 2;
  const ok = Math.abs(rendered - info.simSize) < 0.01 && Math.abs((info.wallX ?? 0) - info.simHalf) < 1.2;
  console.log(
    `${info.map.padEnd(9)} sim=${String(info.simSize).padEnd(3)} session=${String(info.sessionArenaSize).padEnd(3)}`,
    `rigHalf=${String(info.rigHalf).padEnd(5)} wallX=${String(info.wallX).padEnd(6)}`,
    ok ? 'OK' : '<<< MISMATCH',
  );
}

await browser.close();
