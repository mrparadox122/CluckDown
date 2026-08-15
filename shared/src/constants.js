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

export const MODE_LIST = ['casual', 'ranked', 'deathmatch', 'duel'];

// Chicken palette — index by seat, so every player is visually distinct.
export const SEAT_COLORS = [
  '#f2f2f2', // white
  '#ffd166', // amber
  '#8ecae6', // sky
  '#c77dff', // violet
];

export const QUICK_CHAT = ['GG!', 'Help!', 'Nice shot!', 'Oops.', 'Bomber!', 'Follow me'];
