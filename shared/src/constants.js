// Single source of truth for game tuning. Imported by both the client renderer
// and the authoritative server, so a number changed here changes both.

export const TICK_HZ = 60; // authoritative simulation rate
export const TICK_DT = 1 / TICK_HZ;

// State is broadcast on its own, slower timer. Simulating often makes the game
// responsive; broadcasting often mostly makes clients decode more, and
// interpolation already covers the gaps — so the two rates are deliberately
// decoupled rather than tied together.
//
// 30, not 40, and the reason is that it DIVIDES the tick rate. At 40 against a
// 60Hz sim the two never line up: a patch lands after one tick, then after two,
// then one, so remote chickens arrive at the interpolator on an uneven beat and
// wobble slightly no matter how good the smoothing is. 30 is exactly every
// second tick, forever. (Windows timer granularity was already delivering ~30
// in practice, so this is also the rate the game was actually tested at.)
export const PATCH_HZ = 30;
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

  /**
   * Seconds between shots. 0.10 is 600 rounds a minute.
   *
   * TIME TO KILL, and this number is one half of it — BULLET.damage is the
   * other. They are one decision, not two, and the thing to hold in your head
   * while moving either is the pair (shots to kill - 1) x cooldown:
   *
   *   before  19 damage, 6 shots, 0.18s  ->  900ms to kill a body
   *           52 head,   2 shots         ->  180ms, a five-to-one gap
   *   now     22 damage, 5 shots, 0.10s  ->  400ms to kill a body
   *           40 head,   3 shots         ->  200ms, a two-to-one gap
   *
   * 900ms was the real complaint behind "it isn't as addictive as CoD Mobile".
   * A body fight lasted the better part of a second, in which the loser had
   * time to walk out of it, while a headshot deleted someone in a fifth of
   * that. There was no middle: you either erased a player or plinked at one,
   * and neither is a duel. CoD Mobile lands its ARs at 250-400ms and Valorant's
   * Vandal at ~340ms for a reason — that is roughly human reaction time, so
   * both players get exactly one decision each and the better aim wins it.
   *
   * Headshots still pay, and now they pay in a currency you can feel: one head
   * is worth about 1.8 bodies, and two heads and a body is a kill. Five-to-one
   * was not a skill reward, it was a coin flip about where the crosshair
   * happened to be.
   */
  fireCooldown: 0.10,
  /**
   * Floor on the fire cooldown, whatever perks and modifiers multiply it by.
   *
   * Kept from the old rapid-fire pickup, now doing a more important job: Rapid
   * Peck and Feeding Frenzy and TRIGGER HAPPY all multiply the same number, and
   * three multipliers stacked without a floor is a fire rate that empties a
   * crop before anyone can react to it.
   *
   * It moved with `fireCooldown`, and it had to. This is a RATIO to the base
   * rate wearing an absolute number: at 0.07 against the old 0.18 it allowed a
   * 2.6x ceiling, and leaving it there while the base dropped to 0.10 would
   * have quietly capped everything at 1.4x — squashing TRIGGER HAPPY, Rapid
   * Peck and Feeding Frenzy all at once, without any of them changing. 0.04
   * against 0.10 is the same 2.6x the game was tuned around.
   */
  minCooldown: 0.04,
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

  strength: 0.6,      // 0..1 share of the angle closed per second-ish (see sim)
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
   * The number that matters is kills per magazine, not rounds: at 5 shots to a
   * body kill, 16 is three kills and a miss. It was 14 against a 6-shot kill,
   * which is the same 2.3 kills — so this is not a buff, it is the same
   * magazine expressed against a faster gun.
   *
   * It had to move at all because the fire rate did. 14 rounds at 0.10s is 1.4
   * seconds of held trigger, and a fight in a four-a-side match does not
   * resolve in 1.4 seconds; running dry mid-duel every single time is not the
   * "commit, run out, recover" beat this resource is here for, it is just a
   * gun that stops working. 16 buys 1.6s of fire against a 1.8s peck.
   *
   * THE TRADE-OFF WORTH FLAGGING: that is a ~50% duty cycle. Pecking is a
   * 1.8-second stand-still, and standing still is now also what accuracy costs
   * (see SPREAD) — so a dry player is paying twice for the same second. This
   * is the tension noted in the roadmap around a faster reload with pecking
   * kept as the ran-dry penalty; it is not changed here, only measured.
   */
  capacity: 16,

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
    /** One shared rally pad per team has to fit four chickens on it. */
    teamRadius: 3.4,
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

  /**
   * Damage per body shot. Five of them kill, in 400ms — see PLAYER.fireCooldown
   * for the whole time-to-kill argument, because the two numbers only mean
   * anything together.
   *
   * Kept as a number of SHOTS rather than a fraction of health on purpose:
   * `Math.ceil(maxHp / damage)` is the number a player actually learns, and it
   * moves in steps. 22 and 25 look like a small change and are not — 25 kills
   * in four rounds, 22 in five.
   */
  damage: 22,

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
   * 40 against 100 health means three clean headshots kill, versus five body
   * shots: 200ms against 400ms. A headshot is worth about 1.8 body shots, and
   * two heads plus a body is a kill.
   *
   * It used to be 52 against 19 — two shots against six, 180ms against 900ms.
   * That five-to-one gap was argued for as skill expression and was not one. A
   * payoff that large stops being a decision and becomes a coin flip about
   * where the crosshair happened to be when the trigger came down: whoever got
   * a head first won regardless of everything else in the fight, and everybody
   * else spent a full second plinking. Two-to-one is the size at which going
   * for the head is a choice you make and can be punished for.
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
  headDamage: 40,
  headFrom: 1.28,

  /**
   * How fast the TRACER is drawn, in units per second, and nothing else.
   *
   * The shot itself has already been resolved by the time this is used. This is
   * purely how quickly the streak crosses the gap to a decision that has
   * already been made — fast enough to read as instant, slow enough to be a
   * visible line rather than a single frame nobody sees.
   */
  tracerSpeed: 450,

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

// ------------------------------------------------------------------ RECOIL
//
// THE BUG THIS BLOCK REPLACES. There used to be a recoil kick that was applied
// to the CAMERA and to nothing else: the view climbed while the shot kept
// leaving along the un-kicked angle. The crosshair is nailed to screen centre,
// so it rode the climbing camera and the bullets did not — up to 0.12 radians
// of it, which is 1.4 units at duelling range. A whole chicken. Every player
// who sprayed was watching their reticle sit above where their rounds landed
// and had no way to name what was wrong, because everything on screen agreed
// with everything else on screen.
//
// So recoil is REAL now. The kick goes into the look angle itself, which is the
// one number the camera renders and the one number the shot is fired along —
// they cannot drift apart because there is nothing to drift. What used to be a
// lie about where you were aiming is now a true statement that your aim moved.
//
// DETERMINISTIC, never random. Every shot climbs by exactly `kick`, so a spray
// is a pattern you can learn and pull against rather than a dice roll you can
// only hope through. That is the difference between recoil a player masters and
// recoil a player resents, and it is why CS's spray patterns are fixed.
export const RECOIL = {
  /**
   * Radians the view climbs per shot. 0.014 is 0.8 of a degree.
   *
   * Sized against the kill, not against the magazine: five shots is a body
   * kill, so a won duel costs about 3.2 degrees of climb — enough that the
   * fifth round lands high on a chicken you are not compensating for, and
   * nowhere near enough to lose the target. Hold the trigger past that and the
   * climb is the whole point.
   */
  kick: 0.014,

  /**
   * Ceiling on accumulated climb, in radians (~11.5 degrees).
   *
   * A full 16-round magazine would otherwise climb 0.224, which walks the
   * crosshair off the top of a target from any range and turns the last third
   * of every magazine into wasted grain. Capping it keeps a long spray bad
   * without making it pointless.
   */
  max: 0.20,

  /**
   * Seconds after the last shot before the view starts settling back.
   *
   * Slightly longer than one shot interval (0.10), which is what makes the
   * whole system readable: inside a burst nothing recovers, so the climb
   * accumulates and the pattern is stable and learnable. Stop firing and it
   * comes back. A delay shorter than the fire rate would have recovery fighting
   * accumulation on every single round, and the resulting climb would depend on
   * frame timing — the exact opposite of deterministic.
   */
  delay: 0.12,

  /**
   * Radians per second the view settles back down, once `delay` has passed.
   *
   * 0.6 returns one shot's kick in 25ms — so a tap-firer at any human cadence
   * is back to pixel-exact before the next round leaves — and a maxed-out spray
   * in about a third of a second, which reads as the gun settling rather than
   * as the camera snapping.
   */
  recover: 0.6,
};

// ------------------------------------------------------------------ SPREAD
//
// Movement inaccuracy: the skill ceiling this game did not have.
//
// There was no spread of any kind. Every round landed exactly on the crosshair,
// forever, including at full sprint and including mid-jump — which means there
// was no such thing as a good position, a good moment, or a wrong one. Aiming
// well and aiming while running paid identically, so shooting had no mastery
// curve at all, and "stop moving to shoot" is the single defining skill of CS,
// Valorant and CoD Mobile alike.
//
// The cone is driven by MOVEMENT and nothing else. Firing does not widen it —
// that job belongs to RECOIL, which is deterministic and visible. Keeping the
// two separate is what lets a stationary player spray a learnable pattern
// instead of a random one, and it is why the invariant "a standing shot goes
// exactly where the camera points" survives sustained fire.
//
// It is drawn from the world's seeded RNG on the authoritative side, so a
// client cannot decline to be inaccurate.
export const SPREAD = {
  /**
   * Standing still: EXACTLY zero. Not a small number.
   *
   * First-shot accuracy is the contract the whole system rests on — if a
   * stopped player's round can miss a target their crosshair covers, every
   * other rule here reads as the game cheating rather than as a cost they
   * chose. Zero also makes it testable: camera direction and fired direction
   * are the same vector to the last bit, at rest and under fire.
   */
  still: 0,

  /**
   * Cone half-angle at full running speed, in radians (~5.2 degrees).
   *
   * Scaled by how hard you are actually moving, so a nudge costs a little and a
   * sprint costs all of it. At 12 units that is about a unit either side of the
   * crosshair against a chicken 1.2 wide: moving-and-shooting still wins a
   * point-blank scramble and reliably loses a mid-range duel, which is the
   * shape every game the player named uses.
   */
  moving: 0.09,

  /**
   * Mid-air, in radians (~9.2 degrees). Flat, not scaled.
   *
   * Jumping is the one state you cannot steer out of and the hardest to be hit
   * in, so jump-shooting has to be the worst trade in the game rather than a
   * free dodge with a gun attached. At 12 units this is nearly two units off
   * centre — a coin flip against a stationary target and a loss against a
   * moving one.
   */
  air: 0.16,

  /**
   * Seconds from a full-speed cone back to pinpoint, after stopping.
   *
   * This number IS counter-strafing. Long enough that you have to genuinely
   * commit to the stop, short enough that the commit is a quarter of a second
   * rather than a decision to leave the fight. Below about 0.15 it stops being
   * a skill and above about 0.5 nobody ever stops at all.
   *
   * The decay is linear at `moving / settle` radians a second, so the airborne
   * cone — which is wider — takes proportionally longer to settle on landing.
   * Landing costing more than stopping is correct.
   */
  settle: 0.25,
};

export const BOMBER = {
  radius: 1.7,
  // Taller than a player because it is drawn at 1.25 scale. Bullets travel in
  // three dimensions now, so this is what stops a shot arcing over the bomber
  // from counting as a hit on it.
  hitHeight: 2.25,
  maxHp: 45,
  speed: 5.0, // slower than a player: you can always kite it
  detectRadius: 20,
  armRadius: 3.2,
  armSpeedMul: 0.62, // it slows once armed, giving you a window to run
  fuse: 1,
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
   * The rungs: the PUBLIC half of the ladder.
   *
   * A name and a colour, and nothing else. Every chicken's rung rides above its
   * health bar, which is what turns a number into a social object — it marks
   * the threat in the room and makes taking one down worth bragging about.
   * That job is unchanged and this table still does it.
   *
   * WHAT A RUNG GIVES YOU NOW COMES FROM YOUR ROLE. Everyone used to unlock the
   * same five perks — Quick Crop, Long Legs, Rapid Peck, Second Wind, Feeding
   * Frenzy — which meant a Medic and a Sniper climbed the identical ladder and
   * the pick stopped mattering the moment the match started. The tiers in
   * shared/src/roles.js replace them, one list per role, and all five classics
   * survive in there on whichever ladder they fit.
   *
   * The rules that made this ladder work are untouched: the XP curve, the
   * climb/fall asymmetry, and all three death-spiral guards.
   */
  rungs: [
    { level: 1, name: 'Chick', color: '#9aa6c4' },
    { level: 2, name: 'Scratcher', color: '#5ee08a' },
    { level: 3, name: 'Runner', color: '#5fd1ff' },
    { level: 4, name: 'Brawler', color: '#ffcc3d' },
    { level: 5, name: 'Ironfeather', color: '#ff8a3d' },
    { level: 6, name: 'Cock of the Walk', color: '#ff4df0' },
  ],
};

// ------------------------------------------------------------ ROLE ROTATION
//
// Six roles, four slots, unique per team — which is the rule that makes a pick
// a composition, and also the rule that hands the last player to arrive the
// leftovers. Left alone it settles: the same three people take Sniper, Medic
// and Bruiser every match, everyone else plays whatever is left, and a picker
// with one real option is not a picker.
//
// So a role is a LEASE, not a title. Every round you are moved to a different
// free one unless you say otherwise, which flips the default from "whatever I
// grabbed first" to "something else" — nobody hoards, nobody is stuck, and the
// composition changes shape inside a single match.
//
// A ROUND HERE IS A LIFE. Cluckdown has no round timer; the recurring boundary
// is the respawn, and that is also where the picker already lives and where a
// role swap is already safe to apply (see applyRole).
//
// THE PICKER STAYS NOT-A-TOLL-GATE, and that took one design rule: the roll
// happens at DEATH, not at respawn, so the next role is decided and shown while
// the player is looking at the screen anyway. Doing nothing rotates you and
// costs no time; one tap keeps what you had and also costs no time. Rolling it
// at respawn would have been the same feature with the player finding out
// afterwards, which is the version that feels like the game taking the wheel.
export const ROTATION = {
  enabled: true,

  /**
   * Lives between rotations. 1 is every round, which is the point.
   *
   * Higher numbers are the knob to turn if variety ever starts costing more
   * than it buys — the counter is per player, so it is a cadence rather than
   * a schedule everybody shares.
   */
  everyLives: 1,

  /**
   * Never roll the role they are already playing.
   *
   * A "rotation" that lands you back where you were is a rotation that did not
   * happen, and it reads as the feature being broken rather than as luck.
   */
  avoidCurrent: true,

  /**
   * ...and never the one before that either, while there is anything else.
   *
   * Two roles ping-ponging is the failure mode a pure random walk actually
   * produces at six roles and four slots — Runner, Scout, Runner, Scout — and
   * it is indistinguishable from no rotation to the player living it.
   */
  avoidPrevious: true,
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
    blurb: '4v4. No rank, just vibes.',
    maxPlayers: 8,
    minPlayers: 2,
    arena: 54,
    teams: true,
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
    arena: 54,
    // 2v2 keeps its old density while the maps grow for 4v4.
    arenaScale: 0.89,
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
    blurb: 'Hold the middle. Your roost holds it together.',
    maxPlayers: 8,
    minPlayers: 2,
    arena: 54,
    teams: true,
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
    blurb: 'One life each. Last roost standing.',
    maxPlayers: 8,
    minPlayers: 2,
    arena: 54,
    teams: true,
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
    blurb: 'One nest each. Raid theirs, defend yours.',
    maxPlayers: 8,
    minPlayers: 2,
    arena: 54,
    teams: true,
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
    blurb: 'Carry the bomb to their nest. Then survive the clock.',
    maxPlayers: 8,
    minPlayers: 2,
    arena: 54,
    teams: true,
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
    blurb: '4v4. Your rating is on the line.',
    maxPlayers: 8,
    minPlayers: 2,
    arena: 54,
    teams: true,
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
    blurb: 'Endless respawns. First roost to 40 kills.',
    maxPlayers: 8,
    minPlayers: 2,
    arena: 54,
    matchTime: 300,
    killLimit: 0,
    teamKillLimit: 40,
    teams: true,
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
    arenaScale: 0.60, // a duel on The Big Yard would be two chickens jogging
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

// Team play. A snake over every group of four seats — 0,3,4,7 west and
// 1,2,5,6 east — so 8 seats split 4/4 and the old 2v2 mapping is unchanged.
export const TEAM_COLORS = ['#4da3ff', '#ff5d5d'];
export const TEAM_NAMES = ['Blue Roost', 'Red Roost'];
export const teamForSeat = (seat) => {
  const s = ((seat % 4) + 4) % 4;
  return (s === 1 || s === 2) ? 1 : 0;
};

/** Which of the four slots inside a team this seat holds. */
export const teamSlot = (seat) => {
  const s = ((seat % 4) + 4) % 4;
  return Math.floor(seat / 4) * 2 + ((s === 0 || s === 1) ? 0 : 1);
};

// Eight bodies need two answers at a glance: whose side, and who exactly.
// The silhouette stays team-coloured; the shade is the per-player accent the
// nameplate, the scoreboard dot and the ping marker use.
export const TEAM_SHADES = [
  ['#a9d8ff', '#4da3ff', '#2f7ede', '#1257a0'],
  ['#ffb3b3', '#ff5d5d', '#e03a3a', '#a82020'],
];

export const teamShade = (seat, team) => (
  team === null || team === undefined
    ? SEAT_COLORS[seat % SEAT_COLORS.length]
    : TEAM_SHADES[team][teamSlot(seat) % 4]
);

/**
 * The order seats are handed to arriving humans.
 *
 * Seat index decides your team, so "first free seat" decides who you play with,
 * and the answer is different for the two kinds of room:
 *
 *   * a PUBLIC queue wants humans spread evenly, so nobody ends up as the only
 *     real player on a side of bots. Strictly alternating does that at every
 *     prefix, which plain seat order does not (0,1,2,3 is 0,1,1,0).
 *   * a PRIVATE room is friends who typed the same code. Splitting them is the
 *     opposite of what they came for, so those seats go team-major: the first
 *     four arrivals are one roost, the next four are the other.
 *
 * Both are permutations, so every seat is still reachable either way.
 */
export function seatOrder(maxPlayers, together = false) {
  const all = Array.from({ length: maxPlayers }, (_, i) => i);
  if (maxPlayers <= 2) return all;
  const blue = all.filter((seat) => teamForSeat(seat) === 0);
  const red = all.filter((seat) => teamForSeat(seat) === 1);
  if (together) return [...blue, ...red];
  const out = [];
  for (let i = 0; i < Math.max(blue.length, red.length); i++) {
    if (blue[i] !== undefined) out.push(blue[i]);
    if (red[i] !== undefined) out.push(red[i]);
  }
  return out;
}

// ------------------------------------------------------- SPAWNS AND RALLIES
//
// 4v4 needs a front line rather than a scramble, so a team lines up along its
// own wall and both sides know which way forward is. The rally pad sits in the
// middle of that line: one shared feeder per team, which is also the nest in
// Egg Heist and Plant & Defuse.
export const SPAWN = {
  inset: 3.5,       // from the wall
  laneSpread: 0.5,  // how far the four lanes reach, as a share of the half-extent
};

/** Spawn spots indexed by SEAT. Corners in free-for-all, lines in team play. */
export function spawnLayout(half, teams) {
  const d = half - SPAWN.inset;
  if (!teams) return [{ x: -d, z: -d }, { x: d, z: d }, { x: d, z: -d }, { x: -d, z: d }];
  const reach = half * SPAWN.laneSpread;
  const lanes = [-1, -1 / 3, 1 / 3, 1].map((k) => k * reach);
  const out = [];
  for (let seat = 0; seat < 8; seat++) {
    out.push({ x: teamForSeat(seat) === 0 ? -d : d, z: lanes[teamSlot(seat)] });
  }
  return out;
}

/** Feeder pads. Indexed by TEAM in team play, by seat corner otherwise. */
export function feederPoints(half, teams) {
  const d = half - SPAWN.inset;
  if (!teams) return [{ x: -d, z: -d }, { x: d, z: d }, { x: d, z: -d }, { x: -d, z: d }];
  return [{ x: -d, z: 0 }, { x: d, z: 0 }];
}

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
  '#7ae582', // mint
  '#ff9f6e', // coral
  '#ff8ad1', // rose
  '#b8c1ff', // periwinkle
];

export const QUICK_CHAT = ['GG!', 'Help!', 'Nice shot!', 'Oops.', 'Bomber!', 'Follow me'];

// ------------------------------------------------------------------- PINGS
//
// Team comms for a mobile shooter is a ping, not a voice channel: one tap,
// language-independent, and it carries a position — which is the only thing
// worth saying in a firefight anyway.
//
// Five intents, and the smallness is the design. A wheel you have to read is a
// wheel nobody uses under fire, so this is the set that fits one thumb sweep
// and covers what a player actually needs to say.
export const PINGS = [
  { id: 'enemy',  label: 'Enemy here', icon: '⚠', color: '#ff5d5d' },
  { id: 'watch',  label: 'Watch out',  icon: '◉', color: '#ffcc3d' },
  { id: 'help',   label: 'Need help',  icon: '➕', color: '#7ae582' },
  { id: 'coming', label: 'On my way',  icon: '➤', color: '#4da3ff' },
  { id: 'attack', label: 'Attacking',  icon: '⚔', color: '#ff8a3d' },
];

export const PING_LIST = PINGS.map((p) => p.id);
export const pingDef = (id) => PINGS.find((p) => p.id === id) ?? PINGS[0];

/**
 * Which wedge a drag points at.
 *
 * Direction, not position: any drag past the deadzone counts, so the gesture is
 * "flick towards the one I want" rather than "land on a small target" — which
 * is the difference between a wheel that works with a thumb under fire and one
 * that does not. Inside the deadzone it stays on the first intent, so a plain
 * tap is the fastest thing on the wheel.
 *
 * Lives here rather than in the HUD so it can be tested without a browser.
 */
export function pingWedge(dx, dy, deadzone = 26) {
  if (Math.hypot(dx, dy) < deadzone) return 0;
  const step = (Math.PI * 2) / PINGS.length;
  // The wheel starts at straight up, so shift before rounding to a wedge.
  const i = Math.round((Math.atan2(dy, dx) + Math.PI / 2) / step);
  return ((i % PINGS.length) + PINGS.length) % PINGS.length;
}

/** Where a wedge sits on the wheel, in radians, with 0 at the top. */
export const pingAngle = (i) => -Math.PI / 2 + (i / PINGS.length) * Math.PI * 2;

export const PING = {
  /** Seconds a marker stays up. Long enough to act on, short enough to expire. */
  life: 6,
  /**
   * Per player, and both halves matter.
   *
   * The cooldown stops a ping becoming a spam button; the cap stops a player
   * blanketing the map with markers their team then has to read past.
   */
  cooldown: 1.1,
  maxPerPlayer: 2,
  /** Beyond this a marker is noise, not information. */
  maxRange: 90,
};

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

// Sizes grew ~12% for 4v4 and no more. Doubling the roster already halves the
// space per player, which is the density this game wanted; scaling the map by
// the player ratio would hand it straight back. See README for the numbers.
export const MAPS = {
  coop: {
    id: 'coop',
    label: 'The Coop',
    blurb: 'The original yard. Balanced, with cover to fight around.',
    size: 54,
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
    size: 38,
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
    size: 72,
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
    size: 54,
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
    size: 62,
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
  eggsPerNest: 8,
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
