// Grain: the crop, the peck, and the feeder.
//
// Fire used to be unlimited. That is not a balance problem, it is a design
// one — with no resource there is no decision, so every second of a match is
// identical to every other second and nobody is ever vulnerable for a reason
// they caused. The crop exists to create that beat: commit, run dry, be briefly
// helpless, recover.
//
// Most of what is checked here is anti-frustration rather than mechanics,
// because that is where a resource system goes wrong. A magazine that empties
// is fine. A magazine that empties and leaves you with no way out, or eats a
// reload you already paid for, is the thing players quit over.
//
//   node shared/test/crop.mjs

import {
  createWorld, addPlayer, applyInput, stepWorld, beginMatch, spawnPoints,
  CROP, PLAYER, TICK_DT, cropCapacity, MODIFIER_POOL,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const CAP = cropCapacity('none');

function live(modifier = 'none') {
  const w = createWorld({ mode: 'casual', seed: 21, modifier });
  const p = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  for (let t = 0; t < 300 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  // Off the feeder, or every test here is a feeder test.
  p.x = 0; p.z = 0;
  p.invulnUntil = 0;
  return { w, p };
}

/** Steps `seconds` holding one input, and reports what happened. */
function run({ w, p }, input, seconds) {
  const out = { shots: 0, dry: 0, pecks: 0, fed: 0 };
  for (let t = 0; t < seconds / TICK_DT; t++) {
    p.hp = p.hp <= 0 ? PLAYER.maxHp : p.hp;
    applyInput(w, 'a', { seq: t, ...(typeof input === 'function' ? input(t) : input) });
    for (const e of stepWorld(w, TICK_DT)) {
      if (e.type === 'shot' && e.owner === 'a') out.shots++;
      if (e.type === 'dryFire' && e.target === 'a') out.dry++;
      if (e.type === 'peck' && e.target === 'a') out.pecks++;
      if (e.type === 'fed' && e.target === 'a') out.fed++;
    }
  }
  return out;
}

// ----------------------------------------------------------------- the crop
console.log('\n--- fire is finite ---');
{
  const g = live();
  check('you start with a full crop', g.p.crop === CAP, `${g.p.crop}/${CAP}`);

  // Holding fire while moving, so nothing refills: the crop is the whole budget.
  const burst = run(g, { mx: 1, mz: 0, shoot: true }, 6);
  console.log(`  held fire for 6s while running: ${burst.shots} shots, ${burst.dry} dry clicks`);
  check('a full crop is exactly that many shots', burst.shots === CAP,
    `${burst.shots} vs a ${CAP} capacity`);
  check('...and then it stops', g.p.crop === 0, String(g.p.crop));
  check('an empty trigger-pull says so', burst.dry > 0, `${burst.dry} dry clicks`);
}

// The number that decides every fight: can one crop kill one chicken?
{
  const shotsToKill = Math.ceil(PLAYER.maxHp / 11);
  console.log(`  ${CAP} shots against a ${shotsToKill}-shot kill: ${CAP - shotsToKill} misses allowed`);
  check('one crop can kill one chicken with room to miss',
    CAP > shotsToKill && CAP - shotsToKill >= 3,
    `${CAP - shotsToKill} spare`);
  check('...but not two, so a fight has to be earned', CAP < shotsToKill * 2,
    `${CAP} vs ${shotsToKill * 2}`);
}

// Running dry is a commitment, not a stutter: the recovery floor is what makes
// the empty window a real window rather than a hitch.
{
  const g = live();
  g.p.crop = 1;
  run(g, { mx: 1, mz: 0, shoot: true }, 0.4); // spend the last grain on the move
  check('firing the last grain leaves you dry', g.p.dry === true, String(g.p.dry));

  g.p.crop = CROP.recoverTo - 1;
  run(g, { mx: 1, mz: 0, shoot: true }, 0.5);
  check('...and one grain back is not enough to fire again',
    g.p.dry === true && g.p.crop === CROP.recoverTo - 1,
    `dry=${g.p.dry} crop=${g.p.crop}`);

  g.p.crop = CROP.recoverTo;
  run(g, { mx: 0, mz: 0 }, 0.05);
  check('reaching the recovery floor puts you back in the fight', g.p.dry === false,
    String(g.p.dry));
}

// ---------------------------------------------------------------- the peck
console.log('\n--- pecking ---');
{
  const g = live();
  g.p.crop = 0;

  // Running: no refill. Standing still is the price of the reload and the
  // reason it is a decision rather than a formality.
  run(g, { mx: 1, mz: 0, shoot: false }, 2);
  check('running never refills you', g.p.crop === 0, String(g.p.crop));

  const still = run(g, { mx: 0, mz: 0, shoot: false }, 2.4);
  console.log(`  stood still for 2.4s: crop ${g.p.crop}/${CAP}, ${still.pecks} peck event(s)`);
  check('standing still refills the crop', g.p.crop === CAP, `${g.p.crop}/${CAP}`);
  check('it announces itself once, not per grain', still.pecks === 1, `${still.pecks}`);
}

// Progressive, and that is the anti-frustration rule that matters most: a
// reload you got halfway through has to be worth half a reload. Losing it
// wholesale is the single most resented moment in the genre.
{
  const g = live();
  g.p.crop = 0;
  run(g, { mx: 0, mz: 0 }, 0.3 + 0.4); // the delay, plus a little pecking
  const partial = g.p.crop;
  run(g, { mx: 1, mz: 0 }, 0.5);       // interrupted by running
  console.log(`  interrupted mid-peck: kept ${partial} grain, still ${g.p.crop} after running`);
  check('a partial peck gives you partial grain', partial > 0 && partial < CAP, String(partial));
  check('...and interrupting it never takes that back', g.p.crop === partial, String(g.p.crop));
}

// The deadlock guard, and the incentive that sits on top of it.
//
// A player who runs dry and keeps holding the trigger must never be STUCK —
// that is the panicked-player rule, and it is absolute. But they should not get
// the same deal as someone who lets go, either, or the reload is optional.
//
// What actually happens is the right shape: they peck to the recovery floor,
// fire that back off, and cycle. Never locked out, never as well off as a
// player who released and filled up. The lesson is available without a tutorial
// — the crop meter visibly never fills while you hold the trigger.
{
  const held = live();
  held.p.crop = 0;
  const mashed = run(held, { mx: 0, mz: 0, shoot: true }, 2.4);
  console.log(`  mashing on empty for 2.4s: ${mashed.shots} shots, ended at ${held.p.crop}/${CAP}`);
  check('a player mashing the trigger on empty always gets back into the fight',
    mashed.shots > 0, `${mashed.shots} shots`);
  check('...in bursts, not one dribbled grain at a time',
    mashed.shots >= CROP.recoverTo, `${mashed.shots} shots in 2.4s`);

  const let_go = live();
  let_go.p.crop = 0;
  run(let_go, { mx: 0, mz: 0, shoot: false }, 2.4);
  console.log(`  letting go for the same 2.4s: ${let_go.p.crop}/${CAP}`);
  check('...but letting go is strictly the better deal', let_go.p.crop > held.p.crop,
    `${let_go.p.crop} vs ${held.p.crop}`);
  check('...and only that fills the crop', let_go.p.crop === CAP, `${let_go.p.crop}/${CAP}`);
}

// ...but holding fire with grain left must NOT peck, or the resource never
// actually constrains anyone.
{
  const g = live();
  g.p.crop = CAP - 4;
  const held = run(g, { mx: 0, mz: 0, shoot: true }, 1.2);
  check('firing from cover does not secretly reload you', held.pecks === 0,
    `${held.pecks} pecks while shooting`);
}

// Jumping is not a free reload. Refilling in the air would let a player recover
// while doing the one thing that makes them hardest to hit.
{
  const g = live();
  g.p.crop = 0;
  run(g, { mx: 0, mz: 0, jump: true }, 1.4);
  console.log(`  bouncing on the spot for 1.4s: crop ${g.p.crop}`);
  check('you cannot peck in mid-air', g.p.crop < CAP, `${g.p.crop}/${CAP}`);
}

// --------------------------------------------------------------- the feeder
console.log('\n--- the feeder ---');
{
  const g = live();
  const pad = spawnPoints(g.w)[0];
  g.p.x = pad.x; g.p.z = pad.z;
  g.p.crop = 0;
  g.p.hp = 40;
  g.p.lastHurtAt = -99; // out of combat

  const fed = run(g, { mx: 0, mz: 0 }, 1.2);
  console.log(`  1.2s on the pad: crop ${g.p.crop}/${CAP}, hp ${g.p.hp}, ${fed.fed} feed event(s)`);
  check('the feeder fills the crop', g.p.crop === CAP, `${g.p.crop}/${CAP}`);
  check('...and heals you', g.p.hp > 40, `${g.p.hp}hp`);
  check('...faster than pecking, which is what the walk buys',
    CROP.feeder.refill > CROP.peckRate);
  check('it never overheals', g.p.hp <= PLAYER.maxHp, `${g.p.hp}`);
}

// Health waits for the fight to end; grain does not. This is what stops the
// feeder being a fortress — the pads are also the nests in Egg Heist and Plant
// & Defuse, and healing through incoming fire there made a planted bomb
// survivable at full health.
{
  const g = live();
  const pad = spawnPoints(g.w)[0];
  g.p.x = pad.x; g.p.z = pad.z;
  g.p.crop = 0;
  g.p.hp = 40;

  let hpUnderFire = 40;
  for (let t = 0; t < 1.5 / TICK_DT; t++) {
    g.p.lastHurtAt = g.w.time; // something is hitting us, every tick
    applyInput(g.w, 'a', { mx: 0, mz: 0, seq: t });
    stepWorld(g.w, TICK_DT);
    hpUnderFire = g.p.hp;
  }
  console.log(`  under fire on the pad: hp ${hpUnderFire}, crop ${g.p.crop}/${CAP}`);
  check('you cannot heal through a fight', hpUnderFire === 40, `${hpUnderFire}hp`);
  check('...but you can still reload in one', g.p.crop === CAP, `${g.p.crop}/${CAP}`);

  // ...and once it stops, healing resumes. Recovery has to actually arrive or
  // the lockout is just a nerf.
  g.p.lastHurtAt = g.w.time - CROP.feeder.combatDelay - 0.1;
  run(g, { mx: 0, mz: 0 }, 1.0);
  check('healing resumes once nothing is hitting you', g.p.hp > 40, `${g.p.hp}hp`);
}

// Somebody else's feeder is not yours.
{
  const g = live();
  const theirs = spawnPoints(g.w)[1];
  g.p.x = theirs.x; g.p.z = theirs.z;
  g.p.crop = 0;
  g.p.hp = 40;
  g.p.lastHurtAt = -99;
  run(g, { mx: 0, mz: 0 }, 0.6);
  // Checked on the flag rather than on the crop: standing on a rival pad you
  // are still standing still, so pecking refills you slowly and "crop went up"
  // proves nothing. Whether you are FEEDING is the actual question.
  console.log(`  on a rival pad: feeding=${g.p.feeding}, hp ${g.p.hp}, crop ${g.p.crop}`);
  check('a rival feeder does not feed you', g.p.feeding === false, String(g.p.feeding));
  check('...and does not heal you either', g.p.hp === 40, `${g.p.hp}hp`);
}

// ------------------------------------------------------------ round trips
console.log('\n--- the loop closes ---');
{
  // Respawning has to hand back a full crop. Coming back from the dead with an
  // empty magazine is a punishment on top of a punishment.
  const g = live();
  g.p.crop = 0;
  g.p.alive = false;
  g.p.hp = 0;
  g.p.respawnAt = 0;
  stepWorld(g.w, TICK_DT);
  check('you respawn with a full crop', g.p.alive && g.p.crop === CAP, `${g.p.crop}/${CAP}`);
}

{
  // A kill hands some back, so winning a fight does not cost you the next one.
  const g = live();
  const foe = g.w.players.get('b');
  g.p.crop = 2;
  foe.x = g.p.x; foe.z = g.p.z + 6;
  foe.hp = 8;
  foe.invulnUntil = 0;
  const yaw = Math.atan2(0, 6);
  for (let t = 0; t < 1 / TICK_DT && foe.alive; t++) {
    applyInput(g.w, 'a', { mx: 0, mz: 0, ax: Math.sin(yaw), az: Math.cos(yaw), shoot: true, seq: t });
    stepWorld(g.w, TICK_DT);
  }
  console.log(`  killed with 2 in the crop, left holding ${g.p.crop}`);
  check('a kill refunds some grain', !foe.alive && g.p.crop >= CROP.killRefund,
    `${g.p.crop} after the kill`);
}

// ------------------------------------------------------------- modifiers
console.log('\n--- TRIGGER HAPPY still means what it says ---');
{
  // The modifier's whole promise is firing without thinking about it. A crop
  // that did not grow with the fire rate would invert that: the same 14 rounds,
  // gone three times faster, and a match spent pecking.
  const plain = live('none');
  const trigger = live('trigger');
  const a = run(plain, { mx: 1, mz: 0, shoot: true }, 4);
  const b = run(trigger, { mx: 1, mz: 0, shoot: true }, 4);
  console.log(`  4s of held fire: ${a.shots} shots plain, ${b.shots} with TRIGGER HAPPY`);
  check('the crop scales with the fire rate', b.shots > a.shots * 2,
    `${a.shots} -> ${b.shots}`);
  check('...and the meter agrees with the gun',
    cropCapacity('trigger') === b.shots, `cap ${cropCapacity('trigger')} vs ${b.shots} fired`);
}

// Every modifier has to leave a workable crop — a capacity of zero or a
// negative would be a silent, total lockout.
for (const modifier of MODIFIER_POOL) {
  const cap = cropCapacity(modifier);
  check(`${modifier}: the crop is a usable size`, cap >= 8 && Number.isFinite(cap), String(cap));
}

// ---------------------------------------------------------------- the bots
//
// Bots have to solve the crop too, and the way they failed to is worth writing
// down: firing is gated on `dry`, which stays true from zero until
// CROP.recoverTo grain are back, but the bot logic checked `crop <= 0`. So a
// bot pecked exactly one grain, saw a player nearby, went back to strafing —
// and was then stuck forever, unable to shoot because it was still dry and
// unable to peck because it was moving.
//
// It was reported as "they just move back and forth in front of me", which is
// what being permanently unable to act looks like from the outside. The check
// below is written as that sentence rather than as an outcome: bots draw from
// global Math.random, so how many kills they get is chance, but "never stuck
// for longer than the retreat allows" has to hold on every draw.
console.log('\n--- bots recover too ---');
{
  const { stepBots, initBot } = await import('../src/bots.js');

  /** Runs one bot next to one target and reports how it coped with going dry. */
  const trial = (gap, seconds = 14) => {
    const w = createWorld({ mode: 'casual', seed: 41, modifier: 'none' });
    const bot = addPlayer(w, { id: 'bot', name: 'Bot', seat: 0, isBot: true });
    const foe = addPlayer(w, { id: 'foe', name: 'Foe', seat: 1 });
    beginMatch(w, 'coop');
    for (let t = 0; t < 300 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
    initBot(bot, 'normal');
    bot.x = 0; bot.z = 0; bot.crop = 0; bot.dry = true; bot.invulnUntil = 0;

    let shots = 0;
    let peak = 0;
    let stuckRun = 0;
    let worstStuck = 0;
    for (let t = 0; t < seconds / TICK_DT; t++) {
      bot.hp = PLAYER.maxHp;
      foe.hp = PLAYER.maxHp;
      foe.invulnUntil = 0;
      foe.x = 0; foe.z = gap; // pinned, so this measures the bot and not a chase
      stepBots(w, TICK_DT);
      for (const e of stepWorld(w, TICK_DT)) if (e.type === 'shot' && e.owner === 'bot') shots++;
      peak = Math.max(peak, bot.crop);

      // Stuck = alive, cannot fire, and not doing anything about it. Retreating
      // counts as moving, so this legitimately runs for up to RETREAT_TIME
      // before the bot must stand and peck — the bound is what is being tested.
      const moving = Math.hypot(bot.input.mx, bot.input.mz) > 0.05;
      const stuck = bot.alive && bot.dry && moving && !bot.pecking;
      stuckRun = stuck ? stuckRun + TICK_DT : 0;
      worstStuck = Math.max(worstStuck, stuckRun);
    }
    return { shots, peak, worstStuck };
  };

  for (const gap of [6, 12, 26]) {
    const r = trial(gap);
    console.log(`  foe ${gap}u away: ${r.shots} shots, peak crop ${r.peak}, longest stuck ${r.worstStuck.toFixed(2)}s`);
    check(`a dry bot with a foe ${gap}u away gets back into the fight`,
      r.shots > 0, `${r.shots} shots in 14s`);
    check(`...and fills up properly rather than dribbling (${gap}u)`,
      r.peak > CROP.recoverTo + 2, `peak ${r.peak}`);
    // The bug itself. A retreat is bounded at ~1.1s, so anything past a couple
    // of seconds means the bot has stopped being able to act at all.
    check(`...and is never stranded unable to shoot or peck (${gap}u)`,
      r.worstStuck < 2.5, `${r.worstStuck.toFixed(2)}s stuck`);
  }
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
