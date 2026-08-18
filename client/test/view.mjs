// Third-person framing, headless.
//
// This is the test that matters for third person, and it needs no browser: the
// framing is pure geometry, so it can be checked in milliseconds instead of
// waiting on a Playwright run at three frames a second.
//
// What it protects is one promise. In first person the camera sits at the
// muzzle, so "along the camera" and "out of the gun" are the same line and a
// centre crosshair is true by construction. Third person moves the camera onto
// a boom and breaks that: the crosshair is now the middle of a camera standing
// somewhere else, and a shot fired along the camera's own angles would drift
// off it by more the closer the target gets. So the shot is bent to pass
// through the crosshair instead — and if that ever stops being exact, every
// third-person shot in the game silently misses low and left.
//
//   node client/test/view.mjs

import { PLAYER, BULLET, WALL_HEIGHT, segSegDist2 } from '@cluckdown/shared';
import {
  TPP, asView, lookBasis, rayOrigin, boomLength, tppCamera, convergeAim, convergeDistance,
} from '../src/game/view.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const EYE = PLAYER.eyeHeight;

/** Fires along `aim` from the chicken's muzzle and returns the point at `d`. */
function shotPoint(px, py, pz, aim, d) {
  const cp = Math.cos(aim.pitch);
  return {
    x: px + Math.sin(aim.yaw) * cp * d,
    y: py + EYE + Math.sin(aim.pitch) * d,
    z: pz + Math.cos(aim.yaw) * cp * d,
  };
}

/** The world point under the crosshair — the camera ray, `t` units out. */
function crosshairPoint(cam, t) {
  return {
    x: cam.x + cam.basis.fx * t,
    y: cam.y + cam.basis.fy * t,
    z: cam.z + cam.basis.fz * t,
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * How close the line of fire comes to the line the camera looks down.
 *
 * Measured as two rays rather than "is the shot at the convergence point",
 * because the convergence distance is now whatever the crosshair is actually
 * covering — a chicken, the floor, or the fallback range. Asking whether the
 * two lines MEET is the promise itself, and needs to know none of that.
 */
function raysMeet(px, py, pz, yaw, pitch, { half = 24, targets = [] } = {}) {
  const aim = convergeAim(px, py, pz, yaw, pitch, targets, half);
  const cam = tppCamera(px, py, pz, yaw, pitch, half);
  // Long enough to be a ray rather than a segment. This is a claim about two
  // LINES meeting, and the meeting point can legitimately sit past anywhere a
  // bullet reaches — the crosshair can be on a wall right across the map, and
  // converging there is what keeps the tracer under the reticle for the whole
  // 39 units it does travel.
  const L = 500;
  const cp = Math.cos(aim.pitch);
  return Math.sqrt(segSegDist2(
    cam.x, cam.y, cam.z,
    cam.x + cam.basis.fx * L, cam.y + cam.basis.fy * L, cam.z + cam.basis.fz * L,
    px, py + EYE, pz,
    px + Math.sin(aim.yaw) * cp * L, py + EYE + Math.sin(aim.pitch) * L, pz + Math.cos(aim.yaw) * cp * L,
  ));
}

// --------------------------------------------------------------- the promise
console.log('\n--- the bullet goes where the crosshair is ---');
{
  // Deterministic sweep rather than random sampling: a geometry bug that only
  // shows up at one heading is exactly the kind that a lucky seed hides.
  let worst = 0;
  let worstAt = null;
  let n = 0;
  for (const px of [0, 7.5, -12.25]) {
    for (const pz of [0, -9, 15.5]) {
      for (const py of [0, PLAYER.maxJumpHeight]) {
        for (let y = -Math.PI; y < Math.PI; y += 0.21) {
          for (const pitch of [-1.2, -0.6, -0.15, 0, 0.15, 0.6, 1.1]) {
            n++;
            const miss = raysMeet(px, py, pz, y, pitch);
            if (miss > worst) { worst = miss; worstAt = { px, pz, py, y: +y.toFixed(2), pitch }; }
          }
        }
      }
    }
  }
  console.log(`  worst separation over ${n} headings: ${worst.toExponential(2)} units`);
  check('the line of fire always crosses the line the camera looks down',
    worst < 1e-8, `${worst.toExponential(2)}u, worst at ${JSON.stringify(worstAt)}`);
}

// The case that actually decides a fight: someone under the crosshair, at any
// range. Convergence finds them, so the shot goes through them exactly rather
// than through a fixed point 20 units out that they happen not to be standing
// on. This is the whole reason convergeDistance looks for targets at all.
{
  let worst = 0;
  let worstRange = null;
  let tested = 0;
  for (let y = -Math.PI; y < Math.PI; y += 0.23) {
    for (const range of [3, 5, 9, 16, 25, 34]) {
      for (const pitch of [-0.35, 0, 0.3]) {
        // Put a chicken exactly under the crosshair at `range`, standing on the
        // floor. Skip the combinations where that is impossible — a ray angled
        // down is underground long before 34 units, and nothing can be standing
        // there to be hit.
        const basis = lookBasis(y, pitch);
        const o = rayOrigin(0, 0, 0, basis, 60);
        const rayY = o.y + basis.fy * range;
        if (rayY < PLAYER.hitHeight * 0.5 || rayY > PLAYER.maxJumpHeight + PLAYER.hitHeight) continue;
        tested++;
        const foe = {
          x: o.x + basis.fx * range,
          y: rayY - PLAYER.hitHeight * 0.5,
          z: o.z + basis.fz * range,
          alive: true,
        };
        const aim = convergeAim(0, 0, 0, y, pitch, [foe], 60);
        const centre = { x: foe.x, y: foe.y + PLAYER.hitHeight * 0.5, z: foe.z };
        const travel = dist(centre, { x: 0, y: EYE, z: 0 });
        const miss = dist(shotPoint(0, 0, 0, aim, travel), centre);
        if (miss > worst) { worst = miss; worstRange = range; }
      }
    }
  }
  console.log(`  worst miss on a target under the crosshair (${tested} placements): ${worst.toExponential(2)} units`);
  check('a chicken under the crosshair is hit dead centre at ANY range',
    tested > 100 && worst < 1e-9, `${worst.toExponential(2)}u, worst at ${worstRange}u`);
}

// Inside the arena there is always SOMETHING under the crosshair — a chicken, a
// wall or the floor — so convergence finds it and is exact. The fixed fallback
// is only for shots that have already left the building over the parapet.
//
// That claim is load-bearing rather than decorative. With the shoulder this far
// out, NO single fallback distance can keep a shot inside a chicken's width
// across the bullet's whole 39-unit range — the near and far requirements
// contradict each other. So the question worth asking is not "how accurate is
// the fallback" but "can a shot that is still in play ever reach it", and the
// answer has to be no.
{
  const half = 24;
  let fellBack = 0;
  let inPlay = 0;
  let n = 0;
  for (const px of [0, 11, -20]) {
    for (const pz of [0, -17, 22]) {
      for (let y = -Math.PI; y < Math.PI; y += 0.09) {
        for (const pitch of [-1.2, -0.5, -0.1, 0, 0.1, 0.5, 1.2]) {
          n++;
          const basis = lookBasis(y, pitch);
          const o = rayOrigin(px, 0, pz, basis, half);
          if (convergeDistance(o, basis, [], half) !== TPP.converge) continue;
          fellBack++;

          // Worked out independently of convergeDistance: where does this ray
          // cross the arena boundary, and is it over the wall by then?
          let exit = Infinity;
          for (const [oo, d] of [[o.x, basis.fx], [o.z, basis.fz]]) {
            if (Math.abs(d) < 1e-9) continue;
            const t = ((d > 0 ? half : -half) - oo) / d;
            if (t > 0) exit = Math.min(exit, t);
          }
          if (!(o.y + basis.fy * exit > WALL_HEIGHT)) inPlay++;
        }
      }
    }
  }
  console.log(`  ${fellBack} of ${n} rays reached the fallback, ${inPlay} of those were still in play`);
  check('a shot still inside the arena never reaches the fallback', inPlay === 0,
    `${inPlay} in-play rays fell back`);
  check('...and the fallback is genuinely reachable, so that means something',
    fellBack > 0, String(fellBack));
}

// Inside the arena, walls are surfaces too: sparks have to land under the
// reticle rather than short of it.
{
  const half = 24;
  const basis = lookBasis(0, 0);
  const o = rayOrigin(0, 0, 12, basis, half);
  const wallAt = (half - o.z) / basis.fz;
  const range = convergeDistance(o, basis, [], half);
  console.log(`  facing a wall ${wallAt.toFixed(2)}u away: converged at ${range.toFixed(2)}u`);
  check('a wall under the crosshair is converged on', Math.abs(range - wallAt) < 1e-9,
    `${range.toFixed(3)} vs ${wallAt.toFixed(3)}`);

  // ...but a shot angled over the top of it is not stopped by it.
  const over = lookBasis(0, 0.9);
  const overO = rayOrigin(0, 0, 12, over, half);
  check('a shot that clears the parapet ignores the wall',
    convergeDistance(overO, over, [], half) === TPP.converge,
    String(convergeDistance(overO, over, [], half)));
}

// Aiming at the ground converges on the ground, so the sparks land under the
// reticle rather than a metre past it.
{
  const basis = lookBasis(0.4, -0.3);
  const o = rayOrigin(0, 0, 0, basis, 60);
  const floorAt = o.y / -basis.fy;
  const range = convergeDistance(o, basis, []);
  console.log(`  looking down: floor is ${floorAt.toFixed(2)}u along the ray, converged at ${range.toFixed(2)}u`);
  check('looking down converges on the floor, not past it',
    Math.abs(range - floorAt) < 1e-9, `${range.toFixed(3)} vs ${floorAt.toFixed(3)}`);

  // ...until the floor is closer than minConverge, where the clamp deliberately
  // wins. Aiming at your own feet is not a shot anyone is trying to land, and
  // the alternative is the gun swinging near-vertical for no gain.
  const steep = lookBasis(0, -1.3);
  const steepO = rayOrigin(0, 0, 0, steep, 60);
  const steepFloor = steepO.y / -steep.fy;
  console.log(`  aiming at your own feet: floor ${steepFloor.toFixed(2)}u, converged at ${convergeDistance(steepO, steep, []).toFixed(2)}u`);
  check('...but never nearer than minConverge',
    steepFloor < TPP.minConverge && convergeDistance(steepO, steep, []) === TPP.minConverge,
    `floor ${steepFloor.toFixed(2)} -> ${convergeDistance(steepO, steep, []).toFixed(2)}`);
}

// A chicken the crosshair is NOT on must not pull the shot. Convergence is not
// a second aim assist.
{
  const basis = lookBasis(0, 0);
  const o = rayOrigin(0, 0, 0, basis, 60);
  const beside = { x: o.x + 4, y: 0, z: o.z + 12, alive: true }; // well off the ray
  const dead = { x: o.x + basis.fx * 12, y: 0, z: o.z + basis.fz * 12, alive: false };
  check('a chicken off to one side does not bend the shot',
    convergeDistance(o, basis, [beside]) === TPP.converge,
    String(convergeDistance(o, basis, [beside])));
  check('a dead chicken under the crosshair does not either',
    convergeDistance(o, basis, [dead]) === TPP.converge,
    String(convergeDistance(o, basis, [dead])));
  check('convergence never collapses to point blank',
    convergeDistance(o, basis, [{ x: o.x, y: 0, z: o.z + 0.3, alive: true }]) >= TPP.minConverge);
  // The bug this replaced: seeding the search with the fallback distance
  // rejected every target standing beyond it, so a long-range duel converged on
  // empty air instead of on the chicken filling the crosshair.
  //
  // Placed ON the ray rather than at a guessed coordinate — the ray leaves the
  // shoulder, not the eye, so "straight ahead at floor level" is not on it.
  const farT = 34;
  const farBasis = lookBasis(0, -0.034); // just enough droop to reach the floor
  const farO = rayOrigin(0, 0, 0, farBasis, 60);
  const far = {
    x: farO.x + farBasis.fx * farT,
    y: farO.y + farBasis.fy * farT - PLAYER.hitHeight * 0.5,
    z: farO.z + farBasis.fz * farT,
    alive: true,
  };
  check('a chicken beyond the fallback range is still converged on',
    Math.abs(convergeDistance(farO, farBasis, [far], 60) - farT) < 0.05,
    String(convergeDistance(farO, farBasis, [far], 60)));
}

// --------------------------------------------------------------- the framing
console.log('\n--- the chicken sits down and to the left ---');
{
  // Project the chicken's head into camera space. Negative x is left of the
  // crosshair, negative y is below it — which is the whole point of the offset:
  // dead centre would park a bird on top of the reticle.
  const px = 0;
  const py = 0;
  const pz = 0;
  const yaw = 0.7;
  const pitch = 0;
  const cam = tppCamera(px, py, pz, yaw, pitch, 24);
  const b = cam.basis;
  const to = { x: px - cam.x, y: py + EYE - cam.y, z: pz - cam.z };
  // Camera-space coordinates: along forward, along right, along up.
  const fwd = to.x * b.fx + to.y * b.fy + to.z * b.fz;
  const right = to.x * b.rx + to.z * b.rz;
  const up = to.y; // the boom never rolls, so world up is camera up enough here
  console.log(`  head at ${fwd.toFixed(2)}u ahead, ${right.toFixed(2)} right, ${up.toFixed(2)} up`);
  console.log(`  screen offsets: ${(Math.abs(right) / fwd * 100).toFixed(0)}% side, ${(Math.abs(up) / fwd * 100).toFixed(0)}% down (as a fraction of the boom)`);
  check('your chicken is in front of the camera', fwd > 1, fwd.toFixed(2));
  check('...offset to the LEFT of the crosshair', right < -0.1, right.toFixed(2));
  check('...and BELOW it', up < -0.1, up.toFixed(2));
  // A nudge, not a shove. Past about a third of the way out it stops reading as
  // "behind you" and starts reading as a chase cam pointed somewhere else.
  const frac = Math.abs(right) / fwd;
  check('the offset is a nudge, not a shove', frac > 0.15 && frac < 0.35,
    `${(frac * 100).toFixed(0)}% of the distance to the chicken`);

  // ...and the chicken has to be far enough back not to fill the screen. At
  // this boom it is about a quarter of the frame height, which is where a
  // third-person character usually sits.
  const onScreen = PLAYER.hitHeight / (2 * fwd * Math.tan(1.15 / 2));
  console.log(`  your chicken fills ~${(onScreen * 100).toFixed(0)}% of the frame height`);
  check('it does not fill the screen', onScreen < 0.3, `${(onScreen * 100).toFixed(0)}%`);
  check('...but is still big enough to read', onScreen > 0.15, `${(onScreen * 100).toFixed(0)}%`);
}

// The boom must not roll with pitch, or looking up would swing the chicken
// across the screen instead of just tilting the view.
{
  const level = tppCamera(0, 0, 0, 0, 0, 24);
  const steep = tppCamera(0, 0, 0, 0, -1.2, 24);
  console.log(`  side offset level ${(level.origin.x).toFixed(3)} vs pitched ${(steep.origin.x).toFixed(3)}`);
  check('the shoulder offset does not roll when you look up or down',
    Math.abs(level.origin.x - steep.origin.x) < 1e-9,
    `${level.origin.x.toFixed(4)} vs ${steep.origin.x.toFixed(4)}`);
}

// ------------------------------------------------------------------ the wall
console.log('\n--- the boom retracts instead of leaving the arena ---');
{
  const half = 24;
  // Standing near the far wall looking AWAY from it — which is what reverses
  // the camera into it. Looking at a wall is the easy case: the boom goes the
  // other way and nothing is needed.
  const near = tppCamera(0, 0, half - 1, Math.PI, 0, half);
  console.log(`  1u from a wall, facing away: boom ${near.boom.toFixed(2)} of ${TPP.dist}, camera z ${near.z.toFixed(2)}`);
  check('the boom shortens when the camera would reverse into a wall',
    near.boom < TPP.dist, near.boom.toFixed(2));

  // The bound that actually matters is the wall itself, not the target gap —
  // minBoom is allowed to eat into the gap, which is what the gap is for.
  const worstCase = tppCamera(0, 0, half - PLAYER.radius, Math.PI, 0, half);
  console.log(`  pressed against the wall: camera z ${worstCase.z.toFixed(2)} of ${half}`);
  check('the camera never gets outside the arena, even pressed against a wall',
    Math.abs(worstCase.z) < half, `z=${worstCase.z.toFixed(2)} vs wall at ${half}`);

  const open = tppCamera(0, 0, 0, 0, 0, half);
  check('...and it stays at full length in open ground', Math.abs(open.boom - TPP.dist) < 1e-9,
    open.boom.toFixed(2));

  // Looking steeply up drives the camera down toward the floor.
  const low = tppCamera(0, 0, 0, 0, 1.2, half);
  check('the boom also keeps the camera off the floor', low.y >= TPP.floorGap - 1e-9,
    `y=${low.y.toFixed(2)}`);

  // Every corner of every map, in both the tightest and the widest arena.
  let outside = 0;
  for (const h of [14, 27]) {
    const lim = h - PLAYER.radius;
    for (const px of [-lim, 0, lim]) {
      for (const pz of [-lim, 0, lim]) {
        for (let y = -Math.PI; y < Math.PI; y += 0.13) {
          for (const pitch of [-1.2, 0, 1.2]) {
            const c = tppCamera(px, 0, pz, y, pitch, h);
            if (Math.abs(c.x) >= h || Math.abs(c.z) >= h || c.y < 0) outside++;
          }
        }
      }
    }
  }
  check('no corner, heading or pitch puts the camera through a wall or the floor',
    outside === 0, `${outside} escapes`);
}

// THE thing retracting must not do: move your aim. If shortening the boom
// changed where the shot went, aiming would shift whenever you backed into a
// corner — intermittent, positional, and invisible to any test standing in
// open ground.
{
  let worst = 0;
  for (let y = -Math.PI; y < Math.PI; y += 0.17) {
    for (const pitch of [-0.8, 0, 0.8]) {
      // Same spot, same look, two very different arenas — so wildly different
      // boom lengths. convergeAim takes no arena at all, which is the point:
      // it is structurally incapable of noticing.
      const camOpen = tppCamera(0, 0, 0, y, pitch, 60);
      const camTight = tppCamera(0, 0, 0, y, pitch, 3);
      if (Math.abs(camOpen.boom - camTight.boom) < 0.2) continue; // not squeezed
      worst = Math.max(worst, raysMeet(0, 0, 0, y, pitch, { half: 60 }),
        raysMeet(0, 0, 0, y, pitch, { half: 3 }));
    }
  }
  check('a retracted boom still looks straight down the line of fire',
    worst < 1e-8, worst.toExponential(2));
}

// ------------------------------------------------------------------- hygiene
console.log('\n--- view names ---');
check('fps and tpp are both real', asView('fps') === 'fps' && asView('tpp') === 'tpp');
check('anything else falls back to first person',
  asView('topdown') === 'fps' && asView(undefined) === 'fps' && asView(null) === 'fps');

// The basis has to be unit length, or every offset above is silently scaled.
{
  let worst = 0;
  for (let y = -Math.PI; y < Math.PI; y += 0.11) {
    for (const p of [-1.3, -0.4, 0, 0.4, 1.2]) {
      const b = lookBasis(y, p);
      worst = Math.max(
        worst,
        Math.abs(Math.hypot(b.fx, b.fy, b.fz) - 1),
        Math.abs(Math.hypot(b.rx, b.rz) - 1),
        Math.abs(b.fx * b.rx + b.fz * b.rz), // right is perpendicular to forward
      );
    }
  }
  check('forward and right are unit length and perpendicular', worst < 1e-12,
    worst.toExponential(2));
}

// Sanity on the pieces the camera and the aim both lean on.
{
  const b = lookBasis(0, 0);
  const o = rayOrigin(0, 0, 0, b, 60);
  check('facing north, the shoulder offset is to the east',
    Math.abs(o.x - TPP.side) < 1e-9 && Math.abs(o.z) < 1e-9,
    `(${o.x.toFixed(2)}, ${o.z.toFixed(2)})`);
  check('the ray hangs off the head, not the feet',
    Math.abs(o.y - (EYE + TPP.rise)) < 1e-9, o.y.toFixed(2));
  check('boomLength never returns a negative or a NaN',
    Number.isFinite(boomLength(o, b, 24)) && boomLength(o, b, 24) > 0);

  // Pressed into a corner, the offset is squeezed rather than pushed through
  // the wall — and the camera and the aim are squeezed by the same amount,
  // which is the only reason the crosshair survives it.
  const corner = rayOrigin(23.4, 0, 23.4, lookBasis(Math.PI / 2, 0), 24);
  console.log(`  in a corner, the shoulder offset lands at (${corner.x.toFixed(2)}, ${corner.z.toFixed(2)})`);
  check('the shoulder offset is squeezed to stay inside the arena',
    Math.abs(corner.x) <= 24 - TPP.wallGap + 1e-9 && Math.abs(corner.z) <= 24 - TPP.wallGap + 1e-9,
    `(${corner.x.toFixed(2)}, ${corner.z.toFixed(2)})`);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
