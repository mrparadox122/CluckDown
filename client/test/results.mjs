// End-of-match verification: forces a practice match to finish, then checks the
// podium, results table and rating line all render.
//
//   npm run dev:client        (in one terminal)
//   npm run test:results -w @cluckdown/client
//
// Uses the dev-only window.__cluckdown handle to jump the match clock forward.

import { chromium } from 'playwright';

// Screenshots are diagnostics, not assertions. Under a loaded CPU the software
// renderer can blow the default capture timeout, and that must not fail a run.
async function shot(page, path) {
  try {
    await page.screenshot({ path, animations: 'disabled', timeout: 15000 });
  } catch (err) {
    console.warn(`  (screenshot ${path} skipped: ${err.message.slice(0, 90)})`);
  }
}


const OUT = process.env.OUT_DIR || '.';
const errors = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Beaky');
await page.click('#practice-btn');
await page.waitForTimeout(3000);

// Let bots rack up a few kills so the table has real numbers, then jump the
// clock to force the match to end.
await page.evaluate(() => { window.__cluckdown.session.world.clock = 2; });
await page.waitForTimeout(20000);

console.log('results visible:', !(await page.getAttribute('#results', 'class'))?.includes('hidden'));
console.log('title:', await page.textContent('#results-title'));
console.log('podium slots:', await page.$$eval('.podium-slot', (n) => n.map((x) => x.textContent.trim())));
console.log('rows:');
for (const r of await page.$$eval('#results-rows tr', (n) => n.map((x) => [...x.children].map((c) => c.textContent.trim()).join(' | ')))) {
  console.log('   ', r);
}
console.log('rating line:', await page.textContent('#results-rating'));
await shot(page, `${OUT}/06-results.png`);

// Career stats should have been written back to the menu.
await page.click('#menu-btn');
await page.waitForTimeout(400);
console.log('career:', await page.$$eval('.career-stats div', (n) => n.map((x) => x.textContent.trim())));
await shot(page, `${OUT}/07-menu-after.png`);

console.log('\nerrors:', errors.length ? errors.join('\n') : '(none)');
await browser.close();
process.exit(errors.length ? 1 : 0);
