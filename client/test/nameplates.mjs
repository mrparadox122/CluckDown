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
page.on('pageerror', (e) => failures.push(`PAGEERROR: ${e.message}`));

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

let rows = await measure();
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
const spread = Math.max(0, ...rows.map((r) => r.meshVsServer ?? 0));
check('test is meaningful (mesh and server positions differ)', spread > 1,
  `${spread.toFixed(1)}px apart — this is the gap the old code showed`);

// Independent of projectFn entirely: the camera keeps the local player centred,
// so their plate must land near the horizontal middle of the CSS viewport. This
// catches coordinate-space bugs that a projectFn-vs-projectFn check cannot.
const centring = await page.evaluate(() => {
  const plate = [...document.querySelectorAll('.nameplate')]
    .find((p) => p.classList.contains('is-self'));
  if (!plate) return null;
  const r = plate.getBoundingClientRect();
  return {
    dx: (r.left + r.width / 2) - window.innerWidth / 2,
    top: r.top,
    vw: window.innerWidth,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio,
  };
});
console.log('self plate vs viewport centre:', JSON.stringify(centring));
check('own plate is horizontally centred (dpr-safe)', centring && Math.abs(centring.dx) < 25,
  centring ? `dx=${centring.dx.toFixed(0)}px at dpr ${centring.dpr}` : 'no self plate');
check('own plate is on screen vertically', centring && centring.top > 0 && centring.top < centring.vh,
  centring ? `top=${centring.top.toFixed(0)} of ${centring.vh}` : '-');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
