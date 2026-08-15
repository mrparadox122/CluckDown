// Nameplate alignment test.
//
// Measures the gap between where each nameplate is drawn and where its chicken
// actually renders. Plates are HTML positioned by projecting a world point, so
// they drift if they project the raw server position instead of the rendered
// (predicted / interpolated) one.
//
//   npm run dev:client
//   node client/test/nameplates.mjs

import { chromium } from 'playwright';

const URL = process.env.UI_URL || 'http://localhost:5173';
const TOLERANCE_PX = 2; // sub-pixel rounding only

const failures = [];
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// deviceScaleFactor MUST NOT be 1 here. At 1 the render buffer and the CSS
// viewport are the same size, which hides any render-px vs CSS-px confusion in
// the projection — exactly the bug that shipped past an all-DPR-1 test suite.
const page = await browser.newPage({
  viewport: { width: 1100, height: 680 },
  deviceScaleFactor: 1.5,
});
page.on('pageerror', (e) => {
  console.log('PAGEERROR:', e.message);
  failures.push(`PAGEERROR: ${e.message}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Beaky');
// Online by default: offline practice runs the sim in the same loop as the
// renderer, so view and server positions converge every frame and the drift
// this test measures cannot appear. Prediction vs server state is the real case.
await page.click(process.env.PLAY_MODE === 'practice' ? '#practice-btn' : '#play-btn');
await page.waitForTimeout(process.env.PLAY_MODE === 'practice' ? 3500 : 12000);

// Drive the player so prediction/interpolation error is actually non-zero —
// a stationary chicken would hide the bug this test exists to catch.
await page.mouse.move(800, 300);
await page.keyboard.down('KeyD');
await page.waitForTimeout(900);

const measure = () => page.evaluate(() => {
  const game = window.__cluckdown.game;
  const out = [];
  for (const plate of document.querySelectorAll('.nameplate')) {
    if (plate.style.display === 'none') continue;
    const name = plate.querySelector('.np-name').textContent;
    // The inline transform is where the plate is actually drawn.
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(plate.style.transform);
    if (!m) continue;

    const player = game.session.players.find((p) => p.name === name);
    if (!player) continue;
    const view = game.views.get(player.id);
    if (!view) continue;

    const rendered = game.projectFn(view.x, 2.35, view.z);   // where the chicken is
    const serverPos = game.projectFn(player.x, 2.35, player.z); // where the server says
    if (!rendered) continue;

    out.push({
      name,
      self: !!player.isSelf,
      plate: { x: +m[1], y: +m[2] },
      rendered: { x: rendered.x, y: rendered.y },
      driftFromMesh: Math.hypot(+m[1] - rendered.x, +m[2] - rendered.y),
      meshVsServer: serverPos ? Math.hypot(rendered.x - serverPos.x, rendered.y - serverPos.y) : null,
    });
  }
  return out;
});

// Sample repeatedly while moving. Prediction error is momentary — it closes as
// the correction settles — so a single reading can legitimately catch a frame
// where mesh and server agree, which would make the meaningfulness guard below
// fail for no real reason.
let rows = await measure();
let peakSpread = Math.max(0, ...rows.map((r) => r.meshVsServer ?? 0));
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(120);
  const sample = await measure();
  const spreadNow = Math.max(0, ...sample.map((r) => r.meshVsServer ?? 0));
  if (spreadNow > peakSpread) { peakSpread = spreadNow; rows = sample; }
}
await page.keyboard.up('KeyD');

console.log('\n--- nameplate vs rendered chicken ---');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(12)}${r.self ? '(you)' : '     '} plate(${r.plate.x.toFixed(1)}, ${r.plate.y.toFixed(1)})  mesh(${r.rendered.x.toFixed(1)}, ${r.rendered.y.toFixed(1)})  drift=${r.driftFromMesh.toFixed(2)}px  mesh-vs-server=${r.meshVsServer?.toFixed(1) ?? '-'}px`);
}

console.log('\n--- assertions ---');
check('nameplates were found', rows.length > 0, `${rows.length} plates`);
check('own nameplate tracks its chicken', rows.filter((r) => r.self).every((r) => r.driftFromMesh <= TOLERANCE_PX),
  `max ${Math.max(0, ...rows.filter((r) => r.self).map((r) => r.driftFromMesh)).toFixed(2)}px`);
check('all nameplates track their chicken', rows.every((r) => r.driftFromMesh <= TOLERANCE_PX),
  `max ${Math.max(0, ...rows.map((r) => r.driftFromMesh)).toFixed(2)}px`);

// Sanity: confirm rendered and server positions really do differ, otherwise
// this test would pass even with the bug reintroduced.
check('test is meaningful (mesh and server positions differ)', peakSpread > 1,
  `${peakSpread.toFixed(1)}px apart at peak — this is the gap the old code showed`);

// Every plate must sit inside the viewport — a coordinate-space error (render
// pixels leaking into a CSS transform) throws them far off screen.
const onScreen = await page.evaluate(() => {
  const out = [];
  for (const plate of document.querySelectorAll('.nameplate')) {
    if (plate.style.display === 'none') continue;
    const r = plate.getBoundingClientRect();
    if (r.width === 0) continue;
    out.push({ x: r.left + r.width / 2, y: r.top, vw: window.innerWidth, vh: window.innerHeight });
  }
  return { plates: out, dpr: window.devicePixelRatio };
});
console.log(`\nplate positions at dpr ${onScreen.dpr}:`,
  onScreen.plates.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' '));
check('visible plates land inside the viewport',
  onScreen.plates.length > 0 && onScreen.plates.every((p) => p.x > -80 && p.x < p.vw + 80 && p.y > -80 && p.y < p.vh + 80),
  `${onScreen.plates.length} plates in a ${onScreen.plates[0]?.vw}x${onScreen.plates[0]?.vh} viewport`);

// NOTE: "is the local player dead-centre on screen" is deliberately NOT checked
// here. The camera follows smoothly and shakes on hits, so mid-match the player
// is legitimately off-centre and the measurement is meaningless. camera.mjs
// owns that assertion, where the player is pinned and the camera is allowed to
// converge first — and it runs at dpr 1.5 too, so DPR regressions are covered.

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
