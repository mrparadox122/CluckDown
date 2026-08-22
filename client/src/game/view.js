// Where the camera sits, and where a shot has to go for the crosshair to be
// telling the truth.
//
// Cluckdown has two views. First person puts the camera at the chicken's eye,
// so "along the camera" and "from the gun" are the same line and there is
// nothing to reconcile. Third person moves the camera onto a boom behind and to
// the side, and that breaks the identity: the shot still leaves the chicken,
// but the crosshair is now the middle of a camera standing somewhere else.
//
// This module owns both halves of that problem so they cannot disagree. The
// camera placement in scene.js and the aim convergence in controls.js call the
// same functions with the same numbers — which is the only way "the bullet goes
// where the crosshair is" survives contact with tuning.
//
// No Babylon in here on purpose: it is geometry, and geometry is testable.

import { PLAYER, BULLET, WALL_HEIGHT, clamp, segBoxEntry } from '@cluckdown/shared';

export const VIEWS = ['fps', 'tpp'];

/**
 * The first-person beak: a viewmodel, and the fix for "shots come out of the
 * middle of the crosshair".
 *
 * They did, and they were right to feel wrong. In first person the camera sits
 * at the chicken's eye, so the tracer spawned at the exact centre of the screen
 * and appeared to leave the player's own eyeballs. Every shooter solves this
 * the same way — a weapon model held off to one side, with rounds leaving its
 * muzzle rather than the camera — and the absence of one is also why a
 * first-person view without a viewmodel feels disembodied: there is nothing on
 * screen that belongs to your body.
 *
 * Chickens do not hold guns. They have beaks. So the viewmodel is your own
 * beak, low and slightly to the right, and grain leaves the end of it.
 *
 * Offsets are in CAMERA space: +x right, +y up, +z forward.
 */
export const BEAK = {
  /**
   * Apparent size is what matters, and it is set by the ratio of these numbers
   * rather than by any of them alone: at `forward` units from a 1.15rad camera
   * the visible frame is about 1.27 × forward units tall, so a beak 0.11 tall
   * at 0.72 out fills roughly a tenth of the screen.
   *
   * The first pass sat at 0.40 with the same dimensions and covered a quarter
   * of the frame — an enormous orange slab wedged in the corner. A viewmodel
   * has to be present enough to ground you and small enough to forget, and the
   * only way to judge that is to look at it.
   *
   * Low and to the RIGHT, rather than dead centre where a real beak would be.
   * Two reasons, and neither is anatomy: centred it sits directly under the
   * crosshair, and centred-bottom is where the health and grain meters live.
   * A viewmodel that overlaps the HUD makes both harder to read.
   */
  right: 0.195,
  down: 0.215,
  forward: 0.82,

  /** Nose-down tilt, so you see the top of it and it points away from you. */
  tilt: 0.16,

  /**
   * How far past the beak the tracer actually starts, in units.
   *
   * Anything drawn AT the beak is 0.8 units from the camera, and screen size
   * goes as the inverse of that: the tracer is 0.24 across, which at 0.8 units
   * covers about a quarter of the frame height — and it is on the glow layer,
   * so it blooms. Starting it a stride further out drops that to under a tenth
   * while still reading as coming from the beak, because at 30 units a second
   * the round covers this gap in about one frame.
   */
  tracerGap: 1.3,

  /**
   * Diameter of the beak's own muzzle flash, in units.
   *
   * The world muzzle flash is a 0.9-unit sphere — correct at five metres,
   * a full-screen white blowout at arm's length. This one is sized for the
   * distance it is actually seen from, and stays off the glow layer: the bloom
   * radius is set for world-space effects and does not scale down with the
   * thing it is blooming.
   */
  flash: 0.05,

  /**
   * Where the tracer is aimed, in units.
   *
   * Same parallax problem as the third-person boom, one order of magnitude
   * smaller: the beak is a hand's width from the camera, not four metres, so a
   * single convergence distance is plenty. The tracer leaves the beak and meets
   * the real shot far enough out that the two are one line by the time anything
   * is close enough to hit.
   */
  converge: 26,
};

/** Normalises anything into a view the renderer actually has. */
export function asView(v) {
  return VIEWS.includes(v) ? v : 'fps';
}

/**
 * Third-person framing.
 *
 * `side` and `rise` are the whole reason this view is usable: they push the
 * camera right and up, which puts your chicken down and to the LEFT of screen
 * centre. Dead centre would park a whole bird on top of the crosshair — you
 * would be aiming through your own tail.
 *
 * What matters on screen is each offset as a FRACTION of `dist`, not its raw
 * value: the boom is a triangle, so pushing the camera back moves your chicken
 * toward the middle of the frame at the same time as it shrinks it. Lengthening
 * the boom without growing the offsets quietly undoes the whole point. The two
 * ratios below are the numbers to think in.
 *
 *   side / dist ≈ 0.26  ->  the head sits ~23% of a half-width left of centre
 *   rise / dist ≈ 0.15  ->  ...and ~24% of a half-height below it
 *
 * The first pass had the camera at 4.2 with a 0.75 shoulder, which put the
 * chicken 15% off centre and filling nearly 40% of the screen height — close
 * enough to crowd the reticle it is supposed to be clear of, and big enough to
 * read as a chase cam rather than a view of the arena.
 */
export const TPP = {
  dist: 6.2,          // boom length, in units behind the shoulder
  side: 1.6,          // camera right -> chicken appears left of centre
  rise: 0.9,          // camera up    -> chicken appears below centre
  pivot: PLAYER.eyeHeight, // the boom hangs off the head, not the feet

  /**
   * How far down the crosshair ray to aim when there is nothing to aim AT, in
   * units.
   *
   * A fixed convergence can only ever be exactly honest at one distance,
   * because the camera and the gun are not in the same place — that is
   * parallax. It is why `convergeDistance` below goes looking for a real thing
   * under the crosshair instead, and why this number matters less than it
   * looks: inside the arena the ray always meets a chicken, a wall or the
   * floor, so the only shots that reach this fallback are the ones already
   * leaving the building over the parapet. `test:view` proves that rather than
   * assuming it.
   *
   * (With the offsets above, no single fixed distance could keep a shot inside
   * a chicken's width across the bullet's whole 39-unit range. That is not a
   * tuning failure, it is what parallax is — and it is the reason the fallback
   * had to stop being the main path.)
   */
  converge: 20,

  /**
   * Never converge nearer than this, in units.
   *
   * Something a metre from your face is a near-vertical firing angle, and the
   * shot would visibly leave the gun sideways for no gain — at that range you
   * hit it whatever you do.
   */
  minConverge: 2.5,

  /**
   * Retracting can go almost to zero, and that is fine: the boom hangs off the
   * SHOULDER, so even fully collapsed the camera sits `side` units away from
   * the middle of the chicken — beside the head rather than inside it. Letting
   * it collapse is what keeps the camera out of a wall when you back into one.
   */
  minBoom: 0.2,
  wallGap: 0.5,       // how far inside the arena wall the camera aims to stay
  floorGap: 0.45,     // ...and above the floor
};

/**
 * Unit forward and horizontal-right vectors for a look direction.
 *
 * Same spherical construction the simulation uses in `fire()`, so the camera
 * and the bullet agree about what "forward" means. `right` is deliberately flat
 * — rolling the boom with pitch would swing your chicken across the screen
 * every time you looked up.
 */
export function lookBasis(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    fx: Math.sin(yaw) * cp,
    fy: Math.sin(pitch),
    fz: Math.cos(yaw) * cp,
    rx: Math.cos(yaw),
    rz: -Math.sin(yaw),
  };
}

/**
 * The origin of the crosshair ray, in world space.
 *
 * This is where the camera would be with the boom fully retracted, and it is
 * the anchor for everything else here. Defining the ray from this point rather
 * than from the camera is what lets the boom shorten against a wall without
 * moving your aim: retracting slides the camera ALONG this ray, so the line it
 * looks down is unchanged.
 *
 * The shoulder offset is clamped into the arena, and it has to be. A player is
 * only stopped `PLAYER.radius` from the wall, so standing against one and
 * turning swings a 1.6-unit offset clean through it — the camera ends up inside
 * the wall mesh looking at its culled back faces, which renders as a hole in
 * the world. Squeezing the offset instead slides the camera to directly behind
 * you as you scrape along a wall, which is both correct and what every other
 * game does. The clamp is linear, so it is a squeeze rather than a snap.
 *
 * Clamping here rather than at the camera is deliberate: the aim converges on a
 * point down THIS ray, so as long as the camera and the convergence share an
 * origin the crosshair keeps telling the truth. Clamping the camera alone would
 * have moved the picture without moving the aim.
 */
export function rayOrigin(px, py, pz, basis, half = Infinity) {
  const lim = Math.max(1, half - TPP.wallGap);
  return {
    x: clamp(px + basis.rx * TPP.side, -lim, lim),
    y: py + TPP.pivot + TPP.rise,
    z: clamp(pz + basis.rz * TPP.side, -lim, lim),
  };
}

/**
 * How long the boom can be before the camera leaves the arena.
 *
 * The camera travels backwards along the ray, so each bound becomes a limit on
 * how far back it may go, and the tightest one wins. Retracting the boom is the
 * standard third-person answer to a wall, and here it is also the free one: the
 * arena is a box with nothing inside it, so four planes and the floor are the
 * entire collision problem.
 */
export function boomLength(origin, basis, half, want = TPP.dist, obstacles = []) {
  // Position along the boom is o - d*t, so t is capped by whichever wall the
  // camera is reversing toward on that axis.
  const capAxis = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-6) return Infinity;
    const limit = d > 0 ? (o - lo) / d : (o - hi) / d;
    return Math.max(0, limit);
  };

  const lim = Math.max(1, half - TPP.wallGap);
  let t = Math.min(
    want,
    capAxis(origin.x, basis.fx, -lim, lim),
    capAxis(origin.z, basis.fz, -lim, lim),
    // Only the floor matters vertically; there is no ceiling to hit.
    basis.fy > 1e-6 ? Math.max(0, (origin.y - TPP.floorGap) / basis.fy) : Infinity,
  );

  // ...and cover, which is the case that actually happens. Backing into an
  // arena wall takes deliberate effort; backing into a box happens constantly,
  // because fighting from behind one is the entire point of it being there.
  // The box is padded so the camera stops short of the surface rather than
  // resting on it, where the near plane would slice it open.
  if (obstacles.length && t > TPP.minBoom) {
    for (const box of obstacles) {
      const hit = segBoxEntry(
        origin.x, origin.y, origin.z,
        origin.x - basis.fx * t, origin.y - basis.fy * t, origin.z - basis.fz * t,
        box, TPP.wallGap,
      );
      if (hit >= 0) t *= hit;
    }
  }
  return Math.max(TPP.minBoom, t);
}

/**
 * Full third-person camera solve: where it sits, and what it looks at.
 *
 * @param half arena half-extent, for retracting the boom off a wall
 */
export function tppCamera(px, py, pz, yaw, pitch, half, obstacles = []) {
  const basis = lookBasis(yaw, pitch);
  const origin = rayOrigin(px, py, pz, basis, half);
  const boom = boomLength(origin, basis, half, TPP.dist, obstacles);
  return {
    basis,
    origin,
    boom,
    x: origin.x - basis.fx * boom,
    y: origin.y - basis.fy * boom,
    z: origin.z - basis.fz * boom,
  };
}

/**
 * How far along the crosshair ray the thing you are actually aiming at is.
 *
 * This is what makes "the bullet goes where the crosshair is" true rather than
 * true-ish. A fixed convergence distance is exact at that one range and drifts
 * either side of it, so instead the ray is asked what it hits: a chicken the
 * reticle is covering, or the ground, or — failing both — the fallback range,
 * where there was nothing to miss anyway.
 *
 * The chicken test is deliberately tight. It converges only when the crosshair
 * genuinely covers someone, using the same radius the simulation's hit test
 * uses; a generous version would bend shots onto targets the player had not
 * actually aimed at, which is aim assist wearing a disguise, and assist already
 * exists and is a setting people can turn off.
 */
export function convergeDistance(origin, basis, targets = [], half = Infinity, obstacles = []) {
  // Starts at "nothing found" rather than at the fallback. Seeding it with
  // TPP.converge looks equivalent and is not: it silently rejects every target
  // standing further away than the fallback, so a duel across a large map
  // converged on empty air 20 units out instead of on the chicken at 34.
  let best = Infinity;

  // The floor. Very visible, because you can see where the sparks land.
  if (basis.fy < -1e-6) {
    const t = origin.y / -basis.fy;
    if (t > 0) best = Math.min(best, t);
  }

  // The walls, but only where they are solid — a shot angled over the parapet
  // leaves the arena, and there is nothing out there to converge on.
  if (Number.isFinite(half)) {
    for (const [o, d, lim] of [[origin.x, basis.fx, half], [origin.z, basis.fz, half]]) {
      if (Math.abs(d) < 1e-6) continue;
      const t = ((d > 0 ? lim : -lim) - o) / d;
      if (t > 0 && t < best && origin.y + basis.fy * t <= WALL_HEIGHT) best = t;
    }
  }

  // Cover. Same reason as the walls: sparks have to land under the reticle, and
  // shooting at a box is something players do constantly now.
  for (const box of obstacles) {
    const t = segBoxEntry(
      origin.x, origin.y, origin.z,
      origin.x + basis.fx * best, origin.y + basis.fy * best, origin.z + basis.fz * best,
      box, 0,
    );
    if (t >= 0) best *= t;
  }

  // ...and chickens, which beat any surface behind them.
  const rr = PLAYER.radius + BULLET.radius;
  for (const t of targets) {
    if (!t || t.alive === false) continue;
    // Closest approach of the ray to the middle of their body.
    const wx = t.x - origin.x;
    const wy = (t.y ?? 0) + PLAYER.hitHeight * 0.5 - origin.y;
    const wz = t.z - origin.z;
    const along = wx * basis.fx + wy * basis.fy + wz * basis.fz;
    if (along <= 0 || along >= best) continue; // behind us, or behind something solid
    const px = wx - basis.fx * along;
    const py = wy - basis.fy * along;
    const pz = wz - basis.fz * along;
    if (Math.hypot(px, py, pz) > rr) continue; // the crosshair is not on them
    best = along;
  }

  // Nothing under the crosshair at all — open sky over the parapet.
  if (!Number.isFinite(best)) best = TPP.converge;
  return Math.max(TPP.minConverge, best);
}

/**
 * The angles the chicken must actually fire along for the shot to pass through
 * the crosshair.
 *
 * The crosshair is the middle of the screen, which is the camera ray; the
 * bullet leaves the chicken's eye, which is somewhere else. So the shot is
 * aimed at the point where the ray meets whatever you are pointing at, and the
 * two coincide exactly there. Nothing about this reaches the simulation — it
 * produces the same `{yaw, pitch}` a first-person player would have sent, and
 * the server neither knows nor cares which view produced it.
 *
 * Independent of the boom, so retracting off a wall cannot move your aim — see
 * rayOrigin. It does need the arena, because the shoulder offset is squeezed
 * near a wall and the camera and the aim have to be squeezed identically.
 *
 * @param targets everyone worth converging on, as {x, y, z, alive}
 * @param half    arena half-extent, matching what the camera was given
 */
/**
 * Enemy nameplates: when you are allowed to see one.
 *
 * *** THIS IS A WALLHACK FIX. ***
 *
 * A nameplate is HTML floating over the world, and HTML has no depth buffer —
 * so every enemy health bar was drawn through cover, and the reported symptom
 * was players tracking each other through solid boxes off the bars alone. That
 * is not a cosmetic bug: cover is the entire reason the arena has boxes in it,
 * and an information channel that ignores them deletes the mechanic.
 *
 * The rule is the shot's own geometry, which is why it is in this file: a bar
 * appears when you COULD SHOOT THEM. Same origin `fire()` uses (the eye), same
 * boxes `traceShot` clips against, so "I can see their health" and "my round
 * would arrive" are the same sentence. Nothing view-dependent goes into it —
 * first and third person answer identically, exactly like the crosshair.
 *
 * Two gates, and they linger differently on purpose:
 *
 *   LOS   is the wallhack. It gets almost no linger — 0.15s smooths a single
 *         frame of clipping a pillar edge and is useless as a peek.
 *   CONE  is "are you actually looking at them", and it gets a real one. A bar
 *         that strobed as the crosshair drifted off a moving target would be
 *         worse than no bar at all: flicker reads as a rendering fault, and
 *         nobody can hold a dot inside 0.6 radians while strafing.
 */
export const PLATES = {
  /**
   * Half-angle from the crosshair, in radians. ~26 degrees.
   *
   * Sized against the camera rather than picked: the field of view is 1.15rad,
   * so a half-vertical of ~0.575 — this is a bit under 80% of that, which is
   * "in the middle of the screen" rather than "under the reticle". Tighter is
   * tempting and wrong. At ten units a chicken is 0.06rad wide, so a cone that
   * actually required the crosshair ON them would need pixel-perfect aim to
   * read a health bar, and the bar is most wanted in exactly the moments aim
   * is worst.
   */
  cone: 0.45,

  /**
   * Inside this many units, LOS alone is enough — the cone is dropped.
   *
   * Someone this close fills a quarter of the screen and is a sound, a shape
   * and a shove already. Hiding their bar mid-flick loses information without
   * protecting anything, because there is no wall in the way to protect.
   */
  near: 6,

  /** Seconds a plate survives losing line of sight. Deliberately tiny. */
  losLinger: 0.15,

  /** ...and losing the cone. Long enough that tracking is not a strobe light. */
  coneLinger: 0.7,
};

/**
 * Is the line from one point to another clear of cover?
 *
 * The same slab test `traceShot` clips a round against, asked as a yes/no. Only
 * the boxes: two points inside the arena cannot have a perimeter wall between
 * them, and the floor is under both of them.
 */
export function losClear(ox, oy, oz, tx, ty, tz, obstacles = []) {
  for (const box of obstacles) {
    if (segBoxEntry(ox, oy, oz, tx, ty, tz, box, 0) >= 0) return false;
  }
  return true;
}

/**
 * Which enemy plates may be drawn this frame.
 *
 * Stateful because of the linger, and the state is two timestamps per player —
 * see PLATES for why they are two and not one. Team-mates and anyone lit by a
 * Scout sweep skip the whole test: neither is an exploit. The sweep especially
 * is the Scout's entire job, and it is EARNED, which is the difference between
 * information and a wallhack.
 */
export class PlateVision {
  constructor() {
    this.los = new Map();  // id -> time LOS expires
    this.aim = new Map();  // id -> time the cone expires
    this.t = 0;
  }

  /**
   * @param self     the local player, with predicted x/y/z
   * @param yaw/pitch the LOCAL look angles — the ones the shot is built from
   * @param revealed true while our side's Scout sweep is live
   * @returns a Set of player ids whose plate may be drawn
   */
  update(dt, { self, players, x, y, z, yaw, pitch, obstacles = [], revealed = false }) {
    this.t += dt;
    const out = new Set();
    if (!self) return out;

    const basis = lookBasis(yaw, pitch);
    const ox = x;
    const oy = y + PLAYER.eyeHeight;
    const oz = z;
    const live = new Set();

    for (const p of players) {
      if (p.id === self.id || !p.alive) continue;
      const friend = self.team !== null && p.team !== null && p.team === self.team;
      // Your own roost, and anyone your Scout is lighting up. Neither is a
      // thing the player got for free.
      if (friend || (revealed && !friend)) { out.add(p.id); continue; }
      live.add(p.id);

      // Chest, not head and not feet: the plate is about the body, and a head
      // point pops in over cover the target is properly hidden behind.
      const tx = p.x;
      const ty = (p.y ?? 0) + PLAYER.hitHeight * 0.55;
      const tz = p.z;

      if (losClear(ox, oy, oz, tx, ty, tz, obstacles)) {
        this.los.set(p.id, this.t + PLATES.losLinger);
      }

      const dx = tx - ox;
      const dy = ty - oy;
      const dz = tz - oz;
      const dist = Math.hypot(dx, dy, dz) || 1e-6;
      const cos = (dx * basis.fx + dy * basis.fy + dz * basis.fz) / dist;
      if (dist <= PLATES.near || cos >= Math.cos(PLATES.cone)) {
        this.aim.set(p.id, this.t + PLATES.coneLinger);
      }

      if ((this.los.get(p.id) ?? 0) > this.t && (this.aim.get(p.id) ?? 0) > this.t) {
        out.add(p.id);
      }
    }

    // Anyone who left the match keeps a stale timer alive forever otherwise.
    for (const id of this.los.keys()) if (!live.has(id)) this.los.delete(id);
    for (const id of this.aim.keys()) if (!live.has(id)) this.aim.delete(id);
    return out;
  }
}

export function convergeAim(px, py, pz, yaw, pitch, targets = [], half = Infinity, obstacles = []) {
  const basis = lookBasis(yaw, pitch);
  const o = rayOrigin(px, py, pz, basis, half);
  const range = convergeDistance(o, basis, targets, half, obstacles);

  const tx = o.x + basis.fx * range;
  const ty = o.y + basis.fy * range;
  const tz = o.z + basis.fz * range;

  // From the muzzle, which is eye height — the same place fire() starts it.
  const dx = tx - px;
  const dy = ty - (py + PLAYER.eyeHeight);
  const dz = tz - pz;
  const flat = Math.hypot(dx, dz);

  return {
    yaw: Math.atan2(dx, dz),
    // Clamped because it is going into the input struct, and the server clamps
    // it too — better to send an angle we can also render than to have the two
    // quietly disagree at the extremes.
    pitch: clamp(Math.atan2(dy, flat), PLAYER.pitchMin, PLAYER.pitchMax),
  };
}
