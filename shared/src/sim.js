// Pure, headless game simulation. No Babylon, no Colyseus, no DOM.
//
// The server runs this as the authority. The client runs the *same* code to
// predict its own chicken between server snapshots, and to power offline
// practice mode. Keeping it dependency-free is the whole point — don't import
// anything renderer- or network-shaped in here.

import {
  PLAYER, BULLET, BOMBER, PICKUP, SCORE, MODES,
  MULTIKILL_WINDOW, SEAT_COLORS, MODIFIER_POOL, modValue,
  TEAM_COLORS, teamForSeat, HILL, SHRINK, AIM_ASSIST, AMMO, rollPickup,
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

  return {
    modifier: mod,
    mode: cfg.id,
    cfg,
    arena: { size: cfg.arena, half },
    time: 0,
    phase: 'warmup', // warmup -> live -> over
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
    hill: cfg.hill ? { holder: null, contested: false, progress: [0, 0, 0, 0] } : null,

    // Last Chicken Standing: safeHalf is the live boundary players are clamped
    // to. It starts at the full arena and closes from SHRINK.startAt onwards.
    safeHalf: half,
  };
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
  checkSurvival(world);

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
    const moveScale = world.phase === 'live' ? 1 : 0.35;
    let vx = inp.mx * PLAYER.speed * moveScale + p.kx;
    let vz = inp.mz * PLAYER.speed * moveScale + p.kz;

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

    applyAimAssist(world, p, dt);
    stepBurn(world, p, dt);
    if (p.ammoUntil && world.time >= p.ammoUntil) { p.ammo = 'none'; p.ammoUntil = 0; }

    if (inp.shoot && world.phase === 'live' && world.time >= p.nextShotAt) fire(world, p);
  }

  separatePlayers(world);
}

/**
 * Pulls a player's aim onto a nearby enemy and keeps it there.
 *
 * Two cones rather than one: a tight `cone` to ACQUIRE a target, and a wider
 * `stickyCone` to KEEP one. That is what makes it feel like a lock instead of a
 * twitch — once you're on someone, small thumb wobble doesn't shake you off,
 * but deliberately turning away does drop them.
 *
 * Humans only. Bots aim with deliberate error and assist would erase it.
 */
function applyAimAssist(world, p, dt) {
  const raw = p.aimRaw;

  // Off, or a bot: the stick is the aim, full stop.
  if (!AIM_ASSIST.enabled || p.isBot || AIM_ASSIST.strength <= 0) {
    p.aim = raw;
    p.aimTarget = null;
    return;
  }

  // Not aiming? Don't quietly steer someone who isn't asking to shoot.
  if (len(p.input.ax, p.input.az) < AIM_ASSIST.minAimInput && !p.input.shoot) {
    p.aim = raw;
    p.aimTarget = null;
    return;
  }

  let best = null;
  let bestScore = Infinity;

  for (const t of world.players.values()) {
    if (t.id === p.id || !t.alive || world.time < t.invulnUntil) continue;
    if (t.team !== null && t.team === p.team) continue;

    const d = Math.sqrt(dist2(p.x, p.z, t.x, t.z));
    const sticky = t.id === p.aimTarget;
    if (d > (sticky ? AIM_ASSIST.stickyRange : AIM_ASSIST.range)) continue;

    // Measured against the RAW stick angle, not the assisted one. Testing the
    // assisted angle would compare the lock against itself — the offset would
    // always be ~0 and you could never shake a target off by turning away.
    const off = Math.abs(angleDelta(raw, Math.atan2(t.x - p.x, t.z - p.z)));
    if (off > (sticky ? AIM_ASSIST.stickyCone : AIM_ASSIST.cone)) continue;

    // Closest to the centre of your aim wins, then closest by distance. A
    // current lock gets a discount so it holds through a contested moment.
    const score = off * (sticky ? 0.5 : 1) + d * 0.01;
    if (score < bestScore) { bestScore = score; best = t; }
  }

  if (!best) {
    p.aim = raw;
    p.aimTarget = null;
    return;
  }
  p.aimTarget = best.id;

  // Lead the target so the shot meets them rather than trailing behind.
  const d = Math.sqrt(dist2(p.x, p.z, best.x, best.z));
  const flight = d / BULLET.speed;
  const tx = best.x + (best.input?.mx ?? 0) * PLAYER.speed * flight * AIM_ASSIST.lead;
  const tz = best.z + (best.input?.mz ?? 0) * PLAYER.speed * flight * AIM_ASSIST.lead;
  const want = Math.atan2(tx - p.x, tz - p.z);

  // Ease from wherever the aim currently is toward the target. p.aim persists
  // between ticks (it is only snapped back to raw when there is no target), so
  // the pull accumulates instead of being erased and reapplied every frame.
  // Frame-rate independent, so `strength` feels the same at 30fps as at 144.
  const k = 1 - Math.exp(-AIM_ASSIST.strength * 12 * dt);
  p.aim += angleDelta(p.aim, want) * k;
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
        emit(world, { type: 'bounce', id: b.id, x: b.x, z: b.z });
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
          emit(world, { type: 'ignite', x: t.x, z: t.z, target: t.id });
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
  target.input = { mx: 0, mz: 0, ax: 0, az: 0, shoot: false, seq: target.input.seq };

  const killer = byId != null ? world.players.get(byId) : null;
  let multi = 0;
  if (killer && killer !== target) {
    killer.kills++;
    killer.score += SCORE.kill;
    killer.streak = world.time - killer.lastKillAt <= MULTIKILL_WINDOW ? killer.streak + 1 : 1;
    killer.lastKillAt = world.time;
    multi = killer.streak;
  }

  emit(world, {
    type: 'kill',
    x: target.x, z: target.z,
    target: target.id,
    by: killer && killer !== target ? killer.id : null,
    kind, // 'bullet' | 'blast'
    multi,
    color: target.color,
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

  const inside = [...world.players.values()].filter(
    (p) => p.alive && dist2(p.x, p.z, 0, 0) <= HILL.radius * HILL.radius,
  );

  // Everyone inside from the same side? In free-for-all that means exactly one.
  const sides = new Set(inside.map((p) => (p.team ?? p.id)));
  hill.contested = sides.size > 1;
  hill.holder = !hill.contested && inside.length ? inside[0].id : null;

  if (hill.contested || !inside.length) return;

  for (const p of inside) {
    hill.progress[p.seat] = (hill.progress[p.seat] ?? 0) + HILL.rate * dt;
    p.score += Math.round(HILL.rate * dt * 10);

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
    teamScores: world.teamScores ? [...world.teamScores] : null,
    hill: world.hill ? { holder: world.hill.holder, contested: world.hill.contested } : null,
    clock: world.clock,
    players: [...world.players.values()].map((p) => ({
      id: p.id, name: p.name, seat: p.seat, team: p.team, x: p.x, z: p.z, aim: p.aim,
      hp: p.hp, alive: p.alive, kills: p.kills, deaths: p.deaths, score: p.score,
      invuln: p.invulnUntil > world.time, rapid: p.rapidUntil > world.time,
      ammo: p.ammoUntil > world.time ? p.ammo : 'none',
      burning: p.burnUntil > world.time,
      respawnIn: p.alive ? 0 : Math.max(0, p.respawnAt - world.time),
      seq: p.lastSeq, isBot: p.isBot,
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
