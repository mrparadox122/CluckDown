// Desktop first-person controls, plus the two systems first person made
// necessary: world markers and the spectator camera.
//
// Cluckdown has one camera and one control scheme now. There is no view to
// toggle, no aim stick, and no top-down fallback — so this replaces the old
// camera.mjs / touch.mjs / fps.mjs trio.
//
// Space is JUMP here, not fire. Something had to give when the simulation grew
// a Y axis: Space is the jump key in every shooter anyone has played, and fire
// already had a better home on the mouse. F is the keyboard fallback for it.
// The two checks that pin that down are the whole reason this note exists —
// if they ever start failing together, someone has swapped the keys back.
//
//   npm run dev:client
//   node client/test/controls.mjs

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

async function shot(page, path) {
  try {
    await page.screenshot({ path, animations: 'disabled', timeout: 15000 });
  } catch (err) {
    console.warn(`  (screenshot ${path} skipped: ${err.message.slice(0, 80)})`);
  }
}

async function until(page, fn, timeoutMs = 25000, arg = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await page.waitForTimeout(150);
  }
  return last;
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  // Offline practice: no game server needed, but the menu still polls it.
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/ERR_CONNECTION_REFUSED|Failed to load resource/.test(t)) return;
  pageErrors.push(t);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.fill('#name-input', 'Beaky');
await page.click('#practice-btn');
await passLobby(page);
await until(page, () => window.__cluckdown?.session?.phase === 'live');

// --- there is only one camera ---------------------------------------------
console.log('\n--- the camera ---');
const cam = await until(page, () => {
  const g = window.__cluckdown?.game;
  const s = window.__cluckdown?.session;
  if (!g || g.camera.position.y > 3) return null;
  const me = s.players.find((p) => p.isSelf);
  const view = g.views.get(s.selfId);
  return {
    camY: +g.camera.position.y.toFixed(2),
    camX: +g.camera.position.x.toFixed(2),
    camZ: +g.camera.position.z.toFixed(2),
    meX: +me.x.toFixed(2),
    meZ: +me.z.toFixed(2),
    fov: +g.camera.fov.toFixed(2),
    minZ: g.camera.minZ,
    bodyHidden: view ? view.hidden : null,
    crosshair: !document.getElementById('crosshair').classList.contains('hidden'),
    // Aim carries pitch now, so the shot leaves along exactly the line the
    // camera looks down and the reticle belongs at screen centre. It used to be
    // projected 16 units down the firing line precisely BECAUSE that was not
    // true; if this drifts off centre, the projection has crept back in.
    crosshairOff: (() => {
      const r = document.getElementById('crosshair').getBoundingClientRect();
      return Math.round(Math.hypot(
        r.left + r.width / 2 - window.innerWidth / 2,
        r.top + r.height / 2 - window.innerHeight / 2,
      ));
    })(),
    minimap: !document.getElementById('minimap').classList.contains('hidden'),
    // The things that used to exist and must not any more.
    hasViewBtn: !!document.getElementById('hud-view'),
    hasViewSelect: !!document.getElementById('gfx-view'),
    hasAimStick: !!document.getElementById('stick-right'),
    hasCycle: typeof g.cycleView,
  };
});
console.log('  ', JSON.stringify(cam));

check('the camera sits at chicken eye height', cam.camY > 0.5 && cam.camY < 2.5, `y=${cam.camY}`);
check('...and on the player, not behind them',
  Math.abs(cam.camX - cam.meX) < 0.6 && Math.abs(cam.camZ - cam.meZ) < 0.6,
  `cam(${cam.camX},${cam.camZ}) vs me(${cam.meX},${cam.meZ})`);
check('first-person field of view', cam.fov > 1, String(cam.fov));
check('near plane is close enough not to clip your own muzzle', cam.minZ < 0.5, String(cam.minZ));
check('your own body is hidden', cam.bodyHidden === true);
check('crosshair is up', cam.crosshair);
check('the crosshair sits at screen centre, because that is where the shot goes',
  cam.crosshairOff <= 2, `${cam.crosshairOff}px off centre`);
check('minimap is up', cam.minimap);

console.log('\n--- top-down is gone ---');
check('no camera toggle button', !cam.hasViewBtn);
check('no camera setting', !cam.hasViewSelect);
check('no aim stick', !cam.hasAimStick);
check('no view cycling on the game object', cam.hasCycle === 'undefined', cam.hasCycle);

// --- movement is relative to facing ---------------------------------------
console.log('\n--- movement ---');
const rel = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  const out = [];
  for (const yaw of [0, Math.PI / 2]) {
    c.yaw = yaw;
    c.usingTouch = false;
    c.keys.add('KeyW');
    const i = c.sample(null, 1 / 60, []);
    out.push({ yaw: +yaw.toFixed(2), mx: +i.mx.toFixed(2), mz: +i.mz.toFixed(2) });
    c.keys.delete('KeyW');
  }
  c.yaw = 0;
  c.keys.add('KeyD');
  const s = c.sample(null, 1 / 60, []);
  c.keys.delete('KeyD');
  return { fwd: out, strafe: { mx: +s.mx.toFixed(2), mz: +s.mz.toFixed(2) } };
});
console.log('  ', JSON.stringify(rel));
check('facing north, W walks +Z', Math.abs(rel.fwd[0].mz - 1) < 0.05, JSON.stringify(rel.fwd[0]));
check('facing east, the same key walks +X', Math.abs(rel.fwd[1].mx - 1) < 0.05, JSON.stringify(rel.fwd[1]));
check('D strafes rather than turning', Math.abs(rel.strafe.mx - 1) < 0.05, JSON.stringify(rel.strafe));

// --- mouse look, both axes ------------------------------------------------
console.log('\n--- mouse look ---');
const look = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  c.pointerLocked = true;
  c.setSensitivity(1); // these are the shipped defaults, not whatever is stored
  c.yaw = 0; c.pitch = 0;
  c.onPointerMove({ pointerType: 'mouse', movementX: 300, movementY: 0 });
  const yaw = +c.yaw.toFixed(3);
  c.pitch = 0;
  c.onPointerMove({ pointerType: 'mouse', movementX: 0, movementY: 200 });
  const down = +c.pitch.toFixed(3);
  c.pitch = 0;
  c.onPointerMove({ pointerType: 'mouse', movementX: 0, movementY: -200 });
  const up = +c.pitch.toFixed(3);
  c.pitch = 0;
  return { yaw, down, up };
});
console.log('  ', JSON.stringify(look));
check('moving the mouse right turns right', look.yaw > 0.1, String(look.yaw));
check('pushing it down looks down', look.down < -0.05, String(look.down));
check('pulling it up looks up', look.up > 0.05, String(look.up));

// --- look sensitivity, wired all the way from the menu --------------------
//
// The slider is the whole point: no single tuned constant has ever suited both
// the player who flicks and the player who tracks. What matters here is that
// the control in the menu reaches the thing that turns the camera — a slider
// that moves a number nobody reads is worse than no slider.
console.log('\n--- look sensitivity ---');
const sens = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  const el = document.getElementById('gfx-sensitivity');
  const before = c.sensitivity;

  // Drive it the way a player does — the element, not the API behind it.
  el.value = '200';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const afterDrag = c.sensitivity;
  const readout = document.getElementById('gfx-sensitivity-out').textContent;

  // ...and the mouse must actually turn twice as far for the same movement.
  c.pointerLocked = true;
  c.setSensitivity(1);
  c.yaw = 0;
  c.onPointerMove({ pointerType: 'mouse', movementX: 200, movementY: 0 });
  const atOne = c.yaw;
  c.setSensitivity(2);
  c.yaw = 0;
  c.onPointerMove({ pointerType: 'mouse', movementX: 200, movementY: 0 });
  const atTwo = c.yaw;

  el.value = '100';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  c.setSensitivity(1);
  return { before, afterDrag, readout, atOne: +atOne.toFixed(4), atTwo: +atTwo.toFixed(4) };
});
console.log('  ', JSON.stringify(sens));
check('the Settings slider reaches the live controls', sens.afterDrag === 2,
  `${sens.before} -> ${sens.afterDrag}`);
check('it shows the player the value it is on', /2(\.0+)?/.test(sens.readout), sens.readout);
check('doubling it doubles how far the mouse turns you',
  Math.abs(sens.atTwo / sens.atOne - 2) < 0.001, `${(sens.atTwo / sens.atOne).toFixed(3)}x`);

// --- jumping, and where the fire key went ---------------------------------
console.log('\n--- jump ---');
const keyed = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  c.usingTouch = false;
  c.keys.clear();
  c.mouseDown = false;

  c.keys.add('Space');
  const space = c.sample(null, 1 / 60, []);
  const withSpace = { jump: space.jump, shoot: space.shoot };
  c.keys.delete('Space');

  c.keys.add('KeyF');
  const f = c.sample(null, 1 / 60, []);
  const withF = { jump: f.jump, shoot: f.shoot };
  c.keys.delete('KeyF');

  const idle = c.sample(null, 1 / 60, []);
  return { withSpace, withF, idle: { jump: idle.jump, shoot: idle.shoot } };
});
console.log('  ', JSON.stringify(keyed));
check('Space jumps', keyed.withSpace.jump === true, JSON.stringify(keyed.withSpace));
check('...and Space does NOT also fire', keyed.withSpace.shoot === false,
  JSON.stringify(keyed.withSpace));
check('F is the keyboard fire key', keyed.withF.shoot === true, JSON.stringify(keyed.withF));
check('...and F does not jump', keyed.withF.jump === false, JSON.stringify(keyed.withF));
check('nothing held means neither', keyed.idle.jump === false && keyed.idle.shoot === false,
  JSON.stringify(keyed.idle));

// The camera has to actually leave the ground. Polled for a RENDERED frame:
// under SwiftShader the loop runs at two or three frames a second, so a fixed
// wait routinely measures a frame in which nothing has happened yet.
const eyeLevel = await page.evaluate(() => +window.__cluckdown.game.camera.position.y.toFixed(3));
const airborne = await until(page, () => {
  const S = window.__cluckdown;
  const c = S.game.controls;
  const me = S.session.world.players.get(S.session.selfId);
  if (me) { me.hp = 100; me.invulnUntil = S.session.world.time + 60; }
  c.usingTouch = false;
  c.keys.add('Space'); // level-triggered, so holding it is a legitimate jump
  return me && me.y > 0.4
    ? { y: +me.y.toFixed(3), camY: +S.game.camera.position.y.toFixed(3) }
    : null;
}, 15000);
await page.evaluate(() => window.__cluckdown.game.controls.keys.delete('Space'));
console.log('  ', JSON.stringify(airborne), 'from eye level', eyeLevel);
check('holding jump lifts the chicken off the floor', !!airborne, JSON.stringify(airborne));
check('...and the camera goes up with it', (airborne?.camY ?? 0) > eyeLevel + 0.3,
  `${eyeLevel} -> ${airborne?.camY}`);

// ...and comes back down. A jump you cannot land is a bug with a much worse
// name than "jump".
const landed = await until(page, () => {
  const S = window.__cluckdown;
  const me = S.session.world.players.get(S.session.selfId);
  if (me) { me.hp = 100; me.invulnUntil = S.session.world.time + 60; }
  return me && me.y === 0 ? 'grounded' : null;
}, 15000);
check('gravity brings you back down', landed === 'grounded', String(landed));

// Hand spawn protection back before moving on. stepBomber filters invulnerable
// players out of its target list entirely, so a chicken left permanently
// shielded is one the bomber will never chase, never arm on, and never mark —
// which silently fails the whole marker section below for reasons that have
// nothing to do with markers.
await page.evaluate(() => {
  const S = window.__cluckdown;
  const me = S.session.world.players.get(S.session.selfId);
  if (me) me.invulnUntil = 0;
});

// --- aim assist runs on THIS side of the wire -----------------------------
//
// It used to be applied by the server, which was invisible in top-down but a
// lie in first person: the camera renders the local yaw, so a server steering
// the aim elsewhere meant the crosshair stopped covering what got shot.
console.log('\n--- aim assist ---');
const assist = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  // A target 10 units ahead and slightly to the right of where we are aiming.
  const self = { id: 'me', x: 0, y: 0, z: 0, team: null };
  const foes = [{ id: 'foe', x: 2, y: 0, z: 10, alive: true, team: null, invuln: false, mx: 0, mz: 0 }];
  const want = Math.atan2(2, 10);

  c.setAssist(true);
  c.yaw = 0;
  c.usingTouch = false;
  let sent = 0;
  for (let i = 0; i < 30; i++) sent = Math.atan2(...(() => {
    const inp = c.sample(self, 1 / 60, foes);
    return [inp.ax, inp.az];
  })());
  const pulled = +sent.toFixed(3);
  const rawAfter = +c.yaw.toFixed(3);

  // Off: the raw look angle goes out untouched.
  c.setAssist(false);
  c.yaw = 0;
  const inp = c.sample(self, 1 / 60, foes);
  const off = +Math.atan2(inp.ax, inp.az).toFixed(3);
  c.setAssist(true);

  // The vertical half. A target at the top of a jump has to pull the sent pitch
  // UP, or assist would be quietly recreating "the crosshair only moves left
  // and right" one axis over.
  const high = [{ ...foes[0], x: 0, y: 1.25 }];
  c.yaw = 0; c.pitch = 0;
  let sentPitch = 0;
  for (let i = 0; i < 30; i++) sentPitch = c.sample(self, 1 / 60, high).pitch;
  const rawPitchAfter = +c.pitch.toFixed(3);

  return {
    want: +want.toFixed(3), pulled, rawAfter, off,
    sentPitch: +sentPitch.toFixed(3), rawPitchAfter,
  };
});
console.log('  ', JSON.stringify(assist));
check('assist pulls the sent aim toward the target',
  assist.pulled > 0.05 && assist.pulled <= assist.want + 0.01,
  `${assist.pulled} of a possible ${assist.want}`);
check('the RAW look angle is left alone, so turning away still drops the lock',
  Math.abs(assist.rawAfter) < 0.001, String(assist.rawAfter));
check('turning assist off sends exactly what you asked for',
  Math.abs(assist.off) < 0.001, String(assist.off));
check('assist raises the sent pitch onto a target in the air',
  assist.sentPitch > 0.03, String(assist.sentPitch));
check('the RAW pitch is left alone too, for the same reason as the yaw',
  Math.abs(assist.rawPitchAfter) < 0.001, String(assist.rawPitchAfter));

// --- markers: the bomber, and wherever the objective is -------------------
console.log('\n--- world markers ---');
const marked = await until(page, () => {
  const g = window.__cluckdown.game;
  const s = window.__cluckdown.session;
  const w = s.world;
  // Put an armed bomber directly behind the player. This is the case that
  // matters: without a marker it is unavoidable damage from an unseeable
  // source, which is the difference between tense and unfair.
  const me = w.players.get(s.selfId);
  if (!me) return null;
  w.bomberSpawnAt = 0;
  if (!w.bomber) return null;
  // Parked just inside arming range so it ARMS on its own. Forcing state to
  // 'arm' directly does not hold: stepBomber recomputes it every tick from the
  // distance, so the flag was gone again before the next frame rendered.
  w.bomber.alive = true;
  w.bomber.hp = 9999;
  w.bomber.x = me.x - Math.sin(g.controls.yaw) * 2.6;
  w.bomber.z = me.z - Math.cos(g.controls.yaw) * 2.6;

  const el = document.querySelector('.marker');
  // Wait for the urgent state too — the marker appears before the bomber has
  // finished arming.
  if (!el || !el.classList.contains('is-urgent')) return null;
  return {
    count: document.querySelectorAll('.marker').length,
    off: el.classList.contains('is-off'),
    urgent: el.classList.contains('is-urgent'),
    text: el.textContent,
    transform: el.style.transform,
  };
}, 30000);
console.log('  ', JSON.stringify(marked));
check('a bomber behind you is marked', !!marked, 'no marker appeared');
check('the marker is flagged off-screen', marked?.off === true);
check('an armed bomber is marked urgent', marked?.urgent === true);
check('it reports the distance', /\d+m/.test(marked?.text ?? ''), marked?.text);
check('it is positioned', /translate/.test(marked?.transform ?? ''), marked?.transform);

// It has to be pinned inside the viewport, not drawn off the edge of it.
const inside = await page.evaluate(() => {
  const el = document.querySelector('.marker');
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    w: window.innerWidth,
    h: window.innerHeight,
  };
});
console.log('  ', JSON.stringify(inside));
check('an off-screen marker is pinned to the screen edge, not lost',
  inside.x >= 0 && inside.x <= inside.w && inside.y >= 0 && inside.y <= inside.h,
  JSON.stringify(inside));
await shot(page, `${OUT}/18-marker.png`);

// --- spectator camera -----------------------------------------------------
console.log('\n--- spectating ---');
const spec = await until(page, () => {
  const S = window.__cluckdown;
  const w = S.session.world;
  const me = w.players.get(S.session.selfId);
  if (me?.alive) {
    // Hold at 1 HP next to a bot and let a real bullet finish it, so the kill
    // event carries the attacker the spectator camera wants to follow.
    me.hp = 1;
    me.invulnUntil = 0;
    const foe = [...w.players.values()].find((p) => p.id !== me.id && p.alive);
    if (foe) { me.x = foe.x + 3; me.z = foe.z + 3; }
    return null;
  }
  const g = S.game;
  return {
    camY: +g.camera.position.y.toFixed(2),
    killedBy: g.killedBy?.name ?? null,
    crosshairHidden: document.getElementById('crosshair').style.opacity === '0',
  };
}, 40000);
console.log('  ', JSON.stringify(spec));
check('dying lifts the camera into a spectator shot', spec && spec.camY > 5, `y=${spec?.camY}`);
check('the crosshair goes away while dead', spec?.crosshairHidden === true);

// The orbit has to actually move, or it is just a static overhead shot.
const orbit = await page.evaluate(async () => {
  const g = window.__cluckdown.game;
  const a = { x: g.camera.position.x, z: g.camera.position.z };
  await new Promise((r) => setTimeout(r, 1400));
  const b = { x: g.camera.position.x, z: g.camera.position.z };
  return +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2);
});
console.log('  orbit moved:', orbit);
check('the spectator camera orbits', orbit > 0.2, `${orbit} units in 1.4s`);

check('no exceptions anywhere', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
