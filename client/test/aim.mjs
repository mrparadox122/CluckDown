// The camera and the bullet are the same line. Prove it.
//
// THE BUG THIS FILE EXISTS FOR. The camera rig used to render `pitch + recoil`
// while the input struct went out along the un-kicked `pitch`. The crosshair is
// nailed to screen centre, so it rode a view the bullets were not following —
// up to 0.12 radians of it under sustained fire, which at twelve units of range
// is 1.45 units: a whole chicken above where rounds landed. Nothing on screen
// contradicted anything else on screen, which is exactly why the player who
// could feel it could not name it.
//
// So the check is not "does recoil look right". It is: does the vector the
// camera looks down equal the vector the shot leaves along, always. At rest,
// through a burst, at the pitch limits, and while the player fights the climb.
// A future kick, sway or flinch that touches only the view fails here.
//
// Headless on purpose. look.js has no DOM, no Babylon and no nipplejs,
// precisely because the browser is where this bug hid.
//
//   node client/test/aim.mjs

import {
  PLAYER, RECOIL, SPREAD, AIM_ASSIST, nextSpread, spreadPixels, coneDeviate,
  createWorld, addPlayer, applyInput, stepWorld, TICK_DT,
  pickAimTarget, pullAim, pullPitch,
} from '@cluckdown/shared';
import { Look, FP_PITCH_RATIO } from '../src/game/look.js';
import { lookBasis } from '../src/game/view.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const deg = (r) => `${(r * 180 / Math.PI).toFixed(2)}deg`;

/**
 * The two directions that must never come apart.
 *
 * `camera` is what scene.js aims the view down: lookBasis of the yaw and pitch
 * it is handed, which is `controls.yaw` and `controls.pitch` and nothing else.
 * `fired` is what the simulation builds in fire(), from the ax/az/pitch the
 * input struct carries. Two independent constructions of the same idea —
 * writing one in terms of the other would prove nothing.
 */
function bothWays(look) {
  const camera = lookBasis(look.yaw, look.pitch);
  // Exactly what controls.sample() puts in the struct, and exactly what fire()
  // does with it: ax/az are the yaw as a vector, pitch rides along whole.
  const ax = Math.sin(look.yaw);
  const az = Math.cos(look.yaw);
  const yaw = Math.atan2(ax, az);
  const cp = Math.cos(look.pitch);
  const fired = {
    fx: Math.sin(yaw) * cp,
    fy: Math.sin(look.pitch),
    fz: Math.cos(yaw) * cp,
  };
  // The straight-line gap between two unit vectors, which for any angle this
  // small IS the angle in radians — and which measures it without acos.
  // `acos` near a dot product of 1 amplifies floating-point noise by about
  // 1e8: two vectors identical to the last bit came back 2e-8 radians apart,
  // and a test that has to allow 2e-8 cannot tell "identical" from "very
  // slightly wrong". This form has no such floor, so the tolerance below is a
  // real claim rather than a shrug.
  return Math.hypot(camera.fx - fired.fx, camera.fy - fired.fy, camera.fz - fired.fz);
}

// ------------------------------------------------------ the invariant
console.log('\n--- the camera and the shot are one line ---');
{
  const look = new Look();
  let worst = 0;

  // At rest, across the whole range of angles anyone can hold.
  for (let y = -Math.PI; y <= Math.PI; y += 0.19) {
    for (let p = PLAYER.pitchMin; p <= PLAYER.pitchMax; p += 0.11) {
      look.yaw = y;
      look.pitch = p;
      worst = Math.max(worst, bothWays(look));
    }
  }
  check('at rest, at every angle, they are the same vector', worst < 1e-12,
    `worst ${worst.toExponential(2)} rad over the full look range`);

  // ...and through a magazine held down. This is the case that was broken: the
  // old rig climbed 0.035 radians a shot with the shot staying put.
  look.yaw = 0.4;
  look.pitch = 0;
  let sprayWorst = 0;
  let climbed = 0;
  for (let shot = 0; shot < 16; shot++) {
    look.kick();
    sprayWorst = Math.max(sprayWorst, bothWays(look));
    // A frame between rounds, exactly as the render loop runs it.
    for (let f = 0; f < 6; f++) {
      look.step(1 / 60, 0, false);
      sprayWorst = Math.max(sprayWorst, bothWays(look));
    }
    climbed = look.pitch;
  }
  console.log(`  16 rounds held down: the view climbed ${deg(climbed)}`);
  check('under sustained fire they are STILL the same vector', sprayWorst < 1e-12,
    `worst ${sprayWorst.toExponential(2)} rad across a full magazine`);

  // The size of the old lie, for the record. This is what the player was
  // fighting: the reticle sat this far above the rounds at twelve units.
  const oldGap = Math.tan(0.12) * 12;
  console.log(`  for reference, the bug this replaces: ${deg(0.12)} = ${oldGap.toFixed(2)}u at 12u range`);
}

// ------------------------------------------------------------- recoil
console.log('\n--- recoil is real, deterministic, and comes back ---');
{
  const look = new Look();
  const first = look.pitch;
  look.kick();
  check('a shot moves the AIM, not just the view', look.pitch > first,
    `${deg(look.pitch - first)} per shot`);
  check('...by exactly the tuned amount, every time',
    Math.abs((look.pitch - first) - RECOIL.kick) < 1e-12, deg(RECOIL.kick));

  // Determinism: the same burst from the same start lands on the same angle.
  const runBurst = () => {
    const l = new Look();
    for (let i = 0; i < 8; i++) {
      l.kick();
      for (let f = 0; f < 6; f++) l.step(1 / 60, 0, false);
    }
    return l.pitch;
  };
  check('the same burst always climbs to the same angle, never a roll',
    runBurst() === runBurst(), deg(runBurst()));

  // Tapping: a human cadence has to reset completely between rounds, or "tap
  // for accuracy" is advice the game does not honour.
  {
    const l = new Look();
    let worstDrift = 0;
    for (let i = 0; i < 10; i++) {
      l.kick();
      for (let f = 0; f < 18; f++) l.step(1 / 60, 0, false); // 0.3s between taps
      worstDrift = Math.max(worstDrift, Math.abs(l.pitch));
    }
    check('tapping stays pixel-exact — the climb is fully paid back',
      worstDrift < 1e-12, `${deg(worstDrift)} of drift after 10 taps`);
  }

  // Spraying: the climb has to actually accumulate, or the mechanic is decor.
  {
    const l = new Look();
    for (let i = 0; i < 5; i++) {
      l.kick();
      for (let f = 0; f < 6; f++) l.step(1 / 60, 0, false); // one fire interval
    }
    const killBurst = l.pitch;
    for (let i = 0; i < 25; i++) {
      l.kick();
      for (let f = 0; f < 6; f++) l.step(1 / 60, 0, false);
    }
    console.log(`  a 5-round kill burst climbs ${deg(killBurst)}, a long spray ${deg(l.pitch)}`);
    check('a kill-length burst stays controllable', killBurst > 0 && killBurst < 0.08,
      deg(killBurst));
    check('a long spray climbs much further', l.pitch > killBurst * 2, deg(l.pitch));
    check('...but never past the ceiling', l.pitch <= RECOIL.max + 1e-12,
      `${deg(l.pitch)} vs ${deg(RECOIL.max)}`);
  }

  // Recovery may only ever undo climb it caused. A player who pulls down
  // through a spray must not then be dragged below where they were aiming —
  // punishing correct recoil control is worse than having no recoil at all.
  {
    const l = new Look();
    l.pitch = 0.2;
    const aimed = l.pitch;
    for (let i = 0; i < 6; i++) {
      l.kick();
      // ...and the player pulls straight back down by the same amount.
      l.turn(0, RECOIL.kick / (0.0022 * FP_PITCH_RATIO), 0.0022);
      for (let f = 0; f < 6; f++) l.step(1 / 60, 0, false);
    }
    for (let f = 0; f < 120; f++) l.step(1 / 60, 0, false); // two seconds to settle
    console.log(`  pulled down through a 6-round burst: ended ${deg(l.pitch - aimed)} from where they aimed`);
    check('compensating for recoil is not punished afterwards',
      Math.abs(l.pitch - aimed) < 1e-9, deg(l.pitch - aimed));
  }

  // The pitch clamp cannot be allowed to bank climb that never happened.
  {
    const l = new Look();
    l.pitch = PLAYER.pitchMax;
    for (let i = 0; i < 10; i++) l.kick();
    for (let f = 0; f < 200; f++) l.step(1 / 60, 0, false);
    check('firing at the sky does not sink your aim afterwards',
      Math.abs(l.pitch - PLAYER.pitchMax) < 1e-12, deg(l.pitch - PLAYER.pitchMax));
  }
}

// ------------------------------------------------------------- spread
console.log('\n--- the cone the crosshair draws is the cone the sim uses ---');
{
  const l = new Look();
  check('standing still is EXACTLY pinpoint, not nearly', l.spread === 0, String(l.spread));

  l.step(1 / 60, 1, false);
  check('moving opens it immediately', l.spread === SPREAD.moving, deg(l.spread));

  l.step(1 / 60, 0, true);
  check('mid-air is the widest state in the game', l.spread === SPREAD.air, deg(l.spread));

  // Settling, which is what a counter-strafe buys.
  const settle = new Look();
  settle.step(1 / 60, 1, false);
  let t = 0;
  while (settle.spread > 0 && t < 2) {
    settle.step(1 / 60, 0, false);
    t += 1 / 60;
  }
  console.log(`  full-speed cone ${deg(SPREAD.moving)} settles to zero in ${(t * 1000).toFixed(0)}ms`);
  check('stopping pays back in about the tuned settle time',
    Math.abs(t - SPREAD.settle) < 0.03, `${(t * 1000).toFixed(0)}ms vs ${SPREAD.settle * 1000}ms`);

  // The client's cone and the simulation's cone are the same function. If they
  // drift, the reticle is drawing one number while the shot uses another —
  // which is the same class of bug as the recoil one, one layer over.
  let clientSide = SPREAD.still;
  const world = createWorld({ mode: 'casual', seed: 5 });
  world.phase = 'live';
  world.time = 2;
  const me = addPlayer(world, { id: 'me', name: 'me', seat: 0 });
  me.invulnUntil = 0;
  let worstGap = 0;
  for (let i = 0; i < 240; i++) {
    // Two seconds running, then two seconds stopped.
    const moving = i < 120 ? 1 : 0;
    applyInput(world, 'me', { mx: 0, mz: moving, ax: 0, az: 1, pitch: 0, seq: i });
    stepWorld(world, TICK_DT);
    clientSide = nextSpread(clientSide, moving, false, TICK_DT);
    worstGap = Math.max(worstGap, Math.abs(clientSide - me.spread));
  }
  check('the reticle and the simulation never disagree about the cone',
    worstGap < 1e-12, `worst ${worstGap.toExponential(2)} rad`);
}

// --------------------------------------------------- what it looks like
console.log('\n--- what the player actually sees ---');
{
  // A 400px-tall viewport at the game's 1.15rad field of view: a phone in
  // landscape, roughly. These are the numbers the reticle is drawing.
  const H = 400;
  const FOV = 1.15;
  for (const [label, cone] of [
    ['still', SPREAD.still], ['moving', SPREAD.moving], ['mid-air', SPREAD.air],
  ]) {
    const px = spreadPixels(cone, FOV, H);
    const at12 = Math.tan(cone) * 12;
    console.log(`  ${label.padEnd(8)} ${deg(cone).padStart(8)}  ${px.toFixed(1)}px of arm gap  ${at12.toFixed(2)}u wide at 12u`);
  }
  check('the arms actually move enough to be seen',
    spreadPixels(SPREAD.moving, FOV, H) > 12,
    `${spreadPixels(SPREAD.moving, FOV, H).toFixed(1)}px at full speed`);
  check('...and the still cone draws nothing at all',
    spreadPixels(SPREAD.still, FOV, H) === 0);

  // The deviation the cone hands out is bounded BY the cone, and the middle of
  // it is not over-weighted — a cone that mostly rolls near-centre is a cone
  // that lies about how inaccurate it is.
  let worst = 0;
  let outerHalf = 0;
  const n = 20000;
  let seed = 1;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const base = {
    x: Math.sin(0.7) * Math.cos(0.2), y: Math.sin(0.2), z: Math.cos(0.7) * Math.cos(0.2),
  };
  for (let i = 0; i < n; i++) {
    const d = coneDeviate(0.7, 0.2, SPREAD.moving, rng);
    const dot = d.dx * base.x + d.dy * base.y + d.dz * base.z;
    const off = Math.acos(Math.min(1, dot));
    worst = Math.max(worst, off);
    // Half the AREA of a disc lies outside r/sqrt(2) — so half the rolls should.
    if (off > SPREAD.moving / Math.SQRT2) outerHalf++;
  }
  check('no round ever leaves the cone the reticle drew',
    worst <= SPREAD.moving + 1e-9, `worst ${deg(worst)} of ${deg(SPREAD.moving)}`);
  check('...and the cone is filled evenly, not bunched at the middle',
    Math.abs(outerHalf / n - 0.5) < 0.02, `${(outerHalf / n * 100).toFixed(1)}% in the outer half`);
}

// ------------------------------------------------- the one legitimate gap
console.log('');
console.log('--- aim assist is the exception, and it is bounded ---');
{
  // Everything above proves the camera and the shot are one line. Aim assist is
  // the one thing in the game that deliberately breaks that: it steers the
  // SHOT toward a target while leaving the raw look angle alone, so with assist
  // on the reticle and the round genuinely do point at slightly different
  // things. That is the feature — it is what lets a thumb land body shots — and
  // it is why the cone checks measure against the RAW angle, so deliberately
  // turning away still drops the lock.
  //
  // It is not the recoil bug wearing a hat, for two reasons worth keeping
  // honest: it only ever happens while you are already pointing at someone, and
  // it can never exceed the angle at which a lock is held at all. This measures
  // the worst case and holds it to that bound. On a mouse the question is now
  // moot — assist defaults OFF for a fine pointer, which is the whole of 1.5.
  const self = { id: 'me', x: 0, y: 0, z: 0, team: null };
  let worst = 0;
  for (const off of [0.05, 0.15, 0.3, 0.45, 0.6, 0.8]) {
    const foe = {
      id: 'foe', x: Math.sin(off) * 14, y: 0, z: Math.cos(off) * 14,
      alive: true, team: null, invuln: false, mx: 0, mz: 0,
    };
    // Exactly what controls.assistedLook does, run to a steady state.
    let aYaw = 0;
    let aPitch = 0;
    let locked = null;
    for (let i = 0; i < 240; i++) {
      const t = pickAimTarget(self, [foe], 0, locked);
      if (!t) { aYaw = 0; aPitch = 0; locked = null; continue; }
      if (locked !== t.id) { aYaw = 0; aPitch = 0; }
      locked = t.id;
      aYaw = pullAim(self, t, aYaw, 1 / 60);
      aPitch = pullPitch(self, t, aPitch, 1 / 60);
    }
    const raw = lookBasis(0, 0);
    const bent = lookBasis(aYaw, aPitch);
    const gap = Math.hypot(raw.fx - bent.fx, raw.fy - bent.fy, raw.fz - bent.fz);
    worst = Math.max(worst, gap);
    console.log(`  target ${deg(off).padStart(8)} off the crosshair: the shot bends ${deg(gap)}`);
  }
  check('assist can never bend a shot further than it can hold a lock',
    worst <= AIM_ASSIST.stickyCone,
    `${deg(worst)} against a ${deg(AIM_ASSIST.stickyCone)} sticky cone`);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed` : '\n✓ all checks passed');
process.exit(failures.length ? 1 : 0);
