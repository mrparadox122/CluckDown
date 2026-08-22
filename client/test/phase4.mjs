// Phase 4, end to end in a real browser.
//
// Four things shipped together and three of them only exist where the DOM does,
// so this is the test that proves they are wired rather than merely written:
//
//   4.1  the persistent track   — a bar on the menu, a bar on the results
//   4.2  the nameplate wallhack — enemy plates gated on line of sight
//   4.3  role rotation          — the picker offers next round's role
//   4.4  recorded SFX           — death, headshot and win banks decoded
//
//   npm run dev:client
//   node client/test/phase4.mjs

import { chromium } from 'playwright';
import { passLobby } from './_lobby.mjs';

const URL = process.env.UI_URL || 'http://localhost:5173';
const failures = [];
const pageErrors = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

async function until(page, fn, timeoutMs = 40000, arg = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await page.waitForTimeout(180);
  }
  return last;
}

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
page.on('pageerror', (e) => { pageErrors.push(e.message); });

await page.goto(URL, { waitUntil: 'networkidle' });

// ---------------------------------------------------------------- 4.1 menu
console.log('--- 4.1 the persistent track, on the menu ---');
{
  const cold = await page.evaluate(() => ({
    level: document.getElementById('roost-level')?.textContent,
    xp: document.getElementById('roost-xp')?.textContent,
    title: document.getElementById('roost-title')?.textContent,
    next: document.getElementById('roost-next')?.textContent,
    bars: document.querySelectorAll('.mastery-row').length,
    visible: !!document.getElementById('roost-fill')?.offsetParent,
  }));
  console.log('  ', JSON.stringify(cold));
  check('a brand new career shows level 1', cold.level === '1', cold.level);
  check('the bar names how far into the level it is', /\d+ \/ \d+ XP/.test(cold.xp ?? ''), cold.xp);
  check('there is always a named next thing', /level \d+/.test(cold.next ?? ''), cold.next);
  check('every role has a mastery bar', cold.bars === 6, `${cold.bars} bars`);
  check('the track is on screen, not hidden behind a details', cold.visible);
}

// Seed a career so the earned/crest/title path is exercised rather than assumed.
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('cluckdown.profile.v1') ?? '{}');
  raw.career = { xp: 2400, roleXp: { runner: 900, medic: 120 } };
  localStorage.setItem('cluckdown.profile.v1', JSON.stringify(raw));
});
await page.reload({ waitUntil: 'networkidle' });
{
  const warm = await page.evaluate(() => ({
    level: document.getElementById('roost-level').textContent,
    crest: document.getElementById('roost-crest').textContent,
    title: document.getElementById('roost-title').textContent,
    runner: [...document.querySelectorAll('.mastery-row')]
      .find((r) => r.textContent.includes('Runner'))?.textContent,
  }));
  console.log('  ', JSON.stringify(warm));
  check('a saved career survives a reload', Number(warm.level) > 1, `level ${warm.level}`);
  check('an earned crest is worn', warm.crest.length > 0, warm.crest);
  check('an earned title is worn', warm.title !== 'Unranked chicken', warm.title);
  check('a played role shows a higher mastery tier than an untouched one',
    /Veteran|Elite|Legend/.test(warm.runner ?? ''), warm.runner);
}

// --------------------------------------------------------------- in a match
await page.fill('#name-input', 'Beaky');
await page.click('#practice-btn');
await passLobby(page);
await until(page, () => window.__cluckdown?.session?.phase === 'live');
console.log('');
console.log('--- 4.4 recorded SFX ---');
{
  const bank = await until(page, () => {
    const s = window.__cluckdown?.sfx;
    if (!s?.clips?.size) return null;
    const out = Object.fromEntries([...s.clips].map(([k, v]) => [k, v.length]));
    return Object.values(out).every((n) => n > 0) ? out : null;
  }, 15000);
  console.log('  decoded:', JSON.stringify(bank));
  check('the mp3s in src/audio are discovered and decoded', !!bank, JSON.stringify(bank));
  check('death, headshot and win all have a bank',
    ['death', 'headshot', 'win'].every((k) => (bank?.[k] ?? 0) > 0));
  check('the death bank has more than one variant', (bank?.death ?? 0) > 1, `${bank?.death} clips`);
}

console.log('');
console.log('--- 4.2 nameplates stop at cover ---');
{
  // Drive the sim directly: put a wall between us and one enemy, leave another
  // in the open, and read which plates the renderer allows.
  const seen = await until(page, async () => {
    const g = window.__cluckdown.game;
    const self = g.session.players.find((p) => p.isSelf);
    const foes = g.session.players.filter((p) => !p.isSelf && p.team !== self.team && p.alive);
    if (!self || foes.length < 1 || !g.cover?.length) return null;
    return { foes: foes.length, cover: g.cover.length };
  }, 20000);
  console.log('  ', JSON.stringify(seen));

  // The A/B that isolates cover as the cause: identical geometry, identical
  // angles, run once with the real map boxes and once with none.
  const verdict = await page.evaluate(() => {
    const g = window.__cluckdown.game;
    const box = g.cover[0];
    const self = { id: 'me', team: 0, x: box.x, y: 0, z: box.z - 10, alive: true };
    const foe = { id: 'foe', team: 1, x: box.x, y: 0, z: box.z + 10, alive: true };
    const mate = { id: 'mate', team: 0, x: box.x, y: 0, z: box.z + 10, alive: true };
    const Vision = g.plateVision.constructor;
    // yaw 0 is +z, so the target is dead ahead in every one of these.
    const frame = (players, opts = {}) => new Vision().update(0.016, {
      self, players, x: self.x, y: 0, z: self.z, yaw: 0, pitch: 0, ...opts,
    });
    return {
      box: { w: box.w, d: box.d, h: box.h },
      behindCover: frame([self, foe], { obstacles: g.cover }).has('foe'),
      sameSpotNoCover: frame([self, foe], { obstacles: [] }).has('foe'),
      mate: frame([self, mate], { obstacles: g.cover }).has('mate'),
      revealed: frame([self, foe], { obstacles: g.cover, revealed: true }).has('foe'),
      lookingAway: new Vision().update(0.016, {
        self, players: [self, foe], x: self.x, y: 0, z: self.z,
        yaw: Math.PI, pitch: 0, obstacles: [],
      }).has('foe'),
    };
  });
  console.log('  ', JSON.stringify(verdict));
  check('an enemy behind a real map cover box gets no plate', verdict.behindCover === false);
  check('...and the SAME chicken in the SAME spot is plated with the box gone',
    verdict.sameSpotNoCover === true, 'so cover is what did it, not the angle');
  check('a team-mate is still plated through it', verdict.mate === true);
  check('a Scout sweep still sees through walls', verdict.revealed === true);
  check('an enemy in the clear behind you gets no plate either',
    verdict.lookingAway === false);

  // ...and the live HUD really is hiding some of them.
  const hidden = await until(page, () => {
    const plates = [...document.querySelectorAll('.nameplate')];
    const off = plates.filter((p) => p.style.display === 'none').length;
    return plates.length >= 3 ? { total: plates.length, off } : null;
  }, 25000);
  console.log('  live plates:', JSON.stringify(hidden));
  check('the live HUD is hiding plates, not drawing all of them',
    !!hidden && hidden.off > 0, JSON.stringify(hidden));
}

console.log('');
console.log('--- 4.3 the picker offers next round\'s role ---');
{
  // Put the local chicken on one hit and stand it in front of the enemy line.
  // Dying for real is the only way to exercise the path the rotation is rolled
  // on — killPlayer, not a flag flipped from outside it.
  const before = await page.evaluate(() => {
    const s = window.__cluckdown.session;
    const w = s.world;
    const me = w.players.get(s.selfId);
    const foe = [...w.players.values()].find((p) => p.id !== me.id && p.team !== me.team && p.alive);
    me.invulnUntil = 0;
    me.hp = 1;
    if (foe) { me.x = foe.x + 1.4; me.z = foe.z; }
    return me.role;
  });

  const picker = await until(page, () => {
    const el = document.getElementById('role-picker');
    if (!el || el.classList.contains('hidden')) return null;
    const rotating = el.querySelector('.role-card.rotating');
    return {
      hint: el.querySelector('.role-hint')?.textContent ?? '',
      rotating: rotating?.querySelector('.role-card-name')?.textContent ?? null,
      pips: el.querySelectorAll('.role-card-mastery i').length,
      lit: el.querySelectorAll('.role-card-mastery i.on').length,
    };
  }, 30000);

  console.log('  ', JSON.stringify(picker));
  check('the picker comes up on death', !!picker, JSON.stringify(picker));
  check('it says what you are rotating into',
    /ROTATING TO|YOU RESPAWN IN WHAT YOU HAVE|WAS TAKEN/.test(picker?.hint ?? ''), picker?.hint);
  check('mastery pips are drawn on every card', (picker?.pips ?? 0) === 30, `${picker?.pips} pips`);
  check('a played role has pips lit', (picker?.lit ?? 0) > 0, `${picker?.lit} lit`);
  if (picker?.rotating) {
    check('the card it is rotating you into is called out', picker.rotating !== before,
      `${before} -> ${picker.rotating}`);
  }
}

// ---------------------------------------------------------- 4.1 the results
console.log('');
console.log('--- 4.1 the persistent track, on the results screen ---');
{
  await page.evaluate(() => { window.__cluckdown.session.world.clock = 0.2; });
  await until(page, () => !document.getElementById('results').classList.contains('hidden'), 30000);
  await page.waitForTimeout(1400);

  const res = await page.evaluate(() => {
    const box = document.getElementById('results-progress');
    return {
      shown: !!box && !box.classList.contains('hidden'),
      total: document.getElementById('xp-total')?.textContent,
      level: document.getElementById('xp-level')?.textContent,
      next: document.getElementById('xp-next')?.textContent,
      lines: [...document.querySelectorAll('.xp-line')].map((l) => l.textContent),
      roles: [...document.querySelectorAll('.xp-role')].map((r) => r.textContent),
      fill: document.getElementById('xp-fill')?.style.transform,
    };
  });
  console.log('  ', JSON.stringify(res, null, 1).slice(0, 700));
  check('the track is on the results screen', res.shown);
  check('XP was earned for the match', /^\+\d+ XP$/.test(res.total ?? '') && res.total !== '+0 XP', res.total);
  check('it is itemised, not a lump', (res.lines?.length ?? 0) >= 1, res.lines?.join(' | '));
  check('the "match played" line is always there',
    res.lines?.some((l) => /Match played/.test(l)), res.lines?.join(' | '));
  check('there is a next thing named under the bar', (res.next ?? '').length > 0, res.next);
  check('the bar was actually filled', /scaleX\(/.test(res.fill ?? ''), res.fill);
  check('the roles played this match got mastery', (res.roles?.length ?? 0) >= 1,
    res.roles?.join(' | '));

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cluckdown.profile.v1')).career);
  console.log('  banked:', JSON.stringify(saved).slice(0, 200));
  check('the career was banked to localStorage', saved.xp > 2400, `${saved.xp} XP`);
  check('role mastery was banked too',
    Object.values(saved.roleXp).some((v) => v > 0), JSON.stringify(saved.roleXp));
}

check('no exceptions anywhere', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\nX ${failures.length} check(s) failed\n` : '\nAll checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
