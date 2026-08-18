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

// ------------------------------------------------------------------ GRAVITY
//
// The simulation has a Y axis: chickens jump, bullets rise and fall, and a shot
// can pass over someone's head. Everything vertical is tuned from here.
//
// Magnitude only — the sim applies it downward. 22 with a 7.0 jump gives a
// ~0.64s hop, which is close to what a shooter's muscle memory expects.
export const GRAVITY = 22;

/**
 * Height of the arena walls, in units.
 *
 * Shared rather than a renderer detail because the simulation needs it now: a
 * shot steep enough to clear the parapet is not a wall hit, it is a shot that
 * left the building. The renderer builds the walls to this same number, so the
 * two can never drift apart.
 */
export const WALL_HEIGHT = 2.6;

export const PLAYER = {
  radius: 0.6,
  height: 1.2,
  maxHp: 100,
  speed: 7.2,
  respawnDelay: 3,
  spawnInvuln: 2,
  fireCooldown: 0.18,
  /**
   * Floor on the fire cooldown, whatever perks and modifiers multiply it by.
   *
   * Kept from the old rapid-fire pickup, now doing a more important job: Rapid
   * Peck and Feeding Frenzy and TRIGGER HAPPY all multiply the same number, and
   * three multipliers stacked without a floor is a fire rate that empties a
   * crop before anyone can react to it.
   */
  minCooldown: 0.07,
  knockbackDecay: 6, // per second, exponential-ish damping

  /**
   * TAGGING. Being shot slows you briefly instead of shoving you.
   *
   * Bullets used to apply knockback. That is a projectile-game idea and it
   * reads, to anyone arriving from a hitscan shooter, as the game taking the
   * controls off you — which is the exact failure `maxKnockback` below was
   * added to bound. A slow does the same job better: the hit lands, you are
   * meaningfully worse off for a moment, and you never stop steering.
   *
   * Short, because it stacks with itself under sustained fire and a long tag
   * turns a losing fight into a helpless one.
   */
  tagSlow: 0.68,
  tagDuration: 0.35,

  /**
   * Ceiling on the accumulated shove, in units per second.
   *
   * Knockback is ADDED to your movement velocity, so once it exceeds `speed`
   * you are moving backwards no matter what you hold. It used to be uncapped:
   * a three-shot burst under LOW GRAVITY stacked to 25 u/s — three and a half
   * times top speed — and shoved you backwards at 18 u/s while you sprinted the
   * other way, for over a second. That is the "sliding left, can't go right"
   * report, and it reads as broken controls rather than as a game effect.
   *
   * At 1.5x speed a blast still throws you properly and a burst still pushes
   * you around, but sustained fire can no longer take the wheel outright.
   */
  maxKnockback: 7.2 * 1.5,

  // --- the vertical axis ---------------------------------------------------

  /**
   * Where the camera sits, and where shots leave from.
   *
   * Chicken height, not human height: at 1.15 the 2.6-unit walls actually
   * enclose you. Raise it much past 1.6 and you look straight over the top into
   * the abyss the arena floats above.
   */
  eyeHeight: 1.15,

  /**
   * The hitbox, from the floor to the top of the comb.
   *
   * Combined with `radius` this makes a capsule roughly the size of the chicken
   * you can see, which is the whole point of the change: a shot that visibly
   * sails over someone now misses, and one aimed down at a target below you
   * lands. `radius` still does the horizontal work, unchanged, so duelling on
   * flat ground feels exactly as it did.
   */
  hitHeight: 1.8,

  /** Upward velocity of a jump, in units/second. See maxJumpHeight. */
  jumpSpeed: 7.0,

  /**
   * Hard ceiling on how far above the floor you can get, in units.
   *
   * This is a wall, not a suggestion, and it exists for one reason: the arena
   * walls are 2.6 tall and eye height is 1.15, so anything above ~1.4 lets you
   * see over the top into the void the platform floats above. Clamping the
   * position rather than tuning the impulse means LOW GRAVITY, a blast, or a
   * future launcher pad cannot quietly reintroduce the problem.
   *
   * (7.0 against gravity 22 apexes at 1.11 on its own, so a normal jump never
   * touches this. It is here for everything that isn't a normal jump.)
   */
  maxJumpHeight: 1.25,

  /**
   * Vertical look limits, in radians. Roughly -78 to +72 degrees.
   *
   * These live in the simulation, not the renderer, because pitch is part of
   * the shot now: the server has to clamp what a client sends it. The camera
   * uses the same two numbers, so what you can look at and what you can hit are
   * the same range by construction.
   *
   * Up used to be capped hard at 0.42 on the grounds that there was nothing
   * above the arena worth looking at. There still isn't much — but "the
   * crosshair only moves left and right" was a player report, and a stingy
   * ceiling is exactly what that feels like.
   */
  pitchMin: -1.36,
  pitchMax: 1.26,
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
//   0.6  comfortable on a phone
//   0.8  firm — it closes most of the gap for you (default)
//   1    hard lock, feels like the game is playing for you
//
// Raised from 0.6 on player feedback. Cover made it necessary as well as
// wanted: with boxes in the arena a target is visible for a shorter window, so
// the time you have to close the last few degrees by hand went down.
//
// Applied to HUMAN players only. Bots already aim with deliberate error, and
// handing them assist on top would just make them snipers.
export const AIM_ASSIST = {
  enabled: true,

  strength: 0.8,      // 0..1 share of the angle closed per second-ish (see sim)
  cone: 0.5,          // radians (~29 deg) around your aim that can acquire a target
  stickyCone: 0.85,   // wider angle before an ALREADY-locked target is dropped
  range: 26,          // units; beyond this nothing is acquired
  stickyRange: 32,    // a locked target is kept until it passes this
  minAimInput: 0.15,  // stick deflection below this counts as "not aiming"

  /**
   * Where up the target's body the vertical pull aims, as a fraction of
   * PLAYER.hitHeight.
   *
   * Assist gained a vertical component when shots did. Slightly above centre:
   * aiming at the exact middle of the capsule is the safest shot, but it looks
   * like the game is aiming at a chicken's belly, and a hair higher reads as
   * aiming at the bird.
   */
  aimHeight: 0.55,
};

// ------------------------------------------------------------------- GRAIN
//
// Chickens shoot grain, and grain runs out.
//
// THE PROBLEM. Fire was unlimited, gated only by a cooldown, which means the
// player never makes a decision about it: every second of a match is the same
// second. No resource means no risk, no pacing, and no window in which anyone
// is vulnerable for a reason they caused. Every shooter that holds attention
// has some version of this beat, and it is always the same beat: commit, run
// dry, become briefly helpless, recover.
//
// THE SHAPE. Two ways to refill, deliberately different in cost:
//
//   PECK — anywhere, but you must stand still. It is not a button, it is a
//   stance: you stop, your chicken puts its head down, and everyone can see you
//   doing it. That readability is the whole point. A reload that only the
//   reloading player knows about creates tension for one person; a reload that
//   the room can see creates it for everyone, and turns "they stopped moving"
//   into information worth acting on.
//
//   FEEDER — your own spawn pad, which fills you instantly and heals you while
//   you stand there. This is the "go home and eat" idea, and it is deliberately
//   an OPTION rather than the rule. Forcing a walk on an empty player punishes
//   whoever just lost a fight and turns the worst moment of a match into its
//   longest; offering a walk that refills AND heals makes the same trip a
//   choice you make when it is worth it. Same map traffic, opposite feeling.
//
// ANTI-FRUSTRATION, all of it load-bearing:
//   * Pecking refills PROGRESSIVELY. An interrupted peck is never wasted — a
//     wasted reload is the single most resented moment in the genre.
//   * It starts by itself. Nothing to learn, no key to find.
//   * Firing on empty still pecks, so a player mashing the trigger is never
//     stuck. Not doing this deadlocks the most panicked person in the match.
//   * A kill refunds some grain, so winning a fight does not immediately cost
//     you the next one.
export const CROP = {
  /**
   * Shots in a full crop.
   *
   * 14 against a 10-shot kill is the number that matters: you can kill one
   * chicken and miss four times. Tight enough that spraying loses fights,
   * loose enough that losing a fight is never blamed on the magazine.
   */
  capacity: 14,

  /** Grain per second while pecking — a full crop from empty in ~1.5s. */
  peckRate: 9,

  /**
   * Stillness required before pecking starts, in seconds.
   *
   * Short, but not zero. Without it every incidental pause tops you up and the
   * resource stops existing; much longer and stopping deliberately feels
   * unresponsive. This is the window where standing still is a commitment.
   */
  peckDelay: 0.3,

  /**
   * Once you hit zero, how much grain you must peck back before you may fire.
   *
   * Without this the empty state does not really exist. A player holding the
   * trigger pecks one grain, instantly fires it, and drops to zero again —
   * dribbling single shots forever and never recovering, which is the exact
   * trap the "firing on empty still pecks" rule was meant to prevent. It half
   * worked: they pecked, and then spent it before it could add up.
   *
   * A recovery floor makes running dry a real commitment instead of a stutter:
   * roughly half a second where you are out of the fight and everyone can see
   * it. That window IS the mechanic. Overheating weapons in other games use the
   * same shape for the same reason — a resource you can nurse at zero is not a
   * resource.
   */
  recoverTo: 4,

  /** Grain handed back for a kill. Keeps a winning streak flowing. */
  killRefund: 3,

  feeder: {
    /** Matches the spawn pad you can already see on the floor. */
    radius: 2.0,
    /** Health per second while you stand on it. */
    heal: 16,
    /**
     * Grain per second. High enough to be instant in practice — the feeder's
     * cost is the walk and the exposure, not the wait once you arrive.
     */
    refill: 60,

    /**
     * Seconds after taking damage before the feeder will heal you, in seconds.
     *
     * Grain is unaffected; only health waits. Without this the feeder is a
     * fortress: it sits on your spawn corner, which in Egg Heist and Plant &
     * Defuse is also your NEST, so defending the objective would mean standing
     * in permanent regeneration and a planted bomb could not kill you. It was
     * exactly that — a bomb detonating under a player at full health — that
     * found this.
     *
     * The general rule it encodes is worth more than the bug it fixes: you can
     * recover from a fight, never through one. Healing under fire is what makes
     * a defensive position unbreakable, and unbreakable positions are how a
     * four-minute match becomes a stalemate.
     */
    combatDelay: 3,
  },
};

export const BULLET = {
  radius: 0.16,

  damage: 11,

  /**
   * How far a shot reaches, in units. It gets there instantly — see traceShot.
   *
   * Raising the old projectile speed was the wrong fix for "shooting feels
   * unsatisfying", twice over: first from 30 to 52, and it still felt wrong,
   * because travel time is not a tuning knob. A player trained on CS or
   * Valorant does not lead a target — they put the dot on it and click — so any
   * flight time at all makes the game feel like it is disagreeing with them.
   *
   * 46 keeps roughly the reach the projectile had, which was already tuned
   * against the map sizes.
   */
  range: 46,

  /**
   * HEADSHOTS.
   *
   * The skill expression hitscan was missing. With every shot doing the same
   * eleven damage wherever it lands, aim carefully and aim vaguely pay exactly
   * the same — which is the other half of why shooting felt unsatisfying to
   * anyone arriving from CS or Valorant. There, where you put the dot is the
   * whole game.
   *
   * 52 against 100 health means two clean headshots kill, versus ten body
   * shots. That gap is deliberately enormous: a five-to-one payoff is what
   * makes going for the head a real decision under pressure rather than a small
   * bonus you take when convenient.
   *
   * `headFrom` is measured up from the chicken's FEET, so it travels with a
   * jumping target and stays correct at any height.
   *
   * It has to sit ABOVE eye height (1.15), and that is the whole subtlety. The
   * first attempt used 1.05 — the underside of the head box the renderer
   * builds — which looks right and is badly wrong: two chickens stand at the
   * same height, so a shot fired dead level leaves one eye at 1.15 and arrives
   * at the other at 1.15, inside the head. Every flat shot was a free headshot,
   * time-to-kill collapsed to two rounds, and aim assist — which pulls to 0.99,
   * below the line — was actively making your shots WORSE. A test caught it
   * because DOUBLE DAMAGE started reporting 100 damage a hit.
   *
   * At 1.28 a level shot lands in the neck and body, and the head has to be
   * aimed at. The margin is small on purpose: about 0.7 degrees at duelling
   * range, which is a few pixels of crosshair placement. That is the skill —
   * it is the same one CS players spend years on, and it is exactly what was
   * missing from a game where every shot did the same damage wherever it hit.
   *
   * Aim assist deliberately does NOT reach here: it pulls to 0.55 of the body
   * (0.99), well under the line. Assist gets you body shots; heads are earned.
   */
  headDamage: 52,
  headFrom: 1.28,

  /**
   * How fast the TRACER is drawn, in units per second, and nothing else.
   *
   * The shot itself has already been resolved by the time this is used. This is
   * purely how quickly the streak crosses the gap to a decision that has
   * already been made — fast enough to read as instant, slow enough to be a
   * visible line rather than a single frame nobody sees.
   */
  tracerSpeed: 190,

  /**
   * The tracer you can SEE, which is deliberately NOT `radius` above.
   *
   * `radius` is the collision size and it is generous on purpose — it is added
   * to the chicken's own radius in the swept hit test, and shaving it makes
   * every shot in the game harder to land. Drawing the tracer at that size was
   * a separate decision that nobody actually made: it just inherited the
   * number, and players read the result as fat blobs rather than gunfire.
   *
   * So the two are split. Change this to restyle the tracer; change `radius`
   * to change how hard the game is.
   */
  tracerRadius: 0.12,
  /**
   * World units, nose to tail — the streak, not the round.
   *
   * Lengthened with the speed. A tracer is a fake motion blur, and the faster
   * the thing it is standing in for, the longer that blur should be: at 52 a
   * one-unit streak covers less than its own length per frame on a 60Hz
   * display and reads as a dot rather than as gunfire.
   */
  tracerLength: 1.6,
};

export const BOMBER = {
  radius: 0.7,
  // Taller than a player because it is drawn at 1.25 scale. Bullets travel in
  // three dimensions now, so this is what stops a shot arcing over the bomber
  // from counting as a hit on it.
  hitHeight: 2.25,
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

// ------------------------------------------------------------- THE PECKING ORDER
//
// Power is EARNED, not found. Every shooting pickup — tracking, bouncy and fire
// rounds, and rapid fire — was deleted and replaced by this, and that swap is
// the whole design argument:
//
// A pickup is luck. You walk over a thing and become stronger for ten seconds,
// and nothing about that is attributable to you. It generates no story, teaches
// nothing, and the player who lost the fight lost it to a spawn table. A ladder
// you climb by killing is the opposite on every count — it is legible, it is
// yours, and it is public.
//
// PUBLIC is the important word. Everyone's level rides above their health bar,
// which turns a number into a social object: it marks the threat in the room,
// it makes a high level something to defend, and it makes taking one down worth
// bragging about. Status visible to others is a far stronger motivator than
// private power, and it costs one line of HUD.
//
// THE RUNG YOU KILL DECIDES THE CLIMB. Beating someone above you is worth
// multiples of beating someone below, so the leader is also the fastest route
// up — the ladder rubber-bands itself instead of running away with whoever got
// the first kill. Dying is the mirror: losing to someone below you costs far
// more than losing to someone above, because being outmatched is not a mistake
// and being upset is.
//
// GUARDED AGAINST THE DEATH SPIRAL, deliberately and in three places. Loss
// aversion is roughly twice as strong as the pleasure of an equivalent gain,
// so a ladder that takes as freely as it gives is a ladder people quit. Hence:
// you never fall below rung 1, you never fall more than one rung per death, and
// dying to someone above you is nearly free.
export const LEVELS = {
  max: 6,
  /** XP per rung. Flat, because a curve makes the top unreachable in four minutes. */
  step: 100,

  kill: {
    /** Beating an equal. Well over half a rung, so any kill feels like progress. */
    base: 60,
    /**
     * Per rung of difference, added when they are above you and subtracted when
     * below. Killing one rung up is a whole level in a single fight — the
     * biggest single dopamine hit the mode has, and it is aimed squarely at
     * whoever is winning.
     */
    perRung: 40,
    /** Clamped, so farming the bottom of the table is never a strategy. */
    maxRungs: 3,
    floor: 10,
  },

  death: {
    /** Dying to an equal or to someone above you. Cheap on purpose. */
    base: 30,
    /** Extra per rung the killer was BELOW you. Being upset is what costs. */
    perRung: 30,
    maxRungs: 3,
  },

  /**
   * The rungs, and what each one gives you.
   *
   * Every unlock has to be felt within seconds of getting it, or the level-up
   * is a number with no referent. "+5% movement" is invisible and therefore
   * worthless as a reward however good it is on a spreadsheet.
   *
   * They also escalate in KIND rather than in size — tempo, then mobility, then
   * power, then safety, then spectacle. Five different feelings beats one
   * feeling five times, and it keeps the top of the ladder from being simply
   * "the same but more", which is where a progression stops producing dopamine.
   *
   * Note how little of it is raw damage. The leader is already the biggest prize
   * in the room; handing them lethality on top is how a match ends at minute
   * two. Most of the ladder buys TIME — faster recovery, faster legs, an escape
   * — which is felt immediately and still leaves them killable.
   */
  rungs: [
    {
      level: 1,
      name: 'Chick',
      perk: null,
      blurb: 'Everyone starts here.',
      color: '#9aa6c4',
    },
    {
      level: 2,
      name: 'Scratcher',
      perk: 'Quick Crop',
      blurb: 'Peck back to full in half the time.',
      // Tempo. It shortens the most helpless moment in the game, which is the
      // single most welcome thing you can hand someone this early.
      peckRateMul: 1.9,
      color: '#5ee08a',
    },
    {
      level: 3,
      name: 'Runner',
      perk: 'Long Legs',
      blurb: 'You are noticeably quicker on your feet.',
      // Mobility. Felt in the first step, and visible to everyone else too.
      speedMul: 1.16,
      color: '#5fd1ff',
    },
    {
      level: 4,
      name: 'Brawler',
      perk: 'Rapid Peck',
      blurb: 'Your shots come out a third faster.',
      // Power, and the only rung that is straightforwardly lethality. By now
      // you are a visible threat carrying a number everyone wants.
      fireCooldownMul: 0.72,
      color: '#ffcc3d',
    },
    {
      level: 5,
      name: 'Ironfeather',
      perk: 'Second Wind',
      blurb: 'Drop low and bolt — once per life.',
      // Safety, and reactive rather than passive: it FIRES, with a sound and a
      // colour, at the worst moment of a fight. A perk you notice happening is
      // worth several you merely have.
      secondWind: { at: 0.3, seconds: 2.2, speedMul: 1.55 },
      color: '#ff8a3d',
    },
    {
      level: 6,
      name: 'Cock of the Walk',
      perk: 'Feeding Frenzy',
      blurb: 'A kill refills you and sets you loose.',
      // Spectacle. It rewards the thing the top of the ladder should reward —
      // stringing kills together — and it is the only perk that can chain, so
      // the ceiling of the mode is a highlight rather than a stat.
      frenzy: { seconds: 3.2, fireCooldownMul: 0.75, speedMul: 1.2 },
      color: '#ff4df0',
    },
  ],
};

/** The rung definition for a level, clamped into range. */
export function rungOf(level) {
  const i = Math.max(1, Math.min(LEVELS.max, level | 0)) - 1;
  return LEVELS.rungs[i];
}

/** Level from total XP. */
export function levelFromXp(xp) {
  return Math.max(1, Math.min(LEVELS.max, Math.floor(Math.max(0, xp) / LEVELS.step) + 1));
}

/** XP at which a level begins. */
export function xpForLevel(level) {
  return (Math.max(1, level) - 1) * LEVELS.step;
}

/**
 * A perk value for a player at `level`, or `fallback`.
 *
 * Perks are cumulative: reaching rung 4 keeps rungs 2 and 3. So this walks down
 * the ladder rather than reading one entry — a player at 6 still has Long Legs.
 */
export function perkValue(level, key, fallback = 1) {
  let out = fallback;
  for (const rung of LEVELS.rungs) {
    if (rung.level > level) break;
    if (rung[key] !== undefined) out = rung[key];
  }
  return out;
}

/** Does this level have the named perk at all? */
export function hasPerk(level, key) {
  return perkValue(level, key, undefined) !== undefined;
}

// Weighted pickup table. Health only, now that power comes from the ladder
// rather than from the floor — see THE PECKING ORDER above. Kept as a table
// rather than collapsed to a constant because the shape is the useful part:
// adding a non-combat pickup later is one line here and nothing anywhere else.
export const PICKUP_WEIGHTS = [
  ['health', 100],
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
    arena: 48,
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
    arena: 48,
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
    arena: 48,
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
    arena: 48,
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
  heist: {
    id: 'heist',
    label: 'Egg Heist',
    blurb: 'Four eggs each. Steal theirs, defend yours.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 48,
    matchTime: 240,
    killLimit: 0,
    heist: true,
    ranked: false,
    bomberEnabled: true,
    bomberFirstSpawn: 14,
    fillWithBots: true,
    modifiers: true,
  },
  bomb: {
    id: 'bomb',
    label: 'Plant & Defuse',
    blurb: 'Carry the bomb to a rival nest. Then survive the clock.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 48,
    matchTime: 300,
    killLimit: 0,
    bomb: true,
    ranked: false,
    bomberEnabled: false, // one bomb at a time is enough tension
    bomberFirstSpawn: 999,
    fillWithBots: true,
    modifiers: true,
  },
  ranked: {
    id: 'ranked',
    label: 'Ranked',
    blurb: '4-player FFA. Your rating is on the line.',
    maxPlayers: 4,
    minPlayers: 2,
    arena: 48,
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
    arena: 48,
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
    arenaScale: 0.68, // a duel on The Big Yard would be two chickens jogging
    maxPlayers: 2,
    minPlayers: 2,
    arena: 32,
    matchTime: 180,
    killLimit: 10,
    ranked: true,
    bomberEnabled: true,
    bomberFirstSpawn: 25, // it shows up rarely, as a tiebreaker menace
    bomberRespawnMul: 3,
    fillWithBots: false,
  },
};

export const MODE_LIST = [
  'casual', 'heist', 'bomb', 'teams', 'hill', 'survival', 'ranked', 'deathmatch', 'duel',
];

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
  // The zone relocates so a match isn't one long grind over the same tile.
  // This has to be well under `target` or the mechanic never fires: at 30s a
  // solo holder wins at 25 and the zone sits in the middle for the whole match.
  moveEvery: 18,    // seconds between relocations
  warnAt: 4,        // seconds of warning before it moves
  spread: 0.55,     // how far from centre it may land, as a share of the half-extent
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
    // Now that the game has a Y axis this finally means what it says: you fall
    // slowly and hang at the top of a jump. The knockback half stays — skating
    // across the floor was the good part of the old top-down interpretation.
    //
    // The apex does NOT scale with this. PLAYER.maxJumpHeight clamps the
    // position outright, so halving gravity buys hang time, not altitude, and
    // nobody ends up floating over the walls.
    gravityMul: 0.5,
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
    // The crop has to grow with the fire rate, or this stops being TRIGGER
    // HAPPY and becomes TRIGGER HAPPY FOR TWO SECONDS THEN PECK. A modifier
    // that inverts its own promise is worse than not having it.
    cropMul: 2.5,
    peckRateMul: 2,
  },
  potato: {
    id: 'potato',
    label: 'HOT POTATO',
    blurb: 'A cursed egg. Touch someone to hand it on, fast.',
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
  'darkness', 'lowGravity', 'doubleDamage', 'suddenDeath', 'trigger', 'frenzy', 'potato',
];

/**
 * How much grain a full crop holds under a given modifier.
 *
 * Shared so the HUD draws exactly as many pips as the simulation will let you
 * fire. A meter that disagrees with the gun is worse than no meter.
 */
export function cropCapacity(modifier) {
  return Math.round(CROP.capacity * modValue(modifier, 'cropMul'));
}

/** Multiplier lookup that tolerates an unknown or missing modifier. */
export function modValue(modifier, key, fallback = 1) {
  const m = MODIFIERS[modifier];
  return m && typeof m[key] === 'number' ? m[key] : fallback;
}

// ------------------------------------------------------------------ MAPS
//
// Deliberately shallow for now: size and palette only. Real map identity needs
// cover to fight around, and cover needs bot obstacle avoidance — so that is a
// separate job. These exist so the vote has something meaningful to choose
// between, and arena size alone genuinely changes how a match plays.
// ------------------------------------------------------------------ COVER
//
// Every map is a box with cubes in it. The cubes are the difference between a
// firefight and two chickens shooting each other across an empty square, which
// is what players meant by "it feels a bit odd" — with nothing to break line of
// sight, whoever aimed first won and there was nothing to do about it.
//
// Two rules, and both are load-bearing:
//
// 1. **Nothing is short enough to land on.** Every piece of cover is taller
//    than PLAYER.maxJumpHeight, so a jump can never leave you standing on top
//    of one. That keeps cover a purely horizontal problem — no ground-height
//    tracking, no hovering at box edges, no getting sealed inside one on the
//    way down. `test:cover` enforces it.
//
// 2. **Low cover is eye-height cover.** At 1.6 the top is above a standing eye
//    (1.15) and below a jumping one (2.4), so you cannot shoot over it on foot
//    but you can hop to peek. That is the one place jumping became tactical
//    rather than decorative, and it is why the heights are mixed rather than
//    uniform.
export const COVER = {
  /** Nothing may be shorter than this, or you could jump on top of it. */
  minHeight: 1.55,
  /** Cover you can hop to shoot over. */
  low: 1.6,
  /** Cover that blocks outright, even mid-jump. */
  high: 2.6,
  /**
   * Clear lane along the arena's own axes, in units either side.
   *
   * Cover is kept off the lines x=0 and z=0 on purpose. It leaves four open
   * sightlines through the middle, which is what stops a map full of boxes
   * reading as a maze — and it keeps the arena mirror-symmetric on both axes,
   * so `test:control` can still prove there is no directional bias in the
   * movement code by walking from the centre in each cardinal direction.
   */
  axisLane: 0.9,
};

/**
 * Mirrors one quadrant's worth of cover into all four.
 *
 * Authoring a quarter and reflecting it is the cheapest way to guarantee a fair
 * map: whatever advantage a box gives, every seat gets the same one. Maps that
 * are asymmetric by accident are the oldest bug in arena shooters.
 */
function quad(boxes) {
  const out = [];
  for (const b of boxes) {
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) out.push({ ...b, x: b.x * sx, z: b.z * sz });
    }
  }
  return out;
}

export const MAPS = {
  coop: {
    id: 'coop',
    label: 'The Coop',
    blurb: 'The original yard. Balanced, with cover to fight around.',
    size: 48,
    floor: '#3f6fd8',
    trim: '#9aa6c4',
    lamp: '#8fb4ff',
    // An inner diamond of hard cover, wrapped by low walls you can hop to
    // shoot over. The flagship map, so it gets the most legible layout.
    cover: quad([
      { x: 7, z: 7, w: 5, d: 5, h: COVER.high },
      { x: 15, z: 6.8, w: 2.4, d: 9, h: COVER.low },
      { x: 6.8, z: 15, w: 9, d: 2.4, h: COVER.low },
    ]),
  },
  squeeze: {
    id: 'squeeze',
    label: 'Tight Squeeze',
    blurb: 'Small and vicious. Four pillars and bad intentions.',
    size: 34,
    floor: '#8f3fd8',
    trim: '#b49ac4',
    lamp: '#d79aff',
    // Deliberately sparse. The whole character of this map is that there is
    // almost nowhere to go, so it gets exactly enough cover to break a sightline
    // and no more.
    cover: quad([
      { x: 6.5, z: 6.5, w: 4, d: 4, h: COVER.high },
    ]),
  },
  yard: {
    id: 'yard',
    label: 'The Big Yard',
    blurb: 'Room to run, and things to run behind.',
    size: 64,
    floor: '#2f9e6f',
    trim: '#9ac4b4',
    lamp: '#9affd0',
    // The biggest map needs the most, or crossing it is a long walk in the
    // open — which on a map this size is most of a life.
    cover: quad([
      { x: 8, z: 8, w: 4, d: 4, h: COVER.high },
      { x: 19, z: 8, w: 2.6, d: 12, h: COVER.low },
      { x: 8, z: 19, w: 12, d: 2.6, h: COVER.low },
      { x: 23, z: 23, w: 4.5, d: 4.5, h: 2.4 },
    ]),
  },
  dusk: {
    id: 'dusk',
    label: 'Dusk Pen',
    blurb: 'Dim and rusty. Follow the tracers, watch the corners.',
    size: 48,
    floor: '#a8452f',
    trim: '#c49a8a',
    lamp: '#ffb066',
    // Same size as The Coop, deliberately different shape: scattered pillars
    // rather than walls, so it plays as angles instead of lanes.
    cover: quad([
      { x: 6, z: 6, w: 3, d: 3, h: 2.8 },
      { x: 13, z: 13, w: 3.5, d: 3.5, h: COVER.low },
      { x: 18, z: 6, w: 3, d: 3, h: 2.2 },
      { x: 6, z: 18, w: 3, d: 3, h: 2.2 },
    ]),
  },
  frost: {
    id: 'frost',
    label: 'Frost Roost',
    blurb: 'Cold and pale. Long walls, longer sightlines.',
    size: 56,
    floor: '#4a7fa8',
    trim: '#c9d8e4',
    lamp: '#bfe4ff',
    // Long low walls: this map is about crossing open ground under fire, and a
    // wall you can hop over is a decision rather than a detour.
    cover: quad([
      { x: 9, z: 9, w: 12, d: 2.4, h: COVER.low },
      { x: 9, z: 20, w: 2.4, d: 8, h: COVER.high },
    ]),
  },
};

/**
 * The cover for a map, scaled to the arena it is actually being played on.
 *
 * Modes can shrink the arena (1v1 plays The Big Yard at 0.68), so the layout
 * has to shrink with it or a duel map ends up as four boxes in a corner. Only
 * the footprint scales — heights are absolute, because COVER's two rules are
 * about PLAYER.maxJumpHeight and eye level, and neither of those scales.
 *
 * Derived from the arena size rather than stored, so the client can rebuild the
 * identical layout from the map id and size it already syncs.
 */
export function coverFor(mapId, size) {
  const map = MAPS[mapId] ?? MAPS[DEFAULT_MAP];
  const k = size / map.size;
  return (map.cover ?? []).map((c) => ({
    x: c.x * k, z: c.z * k, w: c.w * k, d: c.d * k, h: c.h,
  }));
}

export const MAP_LIST = Object.keys(MAPS);
export const DEFAULT_MAP = 'coop';

export const MAP_VOTE = {
  candidates: 3,   // choices offered
  seconds: 14,     // hard ceiling on the lobby
  minSeconds: 4,   // never flash past, even if everyone votes instantly
};

/** Picks `n` distinct maps using the world RNG, so a seed reproduces the vote. */
export function pickMapCandidates(rand, n = MAP_VOTE.candidates) {
  const pool = [...MAP_LIST];
  const out = [];
  while (out.length < Math.min(n, pool.length)) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

// ---------------------------------------------------------------- BOUNTY
//
// The player in front wears a crown and is worth more. A comeback lever: it
// stops a runaway leader and it hands everyone else a shared target, which is
// where the stories come from.
export const BOUNTY = {
  enabled: true,
  multiplier: 3,     // score for killing the crowned chicken
  minScore: 150,     // no crown until someone is actually ahead
  minLead: 100,      // and clearly ahead of second place
  recheck: 2,        // seconds between recalculations
};

// ------------------------------------------------------------ HOT POTATO
//
// A cursed egg that burns whoever is carrying it. Touch someone to pass it on.
// It inverts the whole game — suddenly you are chasing people to make contact
// rather than to shoot them.
export const POTATO = {
  firstSpawn: 8,
  dps: 11,           // damage per second to the holder
  fuse: 12,          // seconds before it detonates on whoever is holding it
  blastDamage: 55,
  passRadius: 1.7,   // how close you must get to hand it over
  passCooldown: 0.6, // stops it ping-ponging between two touching players
  respawnDelay: 6,
};

// -------------------------------------------------------------- CONTRACTS
//
// Rotating personal side-tasks. This is the cheapest way to make a match feel
// purposeful: it is a counting layer over events the simulation already emits,
// it works in every mode including plain deathmatch, and it quietly teaches
// players the systems they would otherwise never discover.
//
// Each contract declares EITHER `onEvent` (count things that happened) or
// `onTick` (accumulate time under a condition) — never both.
/**
 * Revenge.
 *
 * The most reliable social mechanic in the genre, and the cheapest: whoever
 * killed you last is marked, and killing them back pays. It manufactures a
 * personal story inside a four-minute match between strangers, which is
 * exactly what a session game with no accounts is otherwise missing.
 *
 * `window` matters — a nemesis you are still chasing three minutes later is
 * a grudge; one from thirty seconds ago is a rematch.
 */
export const REVENGE = {
  window: 45,      // seconds the mark stays live
  bonus: 75,       // extra score for taking them back down
};

export const CONTRACT = {
  duration: 45,     // seconds before an unfinished contract rotates out
  gap: 4,           // breather between contracts
  reward: 120,      // score for completing one
};

export const CONTRACTS = {
  doubleKill: {
    id: 'doubleKill',
    label: 'Clean 2 chickens',
    target: 2,
    onEvent: (e, p) => (e.type === 'kill' && e.by === p.id ? 1 : 0),
  },
  bomberDown: {
    id: 'bomberDown',
    label: 'Defuse the bomber',
    target: 1,
    onEvent: (e, p) => (e.type === 'bomberDown' && e.by === p.id ? 1 : 0),
  },
  scavenge: {
    id: 'scavenge',
    label: 'Grab 3 pickups',
    target: 3,
    onEvent: (e, p) => (e.type === 'pickupTaken' && e.by === p.id ? 1 : 0),
  },
  // Both of these replaced ammo-type contracts (set alight, ricochet) when the
  // shooting pickups were removed. They point at the ladder instead, which is
  // where the interesting decisions moved to.
  climber: {
    id: 'climber',
    label: 'Climb 2 rungs',
    target: 2,
    onEvent: (e, p) => (e.type === 'levelUp' && e.target === p.id ? 1 : 0),
  },
  giantSlayer: {
    id: 'giantSlayer',
    label: 'Beat someone above you',
    target: 1,
    onEvent: (e, p) => (e.type === 'kill' && e.by === p.id && e.punchedUp ? 1 : 0),
  },
  regicide: {
    id: 'regicide',
    label: 'Take down the crown',
    target: 1,
    onEvent: (e, p) => (e.type === 'kill' && e.by === p.id && e.bounty ? 1 : 0),
  },
  survivor: {
    id: 'survivor',
    label: 'Survive 25 seconds',
    target: 25,
    // Resets on death, so it is a genuine streak rather than a stopwatch.
    onTick: (p, world, dt) => (p.alive ? dt : -Infinity),
  },
  holdGround: {
    id: 'holdGround',
    label: 'Hold the middle for 8s',
    target: 8,
    onTick: (p, world, dt) => {
      const hx = world.hill?.x ?? 0;
      const hz = world.hill?.z ?? 0;
      const inside = (p.x - hx) ** 2 + (p.z - hz) ** 2 <= HILL.radius * HILL.radius;
      return p.alive && inside ? dt : 0;
    },
  },
};

export const CONTRACT_LIST = Object.keys(CONTRACTS);

// ------------------------------------------------------------- EGG HEIST
//
// Every nest starts with four eggs. Steal from anyone, carry them home.
//
// Carrying is deliberately expensive: each egg slows you and lights you up, so
// a full load makes you a slow glowing target. That is the whole risk/reward,
// and it stops the leader simply hoarding. Eggs drop where you fall rather than
// teleporting home, which turns a death into a scramble.
export const HEIST = {
  eggsPerNest: 4,
  nestRadius: 2.6,
  stealCooldown: 0.7,   // between individual eggs, so a nest isn't emptied instantly
  carrySlow: 0.08,      // speed lost per egg carried
  maxCarrySlow: 0.34,   // ...capped, or four eggs would be unplayable
  dropSpread: 1.4,      // how far dropped eggs scatter
  returnAfter: 15,      // loose eggs go home rather than littering the map
  depositScore: 60,     // points for banking one
  stealScore: 15,       // a little for the theft itself, most for getting home
};

// ------------------------------------------------------ BOMB PLANT/DEFUSE
//
// The defuse race: everyone knows exactly where to be and exactly how long they
// have. Plant it in someone else's nest, then survive the countdown while they
// try to reach it.
export const BOMB = {
  pickupRadius: 1.5,
  plantRadius: 3.0,     // how close to a nest you must be to plant
  plantTime: 2.5,       // seconds of holding still to plant
  defuseTime: 3,        // seconds of holding still to defuse
  fuse: 12,             // countdown once planted
  blastRadius: 9,
  blastDamage: 85,
  plantScore: 150,
  defuseScore: 200,     // defusing is harder, and pays more
  detonateScore: 250,
  respawnDelay: 8,
  carrySlow: 0.12,      // the bomb is heavy
};
