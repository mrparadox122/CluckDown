// The pecking order.
//
// Power used to be found on the floor — tracking, bouncy and fire rounds, and
// rapid fire. All of it is gone, replaced by a ladder you climb by killing.
// That swap is a design argument, not a balance one: a pickup is luck, and it
// generates no story and teaches nothing. A ladder is legible, it is yours, and
// because everyone's rung rides above their health bar, it is public.
//
// Most of what is checked here is not "does the number go up". It is the set of
// guards that keep a ladder from becoming a punishment, because that is the
// only way this feature fails:
//
//   * killing UP is worth multiples of killing DOWN, so the leader is also the
//     fastest route up and the ladder rubber-bands itself
//   * dying to someone ABOVE you is nearly free; being upset is what costs
//   * you never fall below rung 1
//   * you never fall more than ONE rung per death, whatever the arithmetic says
//
// The last is the important one. Loss aversion runs about twice as strong as
// the pleasure of an equivalent gain, so a ladder that takes as freely as it
// gives is a ladder people stop climbing. The player who has just lost a fight
// is the last one who should be handed a second punishment on top.
//
//   node shared/test/levels.mjs

import {
  createWorld, addPlayer, applyInput, stepWorld, beginMatch,
  killXp, deathXp, LEVELS, PLAYER, CROP, TICK_DT,
  levelFromXp, xpForLevel, rungOf, perkValue, cropCapacity,
  PICKUP_WEIGHTS,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

function live() {
  const w = createWorld({ mode: 'casual', seed: 71, modifier: 'none' });
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  const b = addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  for (let t = 0; t < 300 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  a.x = 0; a.z = 0; a.invulnUntil = 0;
  b.x = 0; b.z = 8; b.invulnUntil = 0;
  return { w, a, b };
}

/** Sets a player's rung directly, XP and all. */
function setLevel(p, level) {
  p.xp = xpForLevel(level);
  p.level = level;
}

/** `a` shoots `b` until it dies. Returns the events. */
function killWith(g, killer, victim, seconds = 4) {
  const yaw = Math.atan2(victim.x - killer.x, victim.z - killer.z);
  const out = [];
  for (let t = 0; t < seconds / TICK_DT && victim.alive; t++) {
    killer.crop = 99;
    killer.dry = false;
    victim.invulnUntil = 0;
    applyInput(g.w, killer.id, {
      mx: 0, mz: 0, ax: Math.sin(yaw), az: Math.cos(yaw), shoot: true, seq: t,
    });
    for (const e of stepWorld(g.w, TICK_DT)) out.push(e);
  }
  return out;
}

// ---------------------------------------------------- the shooting pickups
console.log('\n--- the power-ups are gone ---');
check('nothing on the pickup table is a shooting power-up',
  PICKUP_WEIGHTS.every(([k]) => k === 'health'),
  PICKUP_WEIGHTS.map(([k]) => k).join(', '));

// ------------------------------------------------------------- the numbers
console.log('\n--- killing up pays, killing down does not ---');
{
  const even = killXp(3, 3);
  const up1 = killXp(3, 4);
  const up3 = killXp(3, 6);
  const down1 = killXp(3, 2);
  const down3 = killXp(4, 1);
  console.log(`  from rung 3: equal ${even}, +1 ${up1}, +3 ${up3}, -1 ${down1}, -3 ${down3}`);

  check('beating an equal is worth well over half a rung', even >= LEVELS.step * 0.5, String(even));
  check('beating someone one rung up is a WHOLE rung', up1 >= LEVELS.step, `${up1} vs a ${LEVELS.step} step`);
  check('...and the further up, the better', up3 > up1 && up1 > even, `${even} < ${up1} < ${up3}`);
  check('beating someone below you is worth much less', down1 < even / 2, `${down1} vs ${even}`);
  check('...but never nothing, so a kill is always progress', down3 >= LEVELS.kill.floor, String(down3));

  // The clamp: no amount of gap should let one shot skip the ladder.
  check('no single kill can skip more than a couple of rungs',
    killXp(1, LEVELS.max) < LEVELS.step * 3, String(killXp(1, LEVELS.max)));
}

console.log('\n--- dying to someone below you is what costs ---');
{
  const toEqual = deathXp(3, 3);
  const toAbove = deathXp(3, 5);
  const toBelow1 = deathXp(3, 2);
  const toBelow3 = deathXp(4, 1);
  console.log(`  at rung 3: to an equal ${toEqual}, to a better ${toAbove}, to one below ${toBelow1}, to three below ${toBelow3}`);

  check('losing to someone above you is nearly free', -toAbove <= LEVELS.step * 0.35,
    String(toAbove));
  check('...and no worse than losing to an equal', toAbove === toEqual,
    `${toAbove} vs ${toEqual}`);
  check('being upset by someone below costs more', -toBelow1 > -toEqual, `${toBelow1} vs ${toEqual}`);
  check('...and more the further below they were', -toBelow3 > -toBelow1,
    `${toBelow3} vs ${toBelow1}`);
  check('every death costs something', toEqual < 0 && toAbove < 0);
}

// ------------------------------------------------------------- the climbing
console.log('\n--- climbing, in the simulation ---');
{
  const g = live();
  check('everyone starts on rung 1', g.a.level === 1 && g.a.xp === 0, `${g.a.level}`);

  setLevel(g.b, 2); // one above us: a whole rung in one fight
  const events = killWith(g, g.a, g.b);
  const up = events.find((e) => e.type === 'levelUp' && e.target === 'a');
  console.log(`  killed a rung-2 chicken from rung 1: xp ${g.a.xp}, level ${g.a.level}`);
  check('a kill awards xp', g.a.xp > 0, String(g.a.xp));
  check('beating someone above you levels you on the spot', g.a.level === 2, String(g.a.level));
  check('...and it is announced', !!up, up ? `to ${up.level}` : 'no levelUp event');
  check('the announcement carries what was unlocked',
    !!up?.perk && !!up?.name && !!up?.blurb, JSON.stringify({ n: up?.name, p: up?.perk }));
  check('the kill event says it was an upset', events.some((e) => e.type === 'kill' && e.punchedUp));
}

// A win streak has to actually reach the top in a match — a ladder nobody
// summits is a ladder with no top rung.
{
  const g = live();
  let kills = 0;
  while (g.a.level < LEVELS.max && kills < 40) {
    g.b.alive = true;
    g.b.hp = PLAYER.maxHp;
    g.b.x = 0; g.b.z = 8;
    g.b.invulnUntil = 0;
    // Held level with us. Against a victim who never climbs the reward decays
    // by design — that is the anti-farming clamp, checked separately — so
    // leaving them on rung 1 would measure that instead of the ceiling.
    setLevel(g.b, g.a.level);
    killWith(g, g.a, g.b);
    kills++;
  }
  console.log(`  reached the top rung in ${kills} kills against an equal`);
  check('the top of the ladder is reachable in a match', g.a.level === LEVELS.max,
    `level ${g.a.level} after ${kills}`);
  check('...but not trivially', kills >= 5, `${kills} kills`);

  // ...and the same run against someone who never climbs must NOT get there.
  // Farming the bottom of the table is the failure mode the clamp exists for.
  {
    const farm = live();
    for (let i = 0; i < 40; i++) {
      farm.b.alive = true; farm.b.hp = PLAYER.maxHp;
      farm.b.x = 0; farm.b.z = 8; farm.b.invulnUntil = 0;
      setLevel(farm.b, 1);
      killWith(farm, farm.a, farm.b);
    }
    console.log(`  40 kills on a rung-1 punching bag: level ${farm.a.level}`);
    check('farming the bottom of the table stalls out', farm.a.level < LEVELS.max,
      `level ${farm.a.level} after 40 kills`);
  }

  // And it stops there rather than running off the end.
  const before = g.a.xp;
  g.b.alive = true; g.b.hp = PLAYER.maxHp; g.b.x = 0; g.b.z = 8; g.b.invulnUntil = 0;
  killWith(g, g.a, g.b);
  check('the ladder has a top', g.a.level === LEVELS.max, String(g.a.level));
  check('...and xp cannot run away past it', g.a.xp >= before && g.a.level === LEVELS.max);
}

// ------------------------------------------------------------- the falling
console.log('\n--- falling, and the guards that stop it spiralling ---');
{
  // The case the one-rung rule exists for: a high rung killed by rung 1. The
  // arithmetic says three rungs; the player gets to keep two of them.
  const g = live();
  setLevel(g.a, 5);
  setLevel(g.b, 1);
  const raw = deathXp(5, 1);
  const events = killWith(g, g.b, g.a);
  const down = events.find((e) => e.type === 'levelDown' && e.target === 'a');
  console.log(`  rung 5 killed by rung 1: raw ${raw}xp would be ${levelFromXp(xpForLevel(5) + raw)}, landed on ${g.a.level}`);
  check('you fall when you die', g.a.level < 5, String(g.a.level));
  check('...but never more than one rung, whatever the arithmetic says',
    g.a.level === 4, `${g.a.level}, raw would have been ${levelFromXp(xpForLevel(5) + raw)}`);
  check('the fall is announced too', !!down, down ? `to ${down.level}` : 'no levelDown');
}

{
  // ...and rung 1 is the floor. Somebody having a terrible match must always
  // have a rung to stand on.
  const g = live();
  setLevel(g.a, 1);
  setLevel(g.b, 4);
  for (let i = 0; i < 4; i++) {
    g.a.alive = true; g.a.hp = PLAYER.maxHp; g.a.x = 0; g.a.z = 0; g.a.invulnUntil = 0;
    killWith(g, g.b, g.a);
  }
  console.log(`  four deaths from rung 1: level ${g.a.level}, xp ${g.a.xp}`);
  check('you never fall off the bottom', g.a.level === 1 && g.a.xp >= 0,
    `level ${g.a.level}, xp ${g.a.xp}`);
}

{
  // Dying to someone above you should barely dent the climb — the whole point
  // of the asymmetry is that being outmatched is not a mistake.
  const g = live();
  setLevel(g.a, 3);
  setLevel(g.b, 5);
  const before = g.a.xp;
  killWith(g, g.b, g.a);
  console.log(`  rung 3 killed by rung 5: xp ${before} -> ${g.a.xp}`);
  check('losing to a better player costs little', before - g.a.xp <= LEVELS.step * 0.35,
    `${before - g.a.xp}xp`);
}

// -------------------------------------------------------------- the perks
console.log('\n--- what the rungs actually give you ---');
{
  // Every rung above the first has to hand over something NAMED. A level-up
  // with nothing behind it is a number, and a number is not a reward.
  for (const rung of LEVELS.rungs) {
    if (rung.level === 1) continue;
    check(`rung ${rung.level} (${rung.name}) unlocks something named`,
      !!rung.perk && !!rung.blurb, rung.perk ?? 'nothing');
  }
  check('every rung has its own colour',
    new Set(LEVELS.rungs.map((r) => r.color)).size === LEVELS.rungs.length);

  // Perks are cumulative — reaching 4 keeps 2 and 3, or the ladder would be a
  // series of sidegrades and climbing would sometimes be a downgrade.
  check('perks accumulate rather than replace',
    perkValue(LEVELS.max, 'peckRateMul') > 1 && perkValue(LEVELS.max, 'speedMul') > 1,
    `peck ${perkValue(LEVELS.max, 'peckRateMul')}, speed ${perkValue(LEVELS.max, 'speedMul')}`);
  check('rung 1 has none of them',
    perkValue(1, 'peckRateMul') === 1 && perkValue(1, 'speedMul') === 1
    && perkValue(1, 'fireCooldownMul') === 1);
}

// Each of the three passive perks has to be measurable in the simulation, not
// just present in a table.
{
  const walk = (level) => {
    const g = live();
    setLevel(g.a, level);
    g.a.x = 0; g.a.z = 0;
    for (let t = 0; t < 1 / TICK_DT; t++) {
      g.a.hp = PLAYER.maxHp;
      applyInput(g.w, 'a', { mx: 1, mz: 0, seq: t });
      stepWorld(g.w, TICK_DT);
    }
    return g.a.x;
  };
  const slow = walk(1);
  const fast = walk(3);
  console.log(`  one second of running: ${slow.toFixed(2)}u at rung 1, ${fast.toFixed(2)}u at rung 3`);
  check('Long Legs is actually faster', fast > slow * 1.1, `${slow.toFixed(2)} -> ${fast.toFixed(2)}`);

  const peck = (level) => {
    const g = live();
    setLevel(g.a, level);
    g.a.crop = 0;
    for (let t = 0; t < 0.75 / TICK_DT; t++) {
      g.a.hp = PLAYER.maxHp;
      applyInput(g.w, 'a', { mx: 0, mz: 0, seq: t });
      stepWorld(g.w, TICK_DT);
    }
    return g.a.crop;
  };
  const slowPeck = peck(1);
  const fastPeck = peck(2);
  console.log(`  0.75s of pecking: ${slowPeck} grain at rung 1, ${fastPeck} at rung 2`);
  check('Quick Crop really is quicker', fastPeck > slowPeck * 1.4, `${slowPeck} -> ${fastPeck}`);

  const rate = (level) => {
    const g = live();
    setLevel(g.a, level);
    let shots = 0;
    for (let t = 0; t < 1 / TICK_DT; t++) {
      g.a.crop = 999; g.a.dry = false;
      applyInput(g.w, 'a', { mx: 0, mz: 0, ax: 0, az: 1, shoot: true, seq: t });
      for (const e of stepWorld(g.w, TICK_DT)) if (e.type === 'shot' && e.owner === 'a') shots++;
    }
    return shots;
  };
  const slowFire = rate(1);
  const fastFire = rate(4);
  console.log(`  one second of held fire: ${slowFire} shots at rung 1, ${fastFire} at rung 4`);
  check('Rapid Peck really is faster', fastFire > slowFire, `${slowFire} -> ${fastFire}`);
}

// Second Wind: fires once, at the threshold, and not again until you respawn.
{
  const g = live();
  setLevel(g.a, 5);
  const wind = perkValue(5, 'secondWind', null);

  g.a.hp = PLAYER.maxHp;
  applyInput(g.w, 'a', { mx: 0, mz: 0, seq: 1 });
  stepWorld(g.w, TICK_DT);
  check('Second Wind does not fire at full health', g.a.windUntil === 0);

  g.a.hp = PLAYER.maxHp * wind.at - 1;
  let fired = 0;
  for (let t = 0; t < 0.5 / TICK_DT; t++) {
    g.a.hp = Math.max(1, PLAYER.maxHp * wind.at - 1);
    applyInput(g.w, 'a', { mx: 0, mz: 0, seq: 10 + t });
    for (const e of stepWorld(g.w, TICK_DT)) if (e.type === 'secondWind') fired++;
  }
  console.log(`  dropped below ${(wind.at * 100).toFixed(0)}%: fired ${fired} time(s)`);
  check('Second Wind fires when you drop low', fired === 1, `${fired}`);
  check('...exactly once, not every tick while hurt', fired === 1, `${fired}`);

  // ...and a fresh life is a fresh chance.
  g.a.alive = false;
  g.a.hp = 0;
  g.a.respawnAt = 0;
  stepWorld(g.w, TICK_DT);
  check('respawning re-arms it', g.a.alive && g.a.windUsed === false);
}

// Feeding Frenzy: the only perk that chains, which is what makes the top rung a
// highlight rather than a bigger number.
{
  const g = live();
  setLevel(g.a, LEVELS.max);
  g.a.crop = 1;
  const events = killWith(g, g.a, g.b);
  console.log(`  killed at the top rung: crop ${g.a.crop}/${cropCapacity('none')}, frenzy for ${(g.a.frenzyUntil - g.w.time).toFixed(1)}s`);
  check('a kill at the top rung refills you outright',
    g.a.crop === cropCapacity(g.w.modifier), `${g.a.crop}`);
  check('...and sets a timer running', g.a.frenzyUntil > g.w.time);
  check('...and says so', events.some((e) => e.type === 'frenzy' && e.target === 'a'));

  // Lower rungs get the ordinary refund and nothing else.
  const h = live();
  setLevel(h.a, 3);
  h.a.crop = 1;
  killWith(h, h.a, h.b);
  // Only the timer is checked: killWith force-feeds the crop to keep the
  // shooter firing, so the crop afterwards says nothing about the perk.
  check('lower rungs get no frenzy', h.a.frenzyUntil === 0, `until ${h.a.frenzyUntil}`);
}

// -------------------------------------------------------------- bookkeeping
console.log('\n--- xp and level can never disagree ---');
{
  // level is DERIVED from xp everywhere. Two numbers that can drift apart is
  // how a demoted player keeps the perks of a rung they no longer hold.
  let bad = 0;
  for (let xp = -50; xp <= LEVELS.step * (LEVELS.max + 2); xp += 7) {
    const lvl = levelFromXp(xp);
    if (lvl < 1 || lvl > LEVELS.max) bad++;
    if (xp >= 0 && xp < LEVELS.step * LEVELS.max && lvl !== Math.floor(xp / LEVELS.step) + 1) bad++;
  }
  check('levelFromXp is in range and monotonic everywhere', bad === 0, `${bad} bad values`);
  check('negative xp still reads as rung 1', levelFromXp(-500) === 1);
  check('absurd xp caps at the top rung', levelFromXp(1e9) === LEVELS.max);
  check('rungOf clamps rather than throwing',
    rungOf(0).level === 1 && rungOf(99).level === LEVELS.max);

  const g = live();
  setLevel(g.a, 4);
  setLevel(g.b, 4);
  for (let i = 0; i < 6; i++) {
    g.b.alive = true; g.b.hp = PLAYER.maxHp; g.b.x = 0; g.b.z = 8; g.b.invulnUntil = 0;
    killWith(g, g.a, g.b);
    g.a.alive = true; g.a.hp = PLAYER.maxHp; g.a.x = 0; g.a.z = 0; g.a.invulnUntil = 0;
    killWith(g, g.b, g.a);
    if (g.a.level !== levelFromXp(g.a.xp) || g.b.level !== levelFromXp(g.b.xp)) {
      check('level always matches xp', false, `a ${g.a.level}/${g.a.xp}, b ${g.b.level}/${g.b.xp}`);
      break;
    }
  }
  check('level always matches xp through a long exchange',
    g.a.level === levelFromXp(g.a.xp) && g.b.level === levelFromXp(g.b.xp),
    `a ${g.a.level}/${g.a.xp}, b ${g.b.level}/${g.b.xp}`);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
