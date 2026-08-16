// In-game objectives test: contracts, Egg Heist, Plant & Defuse, the rotating
// hill, and Hot Potato.
//
// These are the systems that give a match something to do besides shoot, so
// each one is driven directly rather than left to a bot match — bots use global
// Math.random for aim jitter, which makes bot outcomes chance, not evidence.
//
//   node shared/test/tasks.mjs

import {
  createWorld, addPlayer, stepWorld, beginMatch, contractInfo, snapshot, damagePlayer,
  TICK_DT, CONTRACT, CONTRACTS, CONTRACT_LIST, HEIST, BOMB, HILL, POTATO, PLAYER,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

/** Steps the world for `seconds`, running `each(t)` before every tick. */
function run(world, seconds, each = () => {}) {
  const seen = [];
  for (let t = 0; t < seconds / TICK_DT && world.phase !== 'over'; t++) {
    each(world.time);
    for (const e of stepWorld(world, TICK_DT)) seen.push(e);
  }
  return seen;
}

/**
 * Burns off the warmup countdown.
 *
 * Objectives only tick during `live`, so a test that just steps for N seconds
 * after beginMatch is really testing N-minus-warmup seconds — which quietly
 * shortens every timing assertion below.
 */
function toLive(world, each = () => {}) {
  const seen = [];
  for (let t = 0; t < 10 / TICK_DT && world.phase !== 'live'; t++) {
    each(world.time);
    for (const e of stepWorld(world, TICK_DT)) seen.push(e);
  }
  // The tick that flips to `live` also runs a full simulation step, so events
  // fired on the opening whistle land here rather than in the caller's loop.
  return seen;
}

const countOf = (events, type) => events.filter((e) => e.type === type).length;
const firstOf = (events, type) => events.find((e) => e.type === type);

/**
 * Kills a player through the real damage path.
 *
 * Setting hp to 0 by hand is not a death — it skips killPlayer entirely, so no
 * kill event fires, nothing is dropped, and the corpse respawns on the next
 * tick because respawnAt is still zero.
 */
function kill(world, victim, byId) {
  damagePlayer(world, victim, PLAYER.maxHp * 10, byId, 'shot');
  return world.events;
}

// --------------------------------------------------------------- contracts

console.log('\n--- contracts ---');
{
  const w = createWorld({ mode: 'casual', seed: 11 });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');

  const events = toLive(w).concat(run(w, CONTRACT.gap + 1, () => { a.hp = PLAYER.maxHp; }));
  const assigned = firstOf(events, 'contractNew');
  console.log('  first contract:', assigned && `${assigned.contract} "${assigned.label}"`);

  check('everyone gets a contract shortly after the whistle', !!assigned, String(assigned?.contract));
  check('the contract is one we defined', !!CONTRACTS[a.contract], String(a.contract));
  check('the assignment carries a human-readable label',
    typeof assigned?.label === 'string' && assigned.label.length > 3, assigned?.label);
  check('every player got one, not just the first',
    [...w.players.values()].every((p) => p.contract),
    [...w.players.values()].map((p) => `${p.name}=${p.contract}`).join(' '));

  // The HUD reads this, so it has to be complete.
  const info = contractInfo(a);
  console.log('  hud info:', JSON.stringify(info));
  check('the HUD gets label, progress, target and a countdown',
    info && info.label && info.target > 0 && info.secondsLeft > 0 && info.progress <= info.target,
    JSON.stringify(info));
  check('contracts ride along in the snapshot',
    !!snapshot(w).players.find((p) => p.id === 'a').contract);

  // Completing one pays out.
  //
  // The kills have to happen *inside* a tick. stepWorld clears world.events at
  // the top of every tick, so a kill staged between ticks is invisible to the
  // contract layer — which means A genuinely has to shoot B.
  const scoreBefore = a.score;
  a.contract = 'doubleKill';
  a.contractProgress = 0;
  a.contractAt = CONTRACT.duration;
  const b = w.players.get('b');
  const done = run(w, 20, () => {
    a.x = 0; a.z = 0; a.hp = PLAYER.maxHp;
    a.input = { ...a.input, mx: 0, mz: 0, ax: 0, az: 1, shoot: true }; // facing +z
    if (b.alive) { b.x = 0; b.z = 4; b.hp = 20; b.invulnUntil = 0; }  // in the line of fire
  });
  const paid = firstOf(done, 'contractDone');
  console.log(`  real kills landed: ${countOf(done, 'kill')}`);
  console.log('  completion:', paid && `${paid.contract} +${paid.reward}`);
  check('finishing a contract emits a completion', !!paid, String(paid?.contract));
  check('finishing a contract pays score', a.score >= scoreBefore + CONTRACT.reward,
    `${scoreBefore} -> ${a.score}`);
  check('the completion is counted', a.contractsDone >= 1, String(a.contractsDone));

  // ...and a fresh one arrives after the gap, never the same one twice running.
  // It has to be read out of the same run: that loop keeps going after the
  // completion, so the replacement has already been handed out by now.
  const doneAt = done.indexOf(paid);
  const next = firstOf(done.slice(doneAt + 1), 'contractNew');
  console.log('  next contract:', next?.contract);
  check('a new contract follows', !!next, String(next?.contract));
  check('it is never the same one twice in a row', next?.contract !== 'doubleKill', next?.contract);
}

{
  // Running out of time fails it rather than leaving it stuck on screen.
  const w = createWorld({ mode: 'casual', seed: 12 });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  beginMatch(w, 'coop');
  toLive(w);
  run(w, CONTRACT.gap + 1);
  a.contract = 'doubleKill';
  a.contractProgress = 0;
  a.contractAt = 0.5;
  const failed = firstOf(run(w, 2), 'contractFailed');
  check('an unfinished contract expires instead of hanging around', !!failed, String(failed?.contract));
  check('expiry does not pay out', a.contractsDone === 0, String(a.contractsDone));
}

{
  // Timed contracts must reset when the run is broken, or "survive 25s" would
  // complete itself across a dozen deaths.
  const w = createWorld({ mode: 'casual', seed: 13 });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  toLive(w);
  run(w, CONTRACT.gap + 1, () => { a.hp = PLAYER.maxHp; });
  a.contract = 'survivor';
  a.contractProgress = 0;
  a.contractAt = CONTRACT.duration;
  run(w, 5, () => { a.hp = PLAYER.maxHp; });
  const banked = a.contractProgress;
  kill(w, a, 'b');
  run(w, 1);
  console.log(`  survivor progress: ${banked.toFixed(1)}s alive -> ${a.contractProgress.toFixed(1)}s after dying`);
  check('a timed contract accumulates while you live', banked > 4, `${banked.toFixed(1)}s`);
  check('dying resets the streak', a.contractProgress === 0, `${a.contractProgress.toFixed(1)}s`);
}

check('every contract in the list is defined and scoreable',
  CONTRACT_LIST.every((id) => CONTRACTS[id]
    && (CONTRACTS[id].onEvent || CONTRACTS[id].onTick) && CONTRACTS[id].target > 0),
  `${CONTRACT_LIST.length} contracts`);

// -------------------------------------------------------------- egg heist

console.log('\n--- Egg Heist ---');
{
  const w = createWorld({ mode: 'heist', seed: 21 });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  toLive(w);

  const home = w.nests.find((n) => n.seat === 0);
  const rival = w.nests.find((n) => n.seat === 1);
  console.log('  nests:', w.nests.map((n) => `s${n.seat}(${n.x.toFixed(0)},${n.z.toFixed(0)})=${n.eggs}`).join(' '));
  check('every seat gets a nest on its spawn corner', w.nests.length === 4);
  check('nests start full', w.nests.every((n) => n.eggs === HEIST.eggsPerNest), String(HEIST.eggsPerNest));

  // Park A on the rival nest and steal.
  const stealEvents = run(w, 3, () => { a.x = rival.x; a.z = rival.z; a.hp = PLAYER.maxHp; });
  const steals = countOf(stealEvents, 'eggSteal');
  console.log(`  after 3s on their nest: stole ${steals}, carrying ${a.carrying}, their nest ${rival.eggs}`);
  check('standing on a rival nest steals eggs', a.carrying > 0, `carrying ${a.carrying}`);
  check('stolen eggs leave the rival nest', rival.eggs === HEIST.eggsPerNest - a.carrying,
    `${rival.eggs} left, ${a.carrying} carried`);
  check('the cooldown stops a nest being emptied instantly',
    steals <= Math.ceil(3 / HEIST.stealCooldown), `${steals} steals in 3s`);

  // Carrying should slow you down — that is the whole balance of the mode.
  const load = a.carrying;
  a.x = 0; a.z = 0;
  a.input = { ...a.input, mx: 1, mz: 0, ax: 0, az: 0, shoot: false };
  run(w, 0.5, () => { a.hp = PLAYER.maxHp; });
  const laden = a.x;
  a.carrying = 0;
  a.x = 0;
  run(w, 0.5, () => { a.hp = PLAYER.maxHp; });
  console.log(`  0.5s of running: ${laden.toFixed(2)} carrying ${load}, ${a.x.toFixed(2)} empty-handed`);
  check('carrying eggs slows you down', laden < a.x - 0.05, `${laden.toFixed(2)} vs ${a.x.toFixed(2)}`);
  a.carrying = load;

  // Bank them.
  const banked = run(w, 0.5, () => { a.x = home.x; a.z = home.z; a.hp = PLAYER.maxHp; });
  console.log(`  banked: home nest ${home.eggs}, carrying ${a.carrying}`);
  check('reaching your own nest banks the load', a.carrying === 0);
  check('banked eggs land in your nest', home.eggs === HEIST.eggsPerNest + load,
    `${home.eggs} vs ${HEIST.eggsPerNest + load}`);
  check('banking is announced', countOf(banked, 'eggDeposit') === 1);
}

{
  // Dying scatters the load instead of teleporting it home — otherwise there is
  // no reason to shoot the carrier.
  const w = createWorld({ mode: 'heist', seed: 22 });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  toLive(w);
  const rival = w.nests.find((n) => n.seat === 1);
  run(w, 3, () => { a.x = rival.x; a.z = rival.z; a.hp = PLAYER.maxHp; });
  const load = a.carrying;

  a.x = 5; a.z = 5;
  const drop = firstOf(kill(w, a, 'b'), 'eggDropped');
  console.log(`  dropped ${drop?.count ?? 0} eggs, ${w.looseEggs.length} loose on the floor`);
  check('the drop is announced', drop?.count === load, `${drop?.count} vs ${load}`);
  check('dying scatters the carried eggs', w.looseEggs.length === load,
    `${w.looseEggs.length} loose vs ${load} carried`);
  check('the carrier is emptied', a.carrying === 0, String(a.carrying));
  check('loose eggs land inside the arena',
    w.looseEggs.every((e) => Math.abs(e.x) < w.arena.half && Math.abs(e.z) < w.arena.half));

  // Anyone can scoop them up.
  const b = w.players.get('b');
  const egg = w.looseEggs[0];
  const grabbed = run(w, 0.3, () => { b.x = egg.x; b.z = egg.z; b.hp = PLAYER.maxHp; });
  check('a loose egg can be picked up by anyone', b.carrying > 0, `B carrying ${b.carrying}`);
  check('picking one up is announced', countOf(grabbed, 'eggPickup') > 0);
}

{
  // Abandoned eggs walk themselves home, so a stalemate can't strand them.
  const w = createWorld({ mode: 'heist', seed: 23 });
  addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  beginMatch(w, 'coop');
  toLive(w);
  const rival = w.nests.find((n) => n.seat === 1);
  w.looseEggs.push({ id: 9001, x: 0, z: 0, fromSeat: 1, returnAt: 1 });
  // Park the lone player on its OWN nest — anywhere near a rival's and it
  // starts stealing, which quietly changes the egg count being asserted on.
  const own = w.nests.find((n) => n.seat === 0);
  const solo = w.players.get('a');
  const returned = run(w, 2, () => { solo.x = own.x; solo.z = own.z; solo.hp = PLAYER.maxHp; });
  console.log(`  abandoned egg: ${w.looseEggs.length} loose, rival nest ${rival.eggs}`);
  check('an abandoned egg returns to its nest', countOf(returned, 'eggReturned') === 1);
  check('the returned egg is back in the nest', rival.eggs === HEIST.eggsPerNest + 1, String(rival.eggs));
  check('it is no longer on the floor', w.looseEggs.length === 0, String(w.looseEggs.length));
}

{
  // The final whistle counts nests, so a late raid can steal the match.
  const w = createWorld({ mode: 'heist', seed: 24 });
  addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  toLive(w);
  w.nests.find((n) => n.seat === 0).eggs = 9;
  w.nests.find((n) => n.seat === 1).eggs = 1;
  w.clock = 0.5;
  const end = firstOf(run(w, 3), 'matchEnd');
  console.log(`  winner ${end?.winner}, eggs A=${w.players.get('a').eggsHeld} B=${w.players.get('b').eggsHeld}`);
  check('the fullest nest wins', end?.winner === 'a', String(end?.winner));
  check('final egg counts are reported', w.players.get('a').eggsHeld === 9, String(w.players.get('a').eggsHeld));
}

// ---------------------------------------------------------- plant & defuse

console.log('\n--- Plant & Defuse ---');
{
  const w = createWorld({ mode: 'bomb', seed: 31 });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  const b = addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  toLive(w);

  const hold = (p) => { p.hp = PLAYER.maxHp; p.input = { ...p.input, mx: 0, mz: 0, shoot: false }; };

  const spawned = run(w, w.bombAt + 1, () => { a.x = 0; a.z = 0; hold(a); b.x = 15; b.z = 15; hold(b); });
  console.log('  bomb:', w.bomb && `${w.bomb.state} carried by ${w.bomb.carriedBy}`);
  check('a bomb appears in the middle', countOf(spawned, 'bombSpawn') === 1);
  check('walking over it picks it up', w.bomb?.state === 'carried', String(w.bomb?.state));
  check('the carrier is recorded', w.bomb?.carriedBy === 'a', String(w.bomb?.carriedBy));

  // Carrying the bomb should cost you speed too.
  a.input = { ...a.input, mx: 1, mz: 0 };
  a.x = 0;
  run(w, 0.4, () => { a.hp = PLAYER.maxHp; b.x = 15; b.z = 15; hold(b); });
  check('the bomb follows its carrier', Math.abs(w.bomb.x - a.x) < 0.01,
    `${w.bomb.x.toFixed(2)} vs ${a.x.toFixed(2)}`);

  // Standing on your OWN nest must not plant.
  const own = w.nests.find((n) => n.seat === 0);
  run(w, BOMB.plantTime + 1, () => { a.x = own.x; a.z = own.z; hold(a); b.x = 15; b.z = 15; hold(b); });
  check('you cannot plant in your own nest', w.bomb?.state === 'carried', String(w.bomb?.state));

  // The rival nest is the target.
  const rival = w.nests.find((n) => n.seat === 1);
  const plantEvents = run(w, BOMB.plantTime + 1,
    () => { a.x = rival.x; a.z = rival.z; hold(a); b.x = 15; b.z = 15; hold(b); });
  const planted = firstOf(plantEvents, 'bombPlanted');
  console.log(`  planted at seat ${planted?.seat} by ${planted?.by}, fuse ${w.bomb?.fuse.toFixed(1)}s`);
  check('holding still on a rival nest plants it', !!planted, String(w.bomb?.state));
  check('the plant is credited', planted?.by === 'a' && a.score >= BOMB.plantScore, `score ${a.score}`);
  check('the fuse starts full', (w.bomb?.fuse ?? 0) > BOMB.fuse * 0.8,
    `${w.bomb?.fuse.toFixed(1)}s of ${BOMB.fuse}s`);

  // Its owner defuses it.
  const defuseEvents = run(w, BOMB.defuseTime + 1,
    () => { b.x = rival.x; b.z = rival.z; hold(b); a.x = 15; a.z = 15; hold(a); });
  const defused = firstOf(defuseEvents, 'bombDefused');
  console.log('  defused by', defused?.by, '| score', b.score);
  check('the nest owner can defuse it', !!defused, String(defused?.by));
  check('defusing pays more than planting', b.score >= BOMB.defuseScore, `score ${b.score}`);
  check('the bomb is cleared after a defuse', w.bomb === null);
}

{
  // Only the owner may defuse, and an undefused bomb detonates.
  const w = createWorld({ mode: 'bomb', seed: 32 });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  const b = addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  const c = addPlayer(w, { id: 'c', name: 'C', seat: 2 });
  beginMatch(w, 'coop');
  toLive(w);
  const rival = w.nests.find((n) => n.seat === 1);
  const hold = (p) => { p.hp = PLAYER.maxHp; p.input = { ...p.input, mx: 0, mz: 0, shoot: false }; };

  run(w, w.bombAt + 1, () => { a.x = 0; a.z = 0; hold(a); b.x = 15; b.z = 15; hold(b); c.x = -15; c.z = -15; hold(c); });
  run(w, BOMB.plantTime + 1, () => { a.x = rival.x; a.z = rival.z; hold(a); b.x = 15; b.z = 15; hold(b); c.x = -15; c.z = -15; hold(c); });
  check('the bomb is planted', w.bomb?.state === 'planted', String(w.bomb?.state));

  // C parks on it for longer than a defuse takes. It is not their nest.
  run(w, BOMB.defuseTime + 1,
    () => { c.x = rival.x; c.z = rival.z; hold(c); a.x = 15; a.z = 15; hold(a); b.x = -15; b.z = -15; hold(b); });
  check('a third party cannot defuse someone else\'s bomb', w.bomb?.state === 'planted',
    String(w.bomb?.state ?? 'gone'));

  // Nobody defuses: it goes off, and the owner standing on it is hurt.
  const scoreBefore = a.score;
  const blastEvents = run(w, BOMB.fuse + 2, () => {
    b.x = rival.x; b.z = rival.z;
    b.input = { ...b.input, mx: 1, mz: 0, shoot: false }; // moving, so no defuse
    a.x = 18; a.z = 18; hold(a);
    c.x = -18; c.z = -18; hold(c);
  });
  const blast = firstOf(blastEvents, 'bombBlast');
  console.log(`  detonated: ${!!blast}, B hp ${b.hp.toFixed(0)}, planter score ${scoreBefore} -> ${a.score}`);
  check('an undefused bomb detonates', !!blast);
  check('the blast hurts whoever is standing on it', b.hp < PLAYER.maxHp || !b.alive,
    `hp ${b.hp.toFixed(0)} alive=${b.alive}`);
  check('the planter is paid for the detonation', a.score >= scoreBefore + BOMB.detonateScore,
    `${scoreBefore} -> ${a.score}`);
  check('a new bomb is queued after it goes off', w.bomb === null && w.bombAt > 0, String(w.bombAt));
}

// ------------------------------------------------------------ rotating hill

console.log('\n--- rotating hill ---');
{
  const w = createWorld({ mode: 'hill', seed: 41 });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  toLive(w);

  // Nobody holds the zone here. A player standing on it would win at
  // HILL.target and end the match before the second relocation ever happened,
  // which would make this a test of the win condition instead.
  const spots = [`${w.hill.x.toFixed(1)},${w.hill.z.toFixed(1)}`];
  const events = run(w, HILL.moveEvery * 2 + 2, () => {
    for (const p of w.players.values()) { p.x = 18; p.z = 18; p.hp = PLAYER.maxHp; }
  });
  for (const e of events) if (e.type === 'hillMoved') spots.push(`${e.x.toFixed(1)},${e.z.toFixed(1)}`);
  console.log('  zone visited:', spots.join(' -> '));
  console.log(`  warnings: ${countOf(events, 'hillMoving')}, moves: ${countOf(events, 'hillMoved')}`);

  check('the zone relocates', countOf(events, 'hillMoved') >= 2, `${countOf(events, 'hillMoved')} moves`);
  check('each spot is somewhere new', new Set(spots).size === spots.length, spots.join(' '));
  check('players are warned before it moves', countOf(events, 'hillMoving') >= 1);
  check('the warning comes before the move',
    events.findIndex((e) => e.type === 'hillMoving') < events.findIndex((e) => e.type === 'hillMoved'));
  check('the zone stays inside the arena',
    Math.abs(w.hill.x) <= w.arena.half * HILL.spread + 0.01
    && Math.abs(w.hill.z) <= w.arena.half * HILL.spread + 0.01,
    `(${w.hill.x.toFixed(1)}, ${w.hill.z.toFixed(1)})`);
  check('the zone position is synced to clients',
    typeof snapshot(w).hill.x === 'number' && typeof snapshot(w).hill.z === 'number');
  check('it must move sooner than it can be won, or it never moves at all',
    HILL.moveEvery < HILL.target, `moveEvery ${HILL.moveEvery} vs target ${HILL.target}`);
}

{
  // Chasing the zone pays; camping the spot it left does not. Without this,
  // relocating it is decoration rather than a mechanic.
  const w = createWorld({ mode: 'hill', seed: 42 });
  const chaser = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  const camper = addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  toLive(w);

  // Force a relocation shortly after the camper has settled on the old spot.
  const oldSpot = { x: w.hill.x, z: w.hill.z };
  run(w, 3, () => {
    camper.x = oldSpot.x; camper.z = oldSpot.z; camper.hp = PLAYER.maxHp;
    chaser.x = 18; chaser.z = 18; chaser.hp = PLAYER.maxHp;
  });
  const camperBefore = camper.score;
  w.hill.moveAt = 0.05;
  run(w, 0.2, () => {
    camper.x = oldSpot.x; camper.z = oldSpot.z; camper.hp = PLAYER.maxHp;
    chaser.x = 18; chaser.z = 18; chaser.hp = PLAYER.maxHp;
  });
  const drift = Math.hypot(w.hill.x - oldSpot.x, w.hill.z - oldSpot.z);
  check('the forced relocation actually moved it', drift > HILL.radius, `${drift.toFixed(1)}m`);

  // Now the camper is off the zone and the chaser is on it.
  const camperAt = camper.score;
  run(w, 6, () => {
    camper.x = oldSpot.x; camper.z = oldSpot.z; camper.hp = PLAYER.maxHp;
    chaser.x = w.hill.x; chaser.z = w.hill.z; chaser.hp = PLAYER.maxHp;
  });
  console.log(`  camper ${camperBefore} -> ${camper.score} | chaser ${chaser.score}`);
  check('camping the old spot stops paying', camper.score === camperAt,
    `${camperAt} -> ${camper.score}`);
  check('following the zone keeps paying', chaser.score > 0, `score ${chaser.score}`);
}

// ------------------------------------------------------------- hot potato

console.log('\n--- Hot Potato ---');
{
  const w = createWorld({ mode: 'casual', seed: 51, modifier: 'potato' });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  const b = addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  toLive(w);

  // It arrives on a timer rather than at the whistle, so wait it out.
  run(w, POTATO.firstSpawn + 1, () => {
    for (const p of w.players.values()) { p.x = 18; p.z = 18; p.hp = PLAYER.maxHp; }
  });
  check('the potato exists under its modifier', !!w.potato);

  const grabbed = run(w, 3, () => {
    a.x = w.potato.x; a.z = w.potato.z; a.hp = PLAYER.maxHp;
    b.x = 15; b.z = 15; b.hp = PLAYER.maxHp;
  });
  console.log('  holder:', w.potato.holder, '| fuse', w.potato.fuse.toFixed(1));
  check('walking into it makes you the holder', w.potato.holder === 'a', String(w.potato.holder));
  check('picking it up is announced', countOf(grabbed, 'potatoGrab') > 0
    || countOf(grabbed, 'potatoPass') > 0, grabbed.map((e) => e.type).join(','));

  const fuseAt = w.potato.fuse;
  run(w, 1, () => { a.hp = PLAYER.maxHp; b.x = 15; b.z = 15; b.hp = PLAYER.maxHp; });
  check('holding it burns the fuse down', w.potato.fuse < fuseAt,
    `${fuseAt.toFixed(1)} -> ${w.potato.fuse.toFixed(1)}`);

  // Touching the holder passes it on.
  const passed = run(w, 2, () => {
    a.hp = PLAYER.maxHp; b.hp = PLAYER.maxHp;
    b.x = a.x; b.z = a.z;
  });
  console.log('  after contact, holder is', w.potato.holder);
  check('touching the holder passes it on', w.potato.holder === 'b' || countOf(passed, 'potatoPass') > 0,
    String(w.potato.holder));

  // Let the fuse run out on whoever is holding it.
  const holder = w.players.get(w.potato.holder) ?? a;
  w.potato.fuse = 0.4;
  const boom = run(w, POTATO.respawnDelay + 2, () => {
    for (const p of w.players.values()) if (p.id !== holder.id) { p.x = 18; p.z = 18; p.hp = PLAYER.maxHp; }
  });
  console.log('  detonation events:', boom.filter((e) => e.type.startsWith('potato')).map((e) => e.type).join(','));
  check('the fuse running out detonates on the holder',
    countOf(boom, 'potatoBlast') > 0 || !holder.alive || holder.hp < PLAYER.maxHp,
    `hp ${holder.hp.toFixed(0)} alive=${holder.alive}`);
  check('the potato comes back for another round',
    !!w.potato && (w.potato.holder === null || w.potato.fuse > 0.4), JSON.stringify({
      holder: w.potato?.holder, fuse: w.potato?.fuse?.toFixed(1),
    }));
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
