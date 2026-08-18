import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Color3, Color4, Matrix, Quaternion } from '@babylonjs/core/Maths/math';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';

// Side-effect imports. Deep-importing Babylon keeps the bundle down, but these
// two modules patch methods onto Mesh rather than exporting anything, so
// without them mesh.createInstance() / thinInstanceSetBuffer() throw at
// runtime. Imported here so every module that uses them is covered.
// (meshBuilder.js already pulls in all the individual shape builders.)
import '@babylonjs/core/Meshes/instancedMesh';
import '@babylonjs/core/Meshes/thinInstanceMesh';

import { hardwareScaling } from '../graphics.js';
import { MAPS, DEFAULT_MAP, HILL, PLAYER, WALL_HEIGHT } from '@cluckdown/shared';

// Cluckdown is a first-person game. Everything here is the camera that sits
// behind the chicken's eyes.
//
// Eye height and the pitch limits come from PLAYER now, not from this file.
// They stopped being rendering choices the moment pitch became part of the
// shot: the simulation fires from eye height along the look angle, and it
// clamps what it is sent to the same limits. Two copies of these numbers would
// mean the crosshair and the bullet quietly disagreeing.
const FPS_EYE = PLAYER.eyeHeight;
const FPS_FOV = 1.15;      // ~66 degrees
const FPS_NEAR = 0.12;     // your own muzzle would clip against anything larger
const FPS_YAW_LERP = 22;   // high: looking around must feel instant
const FPS_RECOIL_KICK = 0.035;   // radians per shot
const FPS_RECOIL_RECOVER = 9;    // per second

// Spectator orbit, used while dead. With no top-down view left, this is the
// only overhead shot anyone ever gets.
const SPECTATE_HEIGHT = 9;
const SPECTATE_RADIUS = 7;
const SPECTATE_SPIN = 0.22; // radians per second

export function createStage(canvas, gfx = { resolution: 1, glow: true, antialias: true }, modifier = 'none') {
  const engine = new Engine(canvas, gfx.antialias, {
    preserveDrawingBuffer: false,
    stencil: false,
    antialias: gfx.antialias,
    powerPreference: 'high-performance',
  });
  engine.setHardwareScalingLevel(hardwareScaling(gfx.resolution));

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.02, 0.04, 1);
  scene.ambientColor = new Color3(0.04, 0.04, 0.07);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = new Color3(0.02, 0.02, 0.04);
  scene.fogDensity = 0.011;
  scene.blockMaterialDirtyMechanism = true;

  const camera = new UniversalCamera('cam', new Vector3(0, FPS_EYE, 0), scene);
  camera.fov = FPS_FOV;
  camera.minZ = FPS_NEAR;
  camera.maxZ = 200;
  camera.setTarget(Vector3.Zero());
  // No player camera control at all — the angle is part of the game's identity.
  camera.inputs.clear();

  // Dark by design: just enough ambient to read shapes, everything else comes
  // from emissive materials and the glow layer. LIGHTS OUT drops the ambient to near nothing. Nothing else changes: the
  // glow layer and emissive materials still render, so tracer fire, pickups and
  // the armed bomber become the only things you can see by.
  const dark = modifier === 'darkness';

  const hemi = new HemisphericLight('hemi', new Vector3(0.3, 1, 0.2), scene);
  hemi.intensity = dark ? 0.045 : 0.30;
  hemi.diffuse = new Color3(0.55, 0.6, 0.85);
  hemi.groundColor = new Color3(0.05, 0.05, 0.1);

  const key = new PointLight('key', new Vector3(0, 22, 0), scene);
  key.intensity = dark ? 0.12 : 0.62;
  key.range = 70;
  key.diffuse = new Color3(0.7, 0.75, 1);

  // The glow layer is the single most expensive effect here: an extra render
  // target plus a wide blur, every frame. When it's off, nothing else needs to
  // change — emissive materials still render bright, just without the bloom.
  const glow = gfx.glow ? new GlowLayer('glow', scene, { blurKernelSize: 48 }) : null;
  if (glow) glow.intensity = dark ? 1.5 : 1.15;

  return { engine, scene, camera, glow, key };
}

// Materials are expensive to duplicate and duplicates prevent batching, so
// anything not mutated per-instance is created once and shared. Keyed per
// scene so a new match doesn't reuse materials from a disposed one.
const matCache = new WeakMap();

function shared(scene, key, make) {
  let perScene = matCache.get(scene);
  if (!perScene) { perScene = new Map(); matCache.set(scene, perScene); }
  let m = perScene.get(key);
  if (!m) { m = make(); perScene.set(key, m); }
  return m;
}

/** Solid, unlit-ish material for emissive/glowing things. */
export function emissiveMat(scene, name, hex, { intensity = 1, alpha = 1, cache = true } = {}) {
  if (cache) {
    return shared(scene, `e:${name}:${hex}:${intensity}:${alpha}`,
      () => emissiveMat(scene, name, hex, { intensity, alpha, cache: false }));
  }
  const m = new StandardMaterial(name, scene);
  const c = Color3.FromHexString(hex);
  m.diffuseColor = c.scale(0.2);
  m.emissiveColor = c.scale(intensity);
  m.specularColor = Color3.Black();
  m.disableLighting = true;
  if (alpha < 1) {
    // Plain alpha blending only. needDepthPrePass would fill the depth buffer
    // first, so the blend has nothing behind it to mix with and the mesh
    // renders as a solid black hole — very visible on the spawn shields.
    m.alpha = alpha;
    m.backFaceCulling = false;
    m.separateCullingPass = true;
  }
  m.freeze();
  return m;
}

/**
 * @param cache set false for materials that get mutated per instance — the
 *              chicken body flashes on hit, so sharing it would flash everyone.
 */
export function litMat(scene, name, hex, { emissive = 0.06, spec = 0.05, cache = true } = {}) {
  if (cache) {
    return shared(scene, `l:${name}:${hex}:${emissive}:${spec}`,
      () => litMat(scene, name, hex, { emissive, spec, cache: false }));
  }
  const m = new StandardMaterial(name, scene);
  const c = Color3.FromHexString(hex);
  m.diffuseColor = c;
  m.emissiveColor = c.scale(emissive);
  m.specularColor = new Color3(spec, spec, spec);
  return m;
}

/**
 * The arena: a floor of individual cubes (thin-instanced, so all 1600 of them
 * cost one draw call) plus four walls with the grey top trim from the mockup.
 */
export function buildArena(scene, size, mapId = DEFAULT_MAP) {
  const map = MAPS[mapId] ?? MAPS[DEFAULT_MAP];
  const half = size / 2;
  const root = [];

  const TILE = 2;
  const GAP = 0.08;
  const n = Math.ceil(size / TILE);

  const tile = MeshBuilder.CreateBox('tile', { width: TILE - GAP, height: 0.6, depth: TILE - GAP }, scene);
  tile.material = litMat(scene, `tileMat_${map.id}`, map.floor, { emissive: 0.1 });
  tile.receiveShadows = false;

  const floor = Color3.FromHexString(map.floor);
  const matrices = new Float32Array(n * n * 16);
  const colors = new Float32Array(n * n * 4);
  let i = 0;
  for (let gx = 0; gx < n; gx++) {
    for (let gz = 0; gz < n; gz++) {
      const x = -half + TILE / 2 + gx * TILE;
      const z = -half + TILE / 2 + gz * TILE;
      // Checker + a little noise so the floor doesn't read as one flat slab.
      const checker = (gx + gz) % 2 === 0 ? 1 : 0.82;
      const noise = 0.94 + ((Math.sin(gx * 12.9898 + gz * 78.233) * 43758.5453) % 1) * 0.06;
      const shade = checker * noise;
      Matrix.Translation(x, -0.3, z).copyToArray(matrices, i * 16);
      colors[i * 4 + 0] = floor.r * shade;
      colors[i * 4 + 1] = floor.g * shade;
      colors[i * 4 + 2] = floor.b * shade;
      colors[i * 4 + 3] = 1;
      i++;
    }
  }
  tile.thinInstanceSetBuffer('matrix', matrices, 16, true);
  tile.thinInstanceSetBuffer('color', colors, 4, true);
  tile.isPickable = false;
  root.push(tile);

  // Walls: dark body + light grey cap, mirroring the screenshot's trim.
  const wallMat = litMat(scene, 'wallMat', '#1a1f33', { emissive: 0.05 });
  const capMat = litMat(scene, `capMat_${map.id}`, map.trim, { emissive: 0.16 });
  // Shared with the simulation, which needs to know when a shot has cleared
  // the parapet rather than hit it.
  const H = WALL_HEIGHT;
  const T = 0.9;
  const specs = [
    { x: 0, z: half + T / 2, w: size + T * 2, d: T },
    { x: 0, z: -half - T / 2, w: size + T * 2, d: T },
    { x: half + T / 2, z: 0, w: T, d: size + T * 2 },
    { x: -half - T / 2, z: 0, w: T, d: size + T * 2 },
  ];
  for (const [idx, s] of specs.entries()) {
    const wall = MeshBuilder.CreateBox(`wall${idx}`, { width: s.w, height: H, depth: s.d }, scene);
    wall.position.set(s.x, H / 2, s.z);
    wall.material = wallMat;
    wall.isPickable = false;
    root.push(wall);

    const cap = MeshBuilder.CreateBox(`cap${idx}`, { width: s.w + 0.12, height: 0.42, depth: s.d + 0.12 }, scene);
    cap.position.set(s.x, H + 0.2, s.z);
    cap.material = capMat;
    cap.isPickable = false;
    root.push(cap);
  }

  // Corner spawn pads, so you can see where people come back in.
  const pad = MeshBuilder.CreateBox('spawnPad', { width: 3, height: 0.12, depth: 3 }, scene);
  pad.material = emissiveMat(scene, 'padMat', '#5f7fff', { intensity: 0.5, alpha: 0.5 });
  pad.isPickable = false;
  const d = half - 3.5;
  const padM = new Float32Array(4 * 16);
  [[-d, -d], [d, d], [d, -d], [-d, d]].forEach(([x, z], k) => {
    Matrix.Translation(x, 0.06, z).copyToArray(padM, k * 16);
  });
  pad.thinInstanceSetBuffer('matrix', padM, 16, true);
  root.push(pad);

  // Centre marker: the bomber's nest.
  const nest = MeshBuilder.CreateBox('nest', { width: 3.4, height: 0.14, depth: 3.4 }, scene);
  nest.position.y = 0.07;
  nest.material = emissiveMat(scene, 'nestMat', '#ff2d4b', { intensity: 0.45, alpha: 0.42 });
  nest.isPickable = false;
  root.push(nest);

  // --- everything below exists so the camera can centre on the player ---
  //
  // Keeping the player centred means you see past the walls whenever you're
  // near one. With nothing out there that reads as a hole in the render, so
  // the arena gets a thick underside and a floor far below: it becomes a slab
  // floating over an abyss, and looking off the edge is intentional.

  // Slab: gives the platform visible thickness from this camera angle.
  const slab = MeshBuilder.CreateBox('slab', {
    width: size + T * 2, height: 5, depth: size + T * 2,
  }, scene);
  slab.position.y = -3.1; // top sits just under the floor tiles
  slab.material = litMat(scene, 'slabMat', '#0d1020', { emissive: 0.03 });
  slab.isPickable = false;
  root.push(slab);

  // Abyss: a huge, very dark floor far below. Large enough that its own edges
  // never enter frame, and dim enough to read as depth rather than geometry.
  const abyss = MeshBuilder.CreateBox('abyss', {
    width: size * 6, height: 1, depth: size * 6,
  }, scene);
  abyss.position.y = -16;
  abyss.material = litMat(scene, 'abyssMat', '#070912', { emissive: 0.015 });
  abyss.isPickable = false;
  root.push(abyss);

  // The arena never moves. Freezing world matrices skips recomputing them every
  // frame, and freezing materials skips per-frame dirty checks. Deliberately
  // NOT using scene.freezeActiveMeshes(): players, pickups, debris and the
  // bomber are constantly enabled/disabled, and freezing the active list would
  // strand them.
  for (const m of root) {
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    m.material?.freeze();
  }

  return { meshes: root, half };
}

/**
 * Smooth follow + screen shake. Shake is applied after the lerp so it never
 * accumulates into the camera's resting position.
 */
/**
 * The camera.
 *
 * Cluckdown is first person, so this is simply "where the chicken's eyes are".
 * There used to be three top-down framings alongside it and a good deal of zoom
 * machinery to move between them; all of that is gone, and the file is roughly
 * a third the size for it.
 *
 * Pitch used to live only here: the simulation was flat, so tilting the view
 * moved the horizon and nothing else. It reaches the sim now, along with the
 * player's height off the floor, which is what lets the camera sit inside a
 * jump and the crosshair sit still in the middle of the screen.
 */
export class CameraRig {
  constructor(camera, arenaSize, engine) {
    this.camera = camera;
    this.engine = engine;
    this.half = arenaSize / 2;

    this.camera.fov = FPS_FOV;
    this.camera.minZ = FPS_NEAR;

    this.focus = new Vector3(0, 0, 0);
    this.shake = 0;
    this.recoil = 0;

    // Smoothed separately from the raw input so a 40Hz patch, or a dropped
    // frame, doesn't make the whole world step sideways.
    this.yaw = 0;
    this.yawHas = false;

    // Spectator orbit, used while dead.
    this.spectateAngle = 0;
    this.alive = true;
  }

  /** Kept for the resize handler; there are no follow limits to recompute now. */
  recomputeLimits() {}

  setAlive(alive) {
    if (alive === this.alive) return;
    this.alive = alive;
    if (!alive) this.spectateAngle = this.yaw;
  }

  addShake(amount) {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /** A shot was fired: kick the view up a touch. */
  addRecoil() {
    this.recoil = Math.min(0.12, this.recoil + FPS_RECOIL_KICK);
  }

  /**
   * Respawn: snap the camera to the new corner so "I'm back" is unmissable.
   *
   * In first person there is no zoom punch to play, so this is a hard cut plus
   * a nudge of shake — which reads as landing rather than as a glitch.
   */
  respawnPunch(x, z) {
    this.focus.set(x, 0, z);
    this.yawHas = false; // don't sweep the view across the arena to get here
    this.addShake(0.22);
  }

  snapTo(x, z, y = 0) {
    this.focus.set(x, y, z);
    this.camera.position.set(x, y + FPS_EYE, z);
  }

  /**
   * @param targetY  the player's height off the floor — nonzero mid-jump
   * @param aim      where the player is looking, in radians
   * @param alive    false switches to the spectator orbit
   * @param pitch    vertical look, already clamped by the caller
   * @param watch    optional {x, z} to spectate — normally your killer
   */
  update(dt, targetX, targetY, targetZ, aim = 0, alive = true, pitch = 0, watch = null) {
    this.recoil = Math.max(0, this.recoil - dt * FPS_RECOIL_RECOVER);
    if (!alive) return this.updateSpectator(dt, targetX, targetZ, watch);

    // Shortest-path yaw interpolation, or turning past +/-180 spins the world.
    if (!this.yawHas) { this.yaw = aim; this.yawHas = true; }
    let d = (aim - this.yaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, FPS_YAW_LERP * dt);

    this.focus.set(targetX, targetY, targetZ);

    let sx = 0;
    let sy = 0;
    if (this.shake > 0.001) {
      const sh = this.shake * this.shake; // ease out: big hits punch, small ones nudge
      // Much smaller than a third-person shake would be. At eye level, screen
      // shake stops reading as impact and starts reading as nausea.
      sx = (Math.random() * 2 - 1) * sh * 0.35;
      sy = (Math.random() * 2 - 1) * sh * 0.35;
      this.shake = Math.max(0, this.shake - dt * 2.6);
    }

    const look = pitch + this.recoil;
    // Spherical, so looking down doesn't shorten the horizontal component and
    // change the apparent turn rate. Same construction the simulation uses in
    // fire(), which is the whole reason a centre reticle is honest.
    const cp = Math.cos(look);
    const eye = targetY + FPS_EYE;
    this.camera.position.set(targetX + sx, eye + sy, targetZ);
    this.camera.setTarget(new Vector3(
      targetX + Math.sin(this.yaw) * cp * 10,
      eye + Math.sin(look) * 10,
      targetZ + Math.cos(this.yaw) * cp * 10,
    ));
  }

  /**
   * Dead: rise up and watch.
   *
   * With no top-down view left in the game, this is the only overhead anyone
   * ever gets, so it does real work rather than just parking the camera. It
   * orbits slowly above the spot you fell on, and if your killer is still alive
   * it keeps them framed — which turns the respawn wait into something to watch
   * and feeds the revenge mark waiting for you when you come back.
   */
  updateSpectator(dt, x, z, watch) {
    this.spectateAngle += dt * SPECTATE_SPIN;
    this.shake = 0;

    const cx = x + Math.sin(this.spectateAngle) * SPECTATE_RADIUS;
    const cz = z + Math.cos(this.spectateAngle) * SPECTATE_RADIUS;
    this.camera.position.set(cx, SPECTATE_HEIGHT, cz);

    // Frame the killer if they are still up, otherwise the place you died.
    const tx = watch ? watch.x : x;
    const tz = watch ? watch.z : z;
    this.focus.set(tx, 0, tz);
    this.camera.setTarget(new Vector3(tx, 0.85, tz));
  }
}

export { Vector3, Color3, Color4, Matrix, Quaternion, MeshBuilder, StandardMaterial };


/**
 * King of the Coop zone marker.
 *
 * A flat disc plus a rim ring, recoloured to whoever holds it — white while
 * empty, the holder's colour while held, red while contested. Reading the state
 * of the objective at a glance matters more here than any other HUD element,
 * because the whole mode is "am I allowed to stand there".
 */
export function buildHillZone(scene, radius) {
  const disc = MeshBuilder.CreateCylinder('hillDisc', {
    diameter: radius * 2, height: 0.08, tessellation: 40,
  }, scene);
  disc.position.y = 0.05;
  disc.material = emissiveMat(scene, 'hillDiscMat', '#ffffff', { intensity: 0.5, alpha: 0.16, cache: false });
  disc.isPickable = false;

  const ring = MeshBuilder.CreateTorus('hillRing', {
    diameter: radius * 2, thickness: 0.22, tessellation: 44,
  }, scene);
  ring.position.y = 0.1;
  ring.material = emissiveMat(scene, 'hillRingMat', '#ffffff', { intensity: 1.0, cache: false });
  ring.isPickable = false;

  let spin = 0;
  return {
    meshes: [disc, ring],
    /**
     * @param hex holder colour, or null when empty/contested
     * @param moveAt seconds until the zone relocates, or null if it never does
     */
    update(dt, hex, contested, x = 0, z = 0, moveAt = null) {
      spin += dt * (contested ? 1.6 : 0.5);
      ring.rotation.y = spin;

      // The zone relocates, so it is eased into place rather than teleported —
      // a hard jump reads as a rendering glitch instead of a rule.
      const k = Math.min(1, dt * 6);
      disc.position.x += (x - disc.position.x) * k;
      disc.position.z += (z - disc.position.z) * k;
      ring.position.x = disc.position.x;
      ring.position.z = disc.position.z;

      // About to move: flash amber regardless of who holds it, so the warning
      // cannot be mistaken for ownership.
      const moving = moveAt !== null && moveAt <= HILL.warnAt;
      const blink = moving && Math.sin(spin * 14) > 0;
      const target = blink ? '#ffc233' : (contested ? '#ff2d4b' : (hex ?? '#9aa6c4'));
      const c = Color3.FromHexString(target);
      ring.material.emissiveColor.copyFrom(c);
      disc.material.emissiveColor.copyFrom(c.scale(0.6));
      disc.material.alpha = contested ? 0.26 : (hex ? 0.22 : 0.12);
      // Pulse while contested so it reads as "nobody is scoring".
      const s = contested ? 1 + Math.sin(spin * 6) * 0.03 : 1;
      ring.scaling.setAll(moving ? s * (1 + Math.sin(spin * 14) * 0.05) : s);
    },
  };
}

/**
 * The closing boundary in Last Chicken Standing.
 *
 * A hollow box scaled to the live safe half-extent, rather than moving the real
 * walls: rebuilding arena geometry every tick would be absurd, and the wall
 * meshes are frozen. This is one scaled mesh that reads clearly as a wall of
 * light you must not be outside of.
 */
export function buildSafeZone(scene, startHalf) {
  const box = MeshBuilder.CreateBox('safeZone', { size: 2, height: 3.2 }, scene);
  box.position.y = 1.5;
  box.material = emissiveMat(scene, 'safeZoneMat', '#35e07f', { intensity: 1.0, alpha: 0.16, cache: false });
  box.material.backFaceCulling = false; // we are inside it, so show the far side
  box.isPickable = false;
  box.setEnabled(false);

  let pulse = 0;
  return {
    mesh: box,
    update(dt, half, closing) {
      // Only worth showing once it has actually started closing.
      const active = half < startHalf - 0.05;
      box.setEnabled(active);
      if (!active) return;

      box.scaling.set(half, 1, half);
      pulse += dt * (closing ? 5 : 2);
      box.material.alpha = 0.14 + Math.abs(Math.sin(pulse)) * (closing ? 0.16 : 0.06);
    },
  };
}
