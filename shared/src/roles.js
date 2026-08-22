// Roles: what you are for, and what the ladder gives you for being it.
//
// Six roles, four slots a side. That ratio is the whole design: the fourth
// player to pick still has two real options, so nobody is ever handed the
// leftover. Fewer than five and the last picker has no decision at all, which
// is the same as not having a picker.
//
// UNIQUE PER TEAM. One Medic, one Sniper. Uniqueness is what turns a pick into
// a team composition rather than four people choosing the strongest thing.
//
// Each role carries base stat modifiers AND one signature ability, and the
// one-sentence answer to "what am I for" is different for every one of them:
//
//   MEDIC     keeps the roost alive          SNIPER    deletes one chicken
//   RUNNER    gets there first               BRUISER   walks into the room
//   SCOUT     says where they are            ENGINEER  holds the ground
//
// THE LADDER RUNS THROUGH HERE NOW. LEVELS in constants.js still owns the XP
// curve, the climb/fall asymmetry and all three death-spiral guards — none of
// that changed. What changed is where a rung's PERK comes from: it used to be
// the same five for everybody, and it is now the tier list of whatever role you
// are holding. One level, applied to your current role; levels are deliberately
// NOT per-role, because a four-minute match would never reach an interesting
// tier on any of them.
//
// The classic five perks are still in here — Quick Crop, Long Legs, Rapid Peck,
// Second Wind, Feeding Frenzy — one apiece, spread across the six ladders where
// each fits the role. They are live mechanisms in the simulation with sound and
// colour attached, and deleting them to make room would have been throwing away
// the good part.
//
// Dependency-free like the rest of shared/. This file is a tuning table with
// helpers under it: the numbers at the top are the ones to move.

import { PLAYER, BULLET, LEVELS, ROTATION } from './constants.js';
import { clamp } from './math.js';

/**
 * The six.
 *
 * Base stats are the role's identity; `tiers[0..5]` are levels 1..6 and may
 * override any of them. A tier value REPLACES rather than stacks, and the walk
 * takes the last one defined at or below your level — so reaching tier 5 keeps
 * whatever tier 2 set, exactly like the old rung perks did.
 *
 *   hp                max health, replacing PLAYER.maxHp
 *   speedMul          on PLAYER.speed
 *   damageMul         on BULLET.damage AND BULLET.headDamage together
 *   fireCooldownMul   on PLAYER.fireCooldown (bigger is slower)
 *   spreadMul         on the movement cone — the accuracy cost of moving
 *   falloff           damage by distance, for the roles that have one
 */
export const ROLES = {
  // ------------------------------------------------------------------ MEDIC
  //
  // The one the user asked for by name. It heals in PULSES on a timer rather
  // than on a button, which is deliberate: a support that has to be aimed is a
  // support nobody plays on a phone, and a heal you have to remember is dead
  // time in a fight.
  //
  // CANNOT SELF-HEAL, and that single rule is what keeps it a team role instead
  // of the most survivable duellist in the match. A Medic alone is the weakest
  // chicken on the field; a Medic behind a Bruiser is what makes the push work.
  medic: {
    id: 'medic',
    name: 'Medic',
    icon: '✚',
    color: '#5ee08a',
    blurb: 'Pulse-heals the roost around you. Never yourself.',
    what: 'Keeps them alive',
    // Nothing to heal in a free-for-all. Offering it in a 1v1 would be offering
    // a role that is nothing but −30% damage and −15% speed, which is a trap
    // rather than a choice. See freeRoles.
    teamOnly: true,
    hp: 100,
    speedMul: 0.85,
    damageMul: 0.70,
    fireCooldownMul: 1,
    ability: 'pulse',
    tiers: [
      { perk: 'Pulse', blurb: 'Nearby team-mates heal on a rhythm.',
        pulse: { heal: 8, radius: 5.0, every: 3.0 } },
      { perk: 'Wide Pulse', blurb: 'Your pulse reaches further.',
        pulse: { heal: 8, radius: 6.5, every: 3.0 } },
      { perk: 'Deep Pulse', blurb: 'Each pulse heals for half again.',
        pulse: { heal: 13, radius: 6.5, every: 3.0 } },
      // The classic. A Medic is standing still more than anyone else already,
      // so the perk that pays for standing still is the one that fits.
      { perk: 'Quick Crop', blurb: 'Peck back to full in half the time.',
        peckRateMul: 1.9 },
      { perk: 'Rapid Pulse', blurb: 'Pulses come faster, and further.',
        pulse: { heal: 13, radius: 7.5, every: 2.3 } },
      { perk: 'Triage', blurb: 'A pulse every two seconds, and it lands hard.',
        pulse: { heal: 19, radius: 8.5, every: 1.9 } },
    ],
  },

  // ----------------------------------------------------------------- SNIPER
  //
  // *** THE BALANCE TRAP, WRITTEN DOWN. ***
  //
  // A hitscan one-shot-kill with no travel time and no accuracy cost would
  // simply win an eight-player match. There is nothing to dodge, nothing to
  // hear coming, and no window in which the target gets a decision.
  //
  // Three things make it fair, and all three have to stay:
  //
  //   1. FULL ACCURACY ONLY WHILE STATIONARY. `spreadMul` 3.4 puts a moving
  //      Sniper's cone at ~17 degrees — a wall-hitting device. This is the
  //      whole balance, and it is why the movement cone had to exist first.
  //   2. The re-chamber. 1.3s at tier 1 is thirteen ordinary shots. Miss, and
  //      the fight is theirs.
  //   3. 60 HP. Three ordinary body shots — 200ms — and the Sniper is gone.
  //
  // A headshot kills every role outright at any range EXCEPT the Bruiser, who
  // survives one. That exception is not an accident: it is what makes the
  // Bruiser the answer to a Sniper, and it is why 180 HP is worth having.
  sniper: {
    id: 'sniper',
    name: 'Sniper',
    icon: '◎',
    color: '#ffcc3d',
    blurb: 'One shot, if you stop moving. A head is a kill at any range.',
    what: 'Deletes one chicken',
    hp: 60,
    speedMul: 0.95,
    damageMul: 3.25,
    fireCooldownMul: 13,
    // The rifle IS the ability. Moving costs you everything.
    spreadMul: 3.4,
    ability: 'rechamber',
    tiers: [
      { perk: 'Bolt Action', blurb: 'A slow, lethal rifle. Stand still to use it.',
        fireCooldownMul: 13 },
      { perk: 'Oiled Bolt', blurb: 'Re-chamber a little faster.', fireCooldownMul: 11.5 },
      { perk: 'Steady Hands', blurb: 'A full second between rounds.', fireCooldownMul: 10 },
      { perk: 'Practised Reload', blurb: 'You peck back up noticeably faster.',
        peckRateMul: 1.6 },
      { perk: 'Fast Bolt', blurb: 'Rounds come out in under a second.', fireCooldownMul: 8.5 },
      { perk: 'Machine Bolt', blurb: 'Two lethal rounds in a second and a half.',
        fireCooldownMul: 7 },
    ],
  },

  // ----------------------------------------------------------------- RUNNER
  //
  // Fast, frequent, and made of paper. Its damage per shot is the lowest in the
  // game and its damage per SECOND is near the top, which is the trade: it wins
  // any fight it starts and loses every one it walks into.
  //
  // THE DASH NEVER STEERS YOU. See PLAYER.maxKnockback for the bug this rule
  // comes from — knockback that moved a player against their input read as the
  // game taking the controls away. So the dash is a multiplier on the player's
  // OWN movement vector and refuses to fire without one: hold a direction or
  // nothing happens. There is no scripted lunge anywhere in it.
  runner: {
    id: 'runner',
    name: 'Runner',
    icon: '»',
    color: '#5fd1ff',
    blurb: 'Fastest legs, fastest trigger, softest chicken.',
    what: 'Gets there first',
    hp: 75,
    speedMul: 1.30,
    // −30%, not the −40% this role was first sketched with. At 0.60 the maths
    // came out at 13.2 a round: eight shots to kill, and a damage-per-SECOND
    // below the ordinary gun (1.4 x 0.6 = 0.84). A role called Runner that took
    // 583ms to kill anything — the longest in the game bar the Sniper — while
    // also being the second softest is not a trade, it is just worse. At 0.70
    // its DPS lands on the baseline: seven quick rounds instead of five ordinary
    // ones, which is the same kill in the same time from a much faster gun.
    damageMul: 0.70,
    fireCooldownMul: 0.71, // +40% fire rate
    ability: 'dash',
    tiers: [
      { perk: 'Dash', blurb: 'A burst of speed, the way you are already going.',
        dash: { charges: 1, mul: 2.6, seconds: 0.22, cooldown: 4.0 } },
      { perk: 'Long Dash', blurb: 'The dash carries you further.',
        dash: { charges: 1, mul: 2.6, seconds: 0.30, cooldown: 4.0 } },
      { perk: 'Quick Legs', blurb: 'Dash comes back sooner.',
        dash: { charges: 1, mul: 2.6, seconds: 0.30, cooldown: 3.2 } },
      { perk: 'Double Dash', blurb: 'Two charges. In, and back out.',
        dash: { charges: 2, mul: 2.6, seconds: 0.30, cooldown: 3.2 } },
      // The classic, and the role it was always describing.
      { perk: 'Second Wind', blurb: 'Drop low and bolt — once per life.',
        secondWind: { at: 0.3, seconds: 2.2, speedMul: 1.55 } },
      { perk: 'Blur', blurb: 'Three charges, back almost as fast as you spend them.',
        dash: { charges: 3, mul: 2.8, seconds: 0.30, cooldown: 2.4 } },
    ],
  },

  // ---------------------------------------------------------------- BRUISER
  //
  // The body that makes a push possible. It is the only role that can cross
  // open ground into fire and arrive, and the falloff is what stops it also
  // being the best chicken at every other range: past ~24 units it does about a
  // third of its damage, so a Bruiser holding a lane is a Bruiser doing nothing.
  //
  // Its signature FIRES rather than sits there. Bulwark triggers once per life
  // the moment health crosses the line, with a sound and a colour, exactly like
  // Second Wind — a perk you notice happening is worth several you merely have.
  bruiser: {
    id: 'bruiser',
    name: 'Bruiser',
    icon: '▲',
    color: '#ff8a3d',
    blurb: 'Walks into the room. Useless from across it.',
    what: 'Takes the ground',
    hp: 180,
    speedMul: 0.75,
    damageMul: 1.0,
    fireCooldownMul: 1,
    // Full damage inside `from`, sliding to `min` by `to`. Everything past
    // `to` stays at `min` rather than reaching zero — a Bruiser should be a bad
    // choice at range, not an unarmed one.
    falloff: { from: 9, to: 24, min: 0.35 },
    ability: 'bulwark',
    tiers: [
      { perk: 'Thick Feathers', blurb: 'Nearly twice the health of anyone else.',
        hp: 180, bulwark: { at: 0.40, seconds: 3.5, resist: 0.35 } },
      { perk: 'Tougher', blurb: 'More of it.', hp: 195 },
      { perk: 'Braced', blurb: 'Bulwark lasts a second longer.',
        bulwark: { at: 0.40, seconds: 4.5, resist: 0.35 } },
      { perk: 'Plated', blurb: 'Bulwark halves what reaches you.',
        bulwark: { at: 0.40, seconds: 4.5, resist: 0.50 } },
      // The classic. The role most likely to be standing over a body is the
      // role that should be rewarded for it.
      { perk: 'Feeding Frenzy', blurb: 'A kill refills you and sets you loose.',
        frenzy: { seconds: 3.2, fireCooldownMul: 0.75, speedMul: 1.2 } },
      { perk: 'Unmovable', blurb: 'It fires earlier, lasts longer, and you are huge.',
        hp: 215, bulwark: { at: 0.50, seconds: 5.0, resist: 0.55 } },
    ],
  },

  // ------------------------------------------------------------------ SCOUT
  //
  // The information role, and the one that makes pings matter: a sweep tells
  // the team WHERE, and a ping tells them WHAT TO DO ABOUT IT. Neither is much
  // use without the other.
  //
  // The sweep is automatic on a cooldown but only spends itself when there is
  // actually an enemy inside its range — a reveal fired down an empty corridor
  // is a wasted cooldown, and nothing about that is a decision worth handing a
  // player mid-fight.
  scout: {
    id: 'scout',
    name: 'Scout',
    icon: '◈',
    color: '#c77dff',
    blurb: 'Sweeps the map. Your whole roost sees them through walls.',
    what: 'Says where they are',
    // Same reason as the Medic: a sweep is something a ROOST gets, and there is
    // no roost in a 1v1.
    teamOnly: true,
    hp: 80,
    speedMul: 1.05,
    damageMul: 1.0,
    fireCooldownMul: 1,
    ability: 'sweep',
    tiers: [
      { perk: 'Sweep', blurb: 'Enemies light up for your roost, now and then.',
        sweep: { every: 14, seconds: 2.0, range: 30 } },
      { perk: 'Long Sweep', blurb: 'They stay lit for a second longer.',
        sweep: { every: 14, seconds: 3.0, range: 30 } },
      { perk: 'Rapid Sweep', blurb: 'Sweeps come round faster.',
        sweep: { every: 11, seconds: 3.0, range: 34 } },
      // The classic. A scout that cannot get to the information is not one.
      { perk: 'Long Legs', blurb: 'You are noticeably quicker on your feet.',
        speedMul: 1.16 },
      { perk: 'Deep Sweep', blurb: 'Half the map, every nine seconds.',
        sweep: { every: 9, seconds: 3.0, range: 46 } },
      { perk: 'Eyes Everywhere', blurb: 'The whole arena, almost constantly.',
        sweep: { every: 7, seconds: 4.0, range: 64 } },
    ],
  },

  // --------------------------------------------------------------- ENGINEER
  //
  // Low personal power, high team power. It drops a portable feeder — the same
  // grain-and-health pad that sits on each team's rally point, except this one
  // goes where the fight is. That is the whole role: it decides where "safe"
  // is, and moves it forward.
  //
  // It ties straight into the existing crop system rather than inventing a
  // resource, so a player already knows what it does the first time they stand
  // on one.
  engineer: {
    id: 'engineer',
    name: 'Engineer',
    icon: '⬢',
    color: '#8ecae6',
    blurb: 'Drops a feeder wherever the fight is. Grain and health, for the roost.',
    what: 'Holds the ground',
    // Normal stats, all four of them — the baseline chicken. Its low personal
    // power is not a damage penalty, it is that its signature ability does
    // nothing whatsoever for the Engineer holding it.
    hp: 100,
    speedMul: 1.0,
    damageMul: 1.0,
    fireCooldownMul: 1,
    ability: 'pad',
    tiers: [
      { perk: 'Field Feeder', blurb: 'Drop a feeder your roost can stand on.',
        pad: { seconds: 20, radius: 2.2, cooldown: 16, refill: 45, heal: 10, max: 1 } },
      { perk: 'Bigger Pad', blurb: 'More chickens fit on it.',
        pad: { seconds: 20, radius: 2.8, cooldown: 16, refill: 45, heal: 10, max: 1 } },
      { perk: 'Faster Build', blurb: 'A new pad sooner.',
        pad: { seconds: 20, radius: 2.8, cooldown: 12, refill: 45, heal: 10, max: 1 } },
      // The classic. The role with the weakest gun is the one that most wants
      // the trigger back.
      { perk: 'Rapid Peck', blurb: 'Your shots come out a fifth faster.',
        fireCooldownMul: 0.78 },
      { perk: 'Full Trough', blurb: 'It feeds harder and lasts longer.',
        pad: { seconds: 26, radius: 2.8, cooldown: 12, refill: 60, heal: 15, max: 1 } },
      { perk: 'Two Troughs', blurb: 'Two pads at once. Hold a whole lane.',
        pad: { seconds: 26, radius: 2.8, cooldown: 10, refill: 60, heal: 15, max: 2 } },
    ],
  },
};

/**
 * Pick order, and the default.
 *
 * Also the order the picker draws them in, and the order a player with no
 * preference is handed one. Runner first because it is the role that most
 * resembles the gun everyone has already been using — a new player's first
 * match should not start with a rifle they have to stand still to fire.
 */
export const ROLE_LIST = ['runner', 'scout', 'bruiser', 'medic', 'sniper', 'engineer'];
export const DEFAULT_ROLE = 'runner';

/** Slots a side. Six roles against this is what keeps the last pick a choice. */
export const ROLE_SLOTS = 4;

export const roleDef = (id) => ROLES[id] ?? ROLES[DEFAULT_ROLE];

/**
 * A role value at a level: base stat, then every tier at or below it.
 *
 * Same shape and same walk as the old `perkValue`, which is what let the
 * simulation's call sites swap one for one. Cumulative in the sense that
 * matters — reaching tier 5 keeps what tier 2 set — while a tier that names the
 * same key simply replaces it.
 */
export function roleValue(roleId, level, key, fallback = 1) {
  const def = roleDef(roleId);
  let out = def[key] !== undefined ? def[key] : fallback;
  const top = clamp(level | 0, 1, LEVELS.max);
  for (let i = 0; i < top && i < def.tiers.length; i++) {
    const t = def.tiers[i];
    if (t[key] !== undefined) out = t[key];
  }
  return out;
}

/** The same, read straight off a player. The form the simulation uses. */
export const perkOf = (p, key, fallback = 1) => roleValue(p?.role, p?.level ?? 1, key, fallback);

/** The tier entry a level sits on, for the level-up banner. */
export function roleTier(roleId, level) {
  const def = roleDef(roleId);
  return def.tiers[clamp(level | 0, 1, LEVELS.max) - 1] ?? def.tiers[0];
}

/** Max health for this player. Everything that reads PLAYER.maxHp asks here. */
export const maxHpOf = (p) => roleValue(p?.role, p?.level ?? 1, 'hp', PLAYER.maxHp);

/**
 * Damage one of this player's rounds does, at this distance.
 *
 * `damageMul` scales body and head together on purpose: a role whose rounds hit
 * harder should have headshots that hit harder too, or the Sniper's whole
 * premise stops working at exactly the moment it matters.
 */
export function roleDamage(p, head, distance = 0) {
  const base = head ? BULLET.headDamage : BULLET.damage;
  const mul = perkOf(p, 'damageMul', 1);
  const fall = perkOf(p, 'falloff', null);
  if (!fall) return base * mul;
  const span = Math.max(1e-6, fall.to - fall.from);
  const t = clamp((distance - fall.from) / span, 0, 1);
  return base * mul * (1 - t * (1 - fall.min));
}

/**
 * Roles nobody on this team is holding. Never empty: six roles, four slots.
 *
 * Free-for-all is the other case, and it is two rules rather than one: nothing
 * is taken (there is no composition to protect when everybody is on their own),
 * and the two team-only roles are not offered at all.
 */
export function freeRoles(world, team, exceptId = null) {
  const solo = team === null || team === undefined;
  if (solo) return ROLE_LIST.filter((id) => !ROLES[id].teamOnly);

  const taken = new Set();
  for (const o of world.players.values()) {
    if (o.id === exceptId || o.team !== team) continue;
    if (o.role) taken.add(o.role);
  }
  return ROLE_LIST.filter((id) => !taken.has(id));
}

/** Is this role available to this player right now? */
export const roleFree = (world, team, id, exceptId = null) => (
  !!ROLES[id] && freeRoles(world, team, exceptId).includes(id)
);

/**
 * What this player actually gets, given what they asked for.
 *
 * The whole UX rule of the picker is here: your last role if it is still free,
 * otherwise the first free one. A player who does nothing keeps playing what
 * they were playing and respawns on time — the screen is an opportunity, not a
 * toll gate.
 */
export function resolveRole(world, p, wanted) {
  const free = freeRoles(world, p.team, p.id);
  if (wanted && free.includes(wanted)) return wanted;
  if (p.role && free.includes(p.role)) return p.role;
  return free[0] ?? DEFAULT_ROLE;
}

/**
 * The role this player rotates into next round, or null for "stay put".
 *
 * Rolled at DEATH rather than at respawn, and that ordering is the whole UX of
 * the feature: the answer exists while the picker is on screen, so the player
 * is offered a choice rather than told about a change. See ROTATION.
 *
 * Two exclusions, in order of how much they matter. The current role, because a
 * rotation that lands where it started reads as broken. The previous one,
 * because at six roles and four slots a pure random walk really does produce
 * Runner, Scout, Runner, Scout — which is indistinguishable from no rotation to
 * the player living inside it. Both are dropped rather than enforced when the
 * pool runs dry: a filter that can empty is a filter that returns null on a
 * full team, which is the one case rotation is FOR.
 *
 * @param rng world.rng, so a seeded match replays identically
 */
export function rollRotation(world, p, rng = Math.random) {
  if (!ROTATION.enabled) return null;
  const free = freeRoles(world, p.team, p.id);
  if (!free.length) return null;

  const drop = (pool, id) => {
    if (!id) return pool;
    const kept = pool.filter((r) => r !== id);
    return kept.length ? kept : pool;
  };
  let pool = free;
  if (ROTATION.avoidCurrent) pool = drop(pool, p.role);
  if (ROTATION.avoidPrevious) pool = drop(pool, p.lastRole);

  const pick = pool[Math.floor(rng() * pool.length)] ?? pool[0];
  // One entry left and it is what they are already playing: nothing to offer.
  return pick && pick !== p.role ? pick : null;
}
