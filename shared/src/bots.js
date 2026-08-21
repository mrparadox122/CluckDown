// Bot chickens. They generate the exact same input struct a human joystick
// produces, so the sim can't tell them apart — which also means they work as
// offline practice opponents on the client with zero extra code.

import { applyInput, feederFor, feederRadius } from './sim.js';
import { PLAYER, BOMBER, PICKUP, HILL, HEIST, BOMB, CROP, cropCapacity } from './constants.js';
import { norm, len, dist2, clamp, angleDelta, segBoxEntry } from './math.js';

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

/**
 * How good a bot is, and it is deliberately not very.
 *
 * These came down across the board on player feedback: bots were landing too
 * much of what they fired and reacting faster than anyone can. A bot that wins
 * the aim duel is not a challenge, it is a wall — you cannot out-play it, only
 * out-luck it, and losing to one teaches you nothing about the game.
 *
 *   think     seconds between decisions. Also the reaction time: nothing a bot
 *             notices can be acted on sooner than this.
 *   aimError  radians of jitter added to every aim. The big lever — at 0.26 a
 *             bot at ten paces is spraying around you rather than at you.
 *   range     the distance it tries to hold. Further out is worse: more of its
 *             error turns into a miss.
 *   fireArc   how nearly aimed it has to be before pulling the trigger.
 *   dodge     how hard it strafes. Lowered as well, because a bot that jinks
 *             constantly is accidentally hard to hit.
 */
const DIFFICULTY = {
  easy: { think: 0.40, aimError: 0.34, range: 12.5, fireArc: 0.34, dodge: 0.35 },
  normal: { think: 0.27, aimError: 0.20, range: 10.5, fireArc: 0.28, dodge: 0.6 },
  hard: { think: 0.17, aimError: 0.11, range: 9, fireArc: 0.2, dodge: 0.85 },
};

// How long a bot waits between hops, in seconds. Not a tactic — a bot that
// never leaves the floor reads as scenery the moment the human next to it
// discovers the jump button, and "the other chickens are inert" is the kind of
// thing that makes a practice match feel like a menu.
const JUMP_MIN = 1.8;
const JUMP_SPREAD = 3.4;

export function initBot(p, difficulty = 'normal') {
  p.bot = {
    cfg: DIFFICULTY[difficulty] ?? DIFFICULTY.normal,
    thinkAt: 0,
    strafe: Math.random() < 0.5 ? 1 : -1,
    strafeAt: 0,
    aimJitterX: 0,
    aimJitterZ: 0,
    aimJitterY: 0,
    jumpAt: JUMP_MIN + Math.random() * JUMP_SPREAD,
    // Which way it peels around cover. Held between decisions so it commits to
    // one side instead of dithering in front of a box.
    swerve: Math.random() < 0.5 ? 1 : -1,
    // Seconds of backing away left before it has to stand and peck. See
    // feedErrand: this is a bound, not a plan.
    retreatFor: 0,
    refilling: false,
    wasDry: false,
  };
}

// How long a dry bot may spend backing off before it must stop and peck, and
// how close a foe has to be for backing off to be worth it at all.
const RETREAT_TIME = 1.1;
const RETREAT_RANGE = 16;

/**
 * How full a bot fills up before rejoining the fight, as a share of capacity.
 *
 * This is hysteresis, and it is the difference between a bot that reloads and a
 * bot that panics. Leaving the refill state the instant firing became legal —
 * at CROP.recoverTo — meant the bot immediately spent the four grain it had
 * just earned, went dry again, and started over: a permanent stutter of
 * four-round bursts that never built a usable crop and read as blind terror.
 *
 * Entering on `dry` and leaving at 60% puts a gap between the two thresholds,
 * so the decision sticks long enough to be worth having made.
 */
const REFILL_TO = 0.6;

// How far ahead a bot looks for cover, in units. Roughly a second of running:
// far enough to start turning before it is scraping along a wall, short enough
// that it does not swerve around something it was never going to reach.
const LOOKAHEAD = 5.5;

/**
 * Steers a desired move vector around whatever cover is in front of it.
 *
 * Not pathfinding, and deliberately so. Bots slide along cover for free — the
 * simulation resolves them out of it — so the only real failure was grinding
 * along a wall for several seconds looking broken. One whisker cast down the
 * intended direction, and a shove perpendicular when it hits something, is
 * enough to make that look like a bot going around a box.
 *
 * It is also all the navigation this map format can justify. The arenas are a
 * handful of convex boxes in an open square; there is no maze to solve, and a
 * bot that solved one would be a worse opponent than one that occasionally
 * takes the long way round.
 */
export function steerAroundCover(world, p, mx, mz) {
  const boxes = world.obstacles;
  if (!boxes?.length) return [mx, mz];
  const [dx, dz] = norm(mx, mz);
  if (!dx && !dz) return [mx, mz];

  const eye = p.y + PLAYER.eyeHeight;
  let nearest = -1;
  let hit = null;
  for (const box of boxes) {
    // Nothing to swerve around if the bot is already above it.
    if (p.y >= box.h) continue;
    const t = segBoxEntry(
      p.x, eye, p.z,
      p.x + dx * LOOKAHEAD, eye, p.z + dz * LOOKAHEAD,
      box, PLAYER.radius,
    );
    if (t < 0) continue;
    if (nearest < 0 || t < nearest) { nearest = t; hit = box; }
  }
  if (!hit) return [mx, mz];

  // Perpendicular to the heading, pointing to whichever side of the box the bot
  // is ALREADY on — the short way round.
  //
  // Getting this backwards is silent and expensive: the bot still swerves, so
  // it looks like it is avoiding the box, but it crosses the face to reach the
  // far corner and takes twice as long about it. Dotting the candidate
  // perpendicular against the offset picks the near side; the along-heading
  // part of that offset cancels out, which is exactly what makes it the
  // sideways question and not a distance one.
  const ox = p.x - hit.x;
  const oz = p.z - hit.z;
  let px = -dz;
  let pz = dx;
  const lean = px * ox + pz * oz;
  // Dead centre there is no near side, so `swerve` breaks the tie and the bot
  // commits to one direction instead of dithering in front of the box.
  const flip = Math.abs(lean) < 1e-6 ? p.bot.swerve < 0 : lean < 0;
  if (flip) { px = dz; pz = -dx; }
  // Blend rather than replace: closer means more turn, so it drifts around
  // distant cover and commits hard to near cover.
  const urgency = 1 - clamp(nearest, 0, 1);
  return [dx * (1 - urgency) + px * urgency, dz * (1 - urgency) + pz * urgency];
}

export function stepBots(world, dt) {
  for (const p of world.players.values()) {
    if (!p.isBot || !p.alive) continue;
    if (!p.bot) initBot(p);
    const b = p.bot;

    b.thinkAt -= dt;
    b.strafeAt -= dt;
    b.jumpAt -= dt;
    b.retreatFor -= dt;
    if (b.strafeAt <= 0) {
      b.strafe = Math.random() < 0.5 ? 1 : -1;
      b.strafeAt = 0.8 + Math.random() * 1.2;
    }
    if (b.thinkAt > 0) continue; // keep last input between think ticks
    b.thinkAt = b.cfg.think;
    b.aimJitterX = (Math.random() * 2 - 1) * b.cfg.aimError;
    b.aimJitterZ = (Math.random() * 2 - 1) * b.cfg.aimError;
    b.aimJitterY = (Math.random() * 2 - 1) * b.cfg.aimError * 0.5;

    // Going dry buys one retreat. Reset here rather than in feedErrand so the
    // budget is per dry SPELL, not per decision — refreshing it every think
    // tick is how a bounded retreat quietly becomes an unbounded one.
    if (p.dry && !b.wasDry) b.retreatFor = RETREAT_TIME;
    b.wasDry = p.dry;

    // The jump flag rides on the input struct until the next think tick, which
    // is at most 0.34s away — long enough to leave the ground, far short of the
    // ~0.64s hop, so a bot never re-triggers on landing and pogos on the spot.
    let input = decide(world, p, b);
    input = feedErrand(world, p, b, input) ?? input;
    [input.mx, input.mz] = steerAroundCover(world, p, input.mx, input.mz);
    input.pitch = aimPitch(world, p, b);
    if (b.jumpAt <= 0) {
      input.jump = true;
      b.jumpAt = JUMP_MIN + Math.random() * JUMP_SPREAD;
    }

    applyInput(world, p.id, input);
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

  // Straight at them. Shots are hitscan, so there is nothing to lead — bots
  // used to aim ahead of a moving target, which now misses behind it.
  const [lx, lz] = norm(foe.x - p.x, foe.z - p.z);
  ax = lx + b.aimJitterX;
  az = lz + b.aimJitterZ;
  shoot = aimedAt(p, lx, lz, b.cfg.fireArc) && canSee(world, p, foe);

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
    shoot: aimedAt(p, fx, fz, b.cfg.fireArc) && canSee(world, p, foe),
  };
}

/** Nest belonging to a team. */
function nestFor(world, team) {
  return world.nests ? world.nests.find((n) => n.team === team) : null;
}

/**
 * Egg Heist errand: raid, then bank.
 *
 * Bots deliberately head home before they are full. A bot that hoards until it
 * has every egg is slow, obvious, and hands the whole load back the moment it
 * dies — which is the same mistake new players make.
 */
function heistErrand(world, p, b) {
  const home = nestFor(world, p.team);
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
    if (nest.team === p.team || nest.eggs <= 0) continue;
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
    if (bomb.plantTeam !== p.team) return null;
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
      if (nest.team === p.team) continue;
      if (![...world.players.values()].some((o) => o.team === nest.team)) continue;
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

/**
 * Out of grain, or hurt enough to want the feeder.
 *
 * Bots have to solve this or they spend the back half of a match chasing
 * players they cannot shoot — the crop is a hard gate on being a threat at all.
 * Two behaviours, and the second one is partly there to be WATCHED: a bot
 * trotting home to its pad and standing on it is how a new player finds out the
 * feeder exists. Nothing in the HUD teaches that as well as seeing someone
 * else do it.
 *
 * @returns a replacement input, or null to leave the bot's plan alone.
 */
function feedErrand(world, p, b, input) {
  const home = feederFor(world, p.team ?? p.seat);
  const homeD = Math.sqrt(dist2(p.x, p.z, home.x, home.z));

  // Badly hurt and not in the middle of something: go and eat. The feeder heals
  // as well as refills, which makes this the bot equivalent of disengaging.
  const wantsHome = p.hp < 35 && p.crop < cropCapacity(world.modifier) * 0.5;
  if (wantsHome && homeD > feederRadius(world) * 0.6) {
    const [tx, tz] = norm(home.x - p.x, home.z - p.z);
    return { ...input, mx: tx, mz: tz, shoot: input.shoot && p.crop > 0 };
  }
  if (wantsHome) {
    // Arrived. Stand on it — feeding is a stance, for bots too.
    return { ...input, mx: 0, mz: 0, shoot: false };
  }

  // --- refilling.
  //
  // Entered on `dry`, left at REFILL_TO — two different thresholds on purpose.
  //
  // The condition to ENTER is `p.dry`, not `p.crop <= 0`, and getting that
  // wrong is what made bots look brainless: firing is gated on `dry`, which
  // stays true from hitting zero until CROP.recoverTo grain are back. A bot
  // that stopped pecking the moment its crop was non-zero pecked exactly one
  // grain, saw an enemy nearby, resumed strafing — and was then stuck forever,
  // unable to shoot because it was still dry and unable to peck because it was
  // moving. That is precisely the "walks back and forth in front of you doing
  // nothing" report, and it was one word.
  if (p.dry) b.refilling = true;
  if (b.refilling && p.crop >= cropCapacity(world.modifier) * REFILL_TO) b.refilling = false;

  if (b.refilling) {
    const foe = nearestFoe(world, p);
    const close = foe && dist2(p.x, p.z, foe.x, foe.z) < RETREAT_RANGE * RETREAT_RANGE;
    if (close && b.retreatFor > 0) {
      // Back off first, the way a player would: you do not reload in someone's
      // face. Bounded by a timer that only resets on going dry again, so this
      // can never become a bot that retreats forever and never recovers —
      // which would be the same bug wearing a better disguise.
      const [ax, az] = norm(p.x - foe.x, p.z - foe.z);
      return { ...input, mx: ax, mz: az, shoot: false };
    }
    // Far enough, or out of retreat: put your head down and take the risk.
    //
    // Never shooting while refilling, even once `dry` has cleared. Letting a
    // topped-up-enough bot defend itself sounds humane and undoes the whole
    // mechanism: it fires each grain as it pecks it, and `wants` in stepCrop
    // stops pecking whenever the trigger is held, so the crop never climbs.
    // Refilling is a commitment or it is nothing.
    return { ...input, mx: 0, mz: 0, shoot: false };
  }

  // Nearly empty with nobody close: top up now rather than mid-fight. This is
  // the one genuinely smart thing bots do with the crop, and it is the same
  // instinct a decent player has.
  if (p.crop <= 3) {
    const foe = nearestFoe(world, p);
    const clear = !foe || dist2(p.x, p.z, foe.x, foe.z) > 14 * 14;
    if (clear) return { ...input, mx: 0, mz: 0, shoot: false };
  }
  return null;
}

// Was a second copy of the spawn corners, which silently stopped matching the
// moment team lines replaced them. It asks the simulation now.

/**
 * How far up or down a bot is looking.
 *
 * Bots express aim as a direction vector (ax, az) and have no opinion about
 * height, so this is derived rather than decided: whatever it is most likely to
 * be shooting at, aimed at the middle of that thing's body from the bot's own
 * eye. Get this wrong and a bot standing next to you fires over your head,
 * because a flat shot from eye height is only a hit while both of you are on
 * the floor — which stopped being guaranteed the moment jumping existed.
 *
 * The jitter is scaled down from the horizontal error on purpose. The vertical
 * target is barely two units tall, so the same spread that reads as "human aim"
 * sideways reads as "cannot shoot" up and down.
 */
function aimPitch(world, p, b) {
  const foe = nearestFoe(world, p);
  const bomber = world.bomber?.alive ? world.bomber : null;

  let target = foe;
  let height = PLAYER.hitHeight * 0.55;
  if (bomber && (!foe || dist2(p.x, p.z, bomber.x, bomber.z) < dist2(p.x, p.z, foe.x, foe.z))) {
    target = bomber;
    height = BOMBER.hitHeight * 0.5;
  }
  if (!target) return 0;

  const d = Math.sqrt(dist2(p.x, p.z, target.x, target.z));
  const eye = p.y + PLAYER.eyeHeight;
  const at = (target.y ?? 0) + height;
  return clamp(
    Math.atan2(at - eye, Math.max(0.001, d)) + b.aimJitterY,
    PLAYER.pitchMin,
    PLAYER.pitchMax,
  );
}

function aimedAt(p, dx, dz, arc) {
  return Math.abs(angleDelta(p.aim, Math.atan2(dx, dz))) < arc;
}

/**
 * Can this bot actually see that chicken, or is there a box in the way?
 *
 * Without this a bot happily empties a magazine into the wall a player is
 * standing behind, which looks less like a mistake and more like the game not
 * working. Cheap enough to run per decision: a handful of boxes against one
 * segment, a few times a second.
 */
function canSee(world, p, target) {
  const boxes = world.obstacles;
  if (!boxes?.length) return true;
  const ay = p.y + PLAYER.eyeHeight;
  const by = (target.y ?? 0) + PLAYER.hitHeight * 0.5;
  for (const box of boxes) {
    if (segBoxEntry(p.x, ay, p.z, target.x, by, target.z, box, 0) >= 0) return false;
  }
  return true;
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
