// Where the bullet actually goes, versus where you are pointing.
//
// Two models live here, and they are deliberately different in kind:
//
//   RECOIL is deterministic and moves your AIM. The kick goes into the look
//   angle itself, so the camera, the crosshair and the shot are one line and
//   cannot disagree. A spray is a pattern you learn and pull against.
//
//   SPREAD is random and does NOT move your aim. It is a cone the round is
//   drawn from, sized entirely by how you are moving, and the crosshair draws
//   the cone at its true size — an inaccuracy the player cannot see is an
//   unfair one.
//
// Both are here rather than in the renderer for the same reason aim.js is:
// they are game tuning, not drawing. The simulation applies the spread (a
// client cannot be trusted to make its own shots worse), the client applies
// the recoil (the camera renders the local look angle, so a server steering it
// would put the crosshair somewhere the bullet is not), and both sides size the
// cone with the same function so the reticle never lies about it.
//
// Dependency-free, like everything else in shared/.

import { RECOIL, SPREAD } from './constants.js';
import { clamp } from './math.js';

// ------------------------------------------------------------------ recoil

/**
 * The accumulated climb, and the clock that decides when it comes back down.
 *
 * `bank` is what has been added to the look angle and not yet taken back out.
 * It is tracked separately from the angle itself because the player is allowed
 * to spend it: pulling down during a spray absorbs the bank, so the view does
 * not then recover a second time and end up below where they were aiming. That
 * double-dip is what makes recoil in a badly built shooter feel like the
 * controls are arguing with you.
 */
export function createRecoil() {
  return { bank: 0, sinceShot: Infinity };
}

/**
 * One shot's worth of climb. Returns the radians to ADD to the look pitch.
 *
 * Applied after the shot rather than before it, which is what keeps the first
 * round of every burst pixel-exact: you fire where you were aiming, and then
 * the gun moves.
 *
 * @param room how much further the look angle can actually climb before it hits
 *             PLAYER.pitchMax. Only what is applied gets banked — bank a kick
 *             the clamp swallowed and the recovery would later hand back climb
 *             that never happened, dragging the aim below where the player put
 *             it for as long as they kept firing at the sky.
 */
export function recoilKick(r, room = Infinity) {
  const kick = Math.max(0, Math.min(RECOIL.kick, RECOIL.max - r.bank, room));
  r.bank += kick;
  r.sinceShot = 0;
  return kick;
}

/**
 * Settling, after `RECOIL.delay` of not firing. Returns radians to SUBTRACT.
 *
 * Never returns more than the bank, so recovery can only ever undo climb it
 * put there — it can never drag your aim below where you pointed it.
 */
export function recoilRecover(r, dt) {
  r.sinceShot += dt;
  if (r.sinceShot < RECOIL.delay || r.bank <= 0) return 0;
  const back = Math.min(r.bank, RECOIL.recover * dt);
  r.bank -= back;
  return back;
}

/**
 * The player pulled the view down themselves: spend that against the bank.
 *
 * @param dPitch the change in look pitch this frame, in radians. Only downward
 *               movement (negative) counts — pulling UP is aiming, not
 *               compensating, and must not bank extra recovery.
 *
 * Without this, a player who correctly pulls down through a spray gets the
 * automatic recovery on top of their own correction the moment they stop, and
 * the view sinks below the target. Compensating for recoil would be punished,
 * which is precisely backwards.
 */
export function recoilAbsorb(r, dPitch) {
  if (dPitch >= 0 || r.bank <= 0) return;
  r.bank = Math.max(0, r.bank + dPitch);
}

// ------------------------------------------------------------------ spread

/**
 * The cone a round is drawn from, in radians, for a given movement state.
 *
 * Rises INSTANTLY and settles gradually. That asymmetry is the whole mechanic:
 * stepping out of cover costs you accuracy the moment you step, and getting it
 * back is a commitment measured in `SPREAD.settle`. Symmetrical timing would
 * make a shuffle as accurate as a stop.
 *
 * @param current  the cone last tick, in radians
 * @param moving   0..1, how hard the movement stick is being pushed
 * @param airborne mid-jump, which is flatly the worst state to shoot from
 */
export function nextSpread(current, moving, airborne, dt) {
  const want = airborne ? SPREAD.air : SPREAD.moving * clamp(moving, 0, 1);
  if (want >= current) return want;
  // Linear, at the rate that takes a full-speed cone back to zero in `settle`.
  // The airborne cone is wider, so it takes proportionally longer on landing.
  const rate = SPREAD.moving / Math.max(1e-6, SPREAD.settle);
  return Math.max(want, current - rate * dt);
}

/**
 * Deviates a unit direction by a random angle inside a cone.
 *
 * Uniform over the DISC rather than over the angle — `sqrt(rng())` is what
 * stops the middle of the cone being over-weighted, which would quietly make
 * moving fire more accurate than the cone it advertises.
 *
 * Rotated in the plane perpendicular to the shot, using the same spherical
 * basis fire() and the camera use, so the deviation is symmetrical in every
 * direction and does not blow up looking straight up or straight down.
 *
 * @returns {{dx, dy, dz}} a new unit vector; the input is untouched
 */
export function coneDeviate(yaw, pitch, cone, rng) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);

  const dx = sy * cp;
  const dy = sp;
  const dz = cy * cp;
  if (!(cone > 0)) return { dx, dy, dz };

  // Flat right, and the up that completes the frame. Both are unit and both are
  // perpendicular to the shot for every pitch in range.
  const rx = cy;
  const rz = -sy;
  const ux = -sy * sp;
  const uy = cp;
  const uz = -cy * sp;

  const a = rng() * Math.PI * 2;
  const r = cone * Math.sqrt(rng());
  const ox = Math.cos(a) * rx + Math.sin(a) * ux;
  const oy = Math.sin(a) * uy;
  const oz = Math.cos(a) * rz + Math.sin(a) * uz;

  // An exact rotation by r toward the offset axis, so the result is a unit
  // vector and the deviation is exactly `r` radians rather than approximately.
  const c = Math.cos(r);
  const s = Math.sin(r);
  return {
    dx: dx * c + ox * s,
    dy: dy * c + oy * s,
    dz: dz * c + oz * s,
  };
}

/**
 * The cone's radius on screen, in CSS pixels — what the crosshair draws.
 *
 * A vertical field of view maps an angle to a fraction of the half-height by
 * the ratio of their tangents. This is the honest conversion rather than a
 * flat scale factor, which matters at the airborne cone where the small-angle
 * approximation has visibly drifted.
 */
export function spreadPixels(cone, fov, viewportHeight) {
  if (!(cone > 0) || !(fov > 0) || !(viewportHeight > 0)) return 0;
  return (Math.tan(cone) / Math.tan(fov / 2)) * (viewportHeight / 2);
}
