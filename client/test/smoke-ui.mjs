import { chromium } from 'playwright';
import { passLobby } from './_lobby.mjs';

// Screenshots are diagnostics, not assertions. Under a loaded CPU the software
// renderer can blow the default capture timeout, and that must not fail a run.
async function shot(page, path) {
  try {
    await page.screenshot({ path, animations: 'disabled', timeout: 15000 });
  } catch (err) {
    console.warn(`  (screenshot ${path} skipped: ${err.message.slice(0, 90)})`);
  }
}


const URL = process.env.UI_URL || 'http://localhost:5173';
const OUT = process.env.OUT_DIR || '.';
const MODE = process.env.PLAY_MODE || 'practice'; // 'practice' | 'online'

const errors = [];
const logs = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 }, deviceScaleFactor: 1 });

page.on('console', (m) => {
  const t = `${m.type()}: ${m.text()}`;
  logs.push(t);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

console.log('== menu ==');
console.log('title:', await page.title());
console.log('modes:', await page.$$eval('.mode-btn strong', (n) => n.map((x) => x.textContent)));
console.log('rank:', await page.textContent('#rank-name'), await page.textContent('#rank-elo'));
await shot(page, `${OUT}/01-menu.png`);

// Type a name, pick a mode, start.
await page.fill('#name-input', 'Beaky');
await page.click(`.mode-btn[data-mode="deathmatch"]`);
await page.waitForTimeout(200);
await shot(page, `${OUT}/02-menu-filled.png`);

if (MODE === 'online') {
  await page.click('#play-btn');
  await passLobby(page);
} else {
  await page.click('#practice-btn');
  await passLobby(page);
}

// Let the match run so bots fight, bomber spawns, pickups appear.
await page.waitForTimeout(4000);
await shot(page, `${OUT}/03-game-early.png`);
// The standings are HELD open now, not permanent — see Hud.setScoreboardOpen —
// so reading `.sb-row` cold reports an empty board whether the scoreboard works
// or not. Hold Tab the way a player would, read, let go.
async function scoreboardRows(page) {
  await page.keyboard.down('Tab');
  await page.waitForTimeout(250);
  const rows = await page.$$eval('.sb-row', (n) => n.map((x) => x.textContent.trim()));
  await page.keyboard.up('Tab');
  return rows;
}


console.log('\n== in game ==');
console.log('hud visible:', !(await page.getAttribute('#hud', 'class'))?.includes('hidden'));
console.log('clock:', await page.textContent('#match-clock'));
console.log('mode pill:', await page.textContent('#mode-pill'));
console.log('nameplates:', await page.$$eval('.nameplate', (n) => n.length));
console.log('scoreboard rows (Tab held):', await scoreboardRows(page));

// Drive the player around and shoot with keyboard+mouse.
await page.mouse.move(700, 250);
await page.keyboard.down('KeyW');
await page.mouse.down();
await page.waitForTimeout(1500);
await shot(page, `${OUT}/04-shooting.png`);
await page.keyboard.up('KeyW');
await page.keyboard.down('KeyD');
await page.waitForTimeout(1200);
await page.mouse.up();
await page.keyboard.up('KeyD');

// Quick chat.
//
// Firing grabbed pointer lock, which hands the cursor to the canvas and makes
// every HUD button unclickable — correct first-person behaviour, and the reason
// the game announces "ESC TO FREE THE CURSOR". So do what a player does.
// exitPointerLock() rather than a synthetic Escape: headless Chromium does not
// treat a dispatched keypress as the user gesture that releases the lock, but
// this is exactly what Escape does for a real player.
await page.evaluate(() => document.exitPointerLock?.());
await page.waitForTimeout(500);

const qc = await page.$$('.qc-btn');
if (qc[0]) await qc[0].click();
await page.waitForTimeout(300);

await page.waitForTimeout(12000);
await shot(page, `${OUT}/05-game-late.png`);

console.log('\n== after 18s ==');
console.log('clock:', await page.textContent('#match-clock'));
console.log('killfeed:', await page.$$eval('.kf-row', (n) => n.map((x) => x.textContent.trim())));
console.log('chat:', await page.$$eval('.chat-row', (n) => n.map((x) => x.textContent.trim())));
console.log('scoreboard (Tab held):', await scoreboardRows(page));
console.log('fuse ring present:', await page.$$eval('.fuse-ring', (n) => n.length));
console.log('canvas size:', await page.$eval('#stage', (c) => `${c.width}x${c.height}`));

const fps = await page.evaluate(() => new Promise((res) => {
  let frames = 0;
  const t0 = performance.now();
  const tick = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(Math.round(frames / ((performance.now() - t0) / 1000))); };
  requestAnimationFrame(tick);
}));
console.log('fps (swiftshader software render):', fps);

console.log('\n== errors ==');
console.log(errors.length ? errors.join('\n') : '(none)');

await browser.close();
process.exit(errors.length ? 1 : 0);
