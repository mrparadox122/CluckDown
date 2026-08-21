// Roles: six of them, four slots a side, one signature ability each.
//
// This file exists because roles rewrote the two things the whole simulation
// was previously allowed to assume, and both of them are silent when they break:
//
//   * PLAYER.maxHp was everybody's health. It is a role stat now, and every
//     place that clamped, healed or thresholded against the constant is a place
//     a Bruiser quietly caps at 100 or a Sniper is unkillable-adjacent.
//   * LEVELS.rungs handed out the perks. They come from the role's tier list
//     now, so a level-up that names nothing is a level-up that gives nothing —
//     and the banner would still fire, saying "LEVEL 4" and no more.
//
// The rest is the balance argument, asserted rather than hoped for:
//
//   * a Sniper that can move and shoot would win an eight-player match outright,
//     so the moving cone is checked directly (see the SNIPER note in roles.js)
//   * a Medic that can heal itself is the most survivable duellist in the game
//   * a dash that moves you when you asked for nothing is the knockback bug
//     wearing a better disguise — see PLAYER.maxKnockback
//   * uniqueness per team, and six-for-four, or the last picker has no choice
//
//   node shared/test/roles.mjs

import {
  createWorld, addPlayer, applyInput, stepWorld, beginMatch, setRole, useAbility,
  freeRoles, resolveRole, roleValue, roleTier, roleDamage, maxHpOf, abilityMax,
  damagePlayer, revealedTo, padsFor, assignBotRole, initBot, stepBots,
  ROLES, ROLE_LIST, ROLE_SLOTS, roleDef,
  LEVELS, PLAYER, BULLET, TICK_DT, CROP, SPREAD, cropCapacity,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

/** A live 4v4 with `n` seats filled, nobody's role forced. */
function live(n = 8, mode = 'casual') {
  const w = createWorld({ mode, seed: 91, modifier: 'none' });
  w.bomberSpawnAt = Infinity; // a bomb wandering through a duel is not a role test
  for (let seat = 0; seat < n; seat++) {
    addPlayer(w, { id: `p${seat}`, name: `P${seat}`, seat });
  }
  beginMatch(w, 'coop');
  for (let t = 0; t < 300 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  return w;
}

/** Two chickens on opposite sides, in the roles named, facing each other. */
function duel(roleA, roleB, gap = 8) {
  const w = createWorld({ mode: 'casual', seed: 91, modifier: 'none' });
  w.bomberSpawnAt = Infinity;
  const a = addPlayer(w, { id: 'a', name: 'A', seat: 0, role: roleA });
  const b = addPlayer(w, { id: 'b', name: 'B', seat: 1, role: roleB });
  beginMatch(w, 'coop');
  for (let t = 0; t < 300 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  a.x = 0; a.z = 0; a.invulnUntil = 0;
  b.x = 0; b.z = gap; b.invulnUntil = 0;
  return { w, a, b };
}

const setLevel = (p, level) => {
  p.xp = (level - 1) * LEVELS.step;
  p.level = level;
};

/**
 * Milliseconds for `a` to kill `b`, measured rather than calculated.
 *
 * Stationary and point-blank on purpose: this is the gun's time to kill, and
 * anything else measures the movement cone instead.
 */
function ttk({ w, a, b }, { head = false } = {}) {
  const yaw = Math.atan2(b.x - a.x, b.z - a.z);
  // Aim at the neck or the body. headFrom is measured from the target's feet.
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const eye = PLAYER.eyeHeight;
  const at = head ? BULLET.headFrom + 0.22 : PLAYER.hitHeight * 0.4;
  const pitch = Math.atan2(at - eye, d);

  let firstAt = null;
  let killAt = null;
  for (let t = 0; t < 6 / TICK_DT && killAt === null; t++) {
    a.crop = 99;
    a.dry = false;
    b.invulnUntil = 0;
    applyInput(w, 'a', {
      mx: 0, mz: 0, ax: Math.sin(yaw), az: Math.cos(yaw), pitch, shoot: true, seq: t,
    });
    for (const e of stepWorld(w, TICK_DT)) {
      if (e.type === 'hit' && e.target === 'b' && firstAt === null) firstAt = w.time;
      if (e.type === 'kill' && e.target === 'b') killAt = w.time;
    }
  }
  if (killAt === null) return null;
  // FIRST round that landed to the one that killed. Not from the first trigger
  // pull — the wait for the trigger is the fire rate, not the time to kill —
  // and not to the end of the loop, which would bill a tick that happened after
  // the chicken was already dead.
  return Math.round((killAt - firstAt) * 1000);
}

// ------------------------------------------------------------- the registry
console.log('\n--- six roles, four slots ---');
{
  check('six roles for four slots a side',
    ROLE_LIST.length === 6 && ROLE_SLOTS === 4,
    `${ROLE_LIST.length} roles, ${ROLE_SLOTS} slots`);
  // The fourth picker on a full side still has two roles to choose between.
  // At five they would have one, which is not a decision; at four, none.
  check('...so the last picker still has a real choice',
    ROLE_LIST.length - (ROLE_SLOTS - 1) >= 2,
    `${ROLE_LIST.length - (ROLE_SLOTS - 1)} left for the fourth pick`);

  check('every listed role exists', ROLE_LIST.every((id) => ROLES[id]));
  check('every role has a one-line answer to "what am I for"',
    ROLE_LIST.every((id) => !!ROLES[id].what && !!ROLES[id].blurb));
  check('...and they are all different answers',
    new Set(ROLE_LIST.map((id) => ROLES[id].what)).size === ROLE_LIST.length,
    ROLE_LIST.map((id) => ROLES[id].what).join(' / '));
  check('every role has its own colour and icon',
    new Set(ROLE_LIST.map((id) => ROLES[id].color)).size === ROLE_LIST.length
    && new Set(ROLE_LIST.map((id) => ROLES[id].icon)).size === ROLE_LIST.length);
  check('every role has one signature ability',
    ROLE_LIST.every((id) => typeof ROLES[id].ability === 'string' && ROLES[id].ability));
  check('unknown roles fall back rather than throwing',
    roleDef('nonsense').id === 'runner' && maxHpOf({ role: 'nonsense', level: 1 }) > 0);
}

console.log('\n--- every tier names what it gave you ---');
{
  // A level-up with nothing behind it is a number, and a number is not a
  // reward. The banner reads `perk` and `blurb` straight off these.
  let bad = 0;
  for (const id of ROLE_LIST) {
    for (let level = 1; level <= LEVELS.max; level++) {
      const tier = roleTier(id, level);
      if (!tier?.perk || !tier?.blurb) {
        check(`${id} tier ${level} names something`, false, tier?.perk ?? 'nothing');
        bad++;
      }
    }
  }
  check('all six ladders name every rung', bad === 0, `${bad} silent tiers`);

  // The five classics survived the move — they are live mechanisms with sound
  // and colour already attached, and deleting them to make room would have
  // thrown away the good part.
  const perks = ROLE_LIST.flatMap((id) => ROLES[id].tiers.map((t) => t.perk));
  for (const classic of ['Quick Crop', 'Long Legs', 'Rapid Peck', 'Second Wind', 'Feeding Frenzy']) {
    check(`${classic} is still somebody's perk`, perks.includes(classic));
  }

  // Cumulative, the same way the old rungs were: reaching tier 5 keeps tier 2.
  check('a role value walks down its tiers rather than reading one',
    roleValue('bruiser', LEVELS.max, 'hp') > roleValue('bruiser', 1, 'hp'),
    `${roleValue('bruiser', 1, 'hp')} -> ${roleValue('bruiser', LEVELS.max, 'hp')}`);
  check('...and a tier that names nothing leaves the value alone',
    // Bruiser tier 3 sets bulwark, not hp, so hp holds at tier 2's value.
    roleValue('bruiser', 3, 'hp') === roleValue('bruiser', 2, 'hp'),
    String(roleValue('bruiser', 3, 'hp')));
}

// ------------------------------------------------------------- uniqueness
console.log('\n--- unique per team ---');
{
  const w = live();
  const roles = [...w.players.values()].map((p) => `${p.team}:${p.role}`);
  console.log(`  the roster: ${roles.join(', ')}`);

  for (const team of [0, 1]) {
    const side = [...w.players.values()].filter((p) => p.team === team).map((p) => p.role);
    check(`team ${team} has four distinct roles`,
      side.length === 4 && new Set(side).size === 4, side.join(', '));
  }
  // Uniqueness is per SIDE, not per match — both teams should be able to field
  // a Medic, or half the roles would be unavailable to whoever picked second.
  const blue = new Set([...w.players.values()].filter((p) => p.team === 0).map((p) => p.role));
  const red = [...w.players.values()].filter((p) => p.team === 1).map((p) => p.role);
  check('the other team may hold the same roles', red.some((r) => blue.has(r)),
    `blue ${[...blue].join('/')} vs red ${red.join('/')}`);

  const mate = [...w.players.values()].find((p) => p.team === 0 && p.id !== 'p0');
  check('a role a team-mate holds is refused',
    setRole(w, 'p0', mate.role) === null, mate.role);
  const free = freeRoles(w, 0, 'p0');
  check('...and a free one is accepted', free.length > 0 && !!setRole(w, 'p0', free[0]), free.join(','));
  check('nonsense is refused rather than assigned', setRole(w, 'p0', 'wizard') === null);

  // Free-for-all has no composition to protect. Duel is the only mode without
  // teams, and refusing the second player a role for the first player's sake
  // would be nonsense.
  const d = createWorld({ mode: 'duel', seed: 4, modifier: 'none' });
  addPlayer(d, { id: 'a', name: 'A', seat: 0, role: 'sniper' });
  addPlayer(d, { id: 'b', name: 'B', seat: 1, role: 'sniper' });
  check('free-for-all lets both players hold the same role',
    d.players.get('a').role === 'sniper' && d.players.get('b').role === 'sniper');
  // ...but does not offer the two roles that only do something for a TEAM. A
  // Medic in a 1v1 is nothing but -30% damage and -15% speed.
  const solo = freeRoles(d, null);
  check('free-for-all does not offer the team-only roles',
    !solo.includes('medic') && !solo.includes('scout'), solo.join(','));
  check('...and still leaves a real choice', solo.length >= 3, `${solo.length} offered`);
}

console.log('\n--- the picker never costs you a respawn ---');
{
  const w = live();
  const me = w.players.get('p0');
  const was = me.role;

  // Doing NOTHING keeps what you had. This is the entire UX rule: default to
  // the last role, keep it if it is free, respawn on time.
  check('resolveRole keeps a role you already hold', resolveRole(w, me, null) === was);
  check('...and honours what you asked for when it is free',
    resolveRole(w, me, freeRoles(w, 0, 'p0')[0]) === freeRoles(w, 0, 'p0')[0]);
  // Six for four means there is ALWAYS something left, so the picker can never
  // deadlock a player out of spawning at all.
  check('there is always a role left to hand out', freeRoles(w, 0, 'p0').length >= 2,
    `${freeRoles(w, 0, 'p0').length} free`);

  // Picking while ALIVE is a request, not a swap: changing max health in the
  // middle of a fight that is already happening is not something to do to
  // someone.
  const want = freeRoles(w, 0, 'p0')[0];
  setRole(w, 'p0', want);
  check('a live pick does not change the gun under you', me.role === was, `${me.role}`);
  check('...but it is queued', me.wantRole === want);

  me.alive = false;
  me.hp = 0;
  me.respawnAt = 0;
  stepWorld(w, TICK_DT);
  check('...and lands on the next respawn', me.alive && me.role === want, me.role);
  check('...at the new role’s full health', me.hp === maxHpOf(me), `${me.hp}/${maxHpOf(me)}`);
}

// --------------------------------------------------------------- the stats
console.log('\n--- time to kill, per role ---');
{
  // Against an ordinary 100 HP chicken, stationary, point blank. The numbers
  // are the point: report them, do not assert a window nobody agreed to.
  const rows = [];
  for (const id of ROLE_LIST) {
    const body = ttk(duel(id, 'engineer'), { head: false });
    const head = ttk(duel(id, 'engineer'), { head: true });
    const dmg = roleDamage({ role: id, level: 1 }, false, 4);
    const shots = Math.ceil(100 / dmg);
    rows.push({ id, body, head, dmg: Math.round(dmg * 10) / 10, shots });
  }
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(9)} ${String(r.dmg).padStart(5)} dmg  ${r.shots} shots  `
      + `body ${r.body === null ? '  n/a' : `${String(r.body).padStart(4)}ms`}`
      + `  head ${r.head === null ? '  n/a' : `${String(r.head).padStart(4)}ms`}`);
  }
  check('every role can actually kill someone', rows.every((r) => r.body !== null),
    rows.filter((r) => r.body === null).map((r) => r.id).join(',') || 'all six');
  check('a headshot is never slower than a body shot',
    rows.every((r) => r.head === null || r.body === null || r.head <= r.body));

  // The Sniper is the one number worth a hard assertion: it is the role that
  // breaks the match if it is wrong in either direction.
  const sniper = rows.find((r) => r.id === 'sniper');
  check('a Sniper headshot kills outright', sniper.head === 0, `${sniper.head}ms`);
  check('...but a Sniper BODY shot does not', sniper.shots >= 2, `${sniper.shots} shots`);
}

console.log('\n--- health belongs to the role ---');
{
  for (const id of ROLE_LIST) {
    const hp = maxHpOf({ role: id, level: 1 });
    console.log(`  ${id.padEnd(9)} ${hp} hp`);
  }
  check('the Bruiser is the toughest',
    ROLE_LIST.every((id) => id === 'bruiser' || maxHpOf({ role: id, level: 1 }) < maxHpOf({ role: 'bruiser', level: 1 })));
  check('the Sniper is the softest',
    ROLE_LIST.every((id) => id === 'sniper' || maxHpOf({ role: id, level: 1 }) > maxHpOf({ role: 'sniper', level: 1 })));
  // uint8 on the wire. 256 would arrive as 0, which is a chicken that is
  // permanently dead and a bug nobody would look for in a tier table.
  check('no tier exceeds what the schema can carry',
    ROLE_LIST.every((id) => maxHpOf({ role: id, level: LEVELS.max }) <= 255),
    String(Math.max(...ROLE_LIST.map((id) => maxHpOf({ role: id, level: LEVELS.max })))));

  // A promotion that raises max health has to hand over the difference, or the
  // reward is a number with nothing behind it.
  const { w, a } = duel('bruiser', 'engineer');
  a.hp = maxHpOf(a);
  const before = maxHpOf(a);
  a.xp = LEVELS.step - 1;
  a.level = 1;
  damagePlayer(w, w.players.get('b'), 999, 'a', 'bullet'); // a kill, so XP moves
  console.log(`  bruiser promoted: ${before} -> ${maxHpOf(a)} max, now on ${Math.round(a.hp)}`);
  check('levelling into more health actually gives you the health',
    a.level > 1 && a.hp === maxHpOf(a), `${a.hp}/${maxHpOf(a)} at level ${a.level}`);

  // The feeder heals to the ROLE's max, not to 100.
  const g = duel('bruiser', 'engineer');
  g.a.hp = 40;
  g.a.lastHurtAt = -99;
  const feeder = g.w.arena.half - 3.5;
  g.a.x = -feeder; g.a.z = 0; // the blue rally pad
  for (let t = 0; t < 12 / TICK_DT && g.a.hp < maxHpOf(g.a); t++) {
    applyInput(g.w, 'a', { mx: 0, mz: 0, seq: t });
    stepWorld(g.w, TICK_DT);
  }
  check('the feeder fills a Bruiser to 180, not to 100',
    g.a.hp >= maxHpOf(g.a) - 1, `${Math.round(g.a.hp)}/${maxHpOf(g.a)}`);
}

// ------------------------------------------------------------- the sniper
console.log('\n--- the Sniper is only a Sniper standing still ---');
{
  // *** THE BALANCE TRAP. *** A hitscan one-shot-kill with no travel time and
  // no accuracy cost wins an eight-player match on its own. The stationary
  // requirement is what makes it fair, so it is asserted directly rather than
  // trusted to a constant.
  const still = roleValue('sniper', 1, 'spreadMul');
  // SPREAD.still is exactly zero, and any multiplier on zero is still zero —
  // which is what keeps first-shot accuracy exact for EVERY role, including the
  // one whose whole balance is a movement penalty.
  check('a stopped Sniper is exactly pinpoint, not nearly',
    SPREAD.still * still === 0 && SPREAD.still === 0);

  const g = duel('sniper', 'engineer', 20);
  const yaw = Math.atan2(g.b.x - g.a.x, g.b.z - g.a.z);
  const run = (mx, mz) => {
    let hits = 0;
    let shots = 0;
    for (let t = 0; t < 14 / TICK_DT; t++) {
      g.a.crop = 99; g.a.dry = false;
      g.b.hp = 100; g.b.invulnUntil = 0; g.b.alive = true;
      applyInput(g.w, 'a', {
        mx, mz, ax: Math.sin(yaw), az: Math.cos(yaw), pitch: 0, shoot: true, seq: t,
      });
      for (const e of stepWorld(g.w, TICK_DT)) {
        if (e.type === 'shot' && e.owner === 'a') shots++;
        if (e.type === 'hit' && e.target === 'b') hits++;
      }
    }
    return { hits, shots };
  };
  const stopped = run(0, 0);
  const moving = run(1, 0);
  console.log(`  at 20 units: stopped ${stopped.hits}/${stopped.shots} hit, `
    + `sprinting ${moving.hits}/${moving.shots}`);
  check('a stopped Sniper hits everything it fires', stopped.hits === stopped.shots,
    `${stopped.hits}/${stopped.shots}`);
  check('a sprinting Sniper mostly hits the wall',
    moving.shots > 0 && moving.hits / moving.shots < 0.35,
    `${moving.hits}/${moving.shots}`);
  check('the moving cone is far worse than anyone else’s', still > 2, `${still}x`);

  // The Bruiser is the answer to the Sniper, and that is the whole reason 180
  // health is worth having.
  const head = roleDamage({ role: 'sniper', level: 1 }, true, 20);
  console.log(`  a Sniper headshot does ${Math.round(head)}`);
  check('a Sniper headshot kills every role except the Bruiser',
    ROLE_LIST.every((id) => (id === 'bruiser'
      ? head < maxHpOf({ role: id, level: 1 })
      : head >= maxHpOf({ role: id, level: 1 }))),
    ROLE_LIST.filter((id) => head < maxHpOf({ role: id, level: 1 })).join(',') || 'none survive');
}

// ------------------------------------------------------------ the bruiser
console.log('\n--- the Bruiser cannot shoot across the map ---');
{
  const near = roleDamage({ role: 'bruiser', level: 1 }, false, 4);
  const far = roleDamage({ role: 'bruiser', level: 1 }, false, 30);
  console.log(`  bruiser damage: ${near.toFixed(1)} up close, ${far.toFixed(1)} at 30 units`);
  check('falloff really falls off', far < near * 0.5, `${near.toFixed(1)} -> ${far.toFixed(1)}`);
  check('...but never to nothing — a bad choice, not an unarmed one', far > 0);
  check('nobody else has falloff',
    ROLE_LIST.filter((id) => id !== 'bruiser')
      .every((id) => roleDamage({ role: id, level: 1 }, false, 40)
        === roleDamage({ role: id, level: 1 }, false, 1)));

  // Bulwark fires once per life at the threshold, like Second Wind — a perk you
  // notice happening is worth several you merely have.
  const { w, a } = duel('bruiser', 'engineer');
  const bw = roleValue('bruiser', 1, 'bulwark');
  a.hp = maxHpOf(a);
  applyInput(w, 'a', { mx: 0, mz: 0, seq: 1 });
  stepWorld(w, TICK_DT);
  check('Bulwark does not fire at full health', a.bulwarkUntil === 0);

  let fired = 0;
  for (let t = 0; t < 0.5 / TICK_DT; t++) {
    a.hp = Math.max(1, maxHpOf(a) * bw.at - 1);
    applyInput(w, 'a', { mx: 0, mz: 0, seq: 10 + t });
    for (const e of stepWorld(w, TICK_DT)) if (e.type === 'bulwark') fired++;
  }
  check('Bulwark fires when the Bruiser drops low', fired === 1, `${fired} times`);

  a.hp = maxHpOf(a);
  a.bulwarkUntil = w.time + 5;
  const before = a.hp;
  damagePlayer(w, a, 40, null, 'bullet');
  const took = before - a.hp;
  console.log(`  40 damage into Bulwark landed as ${took.toFixed(1)}`);
  check('Bulwark reduces what reaches you', took < 40 * 0.8, `${took.toFixed(1)}`);
  // Applied in damagePlayer rather than in fire(), so it covers blasts and the
  // zone too — "harder to kill" must not come with a list of exceptions.
  const beforeZone = a.hp;
  damagePlayer(w, a, 20, null, 'zone');
  check('...including damage that is not a bullet', beforeZone - a.hp < 20 * 0.8,
    `${(beforeZone - a.hp).toFixed(1)}`);
}

// -------------------------------------------------------------- the medic
console.log('\n--- the Medic heals the roost and never itself ---');
{
  const w = live();
  const medic = [...w.players.values()].find((p) => p.team === 0) ?? null;
  setRole(w, medic.id, 'medic');
  medic.role = 'medic';
  medic.pulseAt = 0;
  const mate = [...w.players.values()].find((p) => p.team === 0 && p.id !== medic.id);
  const foe = [...w.players.values()].find((p) => p.team === 1);

  // Everyone in one place, so the radius is not what is under test.
  medic.x = 0; medic.z = 0;
  mate.x = 1.5; mate.z = 0;
  foe.x = -1.5; foe.z = 0;
  medic.hp = 40;
  mate.hp = 40;
  foe.hp = 40;

  let healEvents = 0;
  for (let t = 0; t < 4 / TICK_DT; t++) {
    for (const p of w.players.values()) applyInput(w, p.id, { mx: 0, mz: 0, seq: t });
    for (const e of stepWorld(w, TICK_DT)) if (e.type === 'healed') healEvents++;
  }
  console.log(`  four seconds of pulsing: medic ${Math.round(medic.hp)}, `
    + `mate ${Math.round(mate.hp)}, enemy ${Math.round(foe.hp)} (${healEvents} heals)`);
  check('the pulse heals a team-mate', mate.hp > 40, `${Math.round(mate.hp)}`);
  // THE RULE THAT KEEPS IT A TEAM ROLE. A self-healing Medic is simply the most
  // survivable duellist in the match.
  check('the Medic cannot heal itself', medic.hp === 40, `${Math.round(medic.hp)}`);
  check('...and never heals the other side', foe.hp === 40, `${Math.round(foe.hp)}`);
  check('the healing is credited to the Medic', medic.healGiven > 0, `${medic.healGiven}`);
  check('a Medic hits less hard than an ordinary chicken',
    roleDamage({ role: 'medic', level: 1 }, false, 5) < BULLET.damage);
}

// -------------------------------------------------------------- the runner
console.log('\n--- the dash never takes the wheel ---');
{
  // TRAP 1, WRITTEN AS A TEST. Knockback that moved a player against their
  // input was a real reported bug (see PLAYER.maxKnockback), and a dash is the
  // most obvious place to reintroduce it. So: no heading, no dash.
  const { w, a } = duel('runner', 'engineer');
  a.x = 0; a.z = 0;
  applyInput(w, 'a', { mx: 0, mz: 0, seq: 1 });
  stepWorld(w, TICK_DT);
  const refused = useAbility(w, 'a');
  check('a dash from a standstill is refused outright', refused === null, String(refused));
  check('...and the chicken has not moved', Math.abs(a.x) < 1e-6 && Math.abs(a.z) < 1e-6);

  // With a heading it fires, and it goes exactly where the player asked.
  applyInput(w, 'a', { mx: 1, mz: 0, seq: 2 });
  stepWorld(w, TICK_DT);
  check('a dash with a heading fires', useAbility(w, 'a') === 'dash');
  const startX = a.x;
  const startZ = a.z;
  for (let t = 0; t < 0.3 / TICK_DT; t++) {
    applyInput(w, 'a', { mx: 1, mz: 0, seq: 10 + t });
    stepWorld(w, TICK_DT);
  }
  console.log(`  dashed ${(a.x - startX).toFixed(2)}u along the heading, `
    + `${Math.abs(a.z - startZ).toFixed(3)}u sideways`);
  check('the dash goes the way you were already going', a.x - startX > 1.5);
  check('...and nowhere else', Math.abs(a.z - startZ) < 0.05, `${(a.z - startZ).toFixed(3)}u`);

  // Charges, not a flat cooldown — Double Dash is only a different thing from a
  // shorter cooldown if the second charge can be held.
  const g = duel('runner', 'engineer');
  setLevel(g.a, 4);
  g.a.abilityCharges = abilityMax(g.a);
  console.log(`  a level 4 Runner holds ${abilityMax(g.a)} dash charges`);
  check('the ladder buys more charges', abilityMax(g.a) > abilityMax({ role: 'runner', level: 1 }),
    `${abilityMax({ role: 'runner', level: 1 })} -> ${abilityMax(g.a)}`);
  applyInput(g.w, 'a', { mx: 1, mz: 0, seq: 1 });
  stepWorld(g.w, TICK_DT);
  check('two dashes back to back',
    useAbility(g.w, 'a') === 'dash' && useAbility(g.w, 'a') === 'dash');
  check('...and not a third', useAbility(g.w, 'a') === null);

  // Fast, fragile, and low damage per round: the trade that defines the role.
  check('a Runner is the quickest on its feet', ROLE_LIST.filter((id) => id !== 'runner')
    .every((id) => roleValue(id, 1, 'speedMul') < roleValue('runner', 1, 'speedMul')));
  check('...and on the trigger', ROLE_LIST.filter((id) => id !== 'runner')
    .every((id) => roleValue(id, 1, 'fireCooldownMul') > roleValue('runner', 1, 'fireCooldownMul')));
  // Lightest rounds in the game, tied with the Medic. Its damage per SECOND is
  // ordinary — see the damageMul note in roles.js for why it is not lower.
  check('...while its rounds are the lightest in the game',
    ROLE_LIST.every((id) => roleDamage({ role: id, level: 1 }, false, 5)
      >= roleDamage({ role: 'runner', level: 1 }, false, 5)));
  check('...at an ordinary damage per second',
    Math.abs(roleDamage({ role: 'runner', level: 1 }, false, 5) / roleValue('runner', 1, 'fireCooldownMul')
      - BULLET.damage) < BULLET.damage * 0.15,
    `${(roleDamage({ role: 'runner', level: 1 }, false, 5) / roleValue('runner', 1, 'fireCooldownMul')).toFixed(1)} vs ${BULLET.damage}`);
}

// --------------------------------------------------------------- the scout
console.log('\n--- the Scout tells the whole roost ---');
{
  const w = live();
  const scout = [...w.players.values()].find((p) => p.team === 0);
  setRole(w, scout.id, 'scout');
  scout.role = 'scout';
  scout.sweepAt = 0;
  const mate = [...w.players.values()].find((p) => p.team === 0 && p.id !== scout.id);
  const foe = [...w.players.values()].find((p) => p.team === 1);
  scout.x = 0; scout.z = 0;
  foe.x = 6; foe.z = 0;

  let swept = null;
  for (let t = 0; t < 1 / TICK_DT && !swept; t++) {
    for (const p of w.players.values()) applyInput(w, p.id, { mx: 0, mz: 0, seq: t });
    for (const e of stepWorld(w, TICK_DT)) if (e.type === 'sweep') swept = e;
  }
  check('the sweep fires when there is somebody to find', !!swept, swept ? `${swept.found} found` : 'never');
  check('the enemy is revealed to the Scout', revealedTo(w, foe, scout));
  // Team-level, not per-pair-of-eyes: information the roost gets at once.
  check('...and to their team-mates too', revealedTo(w, foe, mate));
  check('...and never to the side being revealed', !revealedTo(w, scout, foe));
  check('team-mates are not "revealed" to each other', !revealedTo(w, mate, scout));

  // It will not SPEND itself on an empty corridor. A reveal that lights up
  // nobody has burned the cooldown and told the team nothing.
  const q = live();
  const lone = [...q.players.values()].find((p) => p.team === 0);
  setRole(q, lone.id, 'scout');
  lone.role = 'scout';
  lone.sweepAt = 0;
  for (const p of q.players.values()) if (p.team === 1) p.alive = false;
  let fired = false;
  for (let t = 0; t < 1 / TICK_DT; t++) {
    applyInput(q, lone.id, { mx: 0, mz: 0, seq: t });
    for (const e of stepWorld(q, TICK_DT)) if (e.type === 'sweep') fired = true;
  }
  check('a sweep with nothing to find holds its charge', !fired);
}

// ------------------------------------------------------------ the engineer
console.log('\n--- the Engineer moves where "safe" is ---');
{
  const w = live();
  const eng = [...w.players.values()].find((p) => p.team === 0);
  setRole(w, eng.id, 'engineer');
  eng.role = 'engineer';
  eng.abilityCharges = abilityMax(eng);
  const mate = [...w.players.values()].find((p) => p.team === 0 && p.id !== eng.id);
  const foe = [...w.players.values()].find((p) => p.team === 1);

  eng.x = 0; eng.z = 0;
  check('the Engineer drops a pad', useAbility(w, eng.id) === 'pad');
  check('...and not two in a row', useAbility(w, eng.id) === null);
  check('the pad is on the floor where they stood',
    w.pads.length === 1 && Math.abs(w.pads[0].x) < 1e-6);
  check('team-mates can use it', padsFor(w, mate.id).length === 1);
  check('the other side cannot', padsFor(w, foe.id).length === 0);

  // It is the same mechanic as the rally pad, which is the point: a player who
  // has learned "stand on the disc" needs no second lesson.
  mate.x = 0; mate.z = 0;
  mate.hp = 30;
  mate.crop = 0;
  mate.dry = true;
  mate.lastHurtAt = -99;
  for (let t = 0; t < 3 / TICK_DT; t++) {
    applyInput(w, mate.id, { mx: 0, mz: 0, seq: t });
    stepWorld(w, TICK_DT);
  }
  console.log(`  three seconds on a field feeder: ${Math.round(mate.hp)} hp, `
    + `${Math.floor(mate.crop)}/${cropCapacity(w.modifier)} grain`);
  check('standing on it refills grain', mate.crop >= CROP.recoverTo, `${Math.floor(mate.crop)}`);
  check('...and heals, out of combat', mate.hp > 30, `${Math.round(mate.hp)}`);

  // And it times out rather than holding a lane forever.
  const life = roleValue('engineer', 1, 'pad').seconds;
  for (let t = 0; t < (life + 1) / TICK_DT && w.pads.length; t++) {
    stepWorld(w, TICK_DT);
  }
  check('the pad expires', w.pads.length === 0, `after ~${life}s`);
}

// ----------------------------------------------------------------- friendly
console.log('\n--- friendly fire is still off ---');
{
  // TRAP 6. A Medic and a Sniper on the same side make teamkill grief far more
  // likely, so this is asserted here rather than assumed to have stayed true.
  const w = live();
  const a = [...w.players.values()].find((p) => p.team === 0);
  const mate = [...w.players.values()].find((p) => p.team === 0 && p.id !== a.id);
  a.role = 'sniper';
  a.x = 0; a.z = 0;
  mate.x = 0; mate.z = 6; mate.invulnUntil = 0;
  const before = mate.hp;
  for (let t = 0; t < 2 / TICK_DT; t++) {
    a.crop = 99; a.dry = false;
    applyInput(w, a.id, { mx: 0, mz: 0, ax: 0, az: 1, pitch: 0, shoot: true, seq: t });
    stepWorld(w, TICK_DT);
  }
  check('a Sniper cannot shoot its own Medic', mate.hp === before, `${mate.hp}/${before}`);
}

// --------------------------------------------------------------------- bots
console.log('\n--- bots pick roles and play them ---');
{
  const w = createWorld({ mode: 'casual', seed: 12, modifier: 'none' });
  w.bomberSpawnAt = Infinity;
  for (let seat = 0; seat < 8; seat++) {
    const p = addPlayer(w, { id: `b${seat}`, name: `B${seat}`, seat, isBot: true });
    initBot(p, 'normal');
    assignBotRole(w, p);
  }
  beginMatch(w, 'coop');
  for (let t = 0; t < 300 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);

  for (const team of [0, 1]) {
    const side = [...w.players.values()].filter((p) => p.team === team).map((p) => p.role);
    check(`bot team ${team} respects uniqueness`,
      new Set(side).size === side.length, side.join(', '));
  }
  console.log(`  bot roster: ${[...w.players.values()].map((p) => p.role).join(', ')}`);

  // A Sniper bot must STOP to fire, or it spends the match spraying a 17-degree
  // cone and reads as broken rather than as outgunned.
  const sniper = [...w.players.values()].find((p) => p.team === 0);
  setRole(w, sniper.id, 'sniper');
  sniper.role = 'sniper';
  let firedMoving = 0;
  let firedStill = 0;
  for (let t = 0; t < 8 / TICK_DT; t++) {
    stepBots(w, TICK_DT);
    const moving = Math.hypot(sniper.input.mx, sniper.input.mz) > 0.1;
    for (const e of stepWorld(w, TICK_DT)) {
      if (e.type !== 'shot' || e.owner !== sniper.id) continue;
      if (moving) firedMoving++; else firedStill++;
    }
  }
  console.log(`  a Sniper bot fired ${firedStill} standing, ${firedMoving} on the move`);
  check('a Sniper bot stops before it shoots', firedMoving === 0,
    `${firedMoving} moving shots`);

  // A Medic bot has to be near the people it is meant to be healing.
  const m = createWorld({ mode: 'casual', seed: 33, modifier: 'none' });
  m.bomberSpawnAt = Infinity;
  for (let seat = 0; seat < 8; seat++) {
    const p = addPlayer(m, { id: `m${seat}`, name: `M${seat}`, seat, isBot: true });
    initBot(p, 'normal');
  }
  beginMatch(m, 'coop');
  for (let t = 0; t < 300 && m.phase !== 'live'; t++) stepWorld(m, TICK_DT);
  const medic = [...m.players.values()].find((p) => p.team === 0);
  const patient = [...m.players.values()].find((p) => p.team === 0 && p.id !== medic.id);
  setRole(m, medic.id, 'medic');
  medic.role = 'medic';
  medic.x = 20; medic.z = 0;
  patient.x = -10; patient.z = 0;
  patient.hp = 30;
  const startGap = Math.hypot(medic.x - patient.x, medic.z - patient.z);
  for (let t = 0; t < 4 / TICK_DT; t++) {
    patient.hp = 30; // held hurt, so the errand does not resolve itself
    stepBots(m, TICK_DT);
    stepWorld(m, TICK_DT);
  }
  const endGap = Math.hypot(medic.x - patient.x, medic.z - patient.z);
  console.log(`  a Medic bot closed on a hurt mate: ${startGap.toFixed(1)}u -> ${endGap.toFixed(1)}u`);
  check('a Medic bot goes to the chicken that needs it', endGap < startGap,
    `${startGap.toFixed(1)} -> ${endGap.toFixed(1)}`);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed` : '\n✓ all checks passed');
process.exit(failures.length ? 1 : 0);
