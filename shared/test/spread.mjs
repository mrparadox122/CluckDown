// Movement inaccuracy: does stopping actually win the fight?
//
// This file exists because the game had NO spread of any kind. Every round
// landed exactly on the crosshair, forever, at full sprint and mid-jump alike —
// so there was no good position, no good moment, and no wrong one. Aiming well
// and aiming while running paid identically, which is the whole reason shooting
// here had no mastery curve while CS, Valorant and CoD Mobile all do. In every
// one of them "stop moving to shoot" is the first thing a player learns.
//
// The checks below are deliberately about ORDER and SIZE rather than about any
// single shot: a cone is random by construction, so the claim worth defending
// is "standing still beats moving beats jumping, by enough to change what you
// do". Every scenario is driven directly rather than through a bot — a bot
// outcome would be chance dressed up as evidence.
//
//   node shared/test/spread.mjs

import {
  createWorld, addPlayer, applyInput, stepWorld,
  PLAYER, BULLET, SPREAD, TICK_DT, nextSpread,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const deg = (r) => `${(r * 180 / Math.PI).toFixed(2)}deg`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

/**
 * Fires `rounds` at a stationary chicken `range` away, in one movement state,
 * and reports what fraction landed.
 *
 * The shooter is PINNED. It is still sent a movement input — that is what opens
 * the cone, and going through the real input path is the point — but its
 * position is written back every tick, so the only thing varying between the
 * runs below is accuracy rather than geometry. Airborne is pinned the same way,
 * because a jump lasts about half a second and this needs a few hundred rounds.
 */
function volley({ state = 'still', range = 12, rounds = 600 } = {}) {
  const world = createWorld({ mode: 'casual', seed: 20250821 });
  world.phase = 'live';
  world.time = 2;
  // No bomber. Six hundred rounds at this fire rate is a minute of world time,
  // which is long enough for one to turn up and start damaging the target — and
  // a hit that nobody fired would be counted here as accuracy.
  world.bomberSpawnAt = Infinity;

  const me = addPlayer(world, { id: 'me', name: 'me', seat: 0 });
  const foe = addPlayer(world, { id: 'foe', name: 'foe', seat: 1 });
  me.invulnUntil = 0;
  foe.invulnUntil = 0;

  const moving = state === 'moving';
  const airborne = state === 'air';
  const eye = (airborne ? PLAYER.maxJumpHeight : 0) + PLAYER.eyeHeight;
  // Aimed at the middle of their body, which is what a player pointing at
  // someone is doing. It matters most in the air: a LEVEL shot from the top of
  // a jump sails clean over a chicken's head at any range, so leaving the pitch
  // at zero would measure the jump rather than the cone.
  const pitch = Math.atan2(PLAYER.hitHeight * 0.5 - eye, range);
  let fired = 0;
  let hit = 0;
  let widest = 0;

  // Long enough for the cone to reach its steady state before anything is
  // counted — it rises instantly, but a settling run has to start settled.
  for (let warm = 0; warm < 30; warm++) {
    me.x = 0; me.z = 0; me.y = airborne ? PLAYER.maxJumpHeight : 0; me.vy = 0;
    applyInput(world, 'me', { mx: moving ? 1 : 0, mz: 0, ax: 0, az: 1, pitch, seq: warm });
    stepWorld(world, TICK_DT);
  }

  for (let t = 0; fired < rounds && t < rounds * 40; t++) {
    // Pin both bodies, and keep the shooter fed — running dry would measure the
    // crop instead of the cone.
    me.x = 0; me.z = 0; me.y = airborne ? PLAYER.maxJumpHeight : 0; me.vy = 0;
    me.crop = 99; me.dry = false;
    foe.x = 0; foe.z = range; foe.y = 0; foe.hp = PLAYER.maxHp; foe.invulnUntil = 0;

    applyInput(world, 'me', {
      mx: moving ? 1 : 0, mz: 0, ax: 0, az: 1, pitch, shoot: true, seq: t,
    });
    widest = Math.max(widest, me.spread);
    for (const e of stepWorld(world, TICK_DT)) {
      if (e.type === 'shot' && e.owner === 'me') fired++;
      // Only rounds WE fired count. Anything else damaging the target would be
      // read here as marksmanship.
      if (e.type === 'hit' && e.target === 'foe' && e.by === 'me') hit++;
    }
  }
  return { rate: hit / fired, fired, cone: widest };
}

// -------------------------------------------------- the defining skill
console.log('\n--- stopping is what makes you accurate ---');
const at12 = {
  still: volley({ state: 'still' }),
  moving: volley({ state: 'moving' }),
  air: volley({ state: 'air' }),
};
for (const [label, r] of Object.entries(at12)) {
  console.log(`  ${label.padEnd(7)} cone ${deg(r.cone).padStart(8)}  ${pct(r.rate).padStart(6)} of ${r.fired} rounds landed at 12u`);
}

// The contract everything else rests on. Not "nearly all" — all of them.
check('a standing shot at a target you are covering NEVER misses',
  at12.still.rate === 1, pct(at12.still.rate));
check('...because the standing cone is exactly zero',
  at12.still.cone === 0 && SPREAD.still === 0, deg(at12.still.cone));

check('running and gunning costs you a real share of your rounds',
  at12.moving.rate < 0.75, pct(at12.moving.rate));
check('...but is not so hopeless that firing back is pointless',
  at12.moving.rate > 0.3, pct(at12.moving.rate));
check('jumping is the worst way to shoot in the game',
  at12.air.rate < at12.moving.rate * 0.6,
  `${pct(at12.air.rate)} in the air vs ${pct(at12.moving.rate)} moving`);

// Range is what turns the cone from a nuisance into a rule. Moving fire has to
// stay viable in a point-blank scramble and fail at duelling range, which is
// the shape every game the player named uses.
console.log('\n--- the cone is an angle, so range decides how much it costs ---');
const close = volley({ state: 'moving', range: 4 });
const far = volley({ state: 'moving', range: 24 });
console.log(`  moving at  4u: ${pct(close.rate)}`);
console.log(`  moving at 12u: ${pct(at12.moving.rate)}`);
console.log(`  moving at 24u: ${pct(far.rate)}`);
check('moving fire still wins a point-blank scramble', close.rate > 0.9, pct(close.rate));
check('...and loses a duel across the map', far.rate < at12.moving.rate * 0.7,
  `${pct(far.rate)} at 24u`);

// ------------------------------------------------------ counter-strafing
console.log('\n--- the quarter second that pays for itself ---');
{
  // Straight from a full-speed cone: how long until a shot is pinpoint again?
  let cone = SPREAD.moving;
  let t = 0;
  while (cone > 0 && t < 2) {
    cone = nextSpread(cone, 0, false, TICK_DT);
    t += TICK_DT;
  }
  console.log(`  full sprint to pinpoint: ${(t * 1000).toFixed(0)}ms`);
  check('stopping pays back in about the tuned settle time',
    Math.abs(t - SPREAD.settle) < 0.03, `${(t * 1000).toFixed(0)}ms vs ${SPREAD.settle * 1000}ms`);
  check('...which is a commitment, not a formality', SPREAD.settle >= 0.15,
    `${SPREAD.settle * 1000}ms`);
  check('...and not so long that nobody would ever stop', SPREAD.settle <= 0.5,
    `${SPREAD.settle * 1000}ms`);

  // Landing costs more than stopping. The airborne cone is wider and settles at
  // the same rate, so it takes longer — which is correct: being in the air is
  // the one state you cannot steer out of, and it should not be free.
  let air = SPREAD.air;
  let ta = 0;
  while (air > 0 && ta < 3) {
    air = nextSpread(air, 0, false, TICK_DT);
    ta += TICK_DT;
  }
  console.log(`  landing to pinpoint:     ${(ta * 1000).toFixed(0)}ms`);
  check('landing costs more than stopping does', ta > t, `${(ta * 1000).toFixed(0)}ms`);
}

// The cone rises the INSTANT you move, and that asymmetry is the mechanic.
// Symmetrical timing would make a shuffle as accurate as a stop, and shuffling
// is free.
console.log('\n--- it opens instantly and closes slowly ---');
{
  const opened = nextSpread(0, 1, false, TICK_DT);
  check('one tick of movement opens the cone all the way',
    opened === SPREAD.moving, deg(opened));
  const closed = nextSpread(SPREAD.moving, 0, false, TICK_DT);
  check('...and one tick of stillness closes only a fraction of it',
    closed > SPREAD.moving * 0.8, `${deg(closed)} of ${deg(SPREAD.moving)} left`);

  // Half a stick is half a cone. A player easing around a corner should pay
  // less than one sprinting past it.
  check('a gentle nudge costs less than a sprint',
    nextSpread(0, 0.5, false, TICK_DT) < nextSpread(0, 1, false, TICK_DT),
    `${deg(nextSpread(0, 0.5, false, TICK_DT))} vs ${deg(SPREAD.moving)}`);
}

// ------------------------------------------------------- what it costs
console.log('\n--- the cone in units, at the ranges fights happen at ---');
{
  const effective = PLAYER.radius + BULLET.radius;
  for (const range of [4, 8, 12, 20, 30]) {
    const move = Math.tan(SPREAD.moving) * range;
    const air = Math.tan(SPREAD.air) * range;
    console.log(`  ${String(range).padStart(2)}u: moving +/-${move.toFixed(2)}u, air +/-${air.toFixed(2)}u`
      + ` (a chicken is ${effective.toFixed(2)}u of hittable half-width)`);
  }
  check('at knife range the moving cone is inside a chicken',
    Math.tan(SPREAD.moving) * 4 < effective,
    `${(Math.tan(SPREAD.moving) * 4).toFixed(2)}u vs ${effective.toFixed(2)}u`);
  check('...and at duelling range it is wider than one',
    Math.tan(SPREAD.moving) * 12 > effective,
    `${(Math.tan(SPREAD.moving) * 12).toFixed(2)}u vs ${effective.toFixed(2)}u`);
}

// ------------------------------------------------------ a client cannot opt out
console.log('\n--- the roll happens on the authority ---');
{
  // Spread is applied inside fire(), from the world RNG, using a movement state
  // the server derived itself from the input struct. There is nothing in the
  // struct a client could set to decline it — which is the whole reason it is
  // here rather than in controls.js alongside the recoil.
  const world = createWorld({ mode: 'casual', seed: 7 });
  world.phase = 'live';
  world.time = 2;
  const me = addPlayer(world, { id: 'me', name: 'me', seat: 0 });
  me.invulnUntil = 0;
  for (let t = 0; t < 30; t++) {
    me.x = 0; me.z = 0;
    // A hand-rolled client claiming to stand perfectly still while running.
    applyInput(world, 'me', { mx: 1, mz: 0, ax: 0, az: 1, pitch: 0, spread: 0, seq: t });
    stepWorld(world, TICK_DT);
  }
  check('a client that claims to be standing still is still given the cone',
    me.spread === SPREAD.moving, deg(me.spread));
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed` : '\n✓ all checks passed');
process.exit(failures.length ? 1 : 0);
