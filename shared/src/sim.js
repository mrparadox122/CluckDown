// Pure, headless game simulation. No Babylon, no Colyseus, no DOM.
//
// The server runs this as the authority. The client runs the *same* code to
// predict its own chicken between server snapshots, and to power offline
// practice mode. Keeping it dependency-free is the whole point — don't import
// anything renderer- or network-shaped in here.

import {
  PLAYER, BULLET, BOMBER, PICKUP, SCORE, MODES,
  MULTIKILL_WINDOW, SEAT_COLORS, MODIFIER_POOL, modValue,
  TEAM_COLORS, teamForSeat, HILL, SHRINK, AMMO, rollPickup,
  MAPS, DEFAULT_MAP, pickMapCandidates, BOUNTY, POTATO,
  CONTRACT, CONTRACTS, CONTRACT_LIST, HEIST, BOMB, REVENGE,
} from './constants.js';
import {
  clamp, clampUnit, norm, len, dist2, segPointDist2, mulberry32, angleDelta,
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
    bullets: [],
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

    // King of the Coop.
    hill: cfg.hill
      ? { holder: null, contested: false, progress: [0, 0, 0, 0], x: 0, z: 0, moveAt: HILL.moveEvery }
      : null,

    // Nests: home base in Egg Heist, and the plant site in Plant & Defuse.
    nests: cfg.heist || cfg.bomb
      ? [0, 1, 2, 3].map((seat) => ({ seat, eggs: cfg.heist ? HEIST.eggsPerNest : 0, x: 0, z: 0 }))
      : null,
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

  // Move everyone onto the new corners, or they start outside the walls.
  const pts = spawnPoints(world);
  // Nests sit on the spawn corners, so they move with the arena too.
  if (world.nests) {
    for (const nest of world.nests) {
      nest.x = pts[nest.seat % 4].x;
      nest.z = pts[nest.seat % 4].z;
    }
  }
  for (const p of world.players.values()) {
    const sp = pts[p.seat % 4];
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
  const d = world.arena.half - 3.5;
  return [
    { x: -d, z: -d }, { x: d, z: d }, { x: d, z: -d }, { x: -d, z: d },
  ];
}

export function addPlayer(world, { id, name, seat, isBot = false }) {
  const seatIdx = seat ?? world.players.size;
  const sp = spawnPoints(world)[seatIdx % 4];
  const p = {
    id,
    name: (name || 'Chicken').slice(0, 14),
    seat: seatIdx,
    team: world.cfg.teams ? teamForSeat(seatIdx) : null,
    color: world.cfg.teams
      ? TEAM_COLORS[teamForSeat(seatIdx)]
      : SEAT_COLORS[seatIdx % SEAT_COLORS.length],
    isBot,
    x: sp.x, z: sp.z,
    kx: 0, kz: 0, // knockback velocity
    aim: Math.atan2(-sp.x, -sp.z), // face the middle
    hp: PLAYER.maxHp,
    alive: true,
    respawnAt: 0,
    invulnUntil: PLAYER.spawnInvuln,
    nextShotAt: 0,
    rapidUntil: 0,
    ammo: 'none',
    ammoUntil: 0,
    burnUntil: 0,
    burnBy: null,
    burnAcc: 0,
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
    input: { mx: 0, mz: 0, ax: 0, az: 0, shoot: false, seq: 0 },
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
  p.input = { mx, mz, ax, az, shoot: !!input.shoot, seq: input.seq | 0 };
  p.lastSeq = input.seq | 0;
}

function emit(world, ev) {
  world.events.push(ev);
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
  stepBullets(world, dt);
  stepBomber(world, dt);
  stepPickups(world, dt);
  stepHill(world, dt);
  stepBounty(world, dt);
  stepPotato(world, dt);
  stepHeist(world, dt);
  stepBomb(world, dt);
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

  for (const p of world.players.values()) {
    if (!p.alive) {
      // Last Chicken Standing has no second chances.
      const canRespawn = world.cfg.respawn !== false;
      if (canRespawn && world.phase !== 'over' && world.time >= p.respawnAt) respawn(world, p);
      continue;
    }

    const inp = p.input;
    let moveScale = world.phase === 'live' ? 1 : 0.35;
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
    stepBurn(world, p, dt);
    stepPotatoBurn(world, p, dt);
    if (p.ammoUntil && world.time >= p.ammoUntil) { p.ammo = 'none'; p.ammoUntil = 0; }

    if (inp.shoot && world.phase === 'live' && world.time >= p.nextShotAt) fire(world, p);
  }

  separatePlayers(world);
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

/** Fire ammo leaves a burn that keeps ticking after the shot landed. */
function stepBurn(world, p, dt) {
  if (!p.burnUntil || world.time >= p.burnUntil) {
    if (p.burnUntil && world.time >= p.burnUntil) { p.burnUntil = 0; p.burnAcc = 0; p.burnBy = null; }
    return;
  }

  const cfg = AMMO.fire;
  p.burnAcc += cfg.burnDps * dt;
  const chunk = cfg.burnDps * cfg.burnTick;
  // Applied in chunks, not every tick: at 60Hz per-tick damage would emit sixty
  // hit events a second and bury the kill feed in damage numbers.
  if (p.burnAcc >= chunk) {
    p.burnAcc -= chunk;
    damagePlayer(world, p, chunk, p.burnBy, 'burn');
  }
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
  const rapid = world.time < p.rapidUntil;
  p.nextShotAt = world.time
    + (rapid ? PLAYER.rapidCooldown : PLAYER.fireCooldown)
      * modValue(world.modifier, 'fireCooldownMul');
  const dx = Math.sin(p.aim);
  const dz = Math.cos(p.aim);
  const muzzle = PLAYER.radius + BULLET.radius + 0.25;
  const id = nextId(world);
  const bx = p.x + dx * muzzle;
  const bz = p.z + dz * muzzle;
  const ammo = world.time < p.ammoUntil ? p.ammo : 'none';
  world.bullets.push({
    id,
    owner: p.id,
    team: p.team,
    ammo,
    x: bx,
    z: bz,
    vx: dx * BULLET.speed,
    vz: dz * BULLET.speed,
    life: BULLET.life,
    bounces: ammo === 'bouncy' ? AMMO.bouncy.bounces : 0,
  });
  // The id lets clients retire the exact tracer that landed, instead of
  // letting the visual sail on through the chicken it just hit.
  emit(world, { type: 'shot', id, x: bx, z: bz, aim: p.aim, owner: p.id, rapid, ammo });
}

function stepBullets(world, dt) {
  const { half } = world.arena;
  const out = [];

  for (const b of world.bullets) {
    b.life -= dt;
    if (b.ammo === 'tracking') steerBullet(world, b, dt);
    const px = b.x;
    const pz = b.z;
    b.x += b.vx * dt;
    b.z += b.vz * dt;

    if (b.life <= 0) {
      emit(world, { type: 'bulletEnd', id: b.id, x: b.x, z: b.z, wall: false });
      continue;
    }

    // Wall hit. Bouncy rounds reflect instead of dying, which is just negating
    // the velocity component on whichever axis was crossed — the walls are
    // axis-aligned, so there is no surface-normal maths to do.
    const edge = half - BULLET.radius;
    if (Math.abs(b.x) > edge || Math.abs(b.z) > edge) {
      if (b.bounces > 0) {
        b.bounces--;
        if (Math.abs(b.x) > edge) { b.vx = -b.vx; b.x = clamp(b.x, -edge, edge); }
        if (Math.abs(b.z) > edge) { b.vz = -b.vz; b.z = clamp(b.z, -edge, edge); }
        emit(world, { type: 'bounce', id: b.id, x: b.x, z: b.z, owner: b.owner });
        out.push(b);
        continue;
      }
      emit(world, {
        type: 'bulletEnd',
        id: b.id,
        x: clamp(b.x, -half, half),
        z: clamp(b.z, -half, half),
        wall: true,
      });
      continue;
    }

    let consumed = false;

    // Swept test against the bomber first — it's the juicier target.
    const bomber = world.bomber;
    if (bomber && bomber.alive) {
      const rr = BOMBER.radius + BULLET.radius;
      if (segPointDist2(px, pz, b.x, b.z, bomber.x, bomber.z) <= rr * rr) {
        damageBomber(world, BULLET.damage, b.owner, b.vx, b.vz);
        emit(world, { type: 'bulletEnd', id: b.id, x: bomber.x, z: bomber.z, wall: false });
        consumed = true;
      }
    }

    if (!consumed) {
      const owner = world.players.get(b.owner);
      for (const t of world.players.values()) {
        if (t.id === b.owner || !t.alive || world.time < t.invulnUntil) continue;
        // Team-mates are not targets. The bullet keeps travelling rather than
        // being absorbed, so you can shoot past a partner instead of being
        // blocked by them.
        if (t.team !== null && owner && t.team === owner.team) continue;
        const rr = PLAYER.radius + BULLET.radius;
        if (segPointDist2(px, pz, b.x, b.z, t.x, t.z) > rr * rr) continue;

        const [nx, nz] = norm(b.vx, b.vz);
        const knock = BULLET.knockback * modValue(world.modifier, 'knockbackMul');
        t.kx += nx * knock;
        t.kz += nz * knock;
        damagePlayer(world, t, BULLET.damage * modValue(world.modifier, 'damageMul'), b.owner, 'bullet');
        if (b.ammo === 'fire' && t.alive) {
          // Refreshes rather than stacks, so sustained fire keeps someone lit
          // without multiplying the damage.
          t.burnUntil = world.time + AMMO.fire.burnDuration;
          t.burnBy = b.owner;
          emit(world, { type: 'ignite', x: t.x, z: t.z, target: t.id, by: b.owner });
        }
        emit(world, { type: 'bulletEnd', id: b.id, x: t.x, z: t.z, wall: false });
        consumed = true;
        break;
      }
    }

    if (!consumed) out.push(b);
  }

  world.bullets = out;
}

/**
 * Tracking rounds. Steers toward the nearest valid enemy ahead of the bullet,
 * turning at a capped rate so a round can be dodged by moving across it rather
 * than being an unavoidable guided missile.
 */
function steerBullet(world, b, dt) {
  const cfg = AMMO.tracking;
  const heading = Math.atan2(b.vx, b.vz);

  let best = null;
  let bestD = Infinity;
  for (const t of world.players.values()) {
    if (t.id === b.owner || !t.alive || world.time < t.invulnUntil) continue;
    if (t.team !== null && b.team !== null && t.team === b.team) continue;

    const d = Math.sqrt(dist2(b.x, b.z, t.x, t.z));
    if (d > cfg.range || d > bestD) continue;
    if (Math.abs(angleDelta(heading, Math.atan2(t.x - b.x, t.z - b.z))) > cfg.cone) continue;
    bestD = d;
    best = t;
  }
  if (!best) return;

  const want = Math.atan2(best.x - b.x, best.z - b.z);
  const turn = clamp(angleDelta(heading, want), -cfg.turnRate * dt, cfg.turnRate * dt);
  const next = heading + turn;
  b.vx = Math.sin(next) * BULLET.speed;
  b.vz = Math.cos(next) * BULLET.speed;
}

// ------------------------------------------------------------ damage / death

export function damagePlayer(world, target, amount, byId, kind) {
  if (!target.alive || world.time < target.invulnUntil || world.phase === 'over') return;
  const dealt = Math.min(amount, target.hp);
  target.hp -= dealt;

  const attacker = byId != null ? world.players.get(byId) : null;
  if (attacker && attacker !== target) {
    attacker.damageDealt += dealt;
  }

  emit(world, {
    type: 'hit', x: target.x, z: target.z, amount: Math.round(dealt),
    target: target.id, by: byId ?? null, kind,
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
  target.input = { mx: 0, mz: 0, ax: 0, az: 0, shoot: false, seq: target.input.seq };

  const killer = byId != null ? world.players.get(byId) : null;
  let multi = 0;
  let revenge = false;
  const wasBounty = world.bounty === target.id;
  if (killer && killer !== target) {
    killer.kills++;
    // Taking the crown down is the whole point of marking someone.
    killer.score += SCORE.kill * (wasBounty ? BOUNTY.multiplier : 1);
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

  // The crown is vacated the instant its holder dies.
  if (wasBounty) world.bounty = null;

  emit(world, {
    type: 'kill',
    x: target.x, z: target.z,
    target: target.id,
    by: killer && killer !== target ? killer.id : null,
    kind, // 'bullet' | 'blast' | 'zone' | 'burn' | 'potato'
    multi,
    bounty: wasBounty,
    revenge,
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
  const pts = spawnPoints(world);
  const foes = [...world.players.values()].filter((o) => o !== p && o.alive);
  let best = pts[p.seat % 4];
  let bestScore = -Infinity;
  for (const pt of pts) {
    let nearest = Infinity;
    for (const f of foes) nearest = Math.min(nearest, dist2(pt.x, pt.z, f.x, f.z));
    if (world.bomber?.alive) nearest = Math.min(nearest, dist2(pt.x, pt.z, world.bomber.x, world.bomber.z));
    if (nearest > bestScore) { bestScore = nearest; best = pt; }
  }
  // Corners can sit outside the safe area once it has closed in.
  p.x = clamp(best.x, -lim, lim);
  p.z = clamp(best.z, -lim, lim);
  p.kx = p.kz = 0;
  p.hp = PLAYER.maxHp;
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
      p.eggsHeld = nestOf(world, p.seat) ? nestOf(world, p.seat).eggs : 0;
      p.score += p.eggsHeld * HEIST.depositScore;
    }
  }

  const ranking = [...world.players.values()].sort((a, b) => b.score - a.score || b.kills - a.kills);
  // A survival or hill win has already named its winner; don't overwrite it.
  world.winnerId ??= ranking[0]?.id ?? null;
  if (world.teamScores) {
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

/** Ends a no-respawn match once one chicken (or nobody) is left standing. */
function checkSurvival(world) {
  if (world.cfg.respawn !== false || world.phase !== 'live') return;
  if (world.players.size < 2) return;

  const alive = [...world.players.values()].filter((p) => p.alive);
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
    hill.x = (world.rng() * 2 - 1) * reach;
    hill.z = (world.rng() * 2 - 1) * reach;
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

  for (const p of inside) {
    hill.progress[p.seat] = (hill.progress[p.seat] ?? 0) + HILL.rate * dt;

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

    if (hill.progress[p.seat] >= HILL.target) {
      world.winnerId = p.id;
      endMatch(world, 'hill');
      return;
    }
  }
}

/** 0..1 share of the hill target held by a seat, for HUD meters. */
export function hillProgress(world, seat) {
  return world.hill ? Math.min(1, (world.hill.progress[seat] ?? 0) / HILL.target) : 0;
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

/** The nest belonging to a seat, or null outside Egg Heist. */
function nestOf(world, seat) {
  return world.nests ? world.nests.find((n) => n.seat === seat % 4) : null;
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

      if (nest.seat === p.seat % 4) {
        // Home: bank whatever is in hand.
        if (p.carrying > 0) {
          nest.eggs += p.carrying;
          p.score += HEIST.depositScore * p.carrying;
          emit(world, {
            type: 'eggDeposit', x: nest.x, z: nest.z, by: p.id, count: p.carrying, seat: nest.seat,
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
          type: 'eggSteal', x: nest.x, z: nest.z, by: p.id, from: nest.seat, carrying: p.carrying,
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
      const home = nestOf(world, egg.fromSeat);
      if (home) home.eggs++;
      emit(world, { type: 'eggReturned', x: egg.x, z: egg.z, seat: egg.fromSeat });
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
      fromSeat: p.seat % 4,
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
      plantSeat: -1, fuse: BOMB.fuse, plant: 0, defuse: 0,
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
      ? world.nests.find((n) => n.seat !== carrier.seat % 4
        && nestOwner(world, n.seat)
        && dist2(carrier.x, carrier.z, n.x, n.z) <= BOMB.plantRadius * BOMB.plantRadius)
      : null;
    const still = len(carrier.input.mx, carrier.input.mz) < 0.2;

    if (target && still) {
      bomb.plant += dt;
      if (bomb.plant >= BOMB.plantTime) {
        bomb.state = 'planted';
        bomb.plantSeat = target.seat;
        bomb.plantedBy = carrier.id;
        bomb.carriedBy = null;
        bomb.fuse = BOMB.fuse;
        bomb.defuse = 0;
        carrier.score += BOMB.plantScore;
        emit(world, {
          type: 'bombPlanted', x: bomb.x, z: bomb.z, by: carrier.id, seat: target.seat,
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

/** Whoever occupies a nest's seat, or undefined if the corner is empty. */
function nestOwner(world, seat) {
  return [...world.players.values()].find((p) => p.seat % 4 === seat);
}

function stepPlantedBomb(world, bomb, dt) {
  bomb.fuse -= dt;

  // Only the nest's owner can defuse, and only by standing on it.
  const owner = nestOwner(world, bomb.plantSeat);
  const canDefuse = owner && owner.alive
    && dist2(owner.x, owner.z, bomb.x, bomb.z) <= BOMB.plantRadius * BOMB.plantRadius
    && len(owner.input.mx, owner.input.mz) < 0.2;

  if (canDefuse) {
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

    // Burning the holder reuses the fire system, so it already renders.
    holder.burnUntil = world.time + 0.4;
    holder.burnBy = null;

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
  if (dirX || dirZ) b.aim = Math.atan2(dirX, dirZ);
}

function pickWanderTarget(world, b) {
  const h = world.arena.half - 4;
  b.wx = (world.rng() * 2 - 1) * h;
  b.wz = (world.rng() * 2 - 1) * h;
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
  const pk = { id: nextId(world), type, x, z };
  world.pickups.push(pk);
  emit(world, { type: 'pickupSpawn', x, z, kind: type, id: pk.id });
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
    } else if (pk.type === 'rapid') {
      taken.rapidUntil = world.time + PICKUP.rapid.duration;
    } else if (AMMO[pk.type]) {
      // One ammo slot: a new type replaces whatever was loaded.
      taken.ammo = pk.type;
      taken.ammoUntil = world.time + AMMO[pk.type].duration;
    }
    emit(world, { type: 'pickupTaken', x: pk.x, z: pk.z, kind: pk.type, id: pk.id, by: taken.id });
  }
  world.pickups = keep;
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
      id: p.id, name: p.name, seat: p.seat, team: p.team, x: p.x, z: p.z, aim: p.aim,
      hp: p.hp, alive: p.alive, kills: p.kills, deaths: p.deaths, score: p.score,
      invuln: p.invulnUntil > world.time, rapid: p.rapidUntil > world.time,
      ammo: p.ammoUntil > world.time ? p.ammo : 'none',
      burning: p.burnUntil > world.time,
      respawnIn: p.alive ? 0 : Math.max(0, p.respawnAt - world.time),
      kx: p.kx, kz: p.kz,
      nemesis: world.time < p.nemesisUntil ? p.nemesis : null,
      seq: p.lastSeq, isBot: p.isBot,
      carrying: p.carrying, contract: contractInfo(p),
    })),
    bullets: world.bullets.map((b) => ({
      id: b.id, x: b.x, z: b.z, vx: b.vx, vz: b.vz, owner: b.owner, ammo: b.ammo,
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
