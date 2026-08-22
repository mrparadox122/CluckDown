// Does the match still work, and did the scoreboard actually become a hold?
import { chromium } from 'playwright';
import { passLobby } from '../client/test/_lobby.mjs';
const URL = 'http://localhost:5173';
const errs = [];
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3 });
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Smoke');
await page.click(process.env.MODE === 'online' ? '#play-btn' : '#practice-btn');
if (!await passLobby(page, { timeout: 60000 })) { console.log('FAILED to enter match'); console.log(errs); process.exit(1); }
await page.waitForTimeout(6000);
await page.keyboard.down('KeyW'); await page.waitForTimeout(2500); await page.keyboard.up('KeyW');

const closed = await page.evaluate(() => {
  const sb = document.getElementById('scoreboard');
  return { rows: sb.childElementCount, display: getComputedStyle(sb).display, open: sb.classList.contains('is-open') };
});
await page.keyboard.down('Tab');
await page.waitForTimeout(700);
const held = await page.evaluate(() => {
  const sb = document.getElementById('scoreboard');
  return { rows: sb.childElementCount, display: getComputedStyle(sb).display, open: sb.classList.contains('is-open') };
});
await page.keyboard.up('Tab');
await page.waitForTimeout(400);
const after = await page.evaluate(() => {
  const sb = document.getElementById('scoreboard');
  return { rows: sb.childElementCount, display: getComputedStyle(sb).display };
});

const state = await page.evaluate(() => {
  const g = window.__cluckdown.game;
  const s = g.scene;
  return {
    fps: g.engine.getFps(),
    meshes: s.meshes.length, materials: s.materials.length,
    glow: !!g.glow, scaling: +g.engine.getHardwareScalingLevel().toFixed(3),
    base: +g.adaptive.base.toFixed(3), dyn: g.adaptive.enabled, cap: g.adaptive.cap,
    tier: window.__cluckdown.gfx?.tier ?? '(not exposed)',
    plates: document.querySelectorAll('.nameplate').length,
    platesVisible: [...document.querySelectorAll('.nameplate')].filter((e) => e.style.display !== 'none').length,
    vitals: !document.getElementById('vitals').classList.contains('hidden'),
    clock: document.getElementById('match-clock').textContent,
    crosshair: getComputedStyle(document.getElementById('crosshair')).opacity,
  };
});
console.log('scoreboard closed:', JSON.stringify(closed));
console.log('scoreboard held  :', JSON.stringify(held));
console.log('after release    :', JSON.stringify(after));
console.log('state            :', JSON.stringify(state, null, 1));
console.log('errors           :', errs.length ? errs.slice(0, 6) : 'none');
await browser.close();
