// Control-authority test.
//
// Knockback is ADDED to your movement velocity, so an uncapped shove means the
// player stops being able to steer. A three-shot burst under LOW GRAVITY used
// to stack to 25 u/s — three and a half times top speed — and pushed you
// backwards at 18 u/s while you sprinted the other way for over a second.
//
// That is what "sliding left, hard to go right" was: you were being shot from
// the right, and the game had taken the wheel.
//
//   node shared/test/control.mjs

import {
  createWorld, addPlayer, stepWorld, beginMatch,
  TICK_DT, PLAYER, BULLET, BOMBER, MODIFIER_POOL, MAPS, MODE_LIST, modValue,
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
 */
function pushBack(modifier, shots) {
  const { w, p } = live('casual', modifier);
  const kb = BULLET.knockback * modValue(modifier, 'knockbackMul');
  p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
  for (let i = 0; i < shots; i++) p.kx -= kb;

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

console.log('\n--- being shot must never take the wheel ---');
for (const modifier of ['none', 'lowGravity']) {
  for (const shots of [1, 3, 6]) {
    const { worst, travelled } = pushBack(modifier, shots);
    console.log(`  ${modifier.padEnd(10)} ${shots} shot(s): worst ${worst.toFixed(2)} u/s, net ${travelled.toFixed(2)}u over 2s`);
    // Being shoved backwards briefly is the point of knockback. Ending up
    // behind where you started, after two seconds of sprinting the other way,
    // is not.
    check(`${modifier}, ${shots} shots: you still end up ahead of where you started`,
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
  check(`${modifier}: a 4-shot burst still leaves you able to advance`,
    travelled > 0, `${travelled.toFixed(2)}u`);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
