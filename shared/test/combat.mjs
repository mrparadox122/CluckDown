// Aim assist and ammo types.
//
// Ammo is pure simulation. Aim assist is not: it runs on the CLIENT, shaping
// the look angle before it is sent, so these drive the same pure helpers the
// client drives — plus one check that the server adds nothing of its own.
//
//   node shared/test/combat.mjs

import {
  createWorld, addPlayer, applyInput, stepWorld,
  AIM_ASSIST, AMMO, PLAYER, BULLET, TICK_DT, rollPickup, PICKUP_WEIGHTS,
  pickAimTarget, pullAim,
} from '../src/index.js';
import { angleDelta } from '../src/math.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

function arena({ modifier = 'none' } = {}) {
  const world = createWorld({ mode: 'casual', seed: 999, modifier });
  world.phase = 'live';
  world.time = 2;
  return world;
}

const add = (world, id, seat, x, z) => {
  const p = addPlayer(world, { id, name: id, seat });
  p.x = x; p.z = z; p.invulnUntil = 0;
  return p;
};

// ------------------------------------------------------------- aim assist
//
// Assist is applied by the CLIENT to its own look angle before that angle is
// sent, not by the server to the angle it received — see shared/src/aim.js. So
// these drive the same pure functions the client drives, rather than stepping a
// world and reading p.aim back out.
console.log('\n--- aim assist ---');

const ME = { id: 'me', x: 0, z: 0, team: null };
const foeAt = (x, z, extra = {}) => ({
  id: 'foe', x, z, alive: true, team: null, invuln: false, mx: 0, mz: 0, ...extra,
});

/** Aims deliberately WIDE of a target and reports how far off we end up. */
function aimError({ offsetRad, foe = foeAt(1, 12), frames = 60 }) {
  const trueAngle = Math.atan2(foe.x - ME.x, foe.z - ME.z);
  const raw = trueAngle + offsetRad;

  let aim = raw;
  let locked = null;
  for (let t = 0; t < frames; t++) {
    // `raw` never moves: it is what the player is actually asking for, and
    // target acquisition is always measured against it.
    const target = pickAimTarget(ME, [foe], raw, locked);
    if (!target) { locked = null; aim = raw; continue; }
    if (locked !== target.id) aim = raw;
    locked = target.id;
    aim = pullAim(ME, target, aim, TICK_DT);
  }
  return { error: Math.abs(angleDelta(aim, trueAngle)), locked };
}

const inCone = aimError({ offsetRad: 0.25 });
const outOfCone = aimError({ offsetRad: 1.2 });

console.log(`  aimed 0.25rad off: error ${inCone.error.toFixed(3)}rad, locked=${inCone.locked}`);
console.log(`  aimed 1.20rad off: error ${outOfCone.error.toFixed(3)}rad, locked=${outOfCone.locked}`);

check('assist pulls aim onto a target inside the cone', inCone.error < 0.05,
  `${inCone.error.toFixed(3)}rad off`);
check('assist acquires a lock', inCone.locked === 'foe', String(inCone.locked));
check('assist ignores targets outside the cone', outOfCone.error > 1.0,
  `${outOfCone.error.toFixed(3)}rad off, locked=${outOfCone.locked}`);

// Dead, invulnerable and same-team chickens are all invisible to it.
check('a dead chicken is never a target',
  !pickAimTarget(ME, [foeAt(1, 12, { alive: false })], Math.atan2(1, 12)));
check('a spawn-shielded chicken is never a target',
  !pickAimTarget(ME, [foeAt(1, 12, { invuln: true })], Math.atan2(1, 12)));
check('a team-mate is never a target',
  !pickAimTarget({ ...ME, team: 0 }, [foeAt(1, 12, { team: 0 })], Math.atan2(1, 12)));
check('an enemy on the OTHER team still is',
  !!pickAimTarget({ ...ME, team: 0 }, [foeAt(1, 12, { team: 1 })], Math.atan2(1, 12)));

// Sticky: acquire, then drift out past the acquire cone but inside the sticky
// one. This is what makes it feel like a lock instead of a twitch.
const sticky = (() => {
  const foe = foeAt(1, 12);
  const trueAngle = Math.atan2(foe.x - ME.x, foe.z - ME.z);
  const acquired = pickAimTarget(ME, [foe], trueAngle, null)?.id ?? null;
  const wide = trueAngle + (AIM_ASSIST.cone + AIM_ASSIST.stickyCone) / 2;
  return {
    acquired,
    keptAfterDrift: pickAimTarget(ME, [foe], wide, acquired)?.id ?? null,
    // ...but turning right away does drop it.
    droppedWhenTurned: pickAimTarget(ME, [foe], trueAngle + AIM_ASSIST.stickyCone + 0.3, acquired)?.id ?? null,
  };
})();
check('a lock survives drift past the acquire cone',
  sticky.acquired === 'foe' && sticky.keptAfterDrift === 'foe',
  `acquired=${sticky.acquired} kept=${sticky.keptAfterDrift}`);
check('...but turning away deliberately still drops it',
  sticky.droppedWhenTurned === null, String(sticky.droppedWhenTurned));

// A target outside the acquire range is not picked up at all.
check('range is respected', !pickAimTarget(ME, [foeAt(0, AIM_ASSIST.range + 5)], 0));

// The simulation itself must no longer touch aim: whatever the client sends is
// exactly what gets fired.
const untouched = (() => {
  const world = arena();
  const me = add(world, 'me', 0, 0, 0);
  add(world, 'foe', 1, 0, 12); // right in front, well inside every cone
  const asked = 0.3;           // ...and we are deliberately aiming past them
  for (let t = 0; t < 30; t++) {
    applyInput(world, 'me', {
      mx: 0, mz: 0, ax: Math.sin(asked), az: Math.cos(asked), shoot: false, seq: t,
    });
    stepWorld(world, TICK_DT);
  }
  return Math.abs(angleDelta(me.aim, asked));
})();
console.log(`  server drift from the angle sent: ${untouched.toFixed(4)}rad`);
check('the server fires exactly the angle it was sent, with no assist of its own',
  untouched < 1e-6, `${untouched.toFixed(6)}rad`);

// ------------------------------------------------------------- ammo types
console.log('\n--- ammo types ---');

/** Fires at a target for `seconds` and reports what landed. */
function fireAt(ammo, { offsetRad = 0, foeAt = [0, 10], seconds = 2 } = {}) {
  const world = arena();
  const me = add(world, 'me', 0, 0, 0);
  const foe = add(world, 'foe', 1, foeAt[0], foeAt[1]);
  if (ammo !== 'none') { me.ammo = ammo; me.ammoUntil = world.time + 60; }

  const angle = Math.atan2(foe.x - me.x, foe.z - me.z) + offsetRad;
  const tally = { hits: 0, damage: 0, bounces: 0, ignites: 0, burnDamage: 0, shots: 0 };

  for (let t = 0; t < seconds / TICK_DT; t++) {
    foe.hp = PLAYER.maxHp; // keep it standing so we can count everything
    foe.invulnUntil = 0;
    applyInput(world, 'me', { mx: 0, mz: 0, ax: Math.sin(angle), az: Math.cos(angle), shoot: true, seq: t });
    for (const e of stepWorld(world, TICK_DT)) {
      if (e.type === 'shot') tally.shots++;
      if (e.type === 'bounce') tally.bounces++;
      if (e.type === 'ignite') tally.ignites++;
      if (e.type === 'hit' && e.target === 'foe') {
        tally.hits++;
        tally.damage += e.amount;
        if (e.kind === 'burn') tally.burnDamage += e.amount;
      }
    }
  }
  return tally;
}

// Tracking: fire deliberately wide, with assist disabled so only the bullet
// steering can explain a hit.
const assistWas = AIM_ASSIST.enabled;
AIM_ASSIST.enabled = false;

const plainWide = fireAt('none', { offsetRad: 0.32 });
const trackWide = fireAt('tracking', { offsetRad: 0.32 });
console.log(`  wide shot: plain ${plainWide.hits} hits, tracking ${trackWide.hits} hits`);
check('tracking rounds curve onto a target a plain shot misses',
  trackWide.hits > plainWide.hits, `${plainWide.hits} -> ${trackWide.hits}`);

AIM_ASSIST.enabled = assistWas;

// Bouncy: shoot at a wall with nobody in front.
const bouncy = fireAt('bouncy', { offsetRad: Math.PI, foeAt: [0, 10], seconds: 1.5 });
const plainWall = fireAt('none', { offsetRad: Math.PI, foeAt: [0, 10], seconds: 1.5 });
console.log(`  into the wall: plain ${plainWall.bounces} bounces, bouncy ${bouncy.bounces} bounces`);
check('bouncy rounds ricochet', bouncy.bounces > 0, `${bouncy.bounces} bounces`);
check('plain rounds do not', plainWall.bounces === 0, `${plainWall.bounces} bounces`);

// Fire: burn keeps ticking and is credited to the shooter.
const fire = fireAt('fire', { seconds: 2 });
const plain = fireAt('none', { seconds: 2 });
console.log(`  fire: ${fire.ignites} ignites, ${fire.burnDamage.toFixed(0)} burn damage of ${fire.damage.toFixed(0)} total`);
check('fire rounds ignite the target', fire.ignites > 0, `${fire.ignites}`);
check('burning deals damage over time', fire.burnDamage > 0, `${fire.burnDamage.toFixed(0)}`);
check('fire out-damages plain rounds', fire.damage > plain.damage,
  `${plain.damage.toFixed(0)} -> ${fire.damage.toFixed(0)}`);
check('plain rounds never ignite', plain.ignites === 0);

// Burn continues after the shooting stops, and expires.
const lingering = (() => {
  const world = arena();
  const me = add(world, 'me', 0, 0, 0);
  const foe = add(world, 'foe', 1, 0, 10);
  foe.burnUntil = world.time + AMMO.fire.burnDuration;
  foe.burnBy = me.id;
  const before = foe.hp;
  for (let t = 0; t < 6 / TICK_DT; t++) stepWorld(world, TICK_DT);
  return { lost: before - foe.hp, stillBurning: foe.burnUntil > world.time };
})();
console.log(`  lingering burn took ${lingering.lost.toFixed(0)} hp`);
check('a burn keeps ticking with no further shots', lingering.lost > 10, `${lingering.lost.toFixed(0)} hp`);
check('a burn eventually goes out', !lingering.stillBurning);

// --------------------------------------------------------------- pickups
console.log('\n--- pickups ---');
const counts = {};
let seed = 1;
const rng = () => ((seed = (seed * 16807 + 11) % 2147483647) / 2147483647);
for (let i = 0; i < 4000; i++) {
  const k = rollPickup(rng);
  counts[k] = (counts[k] ?? 0) + 1;
}
console.log('  ', JSON.stringify(counts));
check('every weighted pickup can appear',
  PICKUP_WEIGHTS.every(([k]) => counts[k] > 0), Object.keys(counts).join(', '));
check('health is the most common', Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] === 'health');

// Picking a type up loads it, and replaces whatever was there.
const slot = (() => {
  const world = arena();
  const p = add(world, 'me', 0, 0, 0);
  world.pickups = [{ id: 1, type: 'tracking', x: 0, z: 0 }];
  stepWorld(world, TICK_DT);
  const first = p.ammo;
  world.pickups = [{ id: 2, type: 'fire', x: 0, z: 0 }];
  stepWorld(world, TICK_DT);
  return { first, second: p.ammo, until: p.ammoUntil > world.time };
})();
check('an ammo pickup loads that type', slot.first === 'tracking', slot.first);
check('a second pickup replaces the first', slot.second === 'fire', slot.second);
check('ammo is on a timer', slot.until);

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
