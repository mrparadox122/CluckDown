// Pure, headless game simulation. No Babylon, no Colyseus, no DOM.
//
// The server runs this as the authority. The client runs the *same* code to
// predict its own chicken between server snapshots, and to power offline
// practice mode. Keeping it dependency-free is the whole point — don't import
// anything renderer- or network-shaped in here.

import {
  PLAYER, BULLET, BOMBER, PICKUP, SCORE, MODES,
  MULTIKILL_WINDOW, SEAT_COLORS, MODIFIER_POOL, modValue,
  TEAM_COLORS, teamForSeat, teamShade, spawnLayout, feederPoints, HILL, SHRINK, rollPickup,
  PING, pingDef,
  LEVELS, levelFromXp, xpForLevel, perkValue, rungOf,
  MAPS, DEFAULT_MAP, pickMapCandidates, BOUNTY, POTATO,
  CONTRACT, CONTRACTS, CONTRACT_LIST, HEIST, BOMB, REVENGE, GRAVITY, WALL_HEIGHT,
  coverFor, CROP, cropCapacity, SPREAD,
} from './constants.js';
import { nextSpread, coneDeviate } from './accuracy.js';
import {
  clamp, clampUnit, norm, len, dist2, segHitsCapsule, mulberry32, angleDelta,
  segBoxEntry, pushOutBox, insideAny,
} from './math.js';

let localIdCounter = 1;

export function createWorld({ mode = 'casual', seed = (Math.random() * 1e9) | 0, modifier } = {}) {
  const cfg = MODES[mode] ?? MODES.casual;
  const half = cfg.arena / 2;
  const rng = mulberry32(seed);

  // Drawn from the seeded RNG so a given seed always produces the same match —
  // handy for reproducing a bug report. Competitive modes never roll one.
  const rolled = cfg.modifiers
    ? MODIFIER_POOL[Math.floor(rng() * MODIFIER_POOL.length)]
    : 'none';
  const mod = modifier ?? rolled;

  const mapCandidates = pickMapCandidates(rng);

  return {
    modifier: mod,
    mode: cfg.id,
    cfg,
    arena: { size: cfg.arena, half },
    // Cover, rebuilt whenever the map changes. Derived from the map id rather
    // than synced: the client already knows the map and the arena size, so it
    // can compute the identical set and nothing has to go over the wire.
    obstacles: coverFor(DEFAULT_MAP, cfg.arena),

    // Map vote. The match sits in `lobby` until a map is chosen, then runs the
    // usual warmup -> live -> over. Nothing simulates during the lobby.
    map: DEFAULT_MAP,
    mapCandidates,
    votes: new Map(), // playerId -> mapId
    lobbyTime: 0,

    time: 0,
    phase: 'lobby', // lobby -> warmup -> live -> over
    clock: cfg.matchTime,
    players: new Map(),
    pickups: [],
    bomber: null,
    bomberSpawnAt: cfg.bomberFirstSpawn * modValue(mod, 'bomberFirstSpawnMul'),
    pickupSpawnAt: 3,
    events: [],
    rng,
    seed,
    nextEntityId: 1,
    winnerId: null,
    winnerTeam: null,

    // Team play. Null in free-for-all so every check can just ask "same team?"
    // and get a safe answer.
    teamScores: cfg.teams ? [0, 0] : null,

    // King of the Coop. Progress is keyed rather than indexed, because in team
    // play the hold belongs to the TEAM — four players rotating through the
    // zone are one hold, not four that each never finish.
    hill: cfg.hill
      ? { holder: null, contested: false, progress: {}, x: 0, z: 0, moveAt: HILL.moveEvery }
      : null,

    // Nests: home base in Egg Heist, and the plant site in Plant & Defuse.
    // One per TEAM — a shared nest is the rally point that makes defending a
    // place a thing four players can do together.
    nests: cfg.heist || cfg.bomb
      ? [0, 1].map((team) => ({ team, eggs: cfg.heist ? HEIST.eggsPerNest : 0, x: 0, z: 0 }))
      : null,

    // Team pings, held for PING.life then dropped. They never enter synced
    // state: the server sends each one only to the pinger's own team, so an
    // opponent's client is never told where it was.
    pings: [],
    looseEggs: cfg.heist ? [] : null,

    // Plant & Defuse.
    bomb: cfg.bomb ? null : null,
    bombAt: cfg.bomb ? 4 : 0,

    // Last Chicken Standing: safeHalf is the live boundary players are clamped
    // to. It starts at the full arena and closes from SHRINK.startAt onwards.
    safeHalf: half,

    // Crowned leader (Bounty) and the cursed egg (Hot Potato).
    bounty: null,
    bountyAt: 0,
    potato: null,
    potatoAt: POTATO.firstSpawn,
  };
}

/**
 * Applies a voted map. Arena size is the only thing that actually changes for
 * now; everything downstream (spawn corners, the safe zone, wall clamping)
 * already derives from it.
 *
 * Modes may scale it — a 1v1 on The Big Yard would be two chickens jogging.
 */
export function applyMap(world, mapId) {
  const map = MAPS[mapId] ? mapId : DEFAULT_MAP;
  world.map = map;

  const size = Math.round(MAPS[map].size * (world.cfg.arenaScale ?? 1));
  world.arena = { size, half: size / 2 };
  world.safeHalf = size / 2;
  world.obstacles = coverFor(map, size);

  // Move everyone onto the new spawns, or they start outside the walls.
  // Nests sit on the rally pads, so they move with the arena too.
  if (world.nests) {
    for (const nest of world.nests) {
      const pad = feederFor(world, nest.team);
      nest.x = pad.x;
      nest.z = pad.z;
    }
  }
  for (const p of world.players.values()) {
    const sp = spawnFor(world, p.seat);
    p.x = sp.x;
    p.z = sp.z;
    p.aim = Math.atan2(-sp.x, -sp.z);
    p.aimRaw = p.aim;
  }
  return map;
}

export function castVote(world, playerId, mapId) {
  if (world.phase !== 'lobby' || !world.mapCandidates.includes(mapId)) return false;
  world.votes.set(playerId, mapId);
  return true;
}

export function voteTally(world) {
  const counts = Object.fromEntries(world.mapCandidates.map((id) => [id, 0]));
  for (const [, id] of world.votes) if (id in counts) counts[id]++;
  return counts;
}

/** Highest-voted map; ties broken by the world RNG so it stays reproducible. */
export function winningMap(world) {
  const counts = voteTally(world);
  const top = Math.max(...Object.values(counts));
  const leaders = world.mapCandidates.filter((id) => counts[id] === top);
  return leaders[Math.floor(world.rng() * leaders.length)] ?? DEFAULT_MAP;
}

/** Ends the lobby and drops into warmup on the chosen map. */
export function beginMatch(world, mapId = null) {
  if (world.phase !== 'lobby') return world.map;
  const chosen = applyMap(world, mapId ?? winningMap(world));
  world.phase = 'warmup';
  world.time = 0;
  emit(world, { type: 'mapChosen', map: chosen });
  return chosen;
}

export function spawnPoints(world) {
  return spawnLayout(world.arena.half, !!world.cfg.teams);
}

/** Where this seat starts. */
export function spawnFor(world, seat) {
  const pts = spawnPoints(world);
  return pts[((seat % pts.length) + pts.length) % pts.length];
}

/** The pad you refill on: your team's shared rally point, or your own corner. */
export function feederFor(world, teamOrSeat) {
  const pads = feederPoints(world.arena.half, !!world.cfg.teams);
  return pads[((teamOrSeat % pads.length) + pads.length) % pads.length];
}

export function feederRadius(world) {
  return world.cfg.teams ? CROP.feeder.teamRadius : CROP.feeder.radius;
}

/** Every spawn this player may legally come back on. */
function spawnChoices(world, p) {
  const pts = spawnPoints(world);
  // Team play sends you back to your OWN line. Picking the corner furthest
  // from the enemy would otherwise respawn you behind theirs, which is both
  // free and unsurvivable.
  if (world.cfg.teams && p.team !== null) {
    return pts.filter((_, seat) => teamForSeat(seat) === p.team);
  }
  return pts;
}

export function addPlayer(world, { id, name, seat, isBot = false }) {
  const seatIdx = seat ?? world.players.size;
  const sp = spawnFor(world, seatIdx);
  const team = world.cfg.teams ? teamForSeat(seatIdx) : null;
  const p = {
    id,
    name: (name || 'Chicken').slice(0, 14),
    seat: seatIdx,
    team,
    // Silhouette says which side; the shade says which teammate.
    color: team !== null ? TEAM_COLORS[team] : SEAT_COLORS[seatIdx % SEAT_COLORS.length],
    shade: teamShade(seatIdx, team),
    isBot,
    x: sp.x, z: sp.z,
    // Height above the floor, and the vertical velocity that changes it.
    // Deliberately NOT part of knockback: kx/kz are a shove you steer against,
    // while y is somewhere you are. Nothing but your own jump lifts you.
    y: 0, vy: 0,
    kx: 0, kz: 0, // knockback velocity
    aim: Math.atan2(-sp.x, -sp.z), // face the middle
    pitch: 0, // vertical look, and therefore the vertical half of every shot
    hp: PLAYER.maxHp,
    alive: true,
    respawnAt: 0,
    invulnUntil: PLAYER.spawnInvuln,
    nextShotAt: 0,
    // The pecking order. XP is the truth and level is derived from it, never
    // the other way round — one number to move, and no way for the two to
    // disagree after a demotion.
    xp: 0,
    level: 1,
    windUntil: 0,   // Second Wind, rung 5
    windUsed: false,
    frenzyUntil: 0, // Feeding Frenzy, rung 6

    // Grain. See CROP: the crop is the magazine, pecking is the reload, and
    // standing on your own feeder is the shortcut that costs you a walk.
    crop: cropCapacity(world.modifier),
    dry: false,     // hit zero, and not yet pecked back to CROP.recoverTo
    peckAcc: 0,     // fractional grain, so the refill rate is not tick-quantised
    stillFor: 0,    // seconds stopped, against CROP.peckDelay
    pecking: false, // synced: it is the tell other players read
    feeding: false,
    healAcc: 0,
    lastHurtAt: -99, // for the feeder's out-of-combat regen
    taggedUntil: 0,  // briefly slowed by a bullet — see fire()
    pingAt: 0,       // next time this player may drop a marker
    // Movement inaccuracy, in radians. Rises the moment you move and settles
    // over SPREAD.settle when you stop — the number a counter-strafe is
    // actually buying, and the number the crosshair draws.
    spread: SPREAD.still,
    aimRaw: Math.atan2(-sp.x, -sp.z), // what the stick asked for, before assist
    aimTarget: null,  // sticky aim-assist lock
    carrying: 0,      // eggs in hand (Egg Heist)
    stealAt: 0,
    contract: null,
    contractProgress: 0,
    contractAt: 0,
    contractsDone: 0,
    eggsHeld: 0,
    nemesis: null,    // who killed you last, while the mark is live
    nemesisUntil: 0,
    revenges: 0,
    hillBank: 0,   // fractional hill score awaiting a whole point
    kills: 0, deaths: 0, score: 0,
    streak: 0, lastKillAt: -99,
    damageDealt: 0,
    input: { mx: 0, mz: 0, ax: 0, az: 0, pitch: 0, jump: false, shoot: false, seq: 0 },
    lastSeq: 0,
    connected: true,
  };
  world.players.set(id, p);
  return p;
}

export function removePlayer(world, id) {
  world.players.delete(id);
}

export function applyInput(world, id, input) {
  const p = world.players.get(id);
  if (!p) return;
  // Sanitize: never trust a client to send a sane vector.
  const [mx, mz] = clampUnit(Number(input.mx) || 0, Number(input.mz) || 0);
  const [ax, az] = clampUnit(Number(input.ax) || 0, Number(input.az) || 0);
  // Pitch is part of the shot now, so it is exactly as untrustworthy as the
  // rest of the struct: clamped to the same range the camera can render, and
  // NaN-proofed, or a hand-rolled client could fire straight down through the
  // floor and out at somebody's feet from across the map.
  const pitch = clamp(Number(input.pitch) || 0, PLAYER.pitchMin, PLAYER.pitchMax);
  p.input = {
    mx, mz, ax, az, pitch, jump: !!input.jump, shoot: !!input.shoot, seq: input.seq | 0,
  };
  p.lastSeq = input.seq | 0;
}

function emit(world, ev) {
  world.events.push(ev);
}

// ------------------------------------------------------------------- cover

/**
 * Pushes a body out of any cover it has ended up inside.
 *
 * Run after the move rather than before it: sliding along a wall falls out of
 * resolving the overlap on the shallower axis, and testing-then-blocking would
 * instead stop you dead the moment you brushed a corner.
 *
 * Two passes, because pushing out of one box can push you into its neighbour —
 * the L-shaped join of two walls is exactly where that happens, and it is also
 * exactly where a player will try to hide.
 */
function clearCover(world, body, r, lim) {
  if (!world.obstacles.length) return;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const box of world.obstacles) {
      // Above the top of it there is nothing to hit. This is the whole reason
      // cover is never short enough to land on: "am I over it" stays a question
      // about one number and never becomes a question about standing on things.
      if ((body.y ?? 0) >= box.h) continue;
      const out = pushOutBox(body.x, body.z, r, box);
      if (!out) continue;
      body.x = out.x;
      body.z = out.z;
      moved = true;
    }
    if (!moved) break;
  }
  // The boundary gets the last word, always. Resolving out of a box can shove a
  // body past it, and in Last Chicken Standing that is the difference between
  // standing in the ring and being cooked by it for something you did not do.
  if (lim !== undefined) {
    body.x = clamp(body.x, -lim, lim);
    body.z = clamp(body.z, -lim, lim);
  }
}

/** Is this spot clear enough to drop something on? */
export function spotIsClear(world, x, z, pad = 0) {
  return !insideAny(world.obstacles, x, z, pad);
}

/**
 * Finds a clear spot near a wanted one, spiralling outward.
 *
 * Pickups, the bomber and the loose bomb are all placed at random or at fixed
 * points that cover may now be standing on. Nudging is better than rejecting:
 * a rejected spawn means no pickup that cycle, which is invisible and feels
 * like the game forgot.
 */
function nearestClear(world, x, z, pad = 0.6) {
  if (spotIsClear(world, x, z, pad)) return { x, z };
  const lim = world.arena.half - 2;
  for (let step = 1; step <= 6; step++) {
    const r = step * 2.2;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const nx = clamp(x + Math.sin(a) * r, -lim, lim);
      const nz = clamp(z + Math.cos(a) * r, -lim, lim);
      if (spotIsClear(world, nx, nz, pad)) return { x: nx, z: nz };
    }
  }
  return { x, z }; // give up rather than fail; the map would have to be absurd
}

function nextId(world) {
  return world.nextEntityId++;
}

// ---------------------------------------------------------------- main step

export function stepWorld(world, dt) {
  world.events = [];

  // The lobby is a waiting room: the clock is the vote timer, and no gameplay
  // runs at all. The room (or LocalSession) decides when it ends.
  if (world.phase === 'lobby') {
    world.lobbyTime += dt;
    return world.events;
  }

  world.time += dt;

  if (world.phase === 'warmup' && world.time >= 1.5) world.phase = 'live';
  if (world.phase === 'live') {
    world.clock = Math.max(0, world.clock - dt);
    if (world.clock <= 0) endMatch(world, 'time');
  }

  stepShrink(world, dt);
  stepPlayers(world, dt);
  stepBomber(world, dt);
  stepPickups(world, dt);
  stepHill(world, dt);
  stepBounty(world, dt);
  stepPotato(world, dt);
  stepHeist(world, dt);
  stepBomb(world, dt);
  stepPings(world);
  checkSurvival(world);

  // Contracts are scored last, from the events this tick produced — that keeps
  // them a pure counting layer with no hooks scattered through the simulation.
  stepContracts(world, dt);

  return world.events;
}

function stepPlayers(world, dt) {
  // The safe area is the wall in Last Chicken Standing; everywhere else it is
  // simply the arena, so this one line covers both.
  const half = world.safeHalf;
  const r = PLAYER.radius;
  const knockDecayMul = modValue(world.modifier, 'knockbackDecayMul');
  const gravity = GRAVITY * modValue(world.modifier, 'gravityMul');

  for (const p of world.players.values()) {
    if (!p.alive) {
      // Last Chicken Standing has no second chances.
      const canRespawn = world.cfg.respawn !== false;
      if (canRespawn && world.phase !== 'over' && world.time >= p.respawnAt) respawn(world, p);
      continue;
    }

    const inp = p.input;
    let moveScale = world.phase === 'live' ? 1 : 0.35;
    // The ladder's mobility perks. Long Legs is permanent from rung 3; Second
    // Wind and Feeding Frenzy are bursts, and they multiply — a level 6 who
    // just took a kill and then dropped low is briefly very hard to catch,
    // which is exactly the highlight the top of the ladder is for.
    moveScale *= perkValue(p.level, 'speedMul');
    // Tagged: hit by a bullet in the last moment. A slow rather than a shove —
    // see fire(). It expires on its own and never fights your input.
    if (world.time < p.taggedUntil) moveScale *= PLAYER.tagSlow;
    if (world.time < p.windUntil) moveScale *= perkValue(p.level, 'secondWind', {}).speedMul ?? 1;
    if (world.time < p.frenzyUntil) moveScale *= perkValue(p.level, 'frenzy', {}).speedMul ?? 1;
    // Carrying is the cost that balances stealing: a full load makes you slow
    // and obvious, so hoarding is punished without needing a hard cap.
    if (p.carrying > 0) moveScale *= 1 - Math.min(HEIST.maxCarrySlow, HEIST.carrySlow * p.carrying);
    if (world.bomb?.carriedBy === p.id) moveScale *= 1 - BOMB.carrySlow;
    // Cap the accumulated shove before it is used. Every knockback source —
    // bullets, the bomber, the plant bomb, the potato — funnels through here,
    // so one clamp covers all of them and none of them can stack past the point
    // where the player stops being able to steer.
    const kMag = len(p.kx, p.kz);
    if (kMag > PLAYER.maxKnockback) {
      const s = PLAYER.maxKnockback / kMag;
      p.kx *= s;
      p.kz *= s;
    }

    const vx = inp.mx * PLAYER.speed * moveScale + p.kx;
    const vz = inp.mz * PLAYER.speed * moveScale + p.kz;

    p.x = clamp(p.x + vx * dt, -half + r, half - r);
    p.z = clamp(p.z + vz * dt, -half + r, half - r);
    clearCover(world, p, r, half - r);

    // --- vertical.
    //
    // Jump is level-triggered rather than edge-triggered: holding the button
    // hops again the moment you land. That is deliberate on touch, where
    // reliably re-tapping a button while a second thumb is swiping to look is
    // genuinely hard. `vy <= 0` is what stops it becoming a double jump — you
    // cannot push off again while you are still on the way up.
    if (inp.jump && p.y <= 0 && p.vy <= 0) {
      p.vy = PLAYER.jumpSpeed;
      emit(world, { type: 'jump', x: p.x, z: p.z, target: p.id });
    }
    p.vy -= gravity * dt;
    p.y += p.vy * dt;
    if (p.y <= 0) {
      p.y = 0;
      p.vy = 0;
    } else if (p.y >= PLAYER.maxJumpHeight) {
      // Bumping your head on the ceiling described in PLAYER.maxJumpHeight.
      // Killing the upward velocity rather than only the position matters:
      // otherwise a low-gravity hop would press against the cap for half a
      // second and then still be climbing when it came off it.
      p.y = PLAYER.maxJumpHeight;
      if (p.vy > 0) p.vy = 0;
    }

    // Knockback bleeds off exponentially so hits feel punchy but not floaty.
    const damp = Math.exp(-PLAYER.knockbackDecay * knockDecayMul * dt);
    p.kx *= damp;
    p.kz *= damp;

    // Aim follows the right stick; falls back to movement direction when idle.
    // This is the RAW request — assist then decides what p.aim actually becomes.
    if (len(inp.ax, inp.az) > 0.15) p.aimRaw = Math.atan2(inp.ax, inp.az);
    else if (len(inp.mx, inp.mz) > 0.15) p.aimRaw = Math.atan2(inp.mx, inp.mz);

    if (p.nemesis && world.time >= p.nemesisUntil) p.nemesis = null;

    applyAim(p);
    stepCrop(world, p, dt);
    stepSecondWind(world, p);
    stepPotatoBurn(world, p, dt);
    // Stepped here rather than inside fire(), because the cone has to keep
    // settling while you are NOT shooting — that quarter second of stillness
    // before the trigger comes down is the entire skill being rewarded.
    p.spread = nextSpread(p.spread ?? SPREAD.still, len(inp.mx, inp.mz), p.y > 0, dt);

    if (inp.shoot && world.phase === 'live' && world.time >= p.nextShotAt) {
      if (p.crop > 0 && !p.dry) fire(world, p);
      else {
        // Empty. Say so, once per trigger-pull's worth of time rather than
        // sixty times a second — an unanswered trigger is the moment a player
        // needs feedback most, and the moment a HUD is least likely to be read.
        p.nextShotAt = world.time + PLAYER.fireCooldown * 2;
        emit(world, { type: 'dryFire', target: p.id, x: p.x, y: p.y, z: p.z });
      }
    }
  }

  separatePlayers(world);
  // Shoving two chickens apart can shove one into a wall, so cover gets the
  // last word. Cover is static and players are not: the wall has to win, or a
  // crowd at a corner slowly extrudes somebody through it.
  for (const p of world.players.values()) {
    if (p.alive) clearCover(world, p, PLAYER.radius, world.safeHalf - PLAYER.radius);
  }
}

/**
 * The simulation takes the aim angle it is given.
 *
 * Aim assist used to live here, rewriting p.aim server-side. It moved to the
 * client (see shared/src/aim.js) because first person renders the player's own
 * look angle: a server that steered the aim somewhere else would leave the
 * crosshair pointing at one thing and the bullet hitting another. The client
 * now shapes its own input before sending, so everything agrees by
 * construction.
 */
function applyAim(p) {
  p.aim = p.aimRaw;
  // Pitch has no movement fallback the way yaw does: an idle stick means
  // "still looking where I was looking", not "point at your feet".
  p.pitch = p.input.pitch;
}

/** The cursed egg burns its holder for as long as they are carrying it. */
function stepPotatoBurn(world, p, dt) {
  const pot = world.potato;
  if (!pot || pot.holder !== p.id) return;
  p.potatoAcc = (p.potatoAcc ?? 0) + POTATO.dps * dt;
  if (p.potatoAcc >= POTATO.dps * 0.5) {
    p.potatoAcc -= POTATO.dps * 0.5;
    damagePlayer(world, p, POTATO.dps * 0.5, null, 'potato');
  }
}

/**
 * Second Wind, rung 5.
 *
 * Fires once per life the moment health crosses the threshold, rather than
 * ticking while you are below it. That is the difference between a perk and a
 * state: it has a moment, a sound and a colour, and a reward you can point at
 * the instant of is worth several you merely possess. Once per life also stops
 * it becoming a permanent aura for anyone who simply plays hurt.
 */
function stepSecondWind(world, p) {
  const wind = perkValue(p.level, 'secondWind', null);
  if (!wind || p.windUsed) return;
  if (p.hp > PLAYER.maxHp * wind.at) return;
  p.windUsed = true;
  p.windUntil = world.time + wind.seconds;
  emit(world, { type: 'secondWind', target: p.id, x: p.x, y: p.y, z: p.z });
}

/** Soft circle separation so chickens can't occupy the same tile. */
function separatePlayers(world) {
  const list = [...world.players.values()].filter((p) => p.alive);
  const minD = PLAYER.radius * 2;
  const { half } = world.arena;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const push = (minD - d) / 2;
      const nx = dx / d;
      const nz = dz / d;
      a.x = clamp(a.x - nx * push, -half + PLAYER.radius, half - PLAYER.radius);
      a.z = clamp(a.z - nz * push, -half + PLAYER.radius, half - PLAYER.radius);
      b.x = clamp(b.x + nx * push, -half + PLAYER.radius, half - PLAYER.radius);
      b.z = clamp(b.z + nz * push, -half + PLAYER.radius, half - PLAYER.radius);
    }
  }
}

function fire(world, p) {
  p.crop--;
  // Empty. From here nothing fires until CROP.recoverTo grain are back — see
  // the constant for why nursing a crop at zero cannot be allowed to work.
  if (p.crop <= 0) p.dry = true;

  // Rapid Peck (rung 4), Feeding Frenzy (rung 6) and TRIGGER HAPPY all multiply
  // the same number, so the floor is doing real work — three stacked
  // multipliers without one is a fire rate nobody can react to.
  let cooldown = PLAYER.fireCooldown
    * modValue(world.modifier, 'fireCooldownMul')
    * perkValue(p.level, 'fireCooldownMul');
  if (world.time < p.frenzyUntil) cooldown *= perkValue(p.level, 'frenzy', {}).fireCooldownMul ?? 1;
  p.nextShotAt = world.time + Math.max(PLAYER.minCooldown, cooldown);
  // Spherical direction: yaw and pitch together. This is the line that makes
  // the crosshair honest — the shot leaves along exactly the vector the camera
  // is looking down, so a reticle nailed to screen centre is the truth rather
  // than an approximation of it.
  //
  // ...then MOVEMENT deviates it, inside a cone the crosshair is drawing at its
  // true size. Standing still the cone is exactly zero and this is the identity
  // — the reticle is not approximately honest for a stopped player, it is
  // exactly honest, which is the contract everything else here rests on.
  //
  // Rolled from the world RNG on the authoritative side. Inaccuracy a client
  // computes for itself is inaccuracy a client can decline.
  const { dx, dy, dz } = coneDeviate(p.aim, p.pitch, p.spread ?? SPREAD.still, world.rng);
  const muzzle = PLAYER.radius + BULLET.radius + 0.25;
  const id = nextId(world);
  const bx = p.x + dx * muzzle;
  const by = p.y + PLAYER.eyeHeight + dy * muzzle;
  const bz = p.z + dz * muzzle;

  // Resolved NOW. See traceShot for why this is not a projectile any more.
  const shot = traceShot(world, p, bx, by, bz, dx, dy, dz);

  if (shot.hit === 'bomber') {
    damageBomber(world, BULLET.damage, p.id, dx, dz);
  } else if (shot.hit === 'player') {
    const t = shot.target;
    const damage = shot.head ? BULLET.headDamage : BULLET.damage;
    // TAGGING, not shoving.
    //
    // Bullets used to knock you across the floor. That is a projectile-game
    // idea, and to anyone arriving from CS or Valorant it reads as the game
    // taking the controls away — the exact complaint PLAYER.maxKnockback exists
    // to bound. A brief slow does the same job better: you feel the hit land,
    // you are meaningfully worse off, and you never stop being the one steering.
    // Blasts still throw you; being thrown by an explosion is correct.
    t.taggedUntil = world.time + PLAYER.tagDuration;
    damagePlayer(world, t, damage * modValue(world.modifier, 'damageMul'), p.id,
      shot.head ? 'head' : 'bullet');
  }

  // One event carries the whole shot: where it left, and where it landed. The
  // client draws a tracer between the two — decoration on a line that has
  // already been resolved, which is exactly how a hitscan game does it.
  emit(world, {
    type: 'shot', id,
    x: bx, y: by, z: bz,
    hx: shot.x, hy: shot.y, hz: shot.z,
    hit: shot.hit, head: !!shot.head, wall: shot.wall,
    // The angles the round ACTUALLY left along, spread included — not the ones
    // the player asked for. Only the tracer's fallback path reads them, and a
    // fallback that draws a different line from the one that was resolved is a
    // fallback that lies about where you shot.
    aim: Math.atan2(dx, dz), pitch: Math.asin(clamp(dy, -1, 1)),
    owner: p.id,
    rapid: world.time < p.frenzyUntil, crop: p.crop,
  });
}

// -------------------------------------------------------------------- grain

/**
 * Pecking and feeding, run once per player per tick.
 *
 * The order matters: the feeder wins over pecking, because a player standing on
 * their pad should not also be head-down in the dirt. Both are "stand still and
 * recover", and the feeder is simply the better version you had to walk to.
 */
function stepCrop(world, p, dt) {
  const inp = p.input;
  const cap = cropCapacity(world.modifier);
  // Airborne counts as moving. Pecking mid-jump would look absurd, and more
  // importantly it would let a player refill while doing the one thing that
  // makes them hardest to hit.
  const moving = len(inp.mx, inp.mz) > 0.05 || p.y > 0;
  p.stillFor = moving ? 0 : p.stillFor + dt;

  const wasPecking = p.pecking;
  p.pecking = false;
  p.feeding = false;
  if (world.phase !== 'live') return;

  // --- the feeder: your team's rally pad, or your own corner in a duel.
  const pad = feederFor(world, p.team ?? p.seat);
  const fr = feederRadius(world);
  if (dist2(p.x, p.z, pad.x, pad.z) <= fr * fr) {
    p.feeding = true;
    // Grain always, health only out of combat — see CROP.feeder.combatDelay.
    p.crop = Math.min(cap, p.crop + CROP.feeder.refill * dt);
    const settled = world.time - (p.lastHurtAt ?? -99) >= CROP.feeder.combatDelay;
    if (p.hp < PLAYER.maxHp && settled) {
      // Chunked like the burn tick, and for the same reason: sixty heal events
      // a second would bury everything else in the feed.
      p.healAcc += CROP.feeder.heal * dt;
      if (p.healAcc >= 4) {
        const gain = Math.min(Math.floor(p.healAcc), PLAYER.maxHp - p.hp);
        p.healAcc -= Math.floor(p.healAcc);
        p.hp += gain;
        if (gain > 0) emit(world, { type: 'fed', target: p.id, x: p.x, z: p.z, heal: gain });
      }
    } else {
      p.healAcc = 0;
    }
    return;
  }
  p.healAcc = 0;

  // --- pecking: anywhere, standing still.
  //
  // `p.crop <= 0` in the second half is the deadlock guard. Holding fire
  // normally means "I am in a fight, do not put your head down" — but holding
  // fire on an EMPTY crop has to peck anyway, or the most panicked player in
  // the match is the one who can never recover.
  // An empty crop is a dry one, however it got there. fire() sets the flag on
  // the way down, but deriving it here as well keeps the two from ever
  // disagreeing — a crop zeroed by anything else (a penalty, a refund that
  // clamps, a future ammo type) would otherwise leave a player who can neither
  // shoot nor peck, which is the worst state in the game and the hardest to
  // notice in review.
  if (p.crop <= 0) p.dry = true;

  // Holding fire normally means "I am in a fight, keep your head up". Holding
  // it while DRY has to peck anyway: that player has no other way out, and it
  // is always the most panicked person in the match.
  const wants = p.crop < cap && (!inp.shoot || p.dry);
  if (!moving && wants && p.stillFor >= CROP.peckDelay) {
    p.pecking = true;
    // Quick Crop (rung 2) lands here. The most helpless moment in the game is
    // the one the first unlock shortens, which is deliberate.
    p.peckAcc += CROP.peckRate
      * modValue(world.modifier, 'peckRateMul')
      * perkValue(p.level, 'peckRateMul') * dt;
    if (p.peckAcc >= 1) {
      const grain = Math.min(Math.floor(p.peckAcc), cap - p.crop);
      p.peckAcc -= Math.floor(p.peckAcc);
      p.crop += grain;
    }
    if (!wasPecking) emit(world, { type: 'peck', target: p.id, x: p.x, z: p.z });
  } else {
    p.peckAcc = 0;
  }

  // Back in the fight. Checked after both refills, so arriving at a feeder
  // clears it in the same tick rather than a frame later.
  if (p.dry && p.crop >= Math.min(CROP.recoverTo, cap)) p.dry = false;
}

/**
 * Where a shot lands, resolved instantly.
 *
 * HITSCAN. This used to be a projectile that stepped a few units per tick, and
 * players who came from CS or Valorant said shooting felt unsatisfying without
 * being able to name why. The reason is travel time: even at 52 units a second
 * a duel at fifteen units took nearly three tenths of a second to resolve, so
 * hitting a moving chicken meant leading it. A player trained on hitscan does
 * not lead — they put the dot on the target and click — so every shot they fired
 * here landed behind where they were looking, and the game felt like it was
 * disagreeing with them.
 *
 * No amount of extra speed fixes that, because it is not a tuning problem. It
 * is a different physical model, and this is the other one: the shot resolves
 * on the tick it is fired, and the tracer the client draws is decoration
 * travelling to an endpoint that has already been decided.
 *
 * The ordering below is the same as the old per-tick code, done once instead of
 * forty times: clip to the world, then look for something alive inside what is
 * left. Solid things have to be resolved FIRST or a shot kills someone standing
 * behind cover.
 */
function traceShot(world, shooter, ox, oy, oz, dx, dy, dz) {
  const { half } = world.arena;
  const range = BULLET.range;
  let ex = ox + dx * range;
  let ey = oy + dy * range;
  let ez = oz + dz * range;
  let wall = false;

  const clipTo = (t) => {
    ex = ox + (ex - ox) * t;
    ey = oy + (ey - oy) * t;
    ez = oz + (ez - oz) * t;
    wall = true;
  };

  // The floor. Aiming down is a real option, so a shot into the ground stops
  // there rather than carrying on under the arena.
  if (dy < -1e-6 && ey < 0) clipTo(oy / (oy - ey));

  // The walls — but only below the parapet. A shot angled steeply enough
  // clears them and leaves, which is what looking at the place suggests.
  for (const [o, d] of [[ox, dx], [oz, dz]]) {
    if (Math.abs(d) < 1e-6) continue;
    const lim = half - BULLET.radius;
    const t = ((d > 0 ? lim : -lim) - o) / (d * range);
    if (t <= 0 || t >= 1) continue;
    if (oy + (ey - oy) * t > WALL_HEIGHT) continue;
    clipTo(t);
  }

  // Cover.
  for (const box of world.obstacles) {
    const t = segBoxEntry(ox, oy, oz, ex, ey, ez, box, BULLET.radius);
    if (t >= 0) clipTo(t);
  }

  // ...and now whatever is alive inside what is left of the line. Nearest wins,
  // measured along the ray — a shot that passes through two chickens hits the
  // near one.
  let best = null;
  let bestAlong = Infinity;
  const consider = (obj, cx, cy, cz, height, radius, kind) => {
    if (!segHitsCapsule(ox, oy, oz, ex, ey, ez, cx, cy, cz, height, radius)) return;
    const along = (cx - ox) * dx + (cy + height * 0.5 - oy) * dy + (cz - oz) * dz;
    if (along < 0 || along >= bestAlong) return;
    bestAlong = along;
    best = { obj, kind, x: cx, y: clamp(oy + dy * along, cy, cy + height), z: cz };
  };

  const bomber = world.bomber;
  if (bomber && bomber.alive) {
    consider(bomber, bomber.x, 0, bomber.z, BOMBER.hitHeight, BOMBER.radius + BULLET.radius, 'bomber');
  }
  for (const t of world.players.values()) {
    if (t.id === shooter.id || !t.alive || world.time < t.invulnUntil) continue;
    // Team-mates are not targets, and they do not block either — you can shoot
    // past a partner rather than being walled in by them.
    if (t.team !== null && shooter.team !== null && t.team === shooter.team) continue;
    consider(t, t.x, t.y, t.z, PLAYER.hitHeight, PLAYER.radius + BULLET.radius, 'player');
  }

  if (best) {
    // Measured from the target's own feet, so it follows a jumping chicken.
    const head = best.kind === 'player' && best.y - best.obj.y >= BULLET.headFrom;
    return {
      x: best.x, y: best.y, z: best.z, hit: best.kind, target: best.obj, head, wall: false,
    };
  }
  return { x: ex, y: ey, z: ez, hit: null, target: null, wall };
}

// ------------------------------------------------------------ the pecking order

/**
 * Moves a player's XP and re-derives their level, announcing any change.
 *
 * Everything about the ladder funnels through here so that XP stays the single
 * source of truth and `level` is never set directly — two numbers that can
 * disagree is how a demotion ends up showing the wrong perks.
 *
 * @param floor lowest XP this change may take them to. The demotion guard.
 */
function awardXp(world, p, amount, reason, floor = 0) {
  if (!amount) return;
  const was = p.level;
  p.xp = Math.max(floor, Math.min(xpForLevel(LEVELS.max + 1) - 1, p.xp + amount));
  p.level = levelFromXp(p.xp);
  if (p.level === was) return;

  const rung = rungOf(p.level);
  emit(world, {
    type: p.level > was ? 'levelUp' : 'levelDown',
    target: p.id, x: p.x, y: p.y, z: p.z,
    level: p.level, from: was,
    name: rung.name, perk: rung.perk, blurb: rung.blurb, color: rung.color,
    reason,
  });
}

/**
 * XP for a kill, by how far apart the two of you were.
 *
 * Beating someone above you is worth multiples of beating someone below, which
 * is what keeps the leader from running away with it: they are simultaneously
 * the biggest threat and the fastest way up, so the room has a reason to go at
 * them rather than farm whoever is already losing. Clamped both ways — nobody
 * should be able to grind the bottom of the table, and nobody should leap three
 * rungs off one lucky shot.
 */
export function killXp(killerLevel, victimLevel) {
  const gap = clamp(victimLevel - killerLevel, -LEVELS.kill.maxRungs, LEVELS.kill.maxRungs);
  return Math.max(LEVELS.kill.floor, LEVELS.kill.base + gap * LEVELS.kill.perRung);
}

/**
 * XP lost for dying, by how far BELOW you the killer was.
 *
 * Losing to someone above you is nearly free — you were outmatched, and
 * punishing that just punishes being new. Losing to someone below you is what
 * costs, because that is the one that was yours to avoid.
 */
export function deathXp(victimLevel, killerLevel) {
  const under = clamp(victimLevel - killerLevel, 0, LEVELS.death.maxRungs);
  return -(LEVELS.death.base + under * LEVELS.death.perRung);
}

// ------------------------------------------------------------ damage / death

export function damagePlayer(world, target, amount, byId, kind) {
  if (!target.alive || world.time < target.invulnUntil || world.phase === 'over') return;
  const dealt = Math.min(amount, target.hp);
  target.hp -= dealt;
  // Starts the feeder's regen lockout. Anything that hurts counts, including
  // the zone and your own cursed egg — "am I in combat" is really "is something
  // currently going wrong", and all of those qualify.
  target.lastHurtAt = world.time;

  const attacker = byId != null ? world.players.get(byId) : null;
  if (attacker && attacker !== target) {
    attacker.damageDealt += dealt;
  }

  emit(world, {
    type: 'hit', x: target.x, z: target.z, amount: Math.round(dealt),
    target: target.id, by: byId ?? null, kind, head: kind === 'head',
  });

  if (target.hp <= 0) killPlayer(world, target, byId, kind);
}

function killPlayer(world, target, byId, kind) {
  target.hp = 0;
  target.alive = false;
  target.deaths++;
  target.score += SCORE.death;
  target.streak = 0;
  target.respawnAt = world.time + PLAYER.respawnDelay;
  dropEggs(world, target);
  target.input = {
    mx: 0, mz: 0, ax: 0, az: 0, pitch: 0, jump: false, shoot: false, seq: target.input.seq,
  };

  const killer = byId != null ? world.players.get(byId) : null;
  let multi = 0;
  let revenge = false;
  const wasBounty = world.bounty === target.id;
  // Captured BEFORE any XP moves. Awarding the kill can promote the killer past
  // their victim, at which point asking "was this an upset" of the post-kill
  // levels answers no — and the one kill most worth celebrating is the one that
  // stops reporting itself.
  const victimLevel = target.level;
  const killerLevel = killer && killer !== target ? killer.level : null;
  const punchedUp = killerLevel !== null && victimLevel > killerLevel;
  if (killer && killer !== target) {
    killer.kills++;
    // Taking the crown down is the whole point of marking someone.
    killer.score += SCORE.kill * (wasBounty ? BOUNTY.multiplier : 1);
    // Fresh meal. Winning a fight should not immediately cost you the next one,
    // and arriving at the second chicken empty is how a good play turns into a
    // bad minute.
    killer.crop = Math.min(cropCapacity(world.modifier), killer.crop + CROP.killRefund);

    // Feeding Frenzy, rung 6: a kill fills you outright and sets you loose.
    // The only perk that chains, which is what makes the top of the ladder a
    // highlight rather than a bigger number.
    const frenzy = perkValue(killer.level, 'frenzy', null);
    if (frenzy) {
      killer.crop = cropCapacity(world.modifier);
      killer.dry = false;
      killer.frenzyUntil = world.time + frenzy.seconds;
      emit(world, { type: 'frenzy', target: killer.id, x: killer.x, y: killer.y, z: killer.z });
    }

    awardXp(world, killer, killXp(killer.level, target.level), 'kill');
    killer.streak = world.time - killer.lastKillAt <= MULTIKILL_WINDOW ? killer.streak + 1 : 1;
    killer.lastKillAt = world.time;
    multi = killer.streak;

    // Settling the score: did the killer just take down their own nemesis?
    if (killer.nemesis === target.id && world.time < killer.nemesisUntil) {
      revenge = true;
      killer.revenges++;
      killer.score += REVENGE.bonus;
      killer.nemesis = null;
      killer.nemesisUntil = 0;
    }

    // ...and the victim now has one. Set after the check above, so killing
    // someone never marks them as their own killer's nemesis in the same beat.
    target.nemesis = killer.id;
    target.nemesisUntil = world.time + REVENGE.window;
  }

  // Falling down the ladder. Two guards, and both exist because loss aversion
  // runs about twice as strong as the pleasure of an equivalent gain — a ladder
  // that takes as freely as it gives is one people stop climbing.
  //
  //   * never below rung 1, so there is always a floor to stand on
  //   * never more than ONE rung per death, whatever the arithmetic says
  //
  // The second is the important one. Without it a level 5 killed by a level 1
  // drops to 3 in a single moment, and a player who has just lost a fight is
  // the last person who should be handed a second punishment on top.
  if (killer && killer !== target) {
    awardXp(world, target, deathXp(target.level, killer.level), 'death',
      xpForLevel(Math.max(1, target.level - 1)));
  }

  // The crown is vacated the instant its holder dies.
  if (wasBounty) world.bounty = null;

  emit(world, {
    type: 'kill',
    // `y` so the burst of feathers happens where the chicken actually was.
    // Dying at the top of a jump used to explode a metre under your own feet.
    x: target.x, y: target.y, z: target.z,
    target: target.id,
    by: killer && killer !== target ? killer.id : null,
    kind, // 'bullet' | 'head' | 'blast' | 'zone' | 'potato'
    multi,
    bounty: wasBounty,
    revenge,
    // The pecking order, on the event that announces the kill: what rung they
    // were on, and whether taking them was punching up. The killfeed and the
    // giantSlayer contract both read it, and neither should have to go looking
    // up a player who may already have respawned.
    level: victimLevel,
    byLevel: killerLevel,
    punchedUp,
    color: target.color,
    // Everything the "you were killed by" panel needs, so the client never has
    // to guess at what happened to it.
    byName: killer && killer !== target ? killer.name : null,
    byColor: killer && killer !== target ? killer.color : null,
    byHp: killer && killer !== target ? Math.max(0, Math.round(killer.hp)) : null,
    byDist: killer && killer !== target
      ? Math.round(Math.sqrt(dist2(target.x, target.z, killer.x, killer.z)) * 10) / 10
      : null,
  });

  if (world.teamScores && killer && killer.team !== null) {
    world.teamScores[killer.team]++;
    if (world.cfg.teamKillLimit && world.teamScores[killer.team] >= world.cfg.teamKillLimit) {
      endMatch(world, 'teamKillLimit');
    }
  }

  if (world.cfg.killLimit && killer && killer.kills >= world.cfg.killLimit) {
    endMatch(world, 'killLimit');
  }
}

function respawn(world, p) {
  const lim = world.safeHalf - 3.5;
  // Spawn at whichever corner is furthest from the nearest living enemy —
  // stops the "spawn directly into a bullet" experience.
  const pts = spawnChoices(world, p);
  const foes = [...world.players.values()]
    .filter((o) => o !== p && o.alive && (p.team === null || o.team !== p.team));
  let best = spawnFor(world, p.seat);
  let bestScore = -Infinity;
  for (const pt of pts) {
    let nearest = Infinity;
    for (const f of foes) nearest = Math.min(nearest, dist2(pt.x, pt.z, f.x, f.z));
    if (world.bomber?.alive) nearest = Math.min(nearest, dist2(pt.x, pt.z, world.bomber.x, world.bomber.z));
    if (nearest > bestScore) { bestScore = nearest; best = pt; }
  }
  // Corners can sit outside the safe area once it has closed in.
  const spot = nearestClear(world, clamp(best.x, -lim, lim), clamp(best.z, -lim, lim), PLAYER.radius + 0.3);
  p.x = spot.x;
  p.z = spot.z;
  p.kx = p.kz = 0;
  // Back on the ground, looking level. Respawning mid-air with the pitch you
  // died at would hand you a corner of the sky and no idea why.
  p.y = 0;
  p.vy = 0;
  p.pitch = 0;
  p.input = { ...p.input, pitch: 0, jump: false };
  p.hp = PLAYER.maxHp;
  p.crop = cropCapacity(world.modifier);
  p.dry = false;
  // Second Wind is once per LIFE, not once per match — it is an escape from a
  // fight, and a fresh life is a fresh fight.
  p.windUsed = false;
  p.windUntil = 0;
  p.frenzyUntil = 0;
  p.peckAcc = 0;
  p.stillFor = 0;
  p.pecking = false;
  // A fresh life starts pinpoint. Inheriting the cone you died sprinting with
  // would mean your first shot back missed for something that happened before
  // you existed.
  p.spread = SPREAD.still;
  p.alive = true;
  p.invulnUntil = world.time + PLAYER.spawnInvuln;
  p.aim = Math.atan2(-p.x, -p.z);
  emit(world, { type: 'respawn', x: p.x, z: p.z, target: p.id });
}

function endMatch(world, reason) {
  if (world.phase === 'over') return;
  world.phase = 'over';
  world.clock = 0;
  // Egg Heist is settled by what is in your nest, not by score — which is why a
  // raid in the closing seconds can take the whole match.
  if (world.cfg.heist) {
    for (const p of world.players.values()) {
      p.eggsHeld = nestOf(world, p.team)?.eggs ?? 0;
      p.score += p.eggsHeld * HEIST.depositScore;
    }
  }

  const ranking = [...world.players.values()].sort((a, b) => b.score - a.score || b.kills - a.kills);
  // A survival or hill win has already named its winner; don't overwrite it.
  world.winnerId ??= ranking[0]?.id ?? null;
  if (world.teamScores && world.winnerTeam === null) {
    const [blue, red] = world.teamScores;
    world.winnerTeam = blue === red ? null : (blue > red ? 0 : 1);
  }
  emit(world, {
    type: 'matchEnd', reason, winner: world.winnerId, winnerTeam: world.winnerTeam,
  });
}

// -------------------------------------------------------------- safe zone

/**
 * Closes the play area in Last Chicken Standing.
 *
 * Players are clamped to `safeHalf` in stepPlayers, so shrinking it physically
 * herds everyone together. The damage below covers the instant between the
 * boundary moving and the clamp catching up.
 */
function stepShrink(world, dt) {
  if (!world.cfg.shrink || world.phase !== 'live') return;

  const elapsed = world.cfg.matchTime - world.clock;
  if (elapsed < SHRINK.startAt) return;

  // No event for this. The boundary moves every single tick, so emitting one
  // would be 60 broadcasts a second for a single number — it rides in synced
  // state instead, which is diffed and sent only when it actually changes.
  world.safeHalf = Math.max(SHRINK.minHalf, world.safeHalf - SHRINK.rate * dt);

  for (const p of world.players.values()) {
    if (!p.alive) continue;
    const outside = Math.max(Math.abs(p.x), Math.abs(p.z)) - world.safeHalf;
    if (outside > 0.01) damagePlayer(world, p, SHRINK.damagePerSec * dt, null, 'zone');
  }
}

/**
 * Ends a no-respawn match once one side is left standing.
 *
 * Last Chicken is FFA-by-definition, so 4v4 reinterprets it as last ROOST
 * standing: the round ends when every member of a team is down. Free-for-all
 * (a duel) still resolves on one body, which is the same rule with one player
 * per side.
 */
function checkSurvival(world) {
  if (world.cfg.respawn !== false || world.phase !== 'live') return;
  if (world.players.size < 2) return;

  const alive = [...world.players.values()].filter((p) => p.alive);

  if (world.cfg.teams) {
    const sides = new Set(alive.map((p) => p.team));
    if (sides.size > 1) return;
    world.winnerTeam = alive.length ? [...sides][0] : null;
    // Best of the surviving side, so the results screen still names somebody.
    world.winnerId = alive.sort((a, b) => b.score - a.score)[0]?.id ?? null;
    endMatch(world, 'lastStanding');
    return;
  }

  if (alive.length > 1) return;
  world.winnerId = alive[0]?.id ?? null;
  endMatch(world, 'lastStanding');
}

// ------------------------------------------------------------------- hill

/**
 * King of the Coop. Standing alone in the middle earns points; two players from
 * different sides in there at once cancel out, so the zone has to be cleared
 * rather than merely reached.
 */
function stepHill(world, dt) {
  const hill = world.hill;
  if (!hill || world.phase !== 'live') return;

  // The zone relocates, so everything here is relative to its current spot.
  hill.moveAt -= dt;
  if (hill.moveAt <= 0) {
    hill.moveAt = HILL.moveEvery;
    const reach = world.arena.half * HILL.spread;
    // The zone is a place you have to stand, so it cannot land on cover — but
    // nearestClear spirals up to 13 units to find room, which on a map with a
    // busy middle walked the zone out to the wall. Reroll instead, and clamp
    // whatever the last attempt gives back: a zone outside its band is a zone
    // nobody has to cross the map for.
    let spot = null;
    for (let attempt = 0; attempt < 8 && !spot; attempt++) {
      const c = nearestClear(world,
        (world.rng() * 2 - 1) * reach, (world.rng() * 2 - 1) * reach, HILL.radius);
      if (Math.abs(c.x) <= reach && Math.abs(c.z) <= reach) spot = c;
      else if (attempt === 7) spot = { x: clamp(c.x, -reach, reach), z: clamp(c.z, -reach, reach) };
    }
    hill.x = spot.x;
    hill.z = spot.z;
    emit(world, { type: 'hillMoved', x: hill.x, z: hill.z });
  } else if (hill.moveAt <= HILL.warnAt && !hill.warned) {
    hill.warned = true;
    emit(world, { type: 'hillMoving', inSeconds: Math.ceil(hill.moveAt) });
  }
  if (hill.moveAt > HILL.warnAt) hill.warned = false;

  const inside = [...world.players.values()].filter(
    (p) => p.alive && dist2(p.x, p.z, hill.x, hill.z) <= HILL.radius * HILL.radius,
  );

  // Everyone inside from the same side? In free-for-all that means exactly one.
  const sides = new Set(inside.map((p) => (p.team ?? p.id)));
  hill.contested = sides.size > 1;
  hill.holder = !hill.contested && inside.length ? inside[0].id : null;

  if (hill.contested || !inside.length) return;

  // One key per SIDE. Without this a team of four rotating through the zone
  // banks four separate quarter-holds and nobody ever reaches the target.
  const key = hillKey(world, inside[0].seat);
  hill.progress[key] = (hill.progress[key] ?? 0) + HILL.rate * dt;

  for (const p of inside) {

    // Score is a whole number, and Math.round(rate * dt * 10) is zero for any
    // dt under a twentieth of a second — so at 60Hz holding the zone paid
    // nothing at all. Bank the fraction and hand over whole points as they add
    // up, which also makes the payout independent of tick rate.
    p.hillBank += HILL.rate * dt * 10;
    const whole = Math.floor(p.hillBank);
    if (whole > 0) {
      p.score += whole;
      p.hillBank -= whole;
    }

    if (hill.progress[key] >= HILL.target) {
      world.winnerId = p.id;
      world.winnerTeam = p.team;
      endMatch(world, 'hill');
      return;
    }
  }
}

const hillKey = (world, seat) => (world.cfg.teams ? `t${teamForSeat(seat)}` : `s${seat}`);

/** 0..1 share of the hill target held by a seat's side, for HUD meters. */
export function hillProgress(world, seat) {
  if (!world.hill) return 0;
  return Math.min(1, (world.hill.progress[hillKey(world, seat)] ?? 0) / HILL.target);
}

// --------------------------------------------------------------- contracts

/**
 * Rotating personal side-tasks.
 *
 * Deliberately a pure counting layer: it reads the events this tick already
 * produced and never hooks into combat itself, so adding a contract is a data
 * entry rather than a change to the simulation.
 */
function stepContracts(world, dt) {
  if (world.phase !== 'live') return;

  for (const p of world.players.values()) {
    // Between contracts.
    if (!p.contract) {
      p.contractAt -= dt;
      if (p.contractAt <= 0) assignContract(world, p);
      continue;
    }

    const def = CONTRACTS[p.contract];

    if (def.onTick) {
      const gain = def.onTick(p, world, dt);
      // -Infinity is the "streak broken" signal, e.g. dying mid-survival.
      p.contractProgress = gain === -Infinity ? 0 : p.contractProgress + gain;
    }

    if (def.onEvent) {
      for (const e of world.events) p.contractProgress += def.onEvent(e, p);
    }

    if (p.contractProgress >= def.target) {
      completeContract(world, p, def);
      continue;
    }

    p.contractAt -= dt;
    if (p.contractAt <= 0) {
      emit(world, { type: 'contractFailed', target: p.id, contract: def.id });
      clearContract(p);
    }
  }
}

function assignContract(world, p) {
  // Never hand out the same one twice running — repetition is what turns a
  // task list into filler.
  const pool = CONTRACT_LIST.filter((id) => id !== p.lastContract);
  const id = pool[Math.floor(world.rng() * pool.length)];

  p.contract = id;
  p.lastContract = id;
  p.contractProgress = 0;
  p.contractAt = CONTRACT.duration;
  emit(world, {
    type: 'contractNew',
    target: p.id,
    contract: id,
    label: CONTRACTS[id].label,
    goal: CONTRACTS[id].target,
  });
}

function completeContract(world, p, def) {
  p.score += CONTRACT.reward;
  p.contractsDone++;
  emit(world, {
    type: 'contractDone',
    target: p.id,
    contract: def.id,
    label: def.label,
    reward: CONTRACT.reward,
  });
  clearContract(p);
}

function clearContract(p) {
  p.contract = null;
  p.contractProgress = 0;
  p.contractAt = CONTRACT.gap;
}

/** What the HUD needs to draw one player's contract strip. */
export function contractInfo(p) {
  if (!p || !p.contract) return null;
  const def = CONTRACTS[p.contract];
  if (!def) return null;
  return {
    id: def.id,
    label: def.label,
    progress: Math.min(p.contractProgress, def.target),
    target: def.target,
    secondsLeft: Math.max(0, p.contractAt),
  };
}

// -------------------------------------------------------------- egg heist

/** The nest belonging to a team, or null outside Egg Heist. */
function nestOf(world, team) {
  return world.nests ? world.nests.find((n) => n.team === team) : null;
}

/**
 * Steal from rival nests, carry the eggs home, bank them.
 *
 * The standings are the eggs sitting in your nest, counted at the final
 * whistle — so a raid in the closing seconds can take the match, which is what
 * gives the last thirty seconds their tension.
 */
function stepHeist(world, dt) {
  if (!world.cfg.heist || world.phase !== 'live') return;

  for (const p of world.players.values()) {
    if (!p.alive) continue;
    p.stealAt = Math.max(0, p.stealAt - dt);

    for (const nest of world.nests) {
      if (dist2(p.x, p.z, nest.x, nest.z) > HEIST.nestRadius * HEIST.nestRadius) continue;

      if (nest.team === p.team) {
        // Home: bank whatever is in hand.
        if (p.carrying > 0) {
          nest.eggs += p.carrying;
          p.score += HEIST.depositScore * p.carrying;
          emit(world, {
            type: 'eggDeposit', x: nest.x, z: nest.z, by: p.id, count: p.carrying, team: nest.team,
          });
          p.carrying = 0;
        }
      } else if (nest.eggs > 0 && p.stealAt <= 0) {
        // Rival nest: take one. The cooldown stops a nest being emptied in a
        // single pass, which is what makes defending one possible at all.
        nest.eggs--;
        p.carrying++;
        p.stealAt = HEIST.stealCooldown;
        p.score += HEIST.stealScore;
        emit(world, {
          type: 'eggSteal', x: nest.x, z: nest.z, by: p.id, from: nest.team, carrying: p.carrying,
        });
      }
    }
  }

  // Loose eggs: grabbed by anyone, or they walk themselves home.
  const keep = [];
  for (const egg of world.looseEggs) {
    egg.returnAt -= dt;

    let taken = null;
    for (const p of world.players.values()) {
      if (!p.alive) continue;
      if (dist2(p.x, p.z, egg.x, egg.z) > HEIST.nestRadius * HEIST.nestRadius) continue;
      taken = p;
      break;
    }

    if (taken) {
      taken.carrying++;
      emit(world, { type: 'eggPickup', x: egg.x, z: egg.z, by: taken.id });
      continue;
    }
    if (egg.returnAt <= 0) {
      const home = nestOf(world, egg.fromTeam);
      if (home) home.eggs++;
      emit(world, { type: 'eggReturned', x: egg.x, z: egg.z, team: egg.fromTeam });
      continue;
    }
    keep.push(egg);
  }
  world.looseEggs = keep;
}

/** Dying scatters what you were carrying. It does not teleport home. */
function dropEggs(world, p) {
  if (!world.cfg.heist || p.carrying <= 0) return;
  const edge = world.arena.half - 1;
  for (let i = 0; i < p.carrying; i++) {
    const a = world.rng() * Math.PI * 2;
    const r = world.rng() * HEIST.dropSpread;
    world.looseEggs.push({
      id: nextId(world),
      x: clamp(p.x + Math.cos(a) * r, -edge, edge),
      z: clamp(p.z + Math.sin(a) * r, -edge, edge),
      fromTeam: p.team,
      returnAt: HEIST.returnAfter,
    });
  }
  emit(world, { type: 'eggDropped', x: p.x, z: p.z, count: p.carrying, by: p.id });
  p.carrying = 0;
}

// ------------------------------------------------------------ plant/defuse

/**
 * Carry the bomb into a rival nest, hold still to plant it, then survive the
 * fuse while its owner races to defuse.
 *
 * Both planting and defusing require standing still and holding — that is what
 * makes this a fight over a place rather than a race to touch a thing.
 */
function stepBomb(world, dt) {
  if (!world.cfg.bomb || world.phase !== 'live') return;

  if (!world.bomb) {
    world.bombAt -= dt;
    if (world.bombAt > 0) return;
    world.bomb = {
      x: 0, z: 0, state: 'loose', carriedBy: null, plantedBy: null,
      plantTeam: -1, fuse: BOMB.fuse, plant: 0, defuse: 0,
    };
    emit(world, { type: 'bombSpawn', x: 0, z: 0 });
    return;
  }

  const bomb = world.bomb;
  if (bomb.state === 'planted') {
    stepPlantedBomb(world, bomb, dt);
    return;
  }

  // Carried: the bomb follows its carrier, and can be planted.
  let carrier = bomb.carriedBy ? world.players.get(bomb.carriedBy) : null;
  if (carrier && !carrier.alive) {
    bomb.carriedBy = null;
    bomb.state = 'loose';
    bomb.plant = 0;
    emit(world, { type: 'bombDropped', x: bomb.x, z: bomb.z });
    carrier = null;
  }

  if (carrier) {
    bomb.x = carrier.x;
    bomb.z = carrier.z;

    const target = world.nests
      ? world.nests.find((n) => n.team !== carrier.team
        && nestDefenders(world, n.team).length
        && dist2(carrier.x, carrier.z, n.x, n.z) <= BOMB.plantRadius * BOMB.plantRadius)
      : null;
    const still = len(carrier.input.mx, carrier.input.mz) < 0.2;

    if (target && still) {
      bomb.plant += dt;
      if (bomb.plant >= BOMB.plantTime) {
        bomb.state = 'planted';
        bomb.plantTeam = target.team;
        bomb.plantedBy = carrier.id;
        bomb.carriedBy = null;
        bomb.fuse = BOMB.fuse;
        bomb.defuse = 0;
        carrier.score += BOMB.plantScore;
        emit(world, {
          type: 'bombPlanted', x: bomb.x, z: bomb.z, by: carrier.id, team: target.team,
        });
      }
    } else {
      bomb.plant = 0;
    }
    return;
  }

  // Loose: anyone can pick it up.
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    if (dist2(p.x, p.z, bomb.x, bomb.z) > BOMB.pickupRadius * BOMB.pickupRadius) continue;
    bomb.carriedBy = p.id;
    bomb.state = 'carried';
    emit(world, { type: 'bombTaken', x: p.x, z: p.z, by: p.id });
    break;
  }
}

/** Everyone who owns this nest. An empty side cannot be planted in. */
function nestDefenders(world, team) {
  return [...world.players.values()].filter((p) => p.team === team);
}

function stepPlantedBomb(world, bomb, dt) {
  bomb.fuse -= dt;

  // Only the nest's own side can defuse, and only by standing on it. Any one
  // of them will do — four defenders is what makes retaking a site possible.
  const owner = nestDefenders(world, bomb.plantTeam).find((p) => p.alive
    && dist2(p.x, p.z, bomb.x, bomb.z) <= BOMB.plantRadius * BOMB.plantRadius
    && len(p.input.mx, p.input.mz) < 0.2);

  if (owner) {
    bomb.defuse += dt;
    if (bomb.defuse >= BOMB.defuseTime) {
      owner.score += BOMB.defuseScore;
      emit(world, { type: 'bombDefused', x: bomb.x, z: bomb.z, by: owner.id });
      world.bomb = null;
      world.bombAt = BOMB.respawnDelay;
      return;
    }
  } else {
    bomb.defuse = 0;
  }

  if (bomb.fuse > 0) return;

  // Detonation: everyone nearby pays, and the planter is paid.
  emit(world, { type: 'bombBlast', x: bomb.x, z: bomb.z, radius: BOMB.blastRadius });
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    const d = Math.sqrt(dist2(p.x, p.z, bomb.x, bomb.z));
    if (d > BOMB.blastRadius) continue;
    const falloff = 1 - d / BOMB.blastRadius;
    const [nx, nz] = norm(p.x - bomb.x, p.z - bomb.z);
    p.kx += nx * BOMBER.blastKnockback * falloff;
    p.kz += nz * BOMBER.blastKnockback * falloff;
    damagePlayer(world, p, BOMB.blastDamage * falloff, bomb.plantedBy, 'bomb');
  }
  const planter = bomb.plantedBy ? world.players.get(bomb.plantedBy) : null;
  if (planter) planter.score += BOMB.detonateScore;

  world.bomb = null;
  world.bombAt = BOMB.respawnDelay;
}

// ------------------------------------------------------------------ bounty

/**
 * Crowns whoever is in front, and makes them worth more to kill.
 *
 * A comeback lever, not a reward: being crowned is a liability. It only appears
 * once someone is genuinely ahead, so an early scrappy lead doesn't paint a
 * target on a player who hasn't earned one.
 */
function stepBounty(world, dt) {
  if (!BOUNTY.enabled || world.phase !== 'live') return;

  world.bountyAt -= dt;
  if (world.bountyAt > 0) return;
  world.bountyAt = BOUNTY.recheck;

  const ranked = [...world.players.values()].sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const second = ranked[1];

  const deserves = leader
    && leader.alive !== undefined
    && leader.score >= BOUNTY.minScore
    && (!second || leader.score - second.score >= BOUNTY.minLead);

  const next = deserves ? leader.id : null;
  if (next === world.bounty) return;

  world.bounty = next;
  emit(world, { type: 'bounty', target: next, name: next ? leader.name : null });
}

// -------------------------------------------------------------- hot potato

/**
 * A cursed egg that burns whoever holds it, passed by touching someone.
 *
 * Inverts the game: you chase people to make contact rather than to shoot them.
 * The pass cooldown matters — without it two chickens standing together would
 * swap it back and forth every tick.
 */
function stepPotato(world, dt) {
  if (world.modifier !== 'potato' || world.phase !== 'live') return;

  if (!world.potato) {
    world.potatoAt -= dt;
    if (world.potatoAt > 0) return;
    world.potato = {
      holder: null,
      x: 0, z: 0,
      fuse: POTATO.fuse,
      passAt: 0,
    };
    emit(world, { type: 'potatoSpawn', x: 0, z: 0 });
    return;
  }

  const pot = world.potato;
  pot.passAt = Math.max(0, pot.passAt - dt);

  const holder = pot.holder ? world.players.get(pot.holder) : null;

  // Dropped by a death: it sits where they fell until someone picks it up.
  if (pot.holder && (!holder || !holder.alive)) {
    pot.holder = null;
    emit(world, { type: 'potatoDropped', x: pot.x, z: pot.z });
  }

  if (holder && holder.alive) {
    pot.x = holder.x;
    pot.z = holder.z;
    pot.fuse -= dt;

    // The damage itself is applied by stepPotatoBurn, which already runs for
    // whoever is holding it.

    if (pot.fuse <= 0) {
      damagePlayer(world, holder, POTATO.blastDamage, null, 'potato');
      emit(world, { type: 'potatoBlast', x: pot.x, z: pot.z, target: holder.id });
      world.potato = null;
      world.potatoAt = POTATO.respawnDelay;
      return;
    }
  }

  // Anyone close enough takes it — from the floor, or off the current holder.
  if (pot.passAt > 0) return;
  const r2 = POTATO.passRadius * POTATO.passRadius;
  for (const p of world.players.values()) {
    if (!p.alive || p.id === pot.holder) continue;
    if (world.time < p.invulnUntil) continue;
    if (dist2(p.x, p.z, pot.x, pot.z) > r2) continue;

    const from = pot.holder;
    pot.holder = p.id;
    pot.passAt = POTATO.passCooldown;
    emit(world, { type: 'potatoPass', x: p.x, z: p.z, to: p.id, from });
    break;
  }
}

// ------------------------------------------------------------------- bomber

function stepBomber(world, dt) {
  if (!world.cfg.bomberEnabled || world.phase !== 'live') return;

  if (!world.bomber) {
    world.bomberSpawnAt -= dt;
    if (world.bomberSpawnAt <= 0) spawnBomber(world);
    return;
  }

  const b = world.bomber;
  const targets = [...world.players.values()].filter((p) => p.alive && world.time >= p.invulnUntil);

  if (!targets.length) {
    b.state = 'search';
    b.fuse = BOMBER.fuse;
    return;
  }

  // Nearest living player, always.
  let target = null;
  let bestD2 = Infinity;
  for (const p of targets) {
    const d2 = dist2(b.x, b.z, p.x, p.z);
    if (d2 < bestD2) { bestD2 = d2; target = p; }
  }
  const d = Math.sqrt(bestD2);
  b.targetId = target.id;

  let dirX = 0;
  let dirZ = 0;
  let speedMul = 1;

  if (b.state === 'search') {
    if (d <= BOMBER.detectRadius) {
      b.state = 'chase';
      emit(world, { type: 'bomberAlert', x: b.x, z: b.z });
    } else {
      b.wanderAt -= dt;
      if (b.wanderAt <= 0) pickWanderTarget(world, b);
      [dirX, dirZ] = norm(b.wx - b.x, b.wz - b.z);
      speedMul = 0.55;
    }
  }

  if (b.state === 'chase') {
    [dirX, dirZ] = norm(target.x - b.x, target.z - b.z);
    if (d <= BOMBER.armRadius) {
      b.state = 'arm';
      b.fuse = BOMBER.fuse;
      emit(world, { type: 'bomberArm', x: b.x, z: b.z });
    }
  }

  if (b.state === 'arm') {
    // Still hunts you while ticking, but slower — outrunning it is the play.
    [dirX, dirZ] = norm(target.x - b.x, target.z - b.z);
    speedMul = BOMBER.armSpeedMul;
    b.fuse -= dt;
    if (b.fuse <= 0) {
      explodeBomber(world);
      return;
    }
  }

  const half = world.arena.half - BOMBER.radius;
  b.x = clamp(b.x + dirX * BOMBER.speed * speedMul * dt, -half, half);
  b.z = clamp(b.z + dirZ * BOMBER.speed * speedMul * dt, -half, half);
  // It walks into cover like everything else, and slides along it. No pathing:
  // the bomber is a threat you kite, and one that solved corners perfectly
  // would stop being kiteable — sliding along a wall is exactly the pause that
  // makes running away work.
  clearCover(world, b, BOMBER.radius, half);
  if (dirX || dirZ) b.aim = Math.atan2(dirX, dirZ);
}

function pickWanderTarget(world, b) {
  const h = world.arena.half - 4;
  const spot = nearestClear(world, (world.rng() * 2 - 1) * h, (world.rng() * 2 - 1) * h, BOMBER.radius);
  b.wx = spot.x;
  b.wz = spot.z;
  b.wanderAt = BOMBER.wanderInterval;
}

function spawnBomber(world) {
  world.bomber = {
    id: nextId(world),
    x: 0, z: 0,
    aim: 0,
    hp: BOMBER.maxHp,
    alive: true,
    state: 'search',
    fuse: BOMBER.fuse,
    targetId: null,
    wx: 0, wz: 0, wanderAt: 0,
  };
  pickWanderTarget(world, world.bomber);
  emit(world, { type: 'bomberSpawn', x: 0, z: 0 });
}

function scheduleBomberRespawn(world) {
  world.bomber = null;
  world.bomberSpawnAt = BOMBER.respawnDelay
    * (world.cfg.bomberRespawnMul ?? 1)
    * modValue(world.modifier, 'bomberRespawnMul');
}

function damageBomber(world, amount, byId, vx, vz) {
  const b = world.bomber;
  if (!b || !b.alive) return;
  b.hp -= amount;
  emit(world, { type: 'hit', x: b.x, z: b.z, amount, target: 'bomber', by: byId ?? null, kind: 'bullet' });

  // Getting shot flinches it backwards a touch — readable feedback that it's dying.
  const [nx, nz] = norm(vx, vz);
  const half = world.arena.half - BOMBER.radius;
  b.x = clamp(b.x + nx * 0.18, -half, half);
  b.z = clamp(b.z + nz * 0.18, -half, half);

  if (b.hp <= 0) {
    b.alive = false;
    const killer = byId != null ? world.players.get(byId) : null;
    if (killer) killer.score += SCORE.bomberKill;
    emit(world, { type: 'bomberDown', x: b.x, z: b.z, by: byId ?? null });
    // Reward the risk: a defused bomber drops a health pack.
    spawnPickup(world, 'health', b.x, b.z);
    scheduleBomberRespawn(world);
  }
}

function explodeBomber(world) {
  const b = world.bomber;
  if (!b || !b.alive) return;
  b.alive = false;
  emit(world, { type: 'blast', x: b.x, z: b.z, radius: BOMBER.blastRadius });

  for (const p of world.players.values()) {
    if (!p.alive) continue;
    const d = Math.sqrt(dist2(p.x, p.z, b.x, b.z));
    if (d > BOMBER.blastRadius) continue;
    const falloff = 1 - d / BOMBER.blastRadius;
    const dmg = (BOMBER.blastDamageMin + (BOMBER.blastDamageMax - BOMBER.blastDamageMin) * falloff)
      * modValue(world.modifier, 'damageMul');
    const [nx, nz] = norm(p.x - b.x, p.z - b.z);
    const blastKnock = BOMBER.blastKnockback * modValue(world.modifier, 'knockbackMul');
    p.kx += nx * blastKnock * falloff;
    p.kz += nz * blastKnock * falloff;
    // No killer credit for blast deaths — the bomber isn't on anyone's team.
    damagePlayer(world, p, dmg, null, 'blast');
  }

  scheduleBomberRespawn(world);
}

// ------------------------------------------------------------------ pickups

function spawnPickup(world, type, x, z) {
  // A pickup inside a wall is invisible and uncollectable, which reads as the
  // spawn simply not happening. Nudge it out rather than skip the cycle.
  const at = nearestClear(world, x, z, PICKUP.radius + 0.4);
  const pk = { id: nextId(world), type, x: at.x, z: at.z };
  world.pickups.push(pk);
  emit(world, { type: 'pickupSpawn', x: pk.x, z: pk.z, kind: type, id: pk.id });
  return pk;
}

function stepPickups(world, dt) {
  if (world.phase === 'live') {
    world.pickupSpawnAt -= dt;
    if (world.pickupSpawnAt <= 0) {
      world.pickupSpawnAt = PICKUP.interval;
      if (world.pickups.length < PICKUP.maxAlive) {
        const h = world.arena.half - 3;
        // Bias toward gold rapid-fire occasionally — a reason to contest the open floor.
        const kind = rollPickup(world.rng);
        spawnPickup(world, kind, (world.rng() * 2 - 1) * h, (world.rng() * 2 - 1) * h);
      }
    }
  }

  const keep = [];
  for (const pk of world.pickups) {
    let taken = null;
    for (const p of world.players.values()) {
      if (!p.alive) continue;
      const rr = PLAYER.radius + PICKUP.radius;
      if (dist2(p.x, p.z, pk.x, pk.z) > rr * rr) continue;
      if (pk.type === 'health' && p.hp >= PLAYER.maxHp) continue; // don't waste it
      taken = p;
      break;
    }
    if (!taken) { keep.push(pk); continue; }

    if (pk.type === 'health') {
      taken.hp = Math.min(PLAYER.maxHp, taken.hp + PICKUP.health.heal);
    }
    emit(world, { type: 'pickupTaken', x: pk.x, z: pk.z, kind: pk.type, id: pk.id, by: taken.id });
  }
  world.pickups = keep;
}

// ------------------------------------------------------------------- pings

/**
 * Drops a team marker at a world point.
 *
 * Rate-limited and capped per player, because the failure mode of a ping
 * system is not that nobody uses it — it is one player painting the map and
 * their team learning to ignore the markers entirely.
 *
 * Returns the ping, or null if it was refused. The caller decides who hears
 * about it; nothing here broadcasts, and pings never enter synced state, so an
 * enemy client is never told a marker exists.
 */
export function placePing(world, id, intent, x, z) {
  const p = world.players.get(id);
  if (!p || !p.alive || world.phase !== 'live') return null;
  if (world.time < p.pingAt) return null;

  const def = pingDef(String(intent ?? ''));
  const px = Number(x);
  const pz = Number(z);
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return null;
  // A marker outside the arena is a hand-rolled client, not a player.
  const lim = world.arena.half + 2;
  if (Math.abs(px) > lim || Math.abs(pz) > lim) return null;
  if (dist2(p.x, p.z, px, pz) > PING.maxRange * PING.maxRange) return null;

  p.pingAt = world.time + PING.cooldown;

  // Oldest one goes when you are at your cap, so the newest thing you saw is
  // always on the map.
  const mine = world.pings.filter((q) => q.by === id);
  while (mine.length >= PING.maxPerPlayer) {
    const drop = mine.shift();
    world.pings.splice(world.pings.indexOf(drop), 1);
  }

  const ping = {
    id: nextId(world),
    by: id,
    byName: p.name,
    team: p.team,
    intent: def.id,
    x: px,
    z: pz,
    until: world.time + PING.life,
  };
  world.pings.push(ping);
  emit(world, { type: 'ping', ...ping });
  return ping;
}

function stepPings(world) {
  if (!world.pings.length) return;
  world.pings = world.pings.filter((q) => q.until > world.time);
}

/** Markers this player is allowed to see. Team-mates only, always. */
export function pingsFor(world, id) {
  const p = world.players.get(id);
  if (!p) return [];
  return world.pings.filter((q) => (p.team === null ? q.by === id : q.team === p.team));
}

// ------------------------------------------------------------------ helpers

/** Compact snapshot used for network sync and for client-side reconciliation. */
export function snapshot(world) {
  return {
    time: world.time,
    phase: world.phase,
    modifier: world.modifier,
    safeHalf: world.safeHalf,
    map: world.map,
    mapCandidates: [...world.mapCandidates],
    lobbyTime: world.lobbyTime,
    bounty: world.bounty,
    nests: world.nests ? world.nests.map((n) => ({ ...n })) : null,
    looseEggs: world.looseEggs ? world.looseEggs.map((e) => ({ ...e })) : null,
    bomb: world.bomb ? { ...world.bomb } : null,
    potato: world.potato ? { x: world.potato.x, z: world.potato.z, holder: world.potato.holder, fuse: world.potato.fuse } : null,
    teamScores: world.teamScores ? [...world.teamScores] : null,
    hill: world.hill
      ? { holder: world.hill.holder, contested: world.hill.contested,
        x: world.hill.x, z: world.hill.z, moveAt: world.hill.moveAt }
      : null,
    clock: world.clock,
    players: [...world.players.values()].map((p) => ({
      id: p.id, name: p.name, seat: p.seat, team: p.team,
      x: p.x, y: p.y, z: p.z, aim: p.aim, pitch: p.pitch,
      hp: p.hp, alive: p.alive, kills: p.kills, deaths: p.deaths, score: p.score,
      invuln: p.invulnUntil > world.time,
      crop: Math.floor(p.crop), pecking: p.pecking, feeding: p.feeding, dry: p.dry,
      // The ladder. `level` is what everyone sees above your head; `xp` and
      // `nextXp` are what draws your own bar.
      level: p.level, xp: p.xp, nextXp: xpForLevel(p.level + 1),
      wind: p.windUntil > world.time, frenzy: p.frenzyUntil > world.time,
      respawnIn: p.alive ? 0 : Math.max(0, p.respawnAt - world.time),
      kx: p.kx, kz: p.kz,
      nemesis: world.time < p.nemesisUntil ? p.nemesis : null,
      seq: p.lastSeq, isBot: p.isBot,
      carrying: p.carrying, contract: contractInfo(p),
    })),
    pickups: world.pickups.map((p) => ({ id: p.id, x: p.x, z: p.z, type: p.type })),
    bomber: world.bomber && world.bomber.alive
      ? {
        x: world.bomber.x, z: world.bomber.z, aim: world.bomber.aim,
        hp: world.bomber.hp, state: world.bomber.state, fuse: world.bomber.fuse,
      }
      : null,
  };
}

export function makeLocalId(prefix = 'p') {
  return `${prefix}${localIdCounter++}`;
}
