// Cover: the boxes in the middle of the map.
//
// The arenas were empty squares, and players said so — with nothing to break a
// sightline, whoever aimed first won and there was nothing anyone could do
// about it. Cover is the fix, and it touches almost everything: bodies collide
// with it, bullets stop on it, bots have to not grind against it, and nothing
// may spawn inside it.
//
// Two invariants carry most of the weight, and both are the kind that fail
// silently rather than loudly:
//
//   1. Nothing is short enough to jump on top of. Cover is a purely horizontal
//      problem only while that holds; the moment a box is landable the sim
//      needs ground-height tracking it does not have, and a player who lands on
//      one gets sealed inside it on the way down.
//   2. Every map is mirror-symmetric with clear cardinal lanes. That is what
//      keeps `test:control`'s directional-bias proof meaningful — it walks from
//      the centre along each axis, and a box in the way would make an unfair
//      map look like a movement bug.
//
//   node shared/test/cover.mjs

import {
  createWorld, addPlayer, applyInput, stepWorld, beginMatch, spotIsClear,
  MAPS, MAP_LIST, COVER, PLAYER, BULLET, TICK_DT, coverFor, MODE_LIST, MODES,
} from '../src/index.js';
import { segBoxEntry, pushOutBox } from '../src/math.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

// ------------------------------------------------------------- the layouts
console.log('\n--- every map is fair by construction ---');
for (const id of MAP_LIST) {
  const map = MAPS[id];
  const boxes = coverFor(id, map.size);
  const half = map.size / 2;

  check(`${id}: has cover at all`, boxes.length > 0, `${boxes.length} boxes`);

  // 1. Nothing landable. This is the invariant that keeps the whole feature
  // two-dimensional, so it is checked on every box of every map.
  const shortest = Math.min(...boxes.map((b) => b.h));
  check(`${id}: nothing is short enough to land on`,
    shortest > PLAYER.maxJumpHeight && shortest >= COVER.minHeight,
    `shortest ${shortest} vs a ${PLAYER.maxJumpHeight} jump`);

  // 2. Mirror symmetry. Every box must have a partner in each reflection, or
  // one seat is fighting a different map from the others.
  const key = (b) => `${b.x.toFixed(3)}|${b.z.toFixed(3)}|${b.w.toFixed(3)}|${b.d.toFixed(3)}|${b.h}`;
  const set = new Set(boxes.map(key));
  const mirrored = boxes.every((b) => (
    set.has(key({ ...b, x: -b.x })) && set.has(key({ ...b, z: -b.z }))
    && set.has(key({ ...b, x: -b.x, z: -b.z }))
  ));
  check(`${id}: the layout is mirror-symmetric on both axes`, mirrored);

  // 3. Clear cardinal lanes — see the header.
  const lane = PLAYER.radius + COVER.axisLane;
  const blocksAxis = boxes.some((b) => (
    Math.abs(b.z) - b.d / 2 < lane || Math.abs(b.x) - b.w / 2 < lane
  ));
  check(`${id}: the cardinal lanes through the middle are clear`, !blocksAxis);

  // 4. Inside the walls, and off the spawn corners — a spawn inside a box is a
  // player who starts the match stuck.
  const outside = boxes.filter((b) => (
    Math.abs(b.x) + b.w / 2 > half - 1 || Math.abs(b.z) + b.d / 2 > half - 1
  ));
  check(`${id}: nothing overlaps the arena wall`, outside.length === 0, `${outside.length} do`);

  const corner = half - 3.5;
  const onSpawn = [[corner, corner], [-corner, corner], [corner, -corner], [-corner, -corner]]
    .some(([x, z]) => boxes.some((b) => (
      Math.abs(x - b.x) < b.w / 2 + PLAYER.radius + 1.6
      && Math.abs(z - b.z) < b.d / 2 + PLAYER.radius + 1.6
    )));
  check(`${id}: the spawn corners are clear`, !onSpawn);
}

// Cover has to scale with the arena, or a duel on a shrunken map is four boxes
// huddled in the middle of an otherwise empty floor.
console.log('\n--- cover scales with the arena ---');
{
  const full = coverFor('yard', MAPS.yard.size);
  const duel = coverFor('yard', MAPS.yard.size * 0.68);
  check('a shrunken arena shrinks its cover',
    Math.abs(duel[0].x / full[0].x - 0.68) < 1e-9, `${(duel[0].x / full[0].x).toFixed(3)}x`);
  check('...but the heights do not, because the jump does not',
    duel.every((b, i) => b.h === full[i].h));
  check('the scaled layout is still off the axes',
    duel.every((b) => Math.abs(b.z) - b.d / 2 > PLAYER.radius),
    'a scaled box crossed the lane');
}

// --------------------------------------------------------------- collision
console.log('\n--- you cannot walk through it ---');

function arena(map = 'coop', mode = 'casual') {
  const w = createWorld({ mode, seed: 11 });
  const p = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  beginMatch(w, map);
  for (let t = 0; t < 200 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  return { w, p };
}

{
  const { w, p } = arena();
  const box = w.obstacles[0];
  // Line the player up and walk straight at the middle of a box.
  p.x = box.x;
  p.z = box.z - box.d / 2 - 4;
  p.y = 0;
  const startZ = p.z;
  for (let t = 0; t < 2 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    applyInput(w, 'a', { mx: 0, mz: 1, seq: t });
    stepWorld(w, TICK_DT);
  }
  const face = box.z - box.d / 2 - PLAYER.radius;
  console.log(`  walked from ${startZ.toFixed(2)} into a box face at ${face.toFixed(2)}, stopped at ${p.z.toFixed(2)}`);
  check('walking into cover stops you', p.z <= face + 1e-6, `${p.z.toFixed(3)} vs ${face.toFixed(3)}`);
  check('...and you did actually get there', p.z > startZ + 2, `${p.z.toFixed(2)}`);

  // Sliding: pushed diagonally into a face, you should travel along it rather
  // than stick. A body that stuck on cover would make every corner a trap.
  const slidFrom = p.x;
  for (let t = 0; t < 1 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    applyInput(w, 'a', { mx: 1, mz: 1, seq: 100 + t });
    stepWorld(w, TICK_DT);
  }
  console.log(`  pressed into the face, slid ${(p.x - slidFrom).toFixed(2)}u along it`);
  check('you slide along cover instead of sticking to it', p.x - slidFrom > 2,
    `${(p.x - slidFrom).toFixed(2)}u`);
}

// Nothing can end a tick inside a box, whatever it was doing.
{
  const { w, p } = arena();
  let inside = 0;
  for (let t = 0; t < 12 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    // A deliberately awkward spiral through the whole cover field.
    const a = t * TICK_DT * 2.4;
    applyInput(w, 'a', { mx: Math.sin(a), mz: Math.cos(a * 1.3), jump: t % 90 === 0, seq: t });
    stepWorld(w, TICK_DT);
    for (const box of w.obstacles) {
      if (p.y >= box.h) continue;
      if (pushOutBox(p.x, p.z, PLAYER.radius * 0.98, box)) inside++;
    }
  }
  check('a body never ends a tick inside cover', inside === 0, `${inside} ticks overlapping`);
}

// Jumping does NOT put you on top of anything — invariant 1, from the other end.
{
  const { w, p } = arena();
  const box = w.obstacles[0];
  let landedOn = 0;
  p.x = box.x;
  p.z = box.z - box.d / 2 - 2;
  for (let t = 0; t < 6 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    applyInput(w, 'a', { mx: 0, mz: 1, jump: true, seq: t });
    stepWorld(w, TICK_DT);
    const over = Math.abs(p.x - box.x) < box.w / 2 && Math.abs(p.z - box.z) < box.d / 2;
    if (over) landedOn++;
  }
  check('jumping never lands you on top of cover', landedOn === 0,
    `${landedOn} ticks stood on a box`);
}

// ----------------------------------------------------------------- bullets
console.log('\n--- it stops bullets ---');

/** Fires one shot from `from` toward `to` and reports what happened. */
function shoot(w, shooter, target, { pitch = 0 } = {}) {
  const yaw = Math.atan2(target.x - shooter.x, target.z - shooter.z);
  const out = { hits: 0, ends: [] };
  for (let t = 0; t < 2 / TICK_DT; t++) {
    if (target.hp !== undefined) { target.hp = PLAYER.maxHp; target.invulnUntil = 0; }
    applyInput(w, shooter.id, {
      mx: 0, mz: 0, ax: Math.sin(yaw), az: Math.cos(yaw), pitch, shoot: t === 0, seq: t,
    });
    for (const e of stepWorld(w, TICK_DT)) {
      if (e.type === 'hit' && e.target === target.id) out.hits++;
      if (e.type === 'bulletEnd') out.ends.push(e);
    }
  }
  return out;
}

{
  const w = createWorld({ mode: 'casual', seed: 12 });
  const me = addPlayer(w, { id: 'me', name: 'me', seat: 0 });
  const foe = addPlayer(w, { id: 'foe', name: 'foe', seat: 1 });
  beginMatch(w, 'coop');
  for (let t = 0; t < 200 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);

  // A tall box, with the two of us lined up either side of it.
  const box = w.obstacles.find((b) => b.h >= COVER.high);
  me.x = box.x; me.z = box.z - box.d / 2 - 6; me.invulnUntil = 0;
  foe.x = box.x; foe.z = box.z + box.d / 2 + 6; foe.invulnUntil = 0;
  const blocked = shoot(w, me, foe);
  console.log(`  through a ${box.h}u box: ${blocked.hits} hits`);
  check('cover stops a shot that would otherwise land', blocked.hits === 0,
    `${blocked.hits} hits`);
  check('...and the bullet dies at the box, not past it',
    blocked.ends.length === 1 && Math.abs(blocked.ends[0].z - (box.z - box.d / 2)) < BULLET.radius + 0.3,
    JSON.stringify(blocked.ends[0] && { z: +blocked.ends[0].z.toFixed(2), wall: blocked.ends[0].wall }));

  // Step aside and the same shot lands, so the miss above was the box and not
  // some other thing quietly breaking.
  me.x = box.x + box.w / 2 + 3;
  foe.x = me.x;
  const clearShot = shoot(w, me, foe);
  check('the same shot lands with the box out of the way', clearShot.hits === 1,
    `${clearShot.hits} hits`);
}

// Low cover is a thing you shoot OVER, which is the one place jumping is
// tactical rather than decorative.
//
// Driven against a purpose-built box rather than whichever low piece a map
// happens to have, because the answer depends on the geometry: a 9-unit-deep
// wall needs a much flatter shot to clear than a 2-unit one, and picking a real
// box would be testing that map's proportions instead of the mechanic.
//
// Swept across pitches rather than fired at one, because "can you hit them from
// here" is the actual claim. A single angle would only prove something about
// that angle.
{
  const w = createWorld({ mode: 'casual', seed: 13 });
  const me = addPlayer(w, { id: 'me', name: 'me', seat: 0 });
  const foe = addPlayer(w, { id: 'foe', name: 'foe', seat: 1 });
  beginMatch(w, 'coop');
  for (let t = 0; t < 200 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);

  w.obstacles = [{ x: 0, z: 0, w: 2, d: 2, h: COVER.low }];
  const pitches = [-0.3, -0.24, -0.18, -0.12, -0.08, -0.04, 0, 0.04];
  const landed = (y) => {
    let best = 0;
    for (const pitch of pitches) {
      me.x = 0; me.z = -6; me.y = y; me.invulnUntil = 0;
      foe.x = 0; foe.z = 6; foe.y = 0; foe.invulnUntil = 0;
      best = Math.max(best, shoot(w, me, foe, { pitch }).hits);
    }
    return best;
  };

  const onFoot = landed(0);
  const midJump = landed(PLAYER.maxJumpHeight);
  me.y = 0;
  console.log(`  over ${COVER.low}u cover, best of ${pitches.length} angles: ${onFoot} standing, ${midJump} mid-jump`);
  check('low cover blocks you on foot, at every angle', onFoot === 0, `${onFoot}`);
  check('...but a jump clears it', midJump > 0, `${midJump}`);
}

// ------------------------------------------------------------------ spawns
console.log('\n--- nothing spawns inside a wall ---');
for (const map of MAP_LIST) {
  const { w, p } = arena(map);
  let bad = 0;
  // Long enough for pickups to cycle several times.
  for (let t = 0; t < 90 / TICK_DT; t++) {
    p.hp = PLAYER.maxHp;
    applyInput(w, 'a', { mx: 0, mz: 0, seq: t });
    stepWorld(w, TICK_DT);
    for (const pk of w.pickups) if (!spotIsClear(w, pk.x, pk.z)) bad++;
    if (w.bomber?.alive && !spotIsClear(w, w.bomber.x, w.bomber.z)) bad++;
  }
  check(`${map}: no pickup or bomber ends up inside cover`, bad === 0, `${bad} tick-instances`);
}

// Respawn corners, in every mode — the arena size changes per mode, so the
// cover moves with it and a corner that is clear on one may not be on another.
console.log('\n--- respawns are clear ---');
for (const mode of MODE_LIST) {
  const w = createWorld({ mode, seed: 5 });
  const p = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, MODES[mode].heist ? 'coop' : 'yard');
  for (let t = 0; t < 200 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  let bad = 0;
  for (let i = 0; i < 12; i++) {
    p.alive = false;
    p.respawnAt = 0;
    p.hp = 0;
    stepWorld(w, TICK_DT);
    if (p.alive && !spotIsClear(w, p.x, p.z, PLAYER.radius * 0.9)) bad++;
  }
  check(`${mode}: never respawns you inside cover`, bad === 0, `${bad} of 12`);
}

// --------------------------------------------------------------------- bots
console.log('\n--- bots cope with it ---');
{
  // Driven, not hoped for: a bot is walked straight at a box and has to end up
  // somewhere other than pressed against the middle of it. Bots use global
  // Math.random, so this asserts "got around" rather than "took route X".
  const { w } = arena('coop');
  const bot = addPlayer(w, { id: 'bot', name: 'Bot', seat: 2, isBot: true });
  const bait = addPlayer(w, { id: 'bait', name: 'Bait', seat: 3 });
  const box = w.obstacles.find((b) => b.h >= COVER.high);
  // Bot on one side, the thing it wants on the other. The direct line is solid.
  //
  // The bait is deliberately NOT made invulnerable to stop it retaliating —
  // nearestFoe skips invulnerable chickens, so spawn protection would hide it
  // from the bot completely and this would end up testing a bot with nothing to
  // do. It has no input, so it never shoots anyway.
  bot.x = box.x; bot.z = box.z - box.d / 2 - 5;
  bait.x = box.x; bait.z = box.z + box.d / 2 + 5;
  bait.invulnUntil = 0;

  const { stepBots, steerAroundCover, initBot } = await import('../src/bots.js');

  // The steering is checked directly rather than by watching a bot walk.
  // Running a bot match and measuring where it ended up is a coin flip — bots
  // draw from global Math.random for jitter, strafe and swerve — and this file
  // says elsewhere not to take a bot outcome as evidence. The function is pure
  // given a world and a heading, so it can simply be asked.
  initBot(bot, 'normal');
  bot.y = 0;

  // One box, at the origin, for the steering questions. A real map is mirrored
  // cover in every direction — "away from this box" is not a clear heading on
  // one, it is a heading toward its reflection — so a map layout would make
  // these checks about coop rather than about the steering.
  const mapCover = w.obstacles;
  w.obstacles = [{ x: 0, z: 0, w: 5, d: 5, h: COVER.high }];
  const only = w.obstacles[0];

  bot.x = 0; bot.z = -only.d / 2 - 4;
  const [sx, sz] = steerAroundCover(w, bot, 0, 1); // straight at it
  const turn = Math.abs(sx) / Math.hypot(sx, sz);
  console.log(`  heading into a box, steering came out (${sx.toFixed(2)}, ${sz.toFixed(2)})`);
  check('a bot heading into cover is steered sideways', turn > 0.4,
    `${(turn * 100).toFixed(0)}% of the move is now lateral`);

  // ...and left alone when there is nothing in the way, or bots would swerve
  // around open ground for no reason.
  const [cx, cz] = steerAroundCover(w, bot, 0, -1); // away from it
  check('a clear heading is passed through untouched',
    Math.abs(cx) < 1e-9 && Math.abs(cz + 1) < 1e-9, `(${cx}, ${cz})`);

  // It should take the SHORT way round: offset to one side of the box, the
  // steer must continue to that side rather than cutting back across the face.
  bot.x = only.w / 2 - 0.5; bot.z = -only.d / 2 - 3;
  const [rx] = steerAroundCover(w, bot, 0, 1);
  bot.x = -only.w / 2 + 0.5;
  const [lx] = steerAroundCover(w, bot, 0, 1);
  console.log(`  offset right it steers ${rx.toFixed(2)}, offset left ${lx.toFixed(2)}`);
  check('it goes round the near side, not across the box', rx > 0 && lx < 0,
    `right=${rx.toFixed(2)} left=${lx.toFixed(2)}`);

  // Above it, there is nothing to go around.
  bot.x = 0; bot.z = -only.d / 2 - 4; bot.y = only.h + 0.1;
  const [ax, az] = steerAroundCover(w, bot, 0, 1);
  check('cover you are already above is not steered around',
    Math.abs(ax) < 1e-9 && Math.abs(az - 1) < 1e-9, `(${ax}, ${az})`);
  bot.y = 0;

  w.obstacles = mapCover;

  // And the whole loop, once, purely to confirm nothing ends up embedded.
  for (let t = 0; t < 6 / TICK_DT; t++) {
    bot.hp = PLAYER.maxHp;
    bait.hp = PLAYER.maxHp;
    bait.invulnUntil = 0;
    bait.x = box.x; bait.z = box.z + box.d / 2 + 5;
    stepBots(w, TICK_DT);
    stepWorld(w, TICK_DT);
    if (!spotIsClear(w, bot.x, bot.z, PLAYER.radius * 0.9)) break;
  }
  check('a bot walking about never ends up inside cover',
    spotIsClear(w, bot.x, bot.z, PLAYER.radius * 0.9), `(${bot.x.toFixed(1)}, ${bot.z.toFixed(1)})`);
}

// A bot must not empty its magazine into a wall.
{
  const w = createWorld({ mode: 'casual', seed: 17 });
  const bot = addPlayer(w, { id: 'bot', name: 'Bot', seat: 0, isBot: true });
  const foe = addPlayer(w, { id: 'foe', name: 'Foe', seat: 1 });
  beginMatch(w, 'coop');
  for (let t = 0; t < 200 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  const box = w.obstacles.find((b) => b.h >= COVER.high);
  const { stepBots } = await import('../src/bots.js');

  const shotsWith = (hidden) => {
    bot.x = box.x; bot.z = box.z - box.d / 2 - 5;
    foe.x = hidden ? box.x : box.x + box.w / 2 + 4;
    foe.z = hidden ? box.z + box.d / 2 + 5 : bot.z;
    foe.invulnUntil = 0;
    let shots = 0;
    for (let t = 0; t < 3 / TICK_DT; t++) {
      bot.hp = PLAYER.maxHp;
      foe.hp = PLAYER.maxHp;
      foe.invulnUntil = 0;
      // Pin both: this is about the decision to fire, not about the chase.
      bot.x = box.x; bot.z = box.z - box.d / 2 - 5;
      foe.x = hidden ? box.x : box.x + box.w / 2 + 4;
      foe.z = hidden ? box.z + box.d / 2 + 5 : bot.z;
      stepBots(w, TICK_DT);
      for (const e of stepWorld(w, TICK_DT)) if (e.type === 'shot') shots++;
    }
    return shots;
  };

  const atWall = shotsWith(true);
  const inSight = shotsWith(false);
  console.log(`  bot fired ${atWall} shots at a hidden target, ${inSight} at a visible one`);
  check('a bot holds fire when cover is in the way', atWall === 0, `${atWall} shots`);
  check('...and still shoots when it can see you', inSight > 0, `${inSight} shots`);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
