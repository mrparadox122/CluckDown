// First-person touch controls, on an emulated phone.
//
// The player report was "FPS controls are harder on mobile", and the cause was
// structural rather than a sensitivity number: the right stick was a RATE
// control, so hitting a specific angle meant holding a direction for exactly
// the right number of milliseconds. Every shipped mobile shooter uses a swipe
// surface instead, because a swipe is a positional mapping — you move your
// thumb by the amount you want to turn.
//
// This proves the new scheme: swipe to look, separate FIRE and JUMP buttons,
// both thumbs usable at once, and pitch that actually exists — and now reaches
// the simulation, so a swipe up genuinely raises where the bullet goes.
//
// The section that matters most is "fire and aim in one gesture". Players
// reported the fire button pinning their thumb: sliding a few pixels off it
// stopped the gun, so tracking a moving target meant lifting off, swiping, and
// pressing again — by which point the target has gone. A press now belongs to
// the finger rather than to the circle, and dragging it turns the view through
// the same call the look surface uses.
//
// Jump is a button rather than a gesture for the same reason fire is. Every
// touch here is tracked by pointerId; a double-tap or a swipe-up would have to
// share the look surface with looking, and the two are indistinguishable until
// it is too late to do either well.
//
//   npm run dev:client
//   node client/test/fps-touch.mjs

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

async function until(page, fn, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn);
    if (last) return last;
    await page.waitForTimeout(150);
  }
  return last;
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// A phone in landscape, which is how the game is actually played.
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  // This test drives offline practice, so it does not need the game server.
  // The menu still polls it for the status panel, and a refused connection
  // there says nothing about the controls under test.
  if (m.type() !== 'error') return;
  const text = m.text();
  if (/ERR_CONNECTION_REFUSED|Failed to load resource/.test(text)) return;
  pageErrors.push(text);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.fill('#name-input', 'Thumbs');
await page.click('#practice-btn');
await passLobby(page);
await until(page, () => window.__cluckdown?.session?.phase === 'live');
await page.waitForTimeout(600);

// --- there is only one camera -------------------------------------------
console.log('\n--- camera ---');
const start = await until(page, () => {
  const g = window.__cluckdown?.game;
  if (!g || g.camera.position.y > 3) return null;
  return { camY: +g.camera.position.y.toFixed(2) };
});
console.log('  ', JSON.stringify(start));
check('the match starts in first person', !!start, `camY=${start?.camY}`);

// --- the right furniture is present ---------------------------------------
console.log('\n--- touch surfaces ---');
const surfaces = await page.evaluate(() => {
  const vis = (id) => {
    const el = document.getElementById(id);
    if (!el || el.classList.contains('hidden')) return false;
    return getComputedStyle(el).display !== 'none';
  };
  const at = (x, y) => document.elementFromPoint(x, y)?.id ?? 'none';
  const fire = document.getElementById('fire-btn').getBoundingClientRect();
  const jump = document.getElementById('jump-btn').getBoundingClientRect();
  const hit = (r, id) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    ?.closest(`#${id}`)?.id ?? 'none';
  return {
    look: vis('look-zone'),
    fire: vis('fire-btn'),
    jump: vis('jump-btn'),
    // The aim stick element is gone from the document entirely now.
    noAimStick: !document.getElementById('stick-right'),
    leftStickTop: at(110, 300),
    lookTop: at(600, 300),
    // closest(), because each button has a <span> label inside it that is
    // what elementFromPoint actually returns.
    fireCentre: hit(fire, 'fire-btn'),
    jumpCentre: hit(jump, 'jump-btn'),
    // Two buttons under one thumb is worse than one, so they must not overlap.
    overlap: !(jump.right < fire.left || jump.left > fire.right
      || jump.bottom < fire.top || jump.top > fire.bottom),
    onScreen: jump.left >= 0 && jump.right <= window.innerWidth
      && jump.top >= 0 && jump.bottom <= window.innerHeight,
  };
});
console.log('  ', JSON.stringify(surfaces));
check('the swipe-to-look surface exists', surfaces.look);
check('the fire button exists', surfaces.fire);
check('the old aim stick is gone', surfaces.noAimStick);
check('the movement stick still owns the left thumb', surfaces.leftStickTop === 'stick-left',
  surfaces.leftStickTop);
check('the look surface receives the right thumb', surfaces.lookTop === 'look-zone', surfaces.lookTop);
check('the fire button sits above the look surface', surfaces.fireCentre === 'fire-btn',
  surfaces.fireCentre);
check('the jump button exists', surfaces.jump);
check('...and it too sits above the look surface', surfaces.jumpCentre === 'jump-btn',
  surfaces.jumpCentre);
check('the two buttons do not overlap', !surfaces.overlap);
check('the jump button is fully on screen in landscape', surfaces.onScreen);

// --- swiping turns you, proportionally ------------------------------------
console.log('\n--- swipe to look ---');
const cdp = await context.newCDPSession(page);

/** Drags one finger across the look surface and reports the yaw/pitch change. */
async function swipe(dx, dy, id = 1) {
  const from = { x: 600, y: 250 };
  const before = await page.evaluate(() => {
    const c = window.__cluckdown.game.controls;
    return { yaw: c.yaw, pitch: c.pitch };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id }] });
  await page.waitForTimeout(60);
  for (let i = 1; i <= 4; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (dx * i) / 4, y: from.y + (dy * i) / 4, id }],
    });
    await page.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => {
    const c = window.__cluckdown.game.controls;
    return { yaw: c.yaw, pitch: c.pitch };
  });
  return { dYaw: after.yaw - before.yaw, dPitch: after.pitch - before.pitch };
}

const small = await swipe(60, 0);
const big = await swipe(120, 0);
console.log(`  swipe 60px → ${small.dYaw.toFixed(3)} rad | 120px → ${big.dYaw.toFixed(3)} rad`);
check('swiping right turns right', small.dYaw > 0.05, small.dYaw.toFixed(3));
// The defining property of a positional control: twice the swipe, twice the
// turn. A rate control would give you "twice the swipe, same turn per second".
check('turn is proportional to swipe distance — this is what a stick could not do',
  Math.abs(big.dYaw / small.dYaw - 2) < 0.35, `${(big.dYaw / small.dYaw).toFixed(2)}x for 2x the distance`);

const back = await swipe(-60, 0);
check('swiping left turns left', back.dYaw < -0.05, back.dYaw.toFixed(3));

// --- pitch: the thing that made it "only left and right" ------------------
console.log('\n--- look up and down ---');
const up = await swipe(0, -70);
const down = await swipe(0, 70);
console.log(`  swipe up → ${up.dPitch.toFixed(3)} rad | down → ${down.dPitch.toFixed(3)} rad`);
check('swiping up looks up', up.dPitch > 0.05, up.dPitch.toFixed(3));
check('swiping down looks down', down.dPitch < -0.05, down.dPitch.toFixed(3));

// The camera must actually follow the pitch, not just store it.
//
// Everything below polls for a rendered frame rather than sleeping. Under
// SwiftShader the render loop runs at two or three frames a second, so a fixed
// 300ms wait routinely measures a frame that has not happened yet.
// Measured from the camera's target rather than getForwardRay(), which needs a
// Babylon side-effect import the game no longer has any reason to pull in —
// mouse ray-picking went away with the top-down aim.
const drop = () => {
  const c = window.__cluckdown.game.camera;
  return +(c.getTarget().y - c.position.y).toFixed(3);
};
// Stay alive for this: the spectator camera sits 9 units up looking down, so a
// dead player reads as permanently tilted and the measurement means nothing.
const alive = () => {
  const S = window.__cluckdown;
  const me = S.session.world.players.get(S.session.selfId);
  if (me) { me.hp = 100; me.invulnUntil = S.session.world.time + 60; }
  return !!me?.alive;
};
await until(page, alive, 15000);
const level = await page.evaluate(drop);
await page.evaluate(() => { window.__cluckdown.game.controls.pitch = -0.6; });
const tilted = await until(page, () => {
  const S = window.__cluckdown;
  const me = S.session.world.players.get(S.session.selfId);
  if (me) { me.hp = 100; me.invulnUntil = S.session.world.time + 60; }
  if (!me?.alive) return null;
  const c = S.game.camera;
  const d = c.getTarget().y - c.position.y;
  return d < -3 ? +d.toFixed(3) : null;
}, 12000);
console.log(`  camera aims this far below eye level: ${level} → ${tilted}`);
check('the camera really tilts down when you look down', tilted !== null && tilted < level - 2,
  `${level} → ${tilted}`);

// Pitch is clamped, or you end up looking at the inside of your own skull.
await page.evaluate(() => { window.__cluckdown.game.controls.pitch = 99; });
const high = await until(page, () => {
  const p = window.__cluckdown.game.controls.pitch;
  return p < 90 ? +p.toFixed(2) : null;
}, 12000);
await page.evaluate(() => { window.__cluckdown.game.controls.pitch = -99; });
const low = await until(page, () => {
  const p = window.__cluckdown.game.controls.pitch;
  return p > -90 ? +p.toFixed(2) : null;
}, 12000);
console.log('  clamped to:', JSON.stringify({ high, low }));
// The limits are PLAYER.pitchMin/pitchMax now, not a renderer constant — the
// server clamps incoming pitch to the same two numbers, because pitch is half
// of where the shot goes. Up used to stop at 0.42 on the grounds that there was
// nothing above the arena worth seeing; that ceiling is most of what "the
// crosshair only moves left and right" felt like, so it is generous now, and
// this checks it is generous rather than absent.
check('pitch is clamped both ways', high !== null && low !== null && high < 1.6 && low > -1.6,
  JSON.stringify({ high, low }));
check('...but far enough to aim up and down properly', high > 0.9 && low < -0.9,
  JSON.stringify({ high, low }));

// --- fire button, and both thumbs at once ---------------------------------
const fireRect = await page.evaluate(() => {
  const r = document.getElementById('fire-btn').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

console.log('\n--- fire ---');

await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart', touchPoints: [{ x: fireRect.x, y: fireRect.y, id: 7 }],
});
// input.shoot is only written when sample() runs, which is once per rendered
// frame — a couple per second here. Poll rather than sleep.
const firing = await until(page, () => {
  const c = window.__cluckdown.game.controls;
  return c.input.shoot ? { shoot: c.input.shoot, held: c.fire.held } : null;
}, 12000);
check('holding the fire button shoots', firing?.shoot === true, JSON.stringify(firing));

// ...while a SECOND thumb swipes to look. This is the reason fire is its own
// button rather than living on the look surface.
const beforeYaw = await page.evaluate(() => window.__cluckdown.game.controls.yaw);
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: fireRect.x, y: fireRect.y, id: 7 }, { x: 560, y: 200, id: 8 }],
});
await page.waitForTimeout(60);
for (let i = 1; i <= 3; i++) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: fireRect.x, y: fireRect.y, id: 7 }, { x: 560 + i * 25, y: 200, id: 8 }],
  });
  await page.waitForTimeout(50);
}
const both = await until(page, () => {
  const c = window.__cluckdown.game.controls;
  return c.input.shoot ? { shoot: true, yaw: c.yaw } : null;
}, 12000) ?? await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  return { shoot: c.input.shoot, yaw: c.yaw };
});
console.log(`  yaw ${beforeYaw.toFixed(3)} → ${both.yaw.toFixed(3)} while firing=${both.shoot}`);
check('you can look and fire at the same time',
  both.shoot === true && Math.abs(both.yaw - beforeYaw) > 0.05,
  `shoot=${both.shoot} dYaw=${(both.yaw - beforeYaw).toFixed(3)}`);

await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const released = await until(page, () => {
  const c = window.__cluckdown.game.controls;
  return c.input.shoot === false ? 'stopped' : null;
}, 12000);
check('releasing stops firing', released === 'stopped', String(released));

// --- fire and aim in ONE gesture ------------------------------------------
console.log('\n--- hold fire and drag to aim ---');

/**
 * Presses the fire button, drags that ONE finger across the screen, and reports
 * whether the gun kept firing the whole way.
 *
 * The drag deliberately ends far outside the button. That is the case that used
 * to break: the visual boundary is not the hitbox once a press has started.
 */
async function fireAndDrag(dx, dy, id = 21) {
  const before = await page.evaluate(() => {
    const c = window.__cluckdown.game.controls;
    return { yaw: c.yaw, pitch: c.pitch };
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: fireRect.x, y: fireRect.y, id }],
  });
  // Poll for a rendered frame that saw the press, rather than assuming one
  // happened: under SwiftShader sample() runs two or three times a second.
  const pressed = await until(page, () => (
    window.__cluckdown.game.controls.input.shoot ? true : null
  ), 12000);

  let firingThroughout = true;
  for (let i = 1; i <= 5; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: fireRect.x + (dx * i) / 5, y: fireRect.y + (dy * i) / 5, id }],
    });
    await page.waitForTimeout(50);
    const still = await page.evaluate(() => {
      const c = window.__cluckdown.game.controls;
      return c.fire.held && c.input.shoot;
    });
    if (!still) firingThroughout = false;
  }

  const after = await page.evaluate(() => {
    const c = window.__cluckdown.game.controls;
    const r = document.getElementById('fire-btn').getBoundingClientRect();
    return {
      yaw: c.yaw,
      pitch: c.pitch,
      held: c.fire.held,
      shoot: c.input.shoot,
      litUp: document.getElementById('fire-btn').classList.contains('is-held'),
      btn: { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height },
    };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(120);
  return {
    pressed: !!pressed,
    firingThroughout,
    dYaw: after.yaw - before.yaw,
    dPitch: after.pitch - before.pitch,
    ...after,
  };
}

const dragged1 = await fireAndDrag(150, 0);
console.log('  ', JSON.stringify({
  pressed: dragged1.pressed,
  firingThroughout: dragged1.firingThroughout,
  dYaw: +dragged1.dYaw.toFixed(3),
  endedHeld: dragged1.held,
  litUp: dragged1.litUp,
}));
check('pressing FIRE shoots', dragged1.pressed);
// 150px is well past the edge of a 74-92px button, so the finger is nowhere
// near it by the end of the drag.
check('dragging the finger right off the button keeps firing',
  dragged1.firingThroughout && dragged1.held && dragged1.shoot,
  JSON.stringify({ throughout: dragged1.firingThroughout, held: dragged1.held }));
check('...and the drag turns the view at the same time', dragged1.dYaw > 0.1,
  dragged1.dYaw.toFixed(3));
check('the finger travelled well outside the button',
  150 > dragged1.btn.w, `dragged 150px across a ${Math.round(dragged1.btn.w)}px button`);
check('the button stays visibly pressed while the thumb is off it', dragged1.litUp === true);

// Vertical too — tracking someone who jumped is the case aim assist alone
// cannot cover, and it is the reason pitch is on this gesture at all.
const dragged2 = await fireAndDrag(0, -110, 22);
console.log(`  dragging up while firing: dPitch ${dragged2.dPitch.toFixed(3)}`);
check('dragging up while firing raises the aim', dragged2.dPitch > 0.05,
  dragged2.dPitch.toFixed(3));
check('...and it is still firing at the top of that drag',
  dragged2.firingThroughout && dragged2.shoot, JSON.stringify(dragged2.firingThroughout));

// The drag has to feel like the look surface, because it IS the look surface.
// Same pixels, same rotation, or the gesture is a different control that merely
// looks like one.
const swipeSame = await swipe(120, 0, 23);
console.log(`  120px: ${dragged1.dYaw.toFixed(3)} rad dragging from FIRE vs ${swipeSame.dYaw.toFixed(3)} rad on the look zone (150px vs 120px)`);
check('a drag from FIRE turns at the same rate as a swipe on the look zone',
  Math.abs((dragged1.dYaw / 150) / (swipeSame.dYaw / 120) - 1) < 0.05,
  `${(dragged1.dYaw / 150).toExponential(3)} vs ${(swipeSame.dYaw / 120).toExponential(3)} rad/px`);

// A tap is one shot. The touch can begin and end between two rendered frames,
// so without a latch a quick tap does nothing at all — which reads as the
// button being unresponsive rather than as a frame-timing detail.
console.log('\n--- a tap fires once ---');
const tap = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  c.usingTouch = true;
  c.fire.onUp();          // clean slate
  c.fire.takeTap();
  // Press and release with no sample() in between, which is what a fast tap is.
  c.fire.onDown({ pointerId: 31, clientX: 700, clientY: 300, preventDefault() {} });
  c.fire.onUp({ pointerId: 31 });
  const first = c.sample(null, 1 / 60, []).shoot;   // the tap is seen
  const second = c.sample(null, 1 / 60, []).shoot;  // ...exactly once
  return { first, second, held: c.fire.held };
});
console.log('  ', JSON.stringify(tap));
check('a tap too quick to span a frame still fires', tap.first === true, JSON.stringify(tap));
check('...and fires exactly once, not continuously', tap.second === false, JSON.stringify(tap));
check('a released button is not held', tap.held === false);

// --- the jump button ------------------------------------------------------
console.log('\n--- jump ---');
const jumpRect = await page.evaluate(() => {
  const r = document.getElementById('jump-btn').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart', touchPoints: [{ x: jumpRect.x, y: jumpRect.y, id: 9 }],
});
// Poll for a RENDERED frame. input.jump is only written when sample() runs,
// which is once per frame — two or three a second under SwiftShader.
const jumped = await until(page, () => {
  const S = window.__cluckdown;
  const c = S.game.controls;
  const me = S.session.world.players.get(S.session.selfId);
  if (me) { me.hp = 100; me.invulnUntil = S.session.world.time + 60; }
  return c.input.jump && me && me.y > 0.4
    ? { jump: true, y: +me.y.toFixed(3), camY: +S.game.camera.position.y.toFixed(3) }
    : null;
}, 15000);
console.log('  ', JSON.stringify(jumped));
check('holding the jump button leaves the ground', !!jumped, JSON.stringify(jumped));
check('...and the camera goes up with the chicken', (jumped?.camY ?? 0) > (jumped?.y ?? 0),
  JSON.stringify(jumped));

// The whole reason these are two buttons and not one gesture: JUMP, FIRE and a
// thumb swiping to look are three independent pointers.
const beforeLook = await page.evaluate(() => window.__cluckdown.game.controls.yaw);
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [
    { x: jumpRect.x, y: jumpRect.y, id: 9 },
    { x: fireRect.x, y: fireRect.y, id: 10 },
    { x: 560, y: 210, id: 11 },
  ],
});
await page.waitForTimeout(60);
for (let i = 1; i <= 3; i++) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: jumpRect.x, y: jumpRect.y, id: 9 },
      { x: fireRect.x, y: fireRect.y, id: 10 },
      { x: 560 + i * 25, y: 210, id: 11 },
    ],
  });
  await page.waitForTimeout(50);
}
const triple = await until(page, () => {
  const c = window.__cluckdown.game.controls;
  return c.input.shoot && c.input.jump ? { shoot: true, jump: true, yaw: c.yaw } : null;
}, 12000) ?? await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  return { shoot: c.input.shoot, jump: c.input.jump, yaw: c.yaw };
});
console.log(`  jump+fire+look together: ${JSON.stringify(triple)} (yaw was ${beforeLook.toFixed(3)})`);
check('you can jump, fire and look all at once',
  triple.shoot === true && triple.jump === true && Math.abs(triple.yaw - beforeLook) > 0.05,
  JSON.stringify(triple));

await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const stopped = await until(page, () => {
  const c = window.__cluckdown.game.controls;
  return c.input.jump === false && c.input.shoot === false ? 'released' : null;
}, 12000);
check('releasing both buttons stops both', stopped === 'released', String(stopped));

// --- movement is still full 360, relative to facing -----------------------
console.log('\n--- movement ---');
const moved = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  const out = [];
  c.usingTouch = true;
  for (const yaw of [0, Math.PI / 2]) {
    c.yaw = yaw;
    c.stickX = 0; c.stickZ = 1;            // stick pushed straight "up"
    const f = c.sample({ x: 0, z: 0 }, 1 / 60);
    out.push({ yaw: +yaw.toFixed(2), mx: +f.mx.toFixed(2), mz: +f.mz.toFixed(2) });
  }
  c.yaw = 0;
  c.stickX = 1; c.stickZ = 0;              // stick pushed right = strafe
  const s = c.sample({ x: 0, z: 0 }, 1 / 60);
  c.stickX = 0; c.stickZ = 0;
  return { fwd: out, strafe: { mx: +s.mx.toFixed(2), mz: +s.mz.toFixed(2) } };
});
console.log('  ', JSON.stringify(moved));
check('stick forward walks the way you face (north)',
  Math.abs(moved.fwd[0].mz - 1) < 0.05, JSON.stringify(moved.fwd[0]));
check('...and still forward after turning 90 degrees',
  Math.abs(moved.fwd[1].mx - 1) < 0.05, JSON.stringify(moved.fwd[1]));
check('stick sideways strafes', Math.abs(moved.strafe.mx - 1) < 0.05, JSON.stringify(moved.strafe));

// --- look sensitivity -----------------------------------------------------
//
// A thumb on a 5" phone and a mouse on a desk are not the same instrument, and
// no single tuned constant has ever suited everyone. The setting is a
// multiplier over the base rate, so the check is proportionality: double the
// sensitivity, double the turn for the same swipe.
console.log('\n--- look sensitivity ---');
const sensitivity = await page.evaluate(() => {
  const c = window.__cluckdown.game.controls;
  const turn = (mul) => {
    c.setSensitivity(mul);
    c.yaw = 0;
    c.pitch = 0;
    c.applyLook(100, -100, 0.005);
    return { yaw: c.yaw, pitch: c.pitch };
  };
  const base = turn(1);
  const fast = turn(2);
  const slow = turn(0.5);
  // Out-of-range values must not be able to make the game unplayable.
  c.setSensitivity(0);
  const zero = c.sensitivity;
  c.setSensitivity('nonsense');
  const junk = c.sensitivity;
  c.setSensitivity(1);
  return { base, fast, slow, zero, junk };
});
console.log('  ', JSON.stringify(sensitivity));
check('doubling sensitivity doubles the turn',
  Math.abs(sensitivity.fast.yaw / sensitivity.base.yaw - 2) < 0.001,
  `${(sensitivity.fast.yaw / sensitivity.base.yaw).toFixed(3)}x`);
check('halving it halves the turn',
  Math.abs(sensitivity.slow.yaw / sensitivity.base.yaw - 0.5) < 0.001,
  `${(sensitivity.slow.yaw / sensitivity.base.yaw).toFixed(3)}x`);
check('it scales pitch as well as yaw, so the two stay in proportion',
  Math.abs(sensitivity.fast.pitch / sensitivity.base.pitch - 2) < 0.001,
  `${(sensitivity.fast.pitch / sensitivity.base.pitch).toFixed(3)}x`);
check('a nonsense sensitivity cannot freeze the camera',
  sensitivity.zero > 0 && sensitivity.junk > 0,
  JSON.stringify({ zero: sensitivity.zero, junk: sensitivity.junk }));

// --- both buttons can be moved --------------------------------------------
//
// Thumb reach varies enormously by hand and by phone, and a fixed layout is the
// difference between comfortable and unplayable. The jump button inherits this
// wholesale rather than reimplementing it — which is exactly the thing worth
// checking, because "the new button almost behaves like the old one" is how
// these diverge.
console.log('\n--- repositioning the thumb buttons ---');
const dragged = await page.evaluate(async () => {
  const c = window.__cluckdown.game.controls;
  c.setButtonEdit(true);

  const drag = (button, id, to) => {
    const before = button.el.getBoundingClientRect().left;
    button.onDown({ pointerId: id, clientX: 700, clientY: 300, preventDefault() {} });
    button.onMove({ pointerId: id, clientX: to.x, clientY: to.y });
    button.onUp({ pointerId: id });
    return { before: Math.round(before), after: Math.round(button.el.getBoundingClientRect().left) };
  };

  const fire = drag(c.fire, 3, { x: 500, y: 200 });
  const jump = drag(c.jump, 4, { x: 300, y: 320 });
  const stored = {
    fire: JSON.parse(localStorage.getItem('cluckdown.fire.v1') ?? 'null'),
    jump: JSON.parse(localStorage.getItem('cluckdown.jump.v1') ?? 'null'),
  };
  c.setButtonEdit(false);
  // Dragging must not have left either button stuck "held" — the pointerup
  // that ended the drag is not the one that would have released it.
  return { fire, jump, stored, editing: c.fire.edit || c.jump.edit, held: c.fire.held || c.jump.held };
});
console.log('  ', JSON.stringify(dragged));
check('edit mode moves the fire button', Math.abs(dragged.fire.after - dragged.fire.before) > 40,
  `${dragged.fire.before} → ${dragged.fire.after}`);
check('edit mode moves the jump button too', Math.abs(dragged.jump.after - dragged.jump.before) > 40,
  `${dragged.jump.before} → ${dragged.jump.after}`);
check('both positions are saved separately',
  !!dragged.stored.fire && !!dragged.stored.jump
  && dragged.stored.fire.x !== dragged.stored.jump.x,
  JSON.stringify(dragged.stored));
check('edit mode turns back off', dragged.editing === false);
check('leaving edit mode does not leave a button held down', dragged.held === false);

await shot(page, `${OUT}/16-fps-touch.png`);
check('no exceptions anywhere', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
