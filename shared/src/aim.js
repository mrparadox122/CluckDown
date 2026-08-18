// Aim assist.
//
// Aiming with a thumb on a 375px-tall screen is genuinely hard, and that was the
// loudest piece of player feedback the game has ever had. This softly pulls your
// aim onto a nearby enemy and keeps it there while they stay in front of you.
//
// Two axes, in two functions: pullAim turns you toward them, pullPitch tilts you
// onto them. They are separate because acquisition is a horizontal decision —
// everyone is on the same floor — while the vertical is only ever a correction.
//
// WHERE THIS RUNS MATTERS. It is applied by the CLIENT to its own look angle,
// before that angle is sent, rather than by the server to the angle it received.
// In first person the camera renders your local yaw, so a server that quietly
// steered the aim somewhere else would leave the crosshair pointing at one thing
// and the bullet going to another. Shaping the input instead keeps the camera,
// the crosshair and the simulation in exact agreement — what you see under the
// reticle is what gets hit.
//
// It lives in shared/ anyway because it is game tuning, not rendering, and
// because that keeps it testable headlessly.

import { AIM_ASSIST, PLAYER } from './constants.js';
import { angleDelta } from './math.js';

/**
 * Chooses the enemy your aim should be pulled toward, or null.
 *
 * Two cones rather than one: a tight `cone` to ACQUIRE a target and a wider
 * `stickyCone` to KEEP one. That is what makes it feel like a lock instead of a
 * twitch — once you are on someone, thumb wobble doesn't shake you off, but
 * deliberately turning away does drop them.
 *
 * @param self   {x, z, team, id}
 * @param foes   iterable of {id, x, z, alive, team, invuln, mx, mz}
 * @param raw    the angle the player actually asked for
 * @param locked id of the current lock, for stickiness
 */
export function pickAimTarget(self, foes, raw, locked = null) {
  let best = null;
  let bestScore = Infinity;

  for (const t of foes) {
    if (!t || t.id === self.id || !t.alive || t.invuln) continue;
    if (t.team != null && self.team != null && t.team === self.team) continue;

    const d = Math.hypot(t.x - self.x, t.z - self.z);
    const sticky = t.id === locked;
    if (d > (sticky ? AIM_ASSIST.stickyRange : AIM_ASSIST.range)) continue;

    // Measured against the RAW angle, never the assisted one. Testing the
    // assisted angle would compare the lock against itself — the offset would
    // always be ~0 and you could never shake a target off by turning away.
    const off = Math.abs(angleDelta(raw, Math.atan2(t.x - self.x, t.z - self.z)));
    if (off > (sticky ? AIM_ASSIST.stickyCone : AIM_ASSIST.cone)) continue;

    // Closest to the centre of your aim wins, then closest by distance. A
    // current lock gets a discount so it holds through a contested moment.
    const score = off * (sticky ? 0.5 : 1) + d * 0.01;
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/**
 * Eases `aim` toward a target, leading them so the shot meets them rather than
 * trailing behind. Frame-rate independent: `strength` feels the same at 30fps
 * as at 144.
 *
 * @returns the new aim angle.
 */
export function pullAim(self, target, aim, dt, strength = AIM_ASSIST.strength) {
  // Straight at them, with no lead. Shots are hitscan — they resolve against
  // where the target IS, so aiming ahead of a moving chicken now aims at empty
  // floor. The lead this used to apply was correct for a projectile and is
  // exactly wrong for a trace.
  const want = Math.atan2(target.x - self.x, target.z - self.z);

  const k = 1 - Math.exp(-strength * 12 * dt);
  return aim + angleDelta(aim, want) * k;
}

/**
 * The vertical half of the same pull.
 *
 * Assist was horizontal-only for as long as shots were: pitch did not reach the
 * simulation, so there was nothing vertical to help with. Now that a shot goes
 * exactly where the camera points, an unassisted vertical axis would be the new
 * version of the old problem — a thumb that lands the yaw and misses high.
 *
 * Deliberately simpler than pullAim: no lead, because chickens only move
 * vertically by jumping and leading a jump would drag your shot to where they
 * are about to *not* be. It aims at the body and lets the capsule be generous.
 *
 * Pitch is not an angle on a circle — it is clamped to a range and can never
 * wrap — so this eases linearly rather than through angleDelta.
 *
 * @returns the new pitch angle.
 */
export function pullPitch(self, target, pitch, dt, strength = AIM_ASSIST.strength) {
  const d = Math.hypot(target.x - self.x, target.z - self.z);
  const eye = (self.y ?? 0) + PLAYER.eyeHeight;
  const aimAt = (target.y ?? 0) + PLAYER.hitHeight * AIM_ASSIST.aimHeight;
  const want = Math.atan2(aimAt - eye, Math.max(0.001, d));

  const k = 1 - Math.exp(-strength * 12 * dt);
  return pitch + (want - pitch) * k;
}
