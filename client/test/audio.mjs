// Audio test.
//
// I cannot hear the result, so this verifies everything *except* taste: that
// the context unlocks on a gesture, that the right cues fire for the right
// events, that mute/volume actually reach the master gain and persist, that
// fuse beeps accelerate, and that voices are released instead of leaking.
//
// Whether it sounds GOOD is not testable here — that needs human ears.
//
//   npm run dev:client
//   node client/test/audio.mjs

import { chromium } from 'playwright';

const URL = process.env.UI_URL || 'http://localhost:5173';
const failures = [];
const pageErrors = [];
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    // Headless Chromium has no audio device; this gives a working WebAudio
    // graph that renders to nothing, which is exactly what we want to inspect.
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle' });

// Instrument the real sfx module rather than a stand-in.
await page.evaluate(() => {
  window.__sfxLog = [];
  const wait = setInterval(() => {
    const s = window.__cluckdown?.sfx;
    if (!s) return;
    clearInterval(wait);
    const play = s.play.bind(s);
    const streak = s.streak.bind(s);
    s.play = (n, o) => { window.__sfxLog.push(n); return play(n, o); };
    s.streak = (m) => { window.__sfxLog.push(`streak${m}`); return streak(m); };
  }, 50);
});
await page.waitForTimeout(400);

const sfxState = () => page.evaluate(() => {
  const s = window.__cluckdown.sfx;
  return {
    hasCtx: !!s.ctx,
    state: s.ctx?.state ?? null,
    masterGain: s.master ? +s.master.gain.value.toFixed(3) : null,
    muted: s.muted,
    volume: +s.volume.toFixed(2),
    voices: s.voices,
  };
});

console.log('\n--- before any gesture ---');
const cold = await sfxState();
console.log('  ', JSON.stringify(cold));
check('no AudioContext is created before a gesture', cold.hasCtx === false);

// A click is a real user gesture.
await page.fill('#name-input', 'Beaky');
await page.click('#practice-btn');
await page.waitForTimeout(600);

const warm = await sfxState();
console.log('\n--- after clicking through ---');
console.log('  ', JSON.stringify(warm));
check('gesture created the AudioContext', warm.hasCtx === true);
check('context is running, not suspended', warm.state === 'running', warm.state);
check('master gain matches volume', Math.abs(warm.masterGain - warm.volume) < 0.01,
  `gain=${warm.masterGain} volume=${warm.volume}`);

// Let a real match play out so genuine events drive the sound. Hold fire so
// our own hit-markers happen too — those only play for shots we landed.
await page.mouse.move(620, 300);
await page.mouse.down();
await page.waitForTimeout(9000);
await page.mouse.up();

// Bring the bomber forward rather than waiting for it. It first spawns ~10s
// into the match and the software renderer runs the sim at roughly half speed,
// so waiting it out would make this test a minute long. Everything after this
// is still the real path: sim -> syncBomber -> sfx.fuseTick.
await page.evaluate(() => { window.__cluckdown.session.world.bomberSpawnAt = 0; });
for (let i = 0; i < 40; i++) {
  if (await page.evaluate(() => !!window.__cluckdown.session.world.bomber)) break;
  await page.waitForTimeout(150);
}
// Give it enormous HP before arming it. Bots are good enough at defusing that
// it usually dies before the fuse ever runs, which would make this check flaky.
await page.evaluate(() => {
  const b = window.__cluckdown.session.world.bomber;
  if (b) { b.alive = true; b.hp = 9999; b.state = 'arm'; b.fuse = 5; }
});
await page.waitForTimeout(3500);

const log = await page.evaluate(() => window.__sfxLog);
const counts = log.reduce((a, n) => { a[n] = (a[n] || 0) + 1; return a; }, {});
console.log('\n--- cues fired during 14s of play ---');
console.log('  ', JSON.stringify(counts));

check('shots make a sound', (counts.shot ?? 0) + (counts.rapidShot ?? 0) > 0, `${counts.shot ?? 0}`);
check('the bomber fuse beeps', (counts.fuseBeep ?? 0) > 0, `${counts.fuseBeep ?? 0} beeps`);
check('at least one combat cue fired',
  ['hit', 'hurt', 'kill', 'death', 'blast', 'bomberDown', 'bomberSpawn'].some((k) => counts[k] > 0),
  Object.keys(counts).join(', '));

const live = await sfxState();
check('voices are released, not leaking', live.voices < 22, `${live.voices} active`);

// --- fuse beeps must accelerate, not tick at a fixed rate -----------------
// Stop the render loop first. This part is a unit test of the audio module,
// and a live game calls fuseTick every frame with its own fuse value —
// interleaving two schedules produces a meaningless cadence. (Clearing the
// bomber is not enough: the sim just spawns another one.)
await page.evaluate(() => { window.__cluckdown.game.dispose(); });
await page.waitForTimeout(400);

const gaps = await page.evaluate(() => new Promise((resolve) => {
  const s = window.__cluckdown.sfx;
  const times = [];
  const orig = s.play.bind(s);
  s.play = (n, o) => {
    if (n === 'fuseBeep') times.push({ t: performance.now(), u: o?.urgency ?? 0 });
    return orig(n, o);
  };
  s.stopFuse();
  // Drain a full 5s fuse over ~4s of real time, close to how it actually runs.
  let fuse = 5;
  const iv = setInterval(() => {
    fuse -= 0.02;
    s.fuseTick(Math.max(0.01, fuse), 5);
    if (fuse <= 0.05) { clearInterval(iv); resolve(times); }
  }, 16);
}));

if (gaps.length >= 4) {
  const deltas = gaps.slice(1).map((g, i) => g.t - gaps[i].t);
  const early = deltas.slice(0, Math.floor(deltas.length / 2));
  const late = deltas.slice(Math.floor(deltas.length / 2));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`\n--- fuse cadence --- ${gaps.length} beeps, early ${avg(early).toFixed(0)}ms → late ${avg(late).toFixed(0)}ms`);
  check('fuse beeps accelerate as the timer runs out', avg(late) < avg(early) * 0.8,
    `${avg(early).toFixed(0)}ms → ${avg(late).toFixed(0)}ms`);
  check('fuse pitch rises with urgency', gaps.at(-1).u > gaps[0].u,
    `urgency ${gaps[0].u.toFixed(2)} → ${gaps.at(-1).u.toFixed(2)}`);
} else {
  check('fuse beeps accelerate as the timer runs out', false, `only ${gaps.length} beeps`);
}

// --- mute + volume --------------------------------------------------------
console.log('\n--- mute & volume ---');
await page.evaluate(() => window.__cluckdown.sfx.setMuted(true));
await page.waitForTimeout(150);
const muted = await sfxState();
check('muting drops the master gain to zero', muted.masterGain === 0, `gain=${muted.masterGain}`);

await page.evaluate(() => window.__cluckdown.sfx.setMuted(false));
await page.evaluate(() => window.__cluckdown.sfx.setVolume(0.35));
await page.waitForTimeout(150);
const vol = await sfxState();
check('volume reaches the master gain', Math.abs(vol.masterGain - 0.35) < 0.02, `gain=${vol.masterGain}`);

const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cluckdown.audio.v1') ?? '{}'));
check('settings persist to localStorage', stored.volume === 0.35 && stored.muted === false,
  JSON.stringify(stored));

// Settings must survive a reload.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const restored = await page.evaluate(() => {
  const s = window.__cluckdown.sfx;
  return { volume: s.volume, muted: s.muted, slider: document.getElementById('volume').value };
});
check('settings restore on reload', Math.abs(restored.volume - 0.35) < 0.01 && restored.slider === '35',
  JSON.stringify(restored));

check('no exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
