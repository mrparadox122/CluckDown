// Single source of truth for game tuning. Imported by both the client renderer
// and the authoritative server, so a number changed here changes both.

export const TICK_HZ = 60; // authoritative simulation rate
export const TICK_DT = 1 / TICK_HZ;

// State is broadcast on its own, slower timer. Simulating often makes the game
// responsive; broadcasting often mostly makes clients decode more, and
// interpolation already covers the gaps — so the two rates are deliberately
// decoupled rather than tied together.
export const PATCH_HZ = 40;
export const PATCH_MS = 1000 / PATCH_HZ;

// Most seconds of simulation a single frame may catch up on. The offline
// practice sim steps inside the render loop, so without a ceiling a stuttering
// device would spiral; with one that is too tight (a fixed step count) a slow
// device silently runs the match in slow motion. Expressing it in seconds
// keeps that behaviour identical at any TICK_HZ.
export const MAX_CATCHUP = 0.25;

export const PLAYER = {
  radius: 0.6,
  height: 1.2,
  maxHp: 100,
  speed: 7.2,
  respawnDelay: 3,
  spawnInvuln: 2,
  fireCooldown: 0.18,
  rapidCooldown: 0.07,
  knockbackDecay: 6, // per second, exponential-ish damping
};

// ---------------------------------------------------------- AIM ASSIST
//
// Aiming with a thumb on a 375px-tall screen is genuinely hard, and that was
// the loudest piece of player feedback. This softly pulls your aim onto a
// nearby enemy and keeps it there while they stay in front of you.
//
// Tune `strength` first — it is the whole feel of the feature:
//   0    off entirely
//   0.35 a gentle nudge, you still do the aiming
//   0.6  comfortable on a phone (default)
//   1    hard lock, feels like the game is playing for you
//
// Applied to HUMAN players only. Bots already aim with deliberate error, and
// handing them assist on top would just make them snipers.
export const AIM_ASSIST = {
  enabled: true,

  strength: 0.6,      // 0..1 share of the angle closed per second-ish (see sim)
  cone: 0.42,         // radians (~24 deg) around your aim that can acquire a target
  stickyCone: 0.72,   // wider angle before an ALREADY-locked target is dropped
  range: 26,          // units; beyond this nothing is acquired
  stickyRange: 32,    // a locked target is kept until it passes this
  lead: 0.55,         // 0..1 how much to aim ahead of a moving target
  minAimInput: 0.15,  // stick deflection below this counts as "not aiming"
};

export const BULLET = {
  radius: 0.22,
  speed: 30,
  damage: 11,
  life: 1.3, // seconds -> ~39 unit range
  knockback: 3.5,
};

export const BOMBER = {
  radius: 0.7,
  maxHp: 45,
  speed: 5.0, // slower than a player: you can always kite it
  detectRadius: 20,
  armRadius: 3.2,
  armSpeedMul: 0.62, // it slows once armed, giving you a window to run
  fuse: 5,
  blastRadius: 6.5,
  blastDamageMax: 62,
  blastDamageMin: 18,
  blastKnockback: 16,
  respawnDelay: 8,
  wanderInterval: 2.2,
  killScore: 50, // shooting it down is worth real points
  killReward: 'health', // ...and drops a pickup where it died
};

// ------------------------------------------------------------- AMMO TYPES
//
// One ammo slot per player: picking a new type replaces the old one rather than
// stacking, which keeps the combinations (and the balance surface) finite.
export const AMMO = {
  tracking: {
    id: 'tracking',
    label: 'Tracking',
    blurb: 'Rounds bend toward whoever you fired at.',
    duration: 10,
    turnRate: 5.0,   // radians per second the round may steer
    range: 24,       // it only tracks a target within this
    cone: 1.1,       // and only one roughly ahead of it
    color: '#c77dff',
  },
  bouncy: {
    id: 'bouncy',
    label: 'Bouncy',
    blurb: 'Rounds ricochet off the walls.',
    duration: 12,
    bounces: 2,
    color: '#8ecae6',
  },
  fire: {
    id: 'fire',
    label: 'Fire',
    blurb: 'Hits set chickens alight. Damage keeps ticking.',
    duration: 10,
    burnDuration: 3,  // seconds the target keeps burning
    burnDps: 9,       // damage per second while alight
    burnTick: 0.5,    // applied in chunks this often, so it reads as ticks
    color: '#ff8a3d',
  },
};

export const AMMO_LIST = ['tracking', 'bouncy', 'fire'];

// Weighted pickup table. Health stays common because it is the one every player
// always wants; the ammo types are the treat.
export const PICKUP_WEIGHTS = [
  ['health', 42],
  ['rapid', 16],
  ['tracking', 14],
  ['bouncy', 14],
  ['fire', 14],
];

/** Deterministic weighted pick, driven by the world RNG. */
export function rollPickup(rand) {
  const total = PICKUP_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let n = rand() * total;
  for (const [kind, w] of PICKUP_WEIGHTS) {
    n -= w;
    if (n <= 0) return kind;
  }
  return 'health';
}

export const PICKUP = {
  radius: 0.7,
  interval: 7,
  maxAlive: 3,
  health: { heal: 35 },
  rapid: { duration: 8 }, // gold pickup: rapid fire
};

export const SCORE = {
  kill: 100,
  death: -25,
  bomberKill: BOMBER.killScore,
};

// Multi-kill windows (seconds between kills to keep a streak alive)
export const MULTIKILL_WINDOW = 4;
export const MULTIKILL_NAMES = ['', 'Double Kill!', 'Triple Kill!', 'CLUCKING RAMPAGE!', 'UNSTOPPABLE!!'];

export const MODES = {
  casual: {
    id: 'casual',
    label: 'Casual',
    blurb: '4-player free-for-all. No rank, just vibes.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 40,
    matchTime: 240,
    killLimit: 0,
    ranked: false,
    bomberEnabled: true,
    bomberFirstSpawn: 10,
    fillWithBots: true,
    modifiers: true,
  },
  teams: {
    id: 'teams',
    label: '2v2 Teams',
    blurb: 'Two roosts enter. Friendly fire is off.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 40,
    matchTime: 240,
    killLimit: 0,
    teamKillLimit: 20,
    teams: true,
    ranked: false,
    bomberEnabled: true,
    bomberFirstSpawn: 12,
    fillWithBots: true,
    modifiers: true,
  },
  hill: {
    id: 'hill',
    label: 'King of the Coop',
    blurb: 'Hold the middle. Everyone wants it.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 40,
    matchTime: 240,
    killLimit: 0,
    hill: true,
    ranked: false,
    bomberEnabled: true,
    bomberFirstSpawn: 10,
    fillWithBots: true,
    modifiers: true,
  },
  survival: {
    id: 'survival',
    label: 'Last Chicken',
    blurb: 'One life. The arena closes in.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 40,
    matchTime: 180,
    killLimit: 0,
    respawn: false,
    shrink: true,
    ranked: false,
    bomberEnabled: true,
    bomberFirstSpawn: 20,
    fillWithBots: true,
    modifiers: true,
  },
  ranked: {
    id: 'ranked',
    label: 'Ranked',
    blurb: '4-player FFA. Your rating is on the line.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 40,
    matchTime: 240,
    killLimit: 0,
    ranked: true,
    bomberEnabled: true,
    bomberFirstSpawn: 10,
    fillWithBots: false,
  },
  deathmatch: {
    id: 'deathmatch',
    label: 'Deathmatch',
    blurb: 'Endless respawns. First to 15 kills.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 40,
    matchTime: 300,
    killLimit: 15,
    ranked: false,
    bomberEnabled: true,
    bomberFirstSpawn: 6,
    fillWithBots: true,
    modifiers: true,
  },
  duel: {
    id: 'duel',
    label: '1v1',
    blurb: 'Tight arena, two chickens, one survives.',
    maxPlayers: 2,
    minPlayers: 2,
    arena: 26,
    matchTime: 180,
    killLimit: 10,
    ranked: true,
    bomberEnabled: true,
    bomberFirstSpawn: 25, // it shows up rarely, as a tiebreaker menace
    bomberRespawnMul: 3,
    fillWithBots: false,
  },
};

export const MODE_LIST = ['casual', 'teams', 'hill', 'survival', 'ranked', 'deathmatch', 'duel'];

// Team play. Seats 0 and 3 hold the west corners, 1 and 2 the east ones, so a
// team always spawns down one side rather than diagonally across the arena.
export const TEAM_COLORS = ['#4da3ff', '#ff5d5d'];
export const TEAM_NAMES = ['Blue Roost', 'Red Roost'];
export const teamForSeat = (seat) => ((seat === 1 || seat === 2) ? 1 : 0);

// King of the Coop: hold the middle. Contested by anyone not on your side.
export const HILL = {
  radius: 5.5,
  // 25 uncontested seconds to win. 100 was the first guess and no bot match
  // ever finished; even 35 only got the leader to 83%. The zone is contested
  // most of the time, so the target has to be a small fraction of the match.
  target: 25,
  rate: 1,          // points per second, uncontested
};

// Last Chicken Standing: the safe area closes in, which forces the fight to a
// conclusion instead of two survivors circling a 40x40 field for three minutes.
export const SHRINK = {
  // Starts early on purpose. A four-player round with one life each resolves in
  // well under a minute, so a boundary that waits 30s never participates at all.
  startAt: 8,
  rate: 0.55,       // units of half-extent per second
  minHalf: 7,
  damagePerSec: 14, // for anyone caught outside
};

// Chicken palette — index by seat, so every player is visually distinct.
export const SEAT_COLORS = [
  '#f2f2f2', // white
  '#ffd166', // amber
  '#8ecae6', // sky
  '#c77dff', // violet
];

export const QUICK_CHAT = ['GG!', 'Help!', 'Nice shot!', 'Oops.', 'Bomber!', 'Follow me'];

// Room codes for playing with friends.
//
// No I/O/0/1 — they're indistinguishable from each other when someone reads a
// code aloud or squints at a phone screen, which is the entire use case.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function makeRoomCode(rand = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return out;
}

/** Normalises user input: uppercase, strip anything not in the alphabet. */
export function cleanRoomCode(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .slice(0, CODE_LENGTH)
    .join('');
}

// ------------------------------------------------------------- MODIFIERS
//
// A random rule twist announced at the start of a match. The point is that no
// two matches feel identical without needing new maps or systems.
//
// Every modifier is expressed as multipliers over existing tuning constants, so
// the simulation applies them in a handful of places and nothing else in the
// codebase has to know they exist. `visual` is the only client-side hook.
//
// Deliberately OFF for ranked and 1v1: a rating is only meaningful if everyone
// played the same game.

export const MODIFIERS = {
  none: {
    id: 'none',
    label: 'Standard',
    blurb: 'No twist. Just chickens.',
  },
  darkness: {
    id: 'darkness',
    label: 'LIGHTS OUT',
    blurb: 'The arena goes dark. Only the glow gives you away.',
    // Purely presentational — the simulation is untouched, but it changes how
    // the match plays because tracer fire becomes the main source of light.
    visual: 'darkness',
  },
  lowGravity: {
    id: 'lowGravity',
    label: 'LOW GRAVITY',
    blurb: 'Everything floats. Knockback sends you flying.',
    // There is no jumping in a top-down game, so "low gravity" is expressed as
    // momentum: knockback barely decays, so hits send chickens skating.
    knockbackDecayMul: 0.22,
    knockbackMul: 2.4,
    debrisGravityMul: 0.3,
  },
  doubleDamage: {
    id: 'doubleDamage',
    label: 'DOUBLE DAMAGE',
    blurb: 'Every shot hurts twice as much.',
    damageMul: 2,
  },
  suddenDeath: {
    id: 'suddenDeath',
    label: 'SUDDEN DEATH',
    blurb: 'One hit. That is the whole rule.',
    damageMul: 99,
  },
  trigger: {
    id: 'trigger',
    label: 'TRIGGER HAPPY',
    blurb: 'Everyone fires like they found the gold egg.',
    fireCooldownMul: 0.34,
  },
  frenzy: {
    id: 'frenzy',
    label: 'BOMBER FRENZY',
    blurb: 'They keep coming. Good luck.',
    bomberRespawnMul: 0.22,
    bomberFirstSpawnMul: 0.15,
  },
};

// `none` is in the pool on purpose — a plain match should still turn up, or the
// twists stop feeling like an event.
export const MODIFIER_POOL = [
  'none', 'none',
  'darkness', 'lowGravity', 'doubleDamage', 'suddenDeath', 'trigger', 'frenzy',
];

/** Multiplier lookup that tolerates an unknown or missing modifier. */
export function modValue(modifier, key, fallback = 1) {
  const m = MODIFIERS[modifier];
  return m && typeof m[key] === 'number' ? m[key] : fallback;
}
