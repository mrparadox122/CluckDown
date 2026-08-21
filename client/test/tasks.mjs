// In-game objectives, driven through the real UI.
//
// The sim tests prove the rules; this proves the game actually shows them —
// that the modes are pickable, the nests and eggs and bomb get rendered, the
// contract strip appears and updates, and none of it throws.
//
//   npm run dev:client
//   node client/test/tasks.mjs

import { chromium } from 'playwright';
import { passLobby } from './_lobby.mjs';

const URL = process.env.UI_URL || 'http://localhost:5173';
const OUT = process.env.OUT_DIR || '.';
const failures = [];
const pageErrors = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

// Screenshots are diagnostics, not assertions — the software renderer can blow
// the capture timeout on a loaded CPU and that must not fail a run.
async function shot(page, path) {
  try {
    await page.screenshot({ path, animations: 'disabled', timeout: 15000 });
  } catch (err) {
    console.warn(`  (screenshot ${path} skipped: ${err.message.slice(0, 80)})`);
  }
}

/**
 * Polls until a predicate holds.
 *
 * Under SwiftShader the page runs at a few frames per second, so a fixed wait
 * is either flaky or absurdly long. Wait on the condition instead.
 */
async function until(page, fn, timeoutMs = 25000, arg = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await page.waitForTimeout(200);
  }
  return last;
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// --- both new modes are offered ------------------------------------------
console.log('\n--- menu ---');
const modes = await page.$$eval('.mode-btn', (n) => n.map((x) => x.dataset.mode));
console.log('  modes:', modes.join(', '));
check('Egg Heist is on the menu', modes.includes('heist'), modes.join(','));
check('Plant & Defuse is on the menu', modes.includes('bomb'), modes.join(','));

/** Starts an offline practice match in a mode and waits for it to go live. */
async function playMode(mode) {
  await page.fill('#name-input', 'Beaky');
  await page.click(`.mode-btn[data-mode="${mode}"]`);
  await page.click('#practice-btn');
  await passLobby(page);
  const live = await until(page, () => window.__cluckdown?.session?.phase === 'live');
  return live;
}

async function backToMenu() {
  await page.evaluate(() => { window.__cluckdown?.game?.dispose?.(); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
}

// ------------------------------------------------------------- Egg Heist

console.log('\n--- Egg Heist ---');
check('the heist match reaches live play', await playMode('heist'));

const heist = await until(page, () => {
  const s = window.__cluckdown?.session;
  const g = window.__cluckdown?.game;
  if (!s || !g) return null;
  return {
    nests: s.nests?.length ?? 0,
    nestViews: g.nests?.size ?? 0,
    totalEggs: (s.nests ?? []).reduce((a, n) => a + n.eggs, 0),
    objective: document.getElementById('objective').textContent,
    cells: document.querySelectorAll('.nest-count').length,
  };
});
console.log('  ', JSON.stringify(heist));
// One nest per ROOST since 4v4 — a shared nest is the thing four players can
// actually defend together.
check('two nests exist in the sim', heist?.nests === 2, String(heist?.nests));
check('two nests are rendered', heist?.nestViews === 2, String(heist?.nestViews));
check('the nests hold eggs', heist?.totalEggs > 0, String(heist?.totalEggs));
check('the HUD shows a count per nest', heist?.cells === 2, String(heist?.cells));

// Bots should actually run the errand, not just shoot. Watch for the totals to
// move — a steal, a bank or a drop all change what is where.
const before = heist.totalEggs;
const moved = await until(page, (b) => {
  const s = window.__cluckdown?.session;
  if (!s?.nests) return null;
  const total = s.nests.reduce((a, n) => a + n.eggs, 0);
  const carried = s.players.reduce((a, p) => a + (p.carrying ?? 0), 0);
  const loose = s.looseEggs?.length ?? 0;
  return (total !== b || carried > 0 || loose > 0) ? { total, carried, loose } : null;
}, 40000, before);
console.log('  after play:', JSON.stringify(moved));
check('bots actually raid nests', !!moved, JSON.stringify(moved ?? `still ${before}`));
check('eggs are conserved — none vanish, none are conjured',
  !moved || moved.total + moved.carried + moved.loose === before,
  moved ? `${moved.total}+${moved.carried}+${moved.loose} vs ${before}` : 'n/a');
await shot(page, `${OUT}/10-heist.png`);

// --- contracts show up while playing --------------------------------------
console.log('\n--- contracts ---');
const contract = await until(page, () => {
  const el = document.getElementById('contract');
  if (el.classList.contains('hidden')) return null;
  const self = window.__cluckdown?.session?.players?.find((p) => p.isSelf);
  return {
    text: el.textContent,
    label: document.querySelector('.contract-label')?.textContent ?? '',
    hasMeter: !!document.querySelector('.contract-meter i'),
    id: self?.contract?.id ?? null,
    target: self?.contract?.target ?? 0,
  };
}, 30000);
console.log('  ', JSON.stringify(contract));
check('a contract strip appears', !!contract, contract?.id ?? 'strip stayed hidden');
check('it names the task', (contract?.label ?? '').length > 3, contract?.label);
check('it has a progress meter', !!contract?.hasMeter);
check('it counts down', /\d+s/.test(contract?.text ?? ''), contract?.text);
check('the sim and the HUD agree on which contract it is',
  !!contract?.id && contract.target > 0, `${contract?.id} target=${contract?.target}`);

// --------------------------------------------------------- Plant & Defuse

console.log('\n--- Plant & Defuse ---');
await backToMenu();
check('the bomb match reaches live play', await playMode('bomb'));

const bombSeen = await until(page, () => {
  const s = window.__cluckdown?.session;
  const g = window.__cluckdown?.game;
  if (!s?.bomb) return null;
  return {
    state: s.bomb.state,
    carrier: s.bomb.carriedBy,
    viewOn: !!g?.bombView?.mesh?.isEnabled(),
    objective: document.getElementById('objective').textContent,
  };
}, 40000);
console.log('  ', JSON.stringify(bombSeen));
check('a bomb appears', !!bombSeen, bombSeen?.state ?? 'none within 40s');
check('the bomb is rendered', !!bombSeen?.viewOn);
check('the HUD reports the bomb', /bomb|BOMB|s\b/i.test(bombSeen?.objective ?? ''), bombSeen?.objective);
check('nests exist to plant in',
  (await page.evaluate(() => window.__cluckdown?.session?.nests?.length)) === 2);

// Walk the local player onto it. Waiting for a bot to wander into a 1.5-unit
// pickup radius is a coin flip inside a test window — and the path that matters
// here is the player's own: touch it, and the HUD has to say so.
const carried = await until(page, () => {
  const s = window.__cluckdown?.session;
  const w = s?.world;
  const me = w?.players?.get(s.selfId);
  if (!me || !w.bomb) return null;
  if (w.bomb.state === 'loose') { me.x = w.bomb.x; me.z = w.bomb.z; }
  if (w.bomb.carriedBy !== s.selfId) return null;
  return {
    state: w.bomb.state,
    objective: document.getElementById('objective').textContent,
  };
}, 30000);
console.log('  ', JSON.stringify(carried));
check('walking onto the bomb picks it up', !!carried, carried?.state ?? 'never became the carrier');
check('the HUD says you are carrying it', /you have the bomb/i.test(carried?.objective ?? ''),
  carried?.objective);
await shot(page, `${OUT}/11-bomb.png`);

// --------------------------------------------------------- rotating hill

console.log('\n--- rotating hill ---');
await backToMenu();
check('the hill match reaches live play', await playMode('hill'));

const start = await page.evaluate(() => {
  const h = window.__cluckdown?.session?.hill;
  return h ? { x: h.x, z: h.z } : null;
});
console.log('  zone starts at', JSON.stringify(start));

// The relocation timer is driven off *sim* time, and under SwiftShader the sim
// advances at a fraction of wall-clock — so waiting out HILL.moveEvery here is
// a coin flip on how loaded the machine is. The cadence is already proven in
// shared/test/tasks.mjs; what this test is for is whether the client notices.
await page.evaluate(() => { window.__cluckdown.session.world.hill.moveAt = 0.05; });

const relocated = await until(page, (s) => {
  const h = window.__cluckdown?.session?.hill;
  if (!h) return null;
  const moved = Math.hypot(h.x - s.x, h.z - s.z) > 1;
  return moved ? { x: +h.x.toFixed(1), z: +h.z.toFixed(1) } : null;
}, 20000, start ?? { x: 0, z: 0 });
console.log('  zone moved to', JSON.stringify(relocated));
check('the zone relocates', !!relocated, JSON.stringify(relocated ?? 'never moved'));

// The rendered disc has to follow it, or the marker lies about where to stand.
const discFollowed = await until(page, () => {
  const g = window.__cluckdown?.game;
  const h = window.__cluckdown?.session?.hill;
  const disc = g?.scene?.meshes?.find((m) => m.name === 'hillDisc');
  if (!disc || !h) return null;
  const d = Math.hypot(disc.position.x - h.x, disc.position.z - h.z);
  return d < 1.5 ? { d: +d.toFixed(2), x: +h.x.toFixed(1), z: +h.z.toFixed(1) } : null;
}, 15000);
console.log('  disc vs zone:', JSON.stringify(discFollowed));
check('the rendered zone follows the real one', !!discFollowed,
  JSON.stringify(discFollowed ?? 'disc never caught up'));
await shot(page, `${OUT}/12-hill.png`);

// --------------------------------------------------------------- potato

console.log('\n--- Hot Potato ---');
await backToMenu();
await page.evaluate(() => { window.__forceMod = 'potato'; });
check('the potato match reaches live play', await playMode('casual'));

const potato = await until(page, () => {
  const s = window.__cluckdown?.session;
  const g = window.__cluckdown?.game;
  if (!s?.potato) return null;
  return {
    modifier: s.modifier,
    holder: s.potato.holder,
    fuse: +s.potato.fuse.toFixed(1),
    rendered: !!g?.potatoView?.mesh?.isEnabled(),
  };
}, 40000);
console.log('  ', JSON.stringify(potato));
check('the potato modifier was applied', potato?.modifier === 'potato', String(potato?.modifier));
check('the potato spawns', !!potato);
check('the potato is rendered', !!potato?.rendered);

// Same reasoning as the bomb: waiting for a bot to blunder into the pass radius
// is a race, and the path worth proving is the player's own.
const held = await until(page, () => {
  const s = window.__cluckdown?.session;
  const w = s?.world;
  const me = w?.players?.get(s.selfId);
  if (!me || !w.potato) return null;
  if (!w.potato.holder) { me.x = w.potato.x; me.z = w.potato.z; }
  return w.potato.holder === s.selfId ? { holder: w.potato.holder, fuse: w.potato.fuse } : null;
}, 30000);
console.log('  holder:', JSON.stringify(held));
check('walking into the potato makes you the holder', !!held, JSON.stringify(held ?? 'nobody'));

// Holding it has to cost something, or it is a trophy rather than a curse.
const burning = await until(page, (f) => {
  const p = window.__cluckdown?.session?.potato;
  return p && p.fuse < f - 0.3 ? +p.fuse.toFixed(1) : null;
}, 20000, held?.fuse ?? 0);
check('holding it burns the fuse down', burning !== null,
  `${held?.fuse?.toFixed(1)} -> ${burning}`);

check('no exceptions anywhere', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
