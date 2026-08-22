import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=d3d11'] });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
console.log('errors:', errs.length ? errs : 'none');
console.log('settings elements:', JSON.stringify(await p.evaluate(() => ({
  cap: !!document.getElementById('gfx-fps-cap'),
  capOpts: document.getElementById('gfx-fps-cap')?.childElementCount,
  dyn: !!document.getElementById('gfx-dynamic-res'),
  sens: document.getElementById('gfx-sensitivity')?.value,
  sensOut: document.getElementById('gfx-sensitivity-out')?.textContent,
  bright: document.getElementById('gfx-brightness')?.value,
  scoreBtn: !!document.getElementById('score-btn'),
}))));
await b.close();
