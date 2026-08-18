export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function len(x, z) {
  return Math.sqrt(x * x + z * z);
}

/** Normalize, returning [0,0] for a zero-length vector. */
export function norm(x, z) {
  const l = len(x, z);
  return l > 1e-6 ? [x / l, z / l] : [0, 0];
}

/** Clamp a vector to unit length (joysticks can overshoot slightly). */
export function clampUnit(x, z) {
  const l = len(x, z);
  return l > 1 ? [x / l, z / l] : [x, z];
}

export function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Shortest signed angular difference, in radians. */
export function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function lerpAngle(from, to, t) {
  return from + angleDelta(from, to) * t;
}

/**
 * Squared distance between two 3D segments, AB and CD.
 *
 * Ericson's closest-point-between-segments, with every degenerate case folded
 * in: a bullet that barely moved this tick is a near-zero-length segment, and a
 * bullet travelling exactly parallel to a chicken's spine makes the shared
 * denominator vanish. Both happen in real matches, and both used to be the kind
 * of thing that silently returns NaN and makes a hit test quietly stop working.
 */
export function segSegDist2(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  // d1 = B-A, d2 = D-C, r = A-C
  const d1x = bx - ax, d1y = by - ay, d1z = bz - az;
  const d2x = dx - cx, d2y = dy - cy, d2z = dz - cz;
  const rx = ax - cx, ry = ay - cy, rz = az - cz;

  const a = d1x * d1x + d1y * d1y + d1z * d1z; // squared length of AB
  const e = d2x * d2x + d2y * d2y + d2z * d2z; // squared length of CD
  const f = d2x * rx + d2y * ry + d2z * rz;

  const EPS = 1e-9;
  let s = 0;
  let t = 0;

  if (a <= EPS && e <= EPS) {
    // Both segments degenerate to points.
  } else if (a <= EPS) {
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      // denom == 0 means parallel: any s does, so start at the segment's head
      // and let the t clamp below pick the sensible pairing.
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }

  const px = ax + d1x * s - (cx + d2x * t);
  const py = ay + d1y * s - (cy + d2y * t);
  const pz = az + d1z * s - (cz + d2z * t);
  return px * px + py * py + pz * pz;
}

/**
 * Did a bullet's swept path this tick touch a standing chicken?
 *
 * The bullet is the segment it travelled, NOT the point it ended at: at 30 u/s
 * a round covers half a unit per tick, so a point test tunnels straight through
 * a 0.6-radius chicken. That was true when this was flat and it is still true
 * now that the segment climbs and falls.
 *
 * The chicken is a capsule standing on `py`. The axis is inset by `radius` at
 * both ends so the shape spans exactly [py, py + height] — using the raw span
 * as the axis would bulge a whole radius above the comb, and a shot that
 * visibly cleared someone's head would register as a hit.
 */
export function segHitsCapsule(ax, ay, az, bx, by, bz, px, py, pz, height, radius) {
  const inset = Math.min(radius, height / 2);
  const d2 = segSegDist2(
    ax, ay, az, bx, by, bz,
    px, py + inset, pz, px, py + height - inset, pz,
  );
  return d2 <= radius * radius;
}

/** Deterministic PRNG so server and any replay agree on pickup placement. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
