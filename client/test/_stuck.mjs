// Hypothesis: a touch that is CANCELLED rather than ended leaves the movement
// stick latched, so the chicken keeps walking with nobody touching the screen.
import { chromium } from 'playwright';
import { passLobby } from './_lobby.mjs';

const URL = process.env.UI_URL || 'http://localhost:5173';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Thumbs');
await page.click('#practice-btn');
await passLobby(page);
await page.waitForTimeout(3000);

const cdp = await context.newCDPSession(page);
const read = () => page.evaluate(() => {
  const c = window.__cluckdown?.game?.controls;
  const s = window.__cluckdown?.session;
  const me = s?.world?.players?.get(s.selfId);
  return { mx: +c.input.mx.toFixed(3), mz: +c.input.mz.toFixed(3), x: +me.x.toFixed(2), z: +me.z.toFixed(2) };
});

const LEFT = { x: 110, y: 300 };

for (const [name, ender] of [
  ['clean touchEnd', async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }],
  ['touchCancel (edge swipe, notification, palm reject)', async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  }],
]) {
  // Drag the movement stick hard to the left.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: LEFT.x, y: LEFT.y, id: 1 }] });
  await page.waitForTimeout(120);
  for (let i = 1; i <= 4; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: LEFT.x - 14 * i, y: LEFT.y, id: 1 }],
    });
    await page.waitForTimeout(60);
  }
  const during = await read();

  await ender();
  await page.waitForTimeout(400);
  const justAfter = await read();
  await page.waitForTimeout(2500);
  const later = await read();

  console.log(`\n--- ${name} ---`);
  console.log('  during drag :', JSON.stringify(during));
  console.log('  after release:', JSON.stringify(justAfter));
  console.log('  +2.5s later  :', JSON.stringify(later));
  const latched = Math.abs(later.mx) > 0.05 || Math.abs(later.mz) > 0.05;
  const drifted = Math.abs(later.x - justAfter.x) > 0.5;
  console.log(`  >>> stick latched: ${latched} | chicken kept moving: ${drifted}`);
}

await browser.close();
