// Bot chickens. They generate the exact same input struct a human joystick
// produces, so the sim can't tell them apart — which also means they work as
// offline practice opponents on the client with zero extra code.

import { applyInput } from './sim.js';
import { PLAYER, BULLET, BOMBER, PICKUP, HILL, HEIST, BOMB } from './constants.js';
import { norm, len, dist2, clamp, angleDelta } from './math.js';

const BOT_NAMES = [
  'Nugget', 'Colonel', 'Drumstick', 'Kfc_Enjoyer', 'Poultrygeist',
  'Cluck Norris', 'Hen Solo', 'Yolko Ono', 'Beak Wick', 'Featherweight',
];

let nameCursor = 0;
export function botName() {
  const n = BOT_NAMES[nameCursor % BOT_NAMES.length];
  nameCursor++;
  return n;
}

const DIFFICULTY = {
  easy: { think: 0.34, aimError: 0.30, range: 12, fireArc: 0.34, dodge: 0.4 },
  normal: { think: 0.22, aimError: 0.17, range: 10, fireArc: 0.26, dodge: 0.7 },
  hard: { think: 0.13, aimError: 0.08, range: 8.5, fireArc: 0.18, dodge: 1.0 },
};

export function initBot(p, difficulty = 'normal') {
  p.bot = {
    cfg: DIFFICULTY[difficulty] ?? DIFFICULTY.normal,
    thinkAt: 0,
    strafe: Math.random() < 0.5 ? 1 : -1,
    strafeAt: 0,
    aimJitterX: 0,
    aimJitterZ: 0,
  };
}

export function stepBots(world, dt) {
  for (const p of world.players.values()) {
    if (!p.isBot || !p.alive) continue;
    if (!p.bot) initBot(p);
    const b = p.bot;

    b.thinkAt -= dt;
    b.strafeAt -= dt;
    if (b.strafeAt <= 0) {
      b.strafe = Math.random() < 0.5 ? 1 : -1;
      b.strafeAt = 0.8 + Math.random() * 1.2;
    }
    if (b.thinkAt > 0) continue; // keep last input between think ticks
    b.thinkAt = b.cfg.think;
    b.aimJitterX = (Math.random() * 2 - 1) * b.cfg.aimError;
    b.aimJitterZ = (Math.random() * 2 - 1) * b.cfg.aimError;

    applyInput(world, p.id, decide(world, p, b));
  }
}

function decide(world, p, b) {
  const half = world.arena.half;
  let mx = 0;
  let mz = 0;
  let ax = 0;
  let az = 0;
  let shoot = false;

  // --- threat: an armed bomber outranks everything else on the todo list
  const bomber = world.bomber;
  if (bomber?.alive) {
    const bd = Math.sqrt(dist2(p.x, p.z, bomber.x, bomber.z));
    const armed = bomber.state === 'arm';
    if (armed && bd < BOMBER.blastRadius + 2.5) {
      const [fx, fz] = norm(p.x - bomber.x, p.z - bomber.z);
      // Shoot it while backpedalling — sometimes you defuse it in time.
      return { mx: fx, mz: fz, ax: -fx, az: -fz, shoot: bomber.hp < 30, seq: 0 };
    }
    if (!armed && bd < 14 && p.hp > 45) {
      // Free score, and it stops it reaching anyone.
      const [tx, tz] = norm(bomber.x - p.x, bomber.z - p.z);
      const approach = bd > 7 ? 1 : -0.4;
      return {
        mx: tx * approach, mz: tz * approach,
        ax: tx + b.aimJitterX, az: tz + b.aimJitterZ,
        shoot: bd < 18, seq: 0,
      };
    }
  }

  // --- healing: hurt bots go shopping
  if (p.hp < 45) {
    const pk = nearestPickup(world, p, 'health');
    if (pk) {
      const [tx, tz] = norm(pk.x - p.x, pk.z - p.z);
      const foe = nearestFoe(world, p);
      if (foe) {
        const [fx, fz] = norm(foe.x - p.x, foe.z - p.z);
        ax = fx + b.aimJitterX;
        az = fz + b.aimJitterZ;
        shoot = aimedAt(p, fx, fz, b.cfg.fireArc);
      }
      return { mx: tx, mz: tz, ax, az, shoot, seq: 0 };
    }
  }

  // --- the closing boundary outranks everything: being outside it is fatal
  if (world.cfg.shrink) {
    const edge = world.safeHalf - 2.5;
    if (Math.abs(p.x) > edge || Math.abs(p.z) > edge) {
      const [tx, tz] = norm(-p.x, -p.z);
      return { mx: tx, mz: tz, ax: tx, az: tz, shoot: false, seq: 0 };
    }
  }

  // --- Plant & Defuse: the bomb outranks the gunfight either way
  if (world.cfg.bomb && world.bomb) {
    const move = bombErrand(world, p, b);
    if (move) return move;
  }

  // --- Egg Heist: a bot that only shoots loses to anyone who runs errands
  if (world.cfg.heist) {
    const move = heistErrand(world, p, b);
    if (move) return move;
  }

  // --- King of the Coop: bots that ignore the objective are no opposition
  if (world.cfg.hill) {
    // The zone relocates, so this has to chase its current spot rather than
    // the middle of the map.
    const zone = world.hill;
    const d = Math.sqrt(dist2(p.x, p.z, zone.x, zone.z));
    if (d > HILL.radius * 0.6) {
      const [tx, tz] = norm(zone.x - p.x, zone.z - p.z);
      const { ax, az, shoot } = coveringFire(world, p, b, tx, tz);
      return { mx: tx, mz: tz, ax, az, shoot, seq: 0 };
    }
  }

  // --- otherwise: fight
  const foe = nearestFoe(world, p);
  if (!foe) {
    const pk = nearestPickup(world, p, null);
    if (pk) {
      const [tx, tz] = norm(pk.x - p.x, pk.z - p.z);
      return { mx: tx, mz: tz, ax: tx, az: tz, shoot: false, seq: 0 };
    }
    return { mx: -p.x / (half || 1), mz: -p.z / (half || 1), ax: 0, az: 0, shoot: false, seq: 0 };
  }

  const d = Math.sqrt(dist2(p.x, p.z, foe.x, foe.z));

  // Lead the target: aim where they'll be when the bullet arrives.
  const flight = d / BULLET.speed;
  const leadX = foe.x + (foe.input?.mx ?? 0) * PLAYER.speed * flight;
  const leadZ = foe.z + (foe.input?.mz ?? 0) * PLAYER.speed * flight;
  const [lx, lz] = norm(leadX - p.x, leadZ - p.z);
  ax = lx + b.aimJitterX;
  az = lz + b.aimJitterZ;
  shoot = aimedAt(p, lx, lz, b.cfg.fireArc);

  // Hold preferred range, strafing perpendicular so they're not a free target.
  const [tx, tz] = norm(foe.x - p.x, foe.z - p.z);
  const closing = d > b.cfg.range ? 1 : d < b.cfg.range - 3 ? -1 : 0;
  const perpX = -tz * b.strafe * b.cfg.dodge;
  const perpZ = tx * b.strafe * b.cfg.dodge;
  mx = tx * closing + perpX;
  mz = tz * closing + perpZ;

  // Don't strafe into a wall and get pinned there.
  const edge = half - 3;
  if (Math.abs(p.x) > edge) mx -= Math.sign(p.x) * 0.8;
  if (Math.abs(p.z) > edge) mz -= Math.sign(p.z) * 0.8;

  return { mx, mz, ax, az, shoot, seq: 0 };
}

/**
 * Aim while running an errand.
 *
 * A bot crossing the map with its gun pointed at its feet is free score, so it
 * keeps covering the nearest foe and falls back to looking where it is going.
 */
function coveringFire(world, p, b, fallbackX, fallbackZ) {
  const foe = nearestFoe(world, p);
  if (!foe) return { ax: fallbackX, az: fallbackZ, shoot: false };
  const [fx, fz] = norm(foe.x - p.x, foe.z - p.z);
  return {
    ax: fx + b.aimJitterX,
    az: fz + b.aimJitterZ,
    shoot: aimedAt(p, fx, fz, b.cfg.fireArc),
  };
}

/** Nest belonging to a seat. */
function nestFor(world, seat) {
  return world.nests ? world.nests.find((n) => n.seat === seat % 4) : null;
}

/**
 * Egg Heist errand: raid, then bank.
 *
 * Bots deliberately head home before they are full. A bot that hoards until it
 * has every egg is slow, obvious, and hands the whole load back the moment it
 * dies — which is the same mistake new players make.
 */
function heistErrand(world, p, b) {
  const home = nestFor(world, p.seat);
  if (!home) return null;

  const goTo = (x, z, stopWithin = 0) => {
    const d = Math.sqrt(dist2(p.x, p.z, x, z));
    if (d <= stopWithin) return null;
    const [tx, tz] = norm(x - p.x, z - p.z);
    const { ax, az, shoot } = coveringFire(world, p, b, tx, tz);
    return { mx: tx, mz: tz, ax, az, shoot, seq: 0 };
  };

  // Hands full, or hurt and holding something: cash out.
  if (p.carrying >= 2 || (p.carrying > 0 && p.hp < 55)) return goTo(home.x, home.z);

  // Anything on the floor nearby is cheaper than raiding for it.
  let best = null;
  let bestD = 14 * 14;
  for (const egg of world.looseEggs ?? []) {
    const d = dist2(p.x, p.z, egg.x, egg.z);
    if (d < bestD) { best = egg; bestD = d; }
  }
  if (best) return goTo(best.x, best.z);

  if (p.carrying > 0) return goTo(home.x, home.z);

  // Otherwise raid the fullest rival nest that is worth the walk.
  let target = null;
  let bestScore = 0;
  for (const nest of world.nests) {
    if (nest.seat === p.seat % 4 || nest.eggs <= 0) continue;
    const d = Math.sqrt(dist2(p.x, p.z, nest.x, nest.z)) + 1;
    const score = nest.eggs / d;
    if (score > bestScore) { target = nest; bestScore = score; }
  }
  return target ? goTo(target.x, target.z) : null;
}

/**
 * Plant & Defuse errand.
 *
 * Defusing your own nest comes first — losing it costs more than any kill is
 * worth — and both planting and defusing mean standing still, so those return
 * a zero move vector rather than nothing.
 */
function bombErrand(world, p, b) {
  const bomb = world.bomb;

  if (bomb.state === 'planted') {
    // Only its owner can defuse. Everyone else may as well keep fighting.
    if (bomb.plantSeat !== p.seat % 4) return null;
    const d = Math.sqrt(dist2(p.x, p.z, bomb.x, bomb.z));
    if (d > BOMB.plantRadius * 0.6) {
      const [tx, tz] = norm(bomb.x - p.x, bomb.z - p.z);
      const { ax, az, shoot } = coveringFire(world, p, b, tx, tz);
      return { mx: tx, mz: tz, ax, az, shoot, seq: 0 };
    }
    // Stand on it. Holding still is what defusing *is*.
    const { ax, az, shoot } = coveringFire(world, p, b, 0, 1);
    return { mx: 0, mz: 0, ax, az, shoot, seq: 0 };
  }

  if (bomb.carriedBy === p.id) {
    // Carry it to the nearest defended rival nest.
    let target = null;
    let bestD = Infinity;
    for (const nest of world.nests ?? []) {
      if (nest.seat === p.seat % 4) continue;
      if (![...world.players.values()].some((o) => o.seat % 4 === nest.seat)) continue;
      const d = dist2(p.x, p.z, nest.x, nest.z);
      if (d < bestD) { target = nest; bestD = d; }
    }
    if (!target) return null;

    if (Math.sqrt(bestD) > BOMB.plantRadius * 0.6) {
      const [tx, tz] = norm(target.x - p.x, target.z - p.z);
      const { ax, az, shoot } = coveringFire(world, p, b, tx, tz);
      return { mx: tx, mz: tz, ax, az, shoot, seq: 0 };
    }
    const { ax, az, shoot } = coveringFire(world, p, b, 0, 1);
    return { mx: 0, mz: 0, ax, az, shoot, seq: 0 };
  }

  if (bomb.state === 'loose') {
    const [tx, tz] = norm(bomb.x - p.x, bomb.z - p.z);
    const { ax, az, shoot } = coveringFire(world, p, b, tx, tz);
    return { mx: tx, mz: tz, ax, az, shoot, seq: 0 };
  }

  // Someone else is carrying it — hunting the carrier is just the normal fight.
  return null;
}

function aimedAt(p, dx, dz, arc) {
  return Math.abs(angleDelta(p.aim, Math.atan2(dx, dz))) < arc;
}

function nearestFoe(world, p) {
  let best = null;
  let bestD = Infinity;
  for (const o of world.players.values()) {
    if (o.id === p.id || !o.alive || world.time < o.invulnUntil) continue;
    // Never hunt a team-mate; friendly fire is off, so it would just be a bot
    // standing there firing harmlessly at its partner.
    if (o.team !== null && o.team === p.team) continue;
    const d = dist2(p.x, p.z, o.x, o.z);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function nearestPickup(world, p, type) {
  let best = null;
  let bestD = Infinity;
  for (const pk of world.pickups) {
    if (type && pk.type !== type) continue;
    const d = dist2(p.x, p.z, pk.x, pk.z);
    if (d < bestD) { bestD = d; best = pk; }
  }
  return bestD < 30 * 30 ? best : null;
}
