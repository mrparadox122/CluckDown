import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math';
import { emissiveMat } from './scene.js';
import { BULLET, BOMBER, AMMO } from '@cluckdown/shared';

const GRAVITY = -26;

/**
 * Glowing bullet tracers.
 *
 * Bullets aren't networked — the server sends `shot` (with an id) and later
 * `bulletEnd` for that same id. In between, every client runs the identical
 * straight-line motion, so the visual matches the authoritative path exactly
 * while costing two tiny messages instead of a synced entity.
 *
 * Each tracer is a stretched, unlit sphere: elongating it along the direction
 * of travel fakes motion blur far more cheaply than a particle trail, and the
 * GlowLayer turns it into the red streak.
 */
export class BulletPool {
  constructor(scene, glow, max = 220) {
    this.scene = scene;
    this.active = new Map(); // id -> tracer

    // One prototype per ammo type. Ammo is readable at a glance from the tracer
    // colour alone, which matters more than it sounds when three people are
    // firing at once.
    this.protos = {};
    this.pools = {};
    const kinds = { none: '#ff2038' };
    for (const id of Object.keys(AMMO)) kinds[id] = AMMO[id].color;

    for (const [id, hex] of Object.entries(kinds)) {
      const proto = MeshBuilder.CreateSphere(`bullet_${id}`, {
        diameter: BULLET.radius * 2, segments: 6,
      }, scene);
      proto.material = emissiveMat(scene, `bulletMat_${id}`, hex, { intensity: 1.0 });
      proto.isPickable = false;
      proto.setEnabled(false);
      glow?.addIncludedOnlyMesh(proto);

      const free = [];
      for (let i = 0; i < Math.ceil(max / 4); i++) {
        const m = proto.createInstance(`b_${id}_${i}`);
        m.isPickable = false;
        m.setEnabled(false);
        free.push(m);
      }
      this.protos[id] = proto;
      this.pools[id] = free;
    }
  }

  spawn(ev) {
    const kind = this.pools[ev.ammo] ? ev.ammo : 'none';
    const mesh = this.pools[kind].pop();
    if (!mesh) return; // pool exhausted — drop the visual rather than stutter
    mesh.setEnabled(true);
    const dx = Math.sin(ev.aim);
    const dz = Math.cos(ev.aim);
    mesh.position.set(ev.x, 0.85, ev.z);
    mesh.rotation.y = ev.aim;
    mesh.scaling.set(0.85, 0.85, 3.2); // stretched along travel = tracer streak
    this.active.set(ev.id, {
      mesh, kind, aim: ev.aim,
      vx: dx * BULLET.speed, vz: dz * BULLET.speed, life: BULLET.life,
    });
  }

  /**
   * Redirects a live tracer — used when a bouncy round ricochets. Without this
   * the visual would carry straight on through the wall while the authoritative
   * bullet went the other way.
   */
  redirect(id, x, z) {
    const t = this.active.get(id);
    if (!t) return;
    // Reflect off whichever axis the impact was on, matching the simulation.
    if (Math.abs(x) > Math.abs(z)) t.vx = -t.vx; else t.vz = -t.vz;
    t.mesh.position.set(x, 0.85, z);
    t.aim = Math.atan2(t.vx, t.vz);
    t.mesh.rotation.y = t.aim;
  }

  /** Retire a specific tracer — called when the server says that bullet landed. */
  end(id) {
    const t = this.active.get(id);
    if (!t) return null;
    this.active.delete(id);
    t.mesh.setEnabled(false);
    this.pools[t.kind].push(t.mesh);
    return t;
  }

  update(dt) {
    for (const [id, t] of this.active) {
      t.life -= dt;
      if (t.life <= 0) { this.end(id); continue; }
      t.mesh.position.x += t.vx * dt;
      t.mesh.position.z += t.vz * dt;
    }
  }
}

/**
 * Pooled cube debris — death explosions, feather bursts, impact sparks and the
 * bomber blast all reduce to "spawn N cubes with a velocity and let them fall",
 * so they share one system.
 *
 * These are thin instances rather than InstancedMesh. An InstancedMesh is a
 * full scene node: parent chain, world matrix, bounding info, all recomputed
 * per frame. With hundreds of short-lived particles that overhead dominates the
 * actual physics. Thin instances are just rows in a matrix buffer, so the cost
 * is the maths we genuinely need and nothing else.
 */
export class DebrisPool {
  constructor(scene, glow, perColour = 90, gravityMul = 1) {
    this.kinds = {};
    this.gravity = GRAVITY * gravityMul;

    for (const [key, hex, intensity] of [
      ['white', '#ffffff', 0.32],
      ['red', '#ff2038', 1.0],
      ['gold', '#ffcc3d', 1.0],
      ['green', '#35e07f', 1.0],
    ]) {
      const mesh = MeshBuilder.CreateBox(`debris_${key}`, { size: 0.3 }, scene);
      mesh.material = emissiveMat(scene, `debrisMat_${key}`, hex, { intensity });
      mesh.isPickable = false;
      // Thin-instance bounds aren't maintained as particles fly around, so opt
      // out of culling instead of paying to refresh the bounding box.
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.doNotSyncBoundingInfo = true;

      const buffer = new Float32Array(perColour * 16);
      mesh.thinInstanceSetBuffer('matrix', buffer, 16, false); // false = updatable
      mesh.thinInstanceCount = 0;

      if (key !== 'white') glow?.addIncludedOnlyMesh(mesh);
      this.kinds[key] = { mesh, buffer, cap: perColour, live: [] };
    }

    // Scratch objects, reused every particle every frame — allocating these in
    // the update loop would hand the GC a few thousand objects a second.
    this._scale = new Vector3();
    this._pos = new Vector3();
    this._quat = new Quaternion();
    this._mat = new Matrix();
  }

  emit(kind, x, y, z, count, opts = {}) {
    const pool = this.kinds[kind];
    if (!pool) return;
    const {
      speed = 7, spread = 1, up = 1, size = 1, life = 0.9, drag = 0.6, flutter = 0,
    } = opts;

    for (let i = 0; i < count; i++) {
      if (pool.live.length >= pool.cap) return; // full — drop rather than stutter
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.45 + Math.random() * 0.85);
      pool.live.push({
        x, y, z,
        vx: Math.cos(a) * sp * spread,
        vy: (0.5 + Math.random()) * sp * up,
        vz: Math.sin(a) * sp * spread,
        rotX: Math.random() * 3, rotY: Math.random() * 3, rotZ: Math.random() * 3,
        rx: (Math.random() - 0.5) * 14,
        ry: (Math.random() - 0.5) * 14,
        size: size * (0.5 + Math.random() * 0.9),
        life,
        maxLife: life,
        drag,
        flutter,
      });
    }
  }

  /** Feathers: light, slow, and they drift instead of falling like bricks. */
  feathers(x, y, z, count = 6) {
    this.emit('white', x, y, z, count, {
      speed: 3.4, up: 1.3, size: 0.55, life: 1.5, drag: 2.6, flutter: 1,
    });
  }

  update(dt) {
    for (const key of Object.keys(this.kinds)) {
      const pool = this.kinds[key];
      const { live, buffer } = pool;

      for (let i = live.length - 1; i >= 0; i--) {
        const d = live[i];
        d.life -= dt;
        if (d.life <= 0) {
          // Swap-remove: order is irrelevant and it avoids an O(n) splice.
          live[i] = live[live.length - 1];
          live.pop();
          continue;
        }

        const damp = Math.exp(-d.drag * dt);
        d.vx *= damp;
        d.vz *= damp;
        d.vy += this.gravity * dt * (d.flutter ? 0.16 : 1);
        if (d.flutter) {
          // Sideways wobble so feathers spiral down rather than drop straight.
          d.vx += Math.sin(d.life * 9 + d.ry) * 2.2 * dt;
          d.vz += Math.cos(d.life * 8 + d.rx) * 2.2 * dt;
        }

        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.z += d.vz * dt;

        // Bounce off the floor once, with a lot of energy lost.
        if (d.y < 0.15) {
          d.y = 0.15;
          d.vy = Math.abs(d.vy) * 0.32;
          d.vx *= 0.7;
          d.vz *= 0.7;
        }

        d.rotX += d.rx * dt;
        d.rotY += d.ry * dt;

        // Shrink out over the last third of life instead of alpha-fading,
        // which would need transparency sorting.
        const t = d.life / d.maxLife;
        if (t < 0.35) d.size = Math.max(0.001, d.size * (1 - dt * 5));
      }

      // Write the surviving particles into the front of the matrix buffer and
      // only render that many.
      for (let i = 0; i < live.length; i++) {
        const d = live[i];
        this._scale.setAll(d.size);
        this._pos.set(d.x, d.y, d.z);
        Quaternion.FromEulerAnglesToRef(d.rotX, d.rotY, d.rotZ, this._quat);
        Matrix.ComposeToRef(this._scale, this._quat, this._pos, this._mat);
        this._mat.copyToArray(buffer, i * 16);
      }

      pool.mesh.thinInstanceCount = live.length;
      if (live.length) pool.mesh.thinInstanceBufferUpdated('matrix');
    }
  }
}

/** Expanding shockwave ring for the bomber blast. */
export class BlastRings {
  constructor(scene, glow, max = 4) {
    this.rings = [];
    for (let i = 0; i < max; i++) {
      const m = MeshBuilder.CreateTorus(`blast${i}`, { diameter: 2, thickness: 0.35, tessellation: 26 }, scene);
      // Shared material — the per-ring fade uses mesh.visibility instead of
      // material.alpha, so four rings don't need four materials.
      m.material = emissiveMat(scene, 'blastMat', '#ff5a2d', { intensity: 1.0, alpha: 0.85 });
      m.rotation.x = 0;
      m.isPickable = false;
      m.setEnabled(false);
      glow?.addIncludedOnlyMesh(m);
      this.rings.push({ m, life: 0 });
    }
    this.cursor = 0;
  }

  fire(x, z, radius = BOMBER.blastRadius) {
    const r = this.rings[this.cursor++ % this.rings.length];
    r.m.setEnabled(true);
    r.m.position.set(x, 0.5, z);
    r.m.scaling.setAll(0.2);
    r.life = 0.55;
    r.maxLife = 0.55;
    r.radius = radius;
  }

  update(dt) {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.m.setEnabled(false); continue; }
      const t = 1 - r.life / r.maxLife;
      r.m.scaling.setAll(0.2 + t * r.radius);
      r.m.visibility = 1 - t;
    }
  }
}

/** Brief bright flash at the muzzle when a shot goes off. */
export class MuzzleFlash {
  constructor(scene, glow, max = 8) {
    this.items = [];
    for (let i = 0; i < max; i++) {
      const m = MeshBuilder.CreateSphere(`muzzle${i}`, { diameter: 0.9, segments: 6 }, scene);
      m.material = emissiveMat(scene, 'muzzleMat', '#ffb03a', { intensity: 1.0 });
      m.isPickable = false;
      m.setEnabled(false);
      glow?.addIncludedOnlyMesh(m);
      this.items.push({ m, life: 0 });
    }
    this.cursor = 0;
  }

  fire(x, z) {
    const it = this.items[this.cursor++ % this.items.length];
    it.m.setEnabled(true);
    it.m.position.set(x, 0.85, z);
    it.m.scaling.setAll(1);
    it.life = 0.07;
  }

  update(dt) {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.m.setEnabled(false); continue; }
      it.m.scaling.setAll(Math.max(0.05, it.m.scaling.x - dt * 14));
    }
  }
}
