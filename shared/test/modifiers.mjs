// Match modifier test.
//
// Pure simulation, no server and no browser — modifiers are just multipliers
// over tuning constants, so each one is checked by running two identical worlds
// that differ only by the modifier and comparing what actually happened.
//
//   node shared/test/modifiers.mjs

import {
  createWorld, addPlayer, applyInput, stepWorld,
  MODIFIERS, MODIFIER_POOL, modValue, TICK_DT, PLAYER,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

/**
 * Two chickens, one shooting the other point blank, for `seconds`.
 * Identical setup every time so the only variable is the modifier.
 *
 * The world is forced past warmup: nobody can fire during it, so a short run
 * would otherwise measure nothing at all.
 */
function duel(modifier, seconds = 3, { keepAlive = false } = {}) {
  const world = createWorld({ mode: 'casual', seed: 12345, modifier });
  const a = addPlayer(world, { id: 'a', name: 'A', seat: 0 });
  const b = addPlayer(world, { id: 'b', name: 'B', seat: 1 });

  world.phase = 'live';
  world.time = 2;

  // Stand them a few units apart, facing each other, and remove spawn immunity.
  a.x = -2; a.z = 0; a.invulnUntil = 0;
  b.x = 2; b.z = 0; b.invulnUntil = 0;

  const tally = { shots: 0, hits: 0, kills: 0, damage: 0, blasts: 0, bomberSpawns: 0 };
  let firstHit = null;
  let firstBomberAt = null;

  for (let t = 0; t < seconds / TICK_DT; t++) {
    applyInput(world, 'a', { mx: 0, mz: 0, ax: 1, az: 0, shoot: true, seq: t });
    // Keeps the target upright so death and respawn don't reset the very
    // position and damage figures we're trying to measure.
    if (keepAlive) { b.hp = PLAYER.maxHp; b.invulnUntil = 0; }

    for (const e of stepWorld(world, TICK_DT)) {
      if (e.type === 'shot' && e.owner === 'a') tally.shots++;
      if (e.type === 'hit' && e.target === 'b') {
        tally.hits++;
        tally.damage += e.amount;
        firstHit ??= e.amount;
      }
      if (e.type === 'kill' && e.target === 'b') tally.kills++;
      if (e.type === 'blast') tally.blasts++;
      if (e.type === 'bomberSpawn') { tally.bomberSpawns++; firstBomberAt ??= world.time - 2; }
    }
  }
  return { world, a, b, tally, firstHit, firstBomberAt };
}

console.log('\n--- registry ---');
check('every pooled id exists in the registry',
  MODIFIER_POOL.every((id) => MODIFIERS[id]), MODIFIER_POOL.join(', '));
check('unknown modifiers fall back to 1x', modValue('nonsense', 'damageMul') === 1);
check('missing keys fall back to 1x', modValue('darkness', 'damageMul') === 1);

console.log('\n--- rolling ---');
const casualRolls = new Set();
for (let seed = 0; seed < 200; seed++) casualRolls.add(createWorld({ mode: 'casual', seed }).modifier);
check('casual rolls a variety', casualRolls.size >= 5, [...casualRolls].join(', '));
check('plain matches still happen', casualRolls.has('none'));
check('ranked never rolls a modifier',
  [...Array(60).keys()].every((seed) => createWorld({ mode: 'ranked', seed }).modifier === 'none'));
check('1v1 never rolls a modifier',
  [...Array(60).keys()].every((seed) => createWorld({ mode: 'duel', seed }).modifier === 'none'));
check('the same seed always rolls the same modifier',
  createWorld({ mode: 'casual', seed: 99 }).modifier === createWorld({ mode: 'casual', seed: 99 }).modifier);

console.log('\n--- effects ---');
const base = duel('none');
console.log(`  baseline: ${base.tally.shots} shots, ${base.tally.hits} hits, first hit ${base.firstHit}`);
check('baseline actually lands hits', base.tally.hits > 0 && base.firstHit > 0);

// Compare the FIRST hit: later ones get clamped to the target's remaining HP by
// damagePlayer, which drags any average below the true multiplier.
const dmg = duel('doubleDamage');
check('DOUBLE DAMAGE doubles damage per hit', dmg.firstHit === base.firstHit * 2,
  `${base.firstHit} -> ${dmg.firstHit} on the first hit`);

const sudden = duel('suddenDeath');
check('SUDDEN DEATH kills in one hit',
  sudden.tally.kills >= 1 && sudden.tally.hits === sudden.tally.kills,
  `${sudden.tally.hits} hits / ${sudden.tally.kills} kills, first hit ${sudden.firstHit}`);

const trig = duel('trigger');
check('TRIGGER HAPPY fires far more shots', trig.tally.shots > base.tally.shots * 2,
  `${base.tally.shots} -> ${trig.tally.shots} shots`);

const frenzy = duel('frenzy', 12);
const normal = duel('none', 12);
check('BOMBER FRENZY brings the bomber out sooner',
  frenzy.firstBomberAt != null && (normal.firstBomberAt == null || frenzy.firstBomberAt < normal.firstBomberAt),
  `frenzy ${frenzy.firstBomberAt?.toFixed(1)}s vs normal ${normal.firstBomberAt?.toFixed(1) ?? 'never'}s`);
check('BOMBER FRENZY spawns more of them', frenzy.tally.bomberSpawns > normal.tally.bomberSpawns,
  `${normal.tally.bomberSpawns} -> ${frenzy.tally.bomberSpawns}`);

// Knockback: how far the target gets pushed off its starting spot.
function knockbackTravel(modifier) {
  const { b } = duel(modifier, 3, { keepAlive: true });
  return Math.abs(b.x - 2);
}
const slide = knockbackTravel('lowGravity');
const normalSlide = knockbackTravel('none');
check('LOW GRAVITY sends chickens skating further', slide > normalSlide * 1.5,
  `${normalSlide.toFixed(2)}u -> ${slide.toFixed(2)}u`);

// DARKNESS is presentational only — the simulation must be identical.
const darkRun = duel('darkness');
check('LIGHTS OUT changes nothing in the simulation',
  darkRun.tally.shots === base.tally.shots
  && darkRun.tally.hits === base.tally.hits
  && darkRun.tally.damage === base.tally.damage,
  `${JSON.stringify(darkRun.tally)} vs ${JSON.stringify(base.tally)}`);

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
