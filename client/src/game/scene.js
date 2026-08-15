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

// The reference screenshot is a dimetric view — tilted ~58° off horizontal,
// never straight down and never rotating with aim. Camera follows position
// only, Brawl-Stars style, so the arena stays readable.
const CAM_HEIGHT = 22;
const CAM_BACK = 13.5;
const CAM_LERP = 6; // higher = snappier follow
const CAM_FOV = 0.8;
// How far past the wall the camera is allowed to show before it stops following.
const VOID_MARGIN = 1.5;

// Camera distance multipliers. 1.0 is the neutral framing CAM_HEIGHT/CAM_BACK
// describe; smaller is closer.
const ZOOM_ALIVE = 0.85;    // in the fight
const ZOOM_DEAD = 1.45;     // dead — wide enough to spectate the whole arena
const ZOOM_RESPAWN = 0.62;  // the moment you pop back in
const ZOOM_RATE_IN = 3.2;
const ZOOM_RATE_OUT = 1.5;      // dying pulls back slowly, it reads as deliberate
const ZOOM_RATE_RESPAWN = 2.6;  // then eases open from the punch
const PUNCH_LOCKOUT = 0.6;      // seconds a respawn punch outranks alive/dead state

export function createStage(canvas, gfx = { resolution: 1, glow: true, antialias: true }) {
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

  const camera = new UniversalCamera('cam', new Vector3(0, CAM_HEIGHT, -CAM_BACK), scene);
  camera.fov = CAM_FOV;
  camera.minZ = 1;
  camera.maxZ = 200;
  camera.setTarget(Vector3.Zero());
  // No player camera control at all — the angle is part of the game's identity.
  camera.inputs.clear();

  // Dark by design: just enough ambient to read shapes, everything else comes
  // from emissive materials and the glow layer.
  const hemi = new HemisphericLight('hemi', new Vector3(0.3, 1, 0.2), scene);
  hemi.intensity = 0.30;
  hemi.diffuse = new Color3(0.55, 0.6, 0.85);
  hemi.groundColor = new Color3(0.05, 0.05, 0.1);

  const key = new PointLight('key', new Vector3(0, 22, 0), scene);
  key.intensity = 0.62;
  key.range = 70;
  key.diffuse = new Color3(0.7, 0.75, 1);

  // The glow layer is the single most expensive effect here: an extra render
  // target plus a wide blur, every frame. When it's off, nothing else needs to
  // change — emissive materials still render bright, just without the bloom.
  const glow = gfx.glow ? new GlowLayer('glow', scene, { blurKernelSize: 48 }) : null;
  if (glow) glow.intensity = 1.15;

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
export function buildArena(scene, size) {
  const half = size / 2;
  const root = [];

  const TILE = 2;
  const GAP = 0.08;
  const n = Math.ceil(size / TILE);

  const tile = MeshBuilder.CreateBox('tile', { width: TILE - GAP, height: 0.6, depth: TILE - GAP }, scene);
  tile.material = litMat(scene, 'tileMat', '#3f6fd8', { emissive: 0.1 });
  tile.receiveShadows = false;

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
      colors[i * 4 + 0] = 0.30 * shade;
      colors[i * 4 + 1] = 0.47 * shade;
      colors[i * 4 + 2] = 0.90 * shade;
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
  const capMat = litMat(scene, 'capMat', '#9aa6c4', { emissive: 0.16 });
  const H = 2.6;
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
export class CameraRig {
  constructor(camera, arenaSize, engine) {
    this.camera = camera;
    this.engine = engine;
    this.focus = new Vector3(0, 0, 0);
    this.shake = 0;
    // Pull back a little on bigger arenas so framing feels consistent.
    const scale = Math.max(0.72, arenaSize / 40);
    this.baseHeight = CAM_HEIGHT * scale;
    this.baseBack = CAM_BACK * scale;
    this.half = arenaSize / 2;

    this.zoom = ZOOM_ALIVE;
    this.zoomTarget = ZOOM_ALIVE;
    this.zoomRate = ZOOM_RATE_IN;
    this.punchTimer = 0;

    this.limits = null;
    this.recomputeLimits();
    this.snapTo(0, 0);
  }

  // Distance is derived from zoom, so everything downstream — framing and the
  // follow limits below — reacts to it for free.
  get height() { return this.baseHeight * this.zoom; }

  get back() { return this.baseBack * this.zoom; }

  /**
   * The camera keeps the player dead centre, everywhere in the arena.
   *
   * An earlier version clamped the follow so empty space past the walls could
   * never come into frame. It framed nicely but it meant your chicken slid off
   * toward a screen edge whenever you fought near a wall, which is exactly
   * where fights happen. Centring is worth more than tidy edges, so the void
   * is handled by actually building something out there (see buildArena's slab
   * and abyss) rather than by refusing to look at it.
   *
   * These bounds are only a safety net: a player can never leave the arena, so
   * the clamp never actually engages during play.
   */
  recomputeLimits() {
    this.limits = { x: this.half, zMax: this.half, zMin: -this.half };
  }

  snapTo(x, z) {
    this.focus.set(x, 0, z);
    this.camera.position.set(x, this.height, z - this.back);
    this.camera.setTarget(this.focus);
  }

  addShake(amount) {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /**
   * Alive: sit in close on the action. Dead: drift back for a spectator view.
   *
   * Pulling back also re-centres the camera on its own — a wider view shrinks
   * the follow limits, so the clamp in update() walks the focus toward the
   * middle of the arena without any special spectator-camera code.
   */
  setAlive(alive) {
    // A respawn punch briefly outranks this. The 'respawn' effect and the
    // alive=true state arrive in separate messages, so for a frame or two the
    // state can still read "dead" — without this guard the camera would yank
    // straight back out again mid-punch.
    if (!alive && this.punchTimer > 0) return;

    const target = alive ? ZOOM_ALIVE : ZOOM_DEAD;
    if (target === this.zoomTarget) return;
    this.zoomTarget = target;
    // Dying eases out slowly (you've got time, you're dead); living snaps in.
    this.zoomRate = alive ? ZOOM_RATE_IN : ZOOM_RATE_OUT;
  }

  /**
   * Respawn: slam the camera onto the player's new corner, tight, then let it
   * breathe back out. Without this you reappear somewhere across the map with
   * no visual cue and spend a second wondering which chicken is yours.
   */
  respawnPunch(x, z) {
    this.zoom = ZOOM_RESPAWN;
    this.zoomTarget = ZOOM_ALIVE;
    this.zoomRate = ZOOM_RATE_RESPAWN;
    this.punchTimer = PUNCH_LOCKOUT;

    // Cut straight to the new position instead of sliding across the arena.
    this.recomputeLimits();
    const lim = this.limits;
    this.focus.x = Math.max(-lim.x, Math.min(lim.x, x));
    this.focus.z = Math.max(lim.zMin, Math.min(lim.zMax, z));
    this.addShake(0.22);
  }

  update(dt, targetX, targetZ) {
    if (this.punchTimer > 0) this.punchTimer -= dt;

    if (Math.abs(this.zoom - this.zoomTarget) > 0.0005) {
      const zt = 1 - Math.exp(-this.zoomRate * dt);
      this.zoom += (this.zoomTarget - this.zoom) * zt;
      this.recomputeLimits(); // distance changed, so the follow limits did too
    }

    const lim = this.limits;
    const tx = Math.max(-lim.x, Math.min(lim.x, targetX));
    const tz = Math.max(lim.zMin, Math.min(lim.zMax, targetZ));

    const t = 1 - Math.exp(-CAM_LERP * dt); // frame-rate independent lerp
    this.focus.x += (tx - this.focus.x) * t;
    this.focus.z += (tz - this.focus.z) * t;

    let sx = 0;
    let sy = 0;
    if (this.shake > 0.001) {
      const s = this.shake * this.shake; // ease out — big hits punch, small ones nudge
      sx = (Math.random() * 2 - 1) * s * 1.6;
      sy = (Math.random() * 2 - 1) * s * 1.6;
      this.shake = Math.max(0, this.shake - dt * 2.6);
    }

    this.camera.position.set(this.focus.x + sx, this.height + sy, this.focus.z - this.back);
    this.camera.setTarget(this.focus);
  }
}

export { Vector3, Color3, Color4, Matrix, Quaternion, MeshBuilder, StandardMaterial };
