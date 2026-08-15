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
 * Squared distance from point P to segment AB. Used for swept bullet hits —
 * at 20Hz a bullet travels 1.5 units per tick, so a point test would tunnel
 * straight through a 0.6-radius chicken.
 */
export function segPointDist2(ax, az, bx, bz, px, pz) {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const abLen2 = abx * abx + abz * abz;
  const t = abLen2 > 1e-9 ? clamp((apx * abx + apz * abz) / abLen2, 0, 1) : 0;
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return dist2(cx, cz, px, pz);
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
