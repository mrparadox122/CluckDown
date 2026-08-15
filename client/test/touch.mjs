// Touch control test — emulates a real phone and drags both joysticks.
//
// This exists because the desktop tests drive WASD + mouse, which bypasses
// nipplejs entirely. A change in the nipplejs listener signature (1.x passes
// one `{type,target,data}` object; 0.x passed `(event, data)`) broke both
// sticks completely while every other test stayed green.
//
//   npm run dev:client
//   node client/test/touch.mjs

import { chromium } from 'playwright';

const URL = process.env.UI_URL || 'http://localhost:5173';

const pageErrors = [];
const failures = [];
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
};
const near = (a, b, tol = 0.08) => Math.abs(a - b) <= tol;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// A phone in LANDSCAPE, which is how the game is actually played — portrait now
// shows the rotate prompt, and that overlay (correctly) swallows touches.
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Thumbs');
await page.click('#practice-btn');
await page.waitForTimeout(3500);

const LEFT = { x: 110, y: 320 };
const RIGHT = { x: 730, y: 320 };

// The stick zones must actually be the topmost element under a thumb — #hud
// is pointer-events:none and the zones opt back in, which is easy to break.
const onTop = await page.evaluate(([l, r]) => {
  const id = (p) => document.elementFromPoint(p.x, p.y)?.id ?? 'none';
  return { left: id(l), right: id(r) };
}, [LEFT, RIGHT]);
check('left zone receives touches', onTop.left === 'stick-left', onTop.left);
check('right zone receives touches', onTop.right === 'stick-right', onTop.right);

const readInput = () => page.evaluate(() => {
  const c = window.__cluckdown?.game?.controls;
  return c ? { ...c.input } : null;
});

const cdp = await context.newCDPSession(page);
async function drag(from, dx, dy) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  await page.waitForTimeout(120);
  for (let i = 1; i <= 4; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (dx * i) / 4, y: from.y + (dy * i) / 4, id: 1 }],
    });
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(180);
  const during = await readInput();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(220);
  return { during, after: await readInput() };
}

// Drag up-and-right on both sticks. Screen-up is world +Z, screen-right is +X,
// so a 45° up-right drag should give equal positive components on both axes.
console.log('\n--- left stick (movement) ---');
const left = await drag(LEFT, 70, -70);
console.log('   during:', JSON.stringify(left.during));
check('left stick drives movement', Math.hypot(left.during.mx, left.during.mz) > 0.3,
  `mx=${left.during.mx.toFixed(2)} mz=${left.during.mz.toFixed(2)}`);
check('up-right drag maps to +X and +Z', left.during.mx > 0.2 && left.during.mz > 0.2);
check('movement vector stays within unit length', Math.hypot(left.during.mx, left.during.mz) <= 1.02);
check('left stick does not fire the gun', left.during.shoot === false);
check('releasing left stick stops movement', left.after.mx === 0 && left.after.mz === 0);

console.log('\n--- right stick (aim + fire) ---');
const right = await drag(RIGHT, 60, -60);
console.log('   during:', JSON.stringify(right.during));
check('right stick drives aim', Math.hypot(right.during.ax, right.during.az) > 0.3,
  `ax=${right.during.ax.toFixed(2)} az=${right.during.az.toFixed(2)}`);
check('holding the right stick fires', right.during.shoot === true);
check('aim points up-right', right.during.ax > 0.2 && right.during.az > 0.2);
check('releasing right stick stops firing', right.after.shoot === false);
check('releasing right stick clears aim', right.after.ax === 0 && right.after.az === 0);

// A drag pointing the other way must produce the opposite sign, otherwise a
// hardcoded constant would satisfy every check above.
console.log('\n--- left stick, opposite direction ---');
const back = await drag(LEFT, -70, 70);
console.log('   during:', JSON.stringify(back.during));
check('down-left drag reverses both axes', back.during.mx < -0.2 && back.during.mz < -0.2,
  `mx=${back.during.mx.toFixed(2)} mz=${back.during.mz.toFixed(2)}`);
check('magnitude matches the mirrored drag',
  near(Math.hypot(back.during.mx, back.during.mz), Math.hypot(left.during.mx, left.during.mz), 0.15));

console.log('\n--- errors ---');
check('no exceptions thrown during touch', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
