// Control-authority test — horizontal and, since the simulation grew a Y axis,
// vertical.
//
// Knockback is ADDED to your movement velocity, so an uncapped shove means the
// player stops being able to steer. A three-shot burst under LOW GRAVITY used
// to stack to 25 u/s — three and a half times top speed — and pushed you
// backwards at 18 u/s while you sprinted the other way for over a second.
//
// That is what "sliding left, hard to go right" was: you were being shot from
// the right, and the game had taken the wheel.
//
// The vertical half of this file exists for the same reason. Being in the air
// is the one state you cannot steer your way out of, so the rules are: only
// your own jump can lift you, nothing can lift you higher than the walls are
// tall, and you keep full control of where you are going while you are up
// there. Every check below is one of those three sentences.
//
//   node shared/test/control.mjs

import {
  createWorld, addPlayer, stepWorld, beginMatch,
  TICK_DT, PLAYER, BOMBER, MODIFIER_POOL, MAPS, MODE_LIST, modValue,
  applyInput, GRAVITY, WALL_HEIGHT,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

function live(mode = 'casual', modifier = 'none', map = 'coop') {
  const w = createWorld({ mode, seed: 3, modifier });
  const p = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, map);
  for (let t = 0; t < 2 / TICK_DT && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  return { w, p };
}

/**
 * Runs into a shove and reports the worst velocity achieved along the axis the
 * player is pushing toward. Negative means "moving backwards while sprinting
 * forwards", which is the thing that must not happen.
 *
 * Driven with BLAST knockback now. Bullets stopped applying any when shooting
 * went hitscan — being shot tags you (a brief slow) instead of shoving you,
 * which is the same idea taken further: a slow cannot move you against your
 * input at all. Explosions still throw you, correctly, so they are what the cap
 * has left to bound and what this has to measure. Blasts hit harder than
 * bullets did, so `blasts` here is worth several of the old `shots`.
 */
function pushBack(modifier, blasts) {
  const { w, p } = live('casual', modifier);
  const kb = BOMBER.blastKnockback * modValue(modifier, 'knockbackMul');
  p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
  for (let i = 0; i < blasts; i++) p.kx -= kb;

  let worst = Infinity;
  let travelled = 0;
  const x0 = p.x;
  for (let t = 0; t < 2 / TICK_DT; t++) {
    const before = p.x;
    p.hp = PLAYER.maxHp;
    p.input = { mx: 1, mz: 0, ax: 0, az: 0, shoot: false, seq: 0 };
    stepWorld(w, TICK_DT);
    worst = Math.min(worst, (p.x - before) / TICK_DT);
  }
  travelled = p.x - x0;
  return { worst, travelled };
}

console.log('\n--- being hit must never take the wheel ---');
for (const modifier of ['none', 'lowGravity']) {
  for (const shots of [1, 3, 6]) {
    const { worst, travelled } = pushBack(modifier, shots);
    console.log(`  ${modifier.padEnd(10)} ${shots} blast(s): worst ${worst.toFixed(2)} u/s, net ${travelled.toFixed(2)}u over 2s`);
    // Being shoved backwards briefly is the point of knockback. Ending up
    // behind where you started, after two seconds of sprinting the other way,
    // is not.
    check(`${modifier}, ${shots} blasts: you still end up ahead of where you started`,
      travelled > 0, `${travelled.toFixed(2)}u`);
  }
}

console.log('\n--- the cap holds whatever the source ---');
{
  const { w, p } = live();
  p.kx = 999; p.kz = -999;
  p.input = { mx: 0, mz: 0, ax: 0, az: 0, shoot: false, seq: 0 };
  stepWorld(w, TICK_DT);
  const mag = Math.hypot(p.kx, p.kz);
  console.log(`  absurd 1400 u/s impulse clamped to ${mag.toFixed(2)} u/s`);
  check('an absurd impulse is clamped', mag <= PLAYER.maxKnockback + 0.01,
    `${mag.toFixed(2)} vs cap ${PLAYER.maxKnockback.toFixed(2)}`);
  check('the direction of the shove survives the clamp', p.kx > 0 && p.kz < 0,
    `(${p.kx.toFixed(1)}, ${p.kz.toFixed(1)})`);
}

// A blast should still throw you — capping must not neuter the bomber.
{
  const { w, p } = live();
  p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
  p.kx = BOMBER.blastKnockback;
  const x0 = p.x;
  for (let t = 0; t < 0.6 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    p.input = { mx: 0, mz: 0, ax: 0, az: 0, shoot: false, seq: 0 };
    stepWorld(w, TICK_DT);
  }
  console.log(`  a blast still throws you ${(p.x - x0).toFixed(2)}u in 0.6s`);
  check('a blast still visibly throws you', p.x - x0 > 1.5, `${(p.x - x0).toFixed(2)}u`);
}

console.log('\n--- movement is symmetric everywhere ---');
// The player report was direction-specific, so prove there is no directional
// bias left in the simulation on any map or in any mode.
const dirs = { right: [1, 0], left: [-1, 0], fwd: [0, 1], back: [0, -1] };
function travel(mode, map) {
  const out = {};
  for (const [name, [mx, mz]] of Object.entries(dirs)) {
    const { w, p } = live(mode, 'none', map);
    p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
    for (let t = 0; t < 1 / TICK_DT; t++) {
      p.hp = PLAYER.maxHp;
      p.input = { mx, mz, ax: 0, az: 0, shoot: false, seq: 0 };
      stepWorld(w, TICK_DT);
    }
    out[name] = Math.hypot(p.x, p.z);
  }
  return out;
}

for (const map of Object.keys(MAPS)) {
  const d = travel('casual', map);
  const vals = Object.values(d);
  const spread = Math.max(...vals) - Math.min(...vals);
  check(`${map}: all four directions travel the same distance`, spread < 1e-6,
    `spread ${spread.toExponential(1)}`);
}
for (const mode of MODE_LIST) {
  const d = travel(mode, 'coop');
  const vals = Object.values(d);
  check(`${mode}: all four directions travel the same distance`,
    Math.max(...vals) - Math.min(...vals) < 1e-6);
}

// Walls too — the clamp has to leave the same gap on both sides.
console.log('\n--- walls are the same distance out on every side ---');
{
  const { w, p } = live();
  const reach = {};
  for (const [name, [mx, mz]] of Object.entries(dirs)) {
    p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
    for (let t = 0; t < 8 / TICK_DT; t++) {
      p.hp = PLAYER.maxHp;
      p.input = { mx, mz, ax: 0, az: 0, shoot: false, seq: 0 };
      stepWorld(w, TICK_DT);
    }
    reach[name] = { x: p.x, z: p.z };
  }
  console.log('  ', Object.entries(reach).map(([k, v]) => `${k}(${v.x.toFixed(2)},${v.z.toFixed(2)})`).join(' '));
  check('left and right stop the same distance from centre',
    Math.abs(Math.abs(reach.left.x) - Math.abs(reach.right.x)) < 1e-6,
    `${reach.left.x.toFixed(3)} vs ${reach.right.x.toFixed(3)}`);
  check('forward and back stop the same distance from centre',
    Math.abs(Math.abs(reach.fwd.z) - Math.abs(reach.back.z)) < 1e-6,
    `${reach.fwd.z.toFixed(3)} vs ${reach.back.z.toFixed(3)}`);
}

// Every modifier, not just LOW GRAVITY.
console.log('\n--- no modifier can take the wheel ---');
for (const modifier of MODIFIER_POOL) {
  const { travelled } = pushBack(modifier, 4);
  check(`${modifier}: four blasts still leave you able to advance`,
    travelled > 0, `${travelled.toFixed(2)}u`);
}

// The strongest form of the same guarantee, and the reason bullets stopped
// shoving at all: a trace that tags you cannot move you one unit against your
// input, however much of it lands.
console.log('\n--- gunfire cannot move you at all any more ---');
{
  const { w, p } = live();
  const shooter = w.players.get('b');
  p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
  p.invulnUntil = 0;
  shooter.x = 0; shooter.z = -10; shooter.invulnUntil = 0;
  const yaw = Math.atan2(0, 10);

  let worstDrift = 0;
  for (let t = 0; t < 1.5 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    p.invulnUntil = 0;
    shooter.crop = 999;
    shooter.dry = false;
    applyInput(w, 'b', {
      mx: 0, mz: 0, ax: Math.sin(yaw), az: Math.cos(yaw), shoot: true, seq: t,
    });
    applyInput(w, 'a', { mx: 0, mz: 0, seq: t });
    stepWorld(w, TICK_DT);
    worstDrift = Math.max(worstDrift, Math.hypot(p.x, p.z));
  }
  console.log(`  stood still under 1.5s of sustained fire: moved ${worstDrift.toFixed(3)}u`);
  check('sustained fire does not push a standing player anywhere',
    worstDrift < 1e-6, `${worstDrift.toFixed(4)}u`);
  check('...and leaves no knockback velocity behind', p.kx === 0 && p.kz === 0,
    `(${p.kx}, ${p.kz})`);
}

// ---------------------------------------------------------------- vertical

/**
 * Steps the world and reports the arc the player traced.
 *
 * `input` may be an object (held for the whole run) or a function of the tick
 * index — jump is level-triggered, so "tap once" and "hold it down" are two
 * genuinely different inputs and both need testing.
 */
function hop(input, seconds = 2, modifier = 'none') {
  const { w, p } = live('casual', modifier);
  p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
  const at = typeof input === 'function' ? input : () => input;
  const trace = [];
  for (let t = 0; t < seconds / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    applyInput(w, 'a', { seq: t, ...at(t) });
    stepWorld(w, TICK_DT);
    trace.push({ y: p.y, vy: p.vy, x: p.x, z: p.z, t: w.time });
  }
  const apex = Math.max(...trace.map((s) => s.y));
  return { w, p, trace, apex };
}

/** One tap of the jump button, on the first tick only. */
const tapJump = (extra = {}) => (t) => ({ mx: 0, mz: 0, ...extra, jump: t === 0 });

console.log('\n--- jumping ---');
{
  const still = hop({ mx: 0, mz: 0, jump: false }, 1);
  check('standing still leaves you on the floor', still.apex === 0, `apex ${still.apex}`);

  const up = hop(tapJump(), 1.2);
  console.log(`  a jump peaks at ${up.apex.toFixed(2)}u after ${(up.trace.findIndex((s) => s.y === up.apex) * TICK_DT).toFixed(2)}s`);
  check('jumping actually leaves the ground', up.apex > 0.5, `${up.apex.toFixed(2)}u`);
  check('...and gravity brings you back down',
    up.trace[up.trace.length - 1].y === 0, `${up.trace[up.trace.length - 1].y.toFixed(3)}u`);

  // The whole reason maxJumpHeight is a hard clamp rather than a tuned impulse.
  // Eye height plus the apex has to stay under the wall, or you are looking at
  // the void the arena floats above.
  const eyeAtApex = PLAYER.eyeHeight + up.apex;
  console.log(`  eye at apex: ${eyeAtApex.toFixed(2)}u vs ${WALL_HEIGHT}u walls`);
  check('you never see over the walls at the top of a jump',
    eyeAtApex < WALL_HEIGHT, `${eyeAtApex.toFixed(2)} vs ${WALL_HEIGHT}`);
  check('the ceiling is respected exactly', up.apex <= PLAYER.maxJumpHeight + 1e-9,
    `${up.apex.toFixed(3)} vs cap ${PLAYER.maxJumpHeight}`);
}

// Holding the button is a bunny hop, not a jetpack: you may leave the ground
// again on landing, but never while already rising.
{
  const held = hop({ mx: 0, mz: 0, jump: true }, 3);
  const landings = held.trace.filter((s, i) => i > 0 && s.y === 0 && held.trace[i - 1].y > 0).length;
  // A boost is velocity INCREASING while both ends of the step are off the
  // floor. Without the second half of that condition, the landing tick itself
  // reads as a boost — vy goes from very negative to zero as you hit the
  // ground — and the check passes or fails for entirely the wrong reason.
  const climbs = held.trace.filter((s, i) => (
    i > 0 && s.vy > held.trace[i - 1].vy + 1e-6 && held.trace[i - 1].y > 0 && s.y > 0
  )).length;
  console.log(`  holding jump for 3s: ${landings} landing(s), ${climbs} mid-air boost(s)`);
  check('holding jump hops again once you are back down', landings >= 2, `${landings}`);
  check('...but never gives you a second jump in mid-air', climbs === 0, `${climbs}`);
}

// LOW GRAVITY finally means what it says — and still cannot lift you over a wall.
console.log('\n--- low gravity floats, it does not launch ---');
{
  const normal = hop({ mx: 0, mz: 0, jump: false }, 1.5);
  const light = hop({ mx: 0, mz: 0, jump: false }, 1.5, 'lowGravity');
  // Drop both from the ceiling and time the fall.
  const fall = (modifier) => {
    const { w, p } = live('casual', modifier);
    p.y = PLAYER.maxJumpHeight;
    p.vy = 0;
    let t = 0;
    for (; t < 4 / TICK_DT && p.y > 0; t++) {
      p.hp = PLAYER.maxHp;
      applyInput(w, 'a', { mx: 0, mz: 0, jump: false, seq: t });
      stepWorld(w, TICK_DT);
    }
    return t * TICK_DT;
  };
  const fastFall = fall('none');
  const slowFall = fall('lowGravity');
  console.log(`  falling ${PLAYER.maxJumpHeight}u takes ${fastFall.toFixed(2)}s normally, ${slowFall.toFixed(2)}s in low gravity`);
  check('low gravity really does make you fall slower', slowFall > fastFall * 1.2,
    `${fastFall.toFixed(2)}s -> ${slowFall.toFixed(2)}s`);

  const floaty = hop(tapJump(), 3, 'lowGravity');
  console.log(`  low-gravity jump peaks at ${floaty.apex.toFixed(2)}u`);
  check('low gravity buys hang time, not altitude',
    floaty.apex <= PLAYER.maxJumpHeight + 1e-9,
    `${floaty.apex.toFixed(3)} vs cap ${PLAYER.maxJumpHeight}`);
  check('...so the walls still hide the void in every modifier',
    PLAYER.eyeHeight + floaty.apex < WALL_HEIGHT,
    `${(PLAYER.eyeHeight + floaty.apex).toFixed(2)}`);
  void normal; void light;
}

// Being airborne must not cost you the controls — the vertical restatement of
// the whole point of this file.
console.log('\n--- you still steer while you are in the air ---');
{
  const ground = hop({ mx: 1, mz: 0, jump: false }, 0.5);
  const air = hop(tapJump({ mx: 1 }), 0.5);
  console.log(`  0.5s of running: ${ground.p.x.toFixed(2)}u on the floor, ${air.p.x.toFixed(2)}u mid-jump`);
  check('a jump does not slow you down', Math.abs(air.p.x - ground.p.x) < 1e-6,
    `${ground.p.x.toFixed(3)} vs ${air.p.x.toFixed(3)}`);
  check('...and you are genuinely off the ground for it', air.apex > 0.5, `${air.apex.toFixed(2)}u`);

  // Change your mind in mid-air and the sim obeys immediately.
  const { w, p } = live();
  p.x = 0; p.z = 0;
  // Both halves have to fit inside one ~0.64s hop, or the reversal is measured
  // with both feet back on the floor and proves nothing.
  for (let t = 0; t < 0.2 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    applyInput(w, 'a', { mx: 1, mz: 0, jump: t === 0, seq: t });
    stepWorld(w, TICK_DT);
  }
  const turnAt = p.x;
  for (let t = 0; t < 0.2 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    applyInput(w, 'a', { mx: -1, mz: 0, jump: false, seq: 100 + t });
    stepWorld(w, TICK_DT);
  }
  console.log(`  reversed in mid-air (y=${p.y.toFixed(2)}): ${turnAt.toFixed(2)}u -> ${p.x.toFixed(2)}u`);
  check('you can reverse direction in mid-air', p.y > 0 && p.x < turnAt,
    `y=${p.y.toFixed(2)} x ${turnAt.toFixed(2)} -> ${p.x.toFixed(2)}`);
}

// Nothing but your own jump lifts you. Knockback is horizontal by construction,
// and this is the check that keeps it that way — a blast that launched people
// would be the vertical version of "sliding left, can't go right".
console.log('\n--- being hit must never launch you ---');
for (const modifier of MODIFIER_POOL) {
  const { w, p } = live('casual', modifier);
  p.x = 0; p.z = 0;
  p.kx = 999; p.kz = 999; // an absurd shove from every direction at once
  let highest = 0;
  for (let t = 0; t < 1 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    applyInput(w, 'a', { mx: 0, mz: 0, jump: false, seq: t });
    stepWorld(w, TICK_DT);
    highest = Math.max(highest, p.y);
  }
  check(`${modifier}: an absurd shove never lifts you off the floor`, highest === 0,
    `${highest.toFixed(3)}u`);
}

// Gravity itself has to be symmetric with the impulse, or the arc is lopsided.
console.log('\n--- the arc is an arc ---');
{
  const up = hop({ mx: 0, mz: 0, jump: true }, 1.5);
  const apexAt = up.trace.findIndex((s) => s.y === up.apex);
  const landedAt = up.trace.findIndex((s, i) => i > apexAt && s.y === 0);
  const rise = apexAt * TICK_DT;
  const fall = (landedAt - apexAt) * TICK_DT;
  console.log(`  rise ${rise.toFixed(3)}s, fall ${fall.toFixed(3)}s (gravity ${GRAVITY})`);
  check('going up takes about as long as coming down', Math.abs(rise - fall) < 0.05,
    `${rise.toFixed(3)}s vs ${fall.toFixed(3)}s`);
}

// Pitch is input, and input is never trusted.
console.log('\n--- the server clamps the look angle it is sent ---');
{
  const { w, p } = live();
  for (const [label, sent] of [['straight down', -99], ['straight up', 99], ['garbage', NaN]]) {
    applyInput(w, 'a', { mx: 0, mz: 0, pitch: sent, seq: 1 });
    stepWorld(w, TICK_DT);
    check(`${label} (${sent}) is clamped into range`,
      p.pitch >= PLAYER.pitchMin - 1e-9 && p.pitch <= PLAYER.pitchMax + 1e-9,
      `${p.pitch.toFixed(3)}`);
  }
  // A sane angle passes through untouched — the clamp must not also be a filter.
  applyInput(w, 'a', { mx: 0, mz: 0, pitch: 0.4, seq: 2 });
  stepWorld(w, TICK_DT);
  check('a legal angle arrives exactly as sent', Math.abs(p.pitch - 0.4) < 1e-9,
    `${p.pitch.toFixed(6)}`);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
