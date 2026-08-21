// Hit detection and aim assist.
//
// Ammo and hit detection are pure simulation. Aim assist is not: it runs on the
// CLIENT, shaping the look angles before they are sent, so those checks drive
// the same pure helpers the client drives — plus one check that the server adds
// nothing of its own.
//
// The 3D section exists because "I want to shoot anywhere, not just left and
// right" was a player report. Shots used to travel flat at chest height no
// matter where the camera pointed, so pitch was decoration; a chicken was an
// infinitely tall cylinder and there was no such thing as shooting over one.
// Both halves of that changed at once, and each is a way the other can break.
//
//   node shared/test/combat.mjs

import {
  createWorld, addPlayer, applyInput, stepWorld, initBot, stepBots,
  AIM_ASSIST, PLAYER, BULLET, TICK_DT, rollPickup, PICKUP_WEIGHTS,
  pickAimTarget, pullAim, pullPitch, WALL_HEIGHT, LEVELS,
} from '../src/index.js';
import { angleDelta, segHitsCapsule } from '../src/math.js';

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

// ------------------------------------------------------- shooting in 3D
console.log('\n--- the shot goes where you are looking ---');

/**
 * Fires one shot along a given yaw and pitch and reports what it did.
 *
 * One shot, not a burst: the point of every check below is where a single
 * bullet went, and a burst would let a second round paper over the first.
 */
function shoot({ from = [0, 0, 0], at = null, pitch = 0, aim = null, seconds = 1.6 } = {}) {
  const world = arena();
  const me = add(world, 'me', 0, from[0], from[2]);
  me.y = from[1];
  const foe = at ? add(world, 'foe', 1, at[0], at[2]) : null;
  if (foe) foe.y = at[1];

  const yaw = aim ?? (foe ? Math.atan2(foe.x - me.x, foe.z - me.z) : 0);
  // `ends` are the impact points. They ride on the shot event itself now: the
  // trace resolves in the instant it is fired, so where it started and where it
  // stopped are decided together and there is nothing left to report later.
  const out = { hits: 0, ends: [], damage: 0, sameTick: null };

  for (let t = 0; t < seconds / TICK_DT; t++) {
    if (foe) { foe.hp = PLAYER.maxHp; foe.invulnUntil = 0; foe.y = at[1]; foe.vy = 0; }
    me.y = from[1];
    me.vy = 0;
    applyInput(world, 'me', {
      mx: 0, mz: 0, ax: Math.sin(yaw), az: Math.cos(yaw), pitch, shoot: t === 0, seq: t,
    });
    const events = stepWorld(world, TICK_DT);
    const fired = events.some((e) => e.type === 'shot' && e.owner === 'me');
    for (const e of events) {
      if (e.type === 'hit' && e.target === 'foe') {
        out.hits++;
        out.damage += e.amount;
        // Hitscan's defining property: the hit is in the SAME batch of events
        // as the shot that caused it.
        out.sameTick ??= fired;
      }
      if (e.type === 'shot' && e.owner === 'me') {
        out.ends.push({ x: e.hx, y: e.hy, z: e.hz, wall: e.wall, hit: e.hit, head: e.head });
      }
    }
  }
  return out;
}

// The baseline: nothing about a duel on flat ground may have changed.
const flatDuel = shoot({ at: [0, 0, 12] });
check('a level shot at someone standing in front of you still lands',
  flatDuel.hits === 1, `${flatDuel.hits} hit(s)`);

// ...and the thing that could not happen before: missing high.
const overHead = shoot({ at: [0, 0, 12], pitch: 0.35 });
console.log(`  same target, aimed 0.35rad up: ${overHead.hits} hit(s)`);
check('a shot aimed over their head misses', overHead.hits === 0, `${overHead.hits} hit(s)`);
check('...and lands somewhere else entirely', overHead.ends.length === 1,
  `${overHead.ends.length} ending(s)`);

// A jumping chicken is a target you have to lead upward. This is the exact
// case that made the feature worth doing.
const jumperFlat = shoot({ at: [0, PLAYER.maxJumpHeight, 12], pitch: 0 });
const jumperUp = shoot({ at: [0, PLAYER.maxJumpHeight, 12], pitch: 0.108 });
console.log(`  target at the top of a jump: level shot ${jumperFlat.hits}, raised shot ${jumperUp.hits}`);
check('a level shot passes under someone at the top of a jump',
  jumperFlat.hits === 0, `${jumperFlat.hits} hit(s)`);
check('raising your aim onto them hits', jumperUp.hits === 1, `${jumperUp.hits} hit(s)`);

// ...and the mirror image: shooting down from mid-air at someone on the floor.
const fromAir = shoot({ from: [0, PLAYER.maxJumpHeight, 0], at: [0, 0, 12], pitch: -0.108 });
const fromAirFlat = shoot({ from: [0, PLAYER.maxJumpHeight, 0], at: [0, 0, 12], pitch: 0 });
console.log(`  firing from the top of a jump: level ${fromAirFlat.hits}, angled down ${fromAir.hits}`);
check('aiming down from mid-jump hits the floor below you', fromAir.hits === 1,
  `${fromAir.hits} hit(s)`);

// The hitbox is the chicken you can see, not a pillar reaching to the ceiling.
console.log('\n--- the hitbox is chicken-shaped ---');
{
  const rr = PLAYER.radius + BULLET.radius;
  const across = (y) => segHitsCapsule(-3, y, 12, 3, y, 12, 0, 0, 12, PLAYER.hitHeight, rr);
  const grazes = [0.1, 0.85, 1.7].map(across);
  console.log(`  a level line at 0.1 / 0.85 / 1.7 up: ${grazes.join(', ')}`);
  check('feet, body and head are all hittable', grazes.every(Boolean), String(grazes));
  check('a line well above the comb is not a hit', !across(PLAYER.hitHeight + rr + 0.2));
  check('a line under the floor is not a hit', !across(-rr - 0.2));
  // A bullet standing still is a degenerate segment, and the closest-point
  // maths has to survive it rather than returning NaN and silently never
  // hitting anything again.
  check('a zero-length sweep still tests cleanly',
    segHitsCapsule(0, 0.85, 12, 0, 0.85, 12, 0, 0, 12, PLAYER.hitHeight, rr));
  // Exactly parallel to the spine: the shared denominator vanishes.
  check('a shot straight down someone\'s axis still tests cleanly',
    segHitsCapsule(0, 4, 12, 0, 0, 12, 0, 0, 12, PLAYER.hitHeight, rr));
}

// Where a bullet stops now that down and up are real directions.
console.log('\n--- bullets stop at the world ---');
{
  const down = shoot({ pitch: -1.2, aim: 0, seconds: 0.6 });
  const end = down.ends[0];
  console.log(`  fired into the ground: ends at y=${end?.y?.toFixed(2)}, wall=${end?.wall}`);
  check('a shot into the floor stops at the floor', end && end.y === 0 && end.wall === true,
    JSON.stringify(end && { y: +end.y.toFixed(2), wall: end.wall }));

  // Against a wall, close range: flat stops on it, steep goes over it.
  const world = arena();
  const half = world.arena.half;
  const near = half - 2;
  const flat = shoot({ from: [0, 0, near], aim: 0, pitch: 0, seconds: 1.6 });
  const steep = shoot({ from: [0, 0, near], aim: 0, pitch: 1.0, seconds: 1.6 });
  console.log(`  two units from a ${WALL_HEIGHT}u wall: flat wall=${flat.ends[0]?.wall}, steep wall=${steep.ends[0]?.wall}`);
  check('a flat shot stops on the wall', flat.ends[0]?.wall === true);
  check('a steep shot clears the parapet instead of stopping in mid-air',
    steep.ends[0]?.wall === false, JSON.stringify(steep.ends[0] && { wall: steep.ends[0].wall }));
}

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

// --- the vertical half.
//
// Assist was horizontal-only for as long as shots were. Leaving it that way
// once pitch reached the simulation would have recreated the original problem
// one axis over: a thumb that lands the yaw and misses high.
console.log('\n--- aim assist, vertically ---');

/** Runs pullPitch to convergence against a target and returns the angle. */
function settle(self, foe, frames = 60) {
  let pitch = 0;
  for (let t = 0; t < frames; t++) pitch = pullPitch(self, foe, pitch, TICK_DT);
  return pitch;
}

const meDown = { id: 'me', x: 0, y: 0, z: 0, team: null };
const standing = settle(meDown, { ...foeAt(0, 12), y: 0 });
const jumping = settle(meDown, { ...foeAt(0, 12), y: PLAYER.maxJumpHeight });
console.log(`  pitch onto a target on the floor ${standing.toFixed(3)}, mid-jump ${jumping.toFixed(3)}`);
check('assist tilts UP for a target in the air', jumping > standing + 0.05,
  `${standing.toFixed(3)} -> ${jumping.toFixed(3)}`);
check('...and roughly level for one on the floor', Math.abs(standing) < 0.06,
  standing.toFixed(3));

// Shooting downward out of a jump is the same problem upside down.
const meUp = { id: 'me', x: 0, y: PLAYER.maxJumpHeight, z: 0, team: null };
const lookDown = settle(meUp, { ...foeAt(0, 12), y: 0 });
check('assist tilts DOWN when you are the one in the air', lookDown < -0.05,
  lookDown.toFixed(3));

// The end-to-end version: an angle assist produced, fired through the real
// simulation, at a target a level shot demonstrably misses.
{
  const assisted = settle(meDown, { ...foeAt(0, 12), y: PLAYER.maxJumpHeight });
  const landed = shoot({ at: [0, PLAYER.maxJumpHeight, 12], pitch: assisted });
  console.log(`  firing the assisted angle (${assisted.toFixed(3)}rad): ${landed.hits} hit(s)`);
  check('the angle assist produces is one that actually lands', landed.hits === 1,
    `${landed.hits} hit(s)`);
}

// Bots aim in three dimensions too, or they fire over your head from arm's
// reach. Point blank on purpose: at one unit the true angle dwarfs the aim
// jitter, so this is a deterministic check on a system that is otherwise all
// Math.random.
console.log('\n--- bots look up and down ---');
{
  const botPitch = (foeY) => {
    const world = arena();
    const bot = add(world, 'bot', 0, 0, 0);
    bot.isBot = true;
    initBot(bot, 'normal');
    const foe = add(world, 'foe', 1, 0, 1);
    foe.y = foeY;
    stepBots(world, TICK_DT);
    return bot.input.pitch;
  };
  const atFeet = botPitch(0);
  const atJumper = botPitch(PLAYER.maxJumpHeight);
  console.log(`  bot pitch: ${atFeet.toFixed(3)} at a grounded foe, ${atJumper.toFixed(3)} at a jumping one`);
  check('a bot looks slightly down at someone on the floor', atFeet < 0, atFeet.toFixed(3));
  check('...and up at someone above it', atJumper > 0.5, atJumper.toFixed(3));
  check('bot pitch stays inside the legal range',
    atJumper <= PLAYER.pitchMax && atFeet >= PLAYER.pitchMin);
}

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

// ---------------------------------------------------------------- hitscan
console.log('\n--- shots resolve instantly ---');
// The reason this stopped being a projectile at all.
//
// Players arriving from CS or Valorant said shooting felt unsatisfying and could
// not say why. The answer was travel time: those games are hitscan, so a player
// trained on them never leads a target — they put the dot on it and click. Here
// a round took a couple of tenths to arrive even after the speed was raised
// twice, so every shot landed behind where they were looking and the game felt
// like it was arguing with them. Raising the speed again would not have fixed
// it, because it was never a tuning problem.
{
  const duel = shoot({ at: [0, 0, 12] });
  check('a hit lands on the same tick as the shot that caused it',
    duel.hits === 1 && duel.sameTick === true, `hits ${duel.hits}, sameTick ${duel.sameTick}`);
  check('...and the shot event carries where it landed',
    duel.ends.length === 1 && Number.isFinite(duel.ends[0].z), JSON.stringify(duel.ends[0]));
  check('...and says what it hit', duel.ends[0]?.hit === 'player', String(duel.ends[0]?.hit));

  // Nothing is left in flight afterwards, because nothing was ever in flight.
  const world = arena();
  add(world, 'me', 0, 0, 0);
  applyInput(world, 'me', { mx: 0, mz: 0, ax: 0, az: 1, shoot: true, seq: 1 });
  stepWorld(world, TICK_DT);
  check('there are no projectiles to keep track of', world.bullets === undefined,
    JSON.stringify(world.bullets));
}

// A trace has no per-tick step to tunnel through anyone, which was a real risk
// while this was a projectile: at the end it moved 0.87 units per tick against
// a 0.76-unit hit radius and would have passed clean THROUGH a chicken between
// two frames if the sweep had ever been simplified to a point test. Range is
// what bounds a trace instead, so that is what gets swept here.
{
  const world = arena();
  // Widened, because the default arena is 48 across and its walls stop a trace
  // long before its range does. Testing reach inside a box half its length
  // would measure the box.
  world.arena = { size: 140, half: 70 };
  world.safeHalf = 70;
  world.obstacles = [];

  const at = (range) => {
    const w = arena();
    w.arena = { size: 140, half: 70 };
    w.safeHalf = 70;
    w.obstacles = [];
    const me = add(w, 'me', 0, 0, 0);
    const foe = add(w, 'foe', 1, 0, range);
    let hits = 0;
    for (let t = 0; t < 0.4 / TICK_DT; t++) {
      foe.hp = PLAYER.maxHp;
      foe.invulnUntil = 0;
      applyInput(w, 'me', { mx: 0, mz: 0, ax: 0, az: 1, shoot: t === 0, seq: t });
      for (const e of stepWorld(w, TICK_DT)) if (e.type === 'hit' && e.target === 'foe') hits++;
    }
    return hits;
  };

  const inside = [2, 3.5, 6, 12, 22, 34, BULLET.range - 2].map((r) => `${r}u:${at(r)}`);
  console.log(`  point blank to the edge of its reach — ${inside.join(' ')}`);
  check('a level shot connects at every range inside its reach',
    inside.every((r) => r.endsWith(':1')), inside.join(' '));

  const beyond = at(BULLET.range + 6);
  console.log(`  ${(BULLET.range + 6).toFixed(0)}u, past a ${BULLET.range}u reach: ${beyond} hits`);
  check('...and stops at the end of it', beyond === 0, `${beyond} hits`);
}

// -------------------------------------------------------------- headshots
console.log('\nHEADSHOTS');
// The skill expression hitscan needed. With every shot doing the same damage
// wherever it lands, aiming carefully and aiming vaguely pay identically — which
// is half of why shooting felt flat to anyone arriving from CS or Valorant.
//
// The subtle part is WHERE the line goes, and the first attempt got it exactly
// backwards. Two chickens stand at the same height, so a shot fired dead level
// leaves one eye at 1.15 and arrives at the other at 1.15. Put the head line
// below that and every flat shot is a free headshot: no skill, a two-round
// time-to-kill, and aim assist — which pulls BELOW the line — quietly making
// your shots worse. It has to sit above eye height so the head is a thing you
// aim at.
{
  check('the head line sits above eye height, or level shots are free heads',
    BULLET.headFrom > PLAYER.eyeHeight,
    `head ${BULLET.headFrom} vs eye ${PLAYER.eyeHeight}`);
  check('...and below the top of the hitbox, or it is unreachable',
    BULLET.headFrom < PLAYER.hitHeight, `${BULLET.headFrom} vs ${PLAYER.hitHeight}`);
  // Measured in SHOTS TO KILL rather than as a damage ratio, because that is
  // what a player actually experiences and it is what survives body damage
  // being retuned. Half the shots is the floor: below that, going for the head
  // is a small bonus rather than the decision the fight turns on.
  const bodyShots = Math.ceil(PLAYER.maxHp / BULLET.damage);
  const headShots = Math.ceil(PLAYER.maxHp / BULLET.headDamage);
  check('a headshot kills in at most half the shots of a body shot',
    headShots * 2 <= bodyShots, `${bodyShots} body vs ${headShots} head`);
  check('...but never in one, which would make whiffing the only outcome that matters',
    headShots >= 2, `${headShots} head shot(s)`);

  const level = shoot({ at: [0, 0, 12], pitch: 0 });
  console.log(`  level shot at 12u: ${level.damage} damage, head=${level.ends[0]?.head}`);
  check('a level shot hits the body, not the head', level.damage === BULLET.damage,
    `${level.damage} damage`);

  // Nudged up by the angle the constant implies. This is the crosshair
  // placement the whole feature exists to reward.
  const up = Math.atan2(BULLET.headFrom + 0.18 - PLAYER.eyeHeight, 12);
  const head = shoot({ at: [0, 0, 12], pitch: up });
  console.log(`  aimed ${(up * 180 / Math.PI).toFixed(2)} degrees higher: ${head.damage} damage, head=${head.ends[0]?.head}`);
  check('aiming a fraction higher hits the head', head.damage === BULLET.headDamage,
    `${head.damage} damage`);
  check('...and the shot event says so', head.ends[0]?.head === true, String(head.ends[0]?.head));

  // Two heads kill; ten bodies do. The gap is the point.
  check('two headshots are lethal', BULLET.headDamage * 2 >= PLAYER.maxHp,
    `${BULLET.headDamage * 2} vs ${PLAYER.maxHp}hp`);
  check('...but one is not, so it is never a one-shot game',
    BULLET.headDamage < PLAYER.maxHp, String(BULLET.headDamage));

  // Aim assist must NOT hand them out — it exists so a thumb can land body
  // shots, not so it can play the skill part of the game for you.
  const assistAt = PLAYER.hitHeight * AIM_ASSIST.aimHeight;
  console.log(`  aim assist pulls to ${assistAt.toFixed(2)}, head line at ${BULLET.headFrom}`);
  check('aim assist aims at the body, never the head', assistAt < BULLET.headFrom,
    `${assistAt.toFixed(2)} vs ${BULLET.headFrom}`);
}

// ---------------------------------------------------------------- tagging
console.log('\n--- being shot slows you, it does not shove you ---');
{
  const world = arena();
  const me = add(world, 'me', 0, 0, 0);
  const foe = add(world, 'foe', 1, 0, 12);
  const startX = foe.x;
  const startZ = foe.z;

  applyInput(world, 'me', { mx: 0, mz: 0, ax: 0, az: 1, shoot: true, seq: 1 });
  stepWorld(world, TICK_DT);
  console.log(`  after a hit: knockback (${foe.kx.toFixed(2)}, ${foe.kz.toFixed(2)}), tagged for ${(foe.taggedUntil - world.time).toFixed(2)}s`);
  check('a bullet applies no knockback at all', foe.kx === 0 && foe.kz === 0,
    `(${foe.kx}, ${foe.kz})`);
  check('...it tags you instead', foe.taggedUntil > world.time,
    `${(foe.taggedUntil - world.time).toFixed(2)}s`);

  // The distinction that matters: a tagged chicken is slower, but it is still
  // going exactly where its player pointed it. Knockback moved you against your
  // input; this cannot.
  const runFor = (tagged) => {
    const w = arena();
    const p = add(w, 'me', 0, 0, 0);
    if (tagged) p.taggedUntil = w.time + 99;
    for (let t = 0; t < 0.5 / TICK_DT; t++) {
      p.hp = PLAYER.maxHp;
      if (tagged) p.taggedUntil = w.time + 99;
      applyInput(w, 'me', { mx: 1, mz: 0, seq: t });
      stepWorld(w, TICK_DT);
    }
    return p.x;
  };
  const free = runFor(false);
  const slow = runFor(true);
  console.log(`  half a second of running: ${free.toFixed(2)}u free, ${slow.toFixed(2)}u tagged`);
  check('tagging really does slow you', slow < free * 0.85, `${free.toFixed(2)} -> ${slow.toFixed(2)}`);
  check('...but you still go where you pointed', slow > 0, `${slow.toFixed(2)}u`);
  void startX; void startZ;
}

// ------------------------------------------------------ the fire rate floor
console.log('\n--- stacked fire-rate multipliers ---');
// The ammo types are gone; power comes from the ladder now. What replaced them
// can stack in a way ammo never could — Rapid Peck, Feeding Frenzy and TRIGGER
// HAPPY all multiply the same cooldown — so the floor that used to belong to
// the rapid-fire pickup is doing more work than it was.
{
  const world = arena({ modifier: 'trigger' });
  const me = add(world, 'me', 0, 0, 0);
  add(world, 'foe', 1, 0, 12);
  me.level = LEVELS.max;                 // Rapid Peck AND Feeding Frenzy
  me.frenzyUntil = world.time + 99;
  me.crop = 9999;

  let shots = 0;
  for (let t = 0; t < 1 / TICK_DT; t++) {
    me.crop = 9999;
    me.dry = false;
    applyInput(world, 'me', { mx: 0, mz: 0, ax: 0, az: 1, shoot: true, seq: t });
    for (const e of stepWorld(world, TICK_DT)) if (e.type === 'shot') shots++;
  }
  const gap = 1 / shots;
  console.log(`  top rung + frenzy + TRIGGER HAPPY: ${shots} shots/s, ${(gap * 1000).toFixed(0)}ms apart`);
  check('three stacked multipliers cannot outrun the cooldown floor',
    gap >= PLAYER.minCooldown - 1e-6, `${(gap * 1000).toFixed(1)}ms vs a ${PLAYER.minCooldown * 1000}ms floor`);
  // ...and it is still meaningfully faster than nothing, or the floor has eaten
  // the perk rather than bounded it.
  check('...but it is still much faster than a plain shot',
    gap < PLAYER.fireCooldown * 0.75, `${(gap * 1000).toFixed(1)}ms vs ${PLAYER.fireCooldown * 1000}ms`);
}

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

// Health is now the only thing on the floor — power comes from the pecking
// order instead. Kept as a check rather than deleted: the weighted roll still
// has to work, and a table that silently returns undefined would spawn pickups
// nobody can collect.
{
  const world = arena();
  const p = add(world, 'me', 0, 0, 0);
  p.hp = 40;
  world.pickups = [{ id: 1, type: 'health', x: 0, z: 0 }];
  stepWorld(world, TICK_DT);
  check('a health pickup still heals', p.hp > 40, `${p.hp}hp`);
  check('nothing on the table is a shooting power-up',
    PICKUP_WEIGHTS.every(([k]) => k === 'health'),
    PICKUP_WEIGHTS.map(([k]) => k).join(', '));
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
