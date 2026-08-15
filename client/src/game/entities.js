import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Vector3, Color3 } from '@babylonjs/core/Maths/math';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { emissiveMat, litMat } from './scene.js';
import { PLAYER, BOMBER, PICKUP } from '@cluckdown/shared';

/**
 * A chicken, assembled from boxes then baked down to a SINGLE mesh.
 *
 * The parts are still authored separately — body, head, beak, comb, tail, feet,
 * eyes — because stacked cubes are what make the silhouette read as a chicken.
 * But they are merged before anything renders, with each part's colour written
 * into vertex colours so one material covers the whole bird.
 *
 * This matters more than it looks: unmerged, four players plus the bomber cost
 * ~50 draw calls before a single bullet is drawn, and draw-call overhead is a
 * far bigger deal on mobile than on desktop. Merged, it's one call each.
 *
 * The material is deliberately NOT shared between chickens: the body flashes on
 * hit and the bomber strobes while armed, both by mutating emissiveColor, so a
 * shared material would flash every bird at once.
 */
export function buildChicken(scene, { color = '#f2f2f2', dark = false, scale = 1 } = {}) {
  const BODY = dark ? '#14141c' : color;
  const BEAK = '#ff9f1c';
  const COMB = '#ff2d4b';
  const EYE = dark ? '#ff2d4b' : '#101018';

  // [name, dimensions, position, colour]
  const parts = [
    ['body', { width: 1.15, height: 1.0, depth: 1.0 }, [0, 0.62, 0], BODY],
    ['head', { width: 0.74, height: 0.66, depth: 0.66 }, [0, 1.38, 0.16], BODY],
    ['beak', { width: 0.24, height: 0.2, depth: 0.34 }, [0, 1.3, 0.62], BEAK],
    ['comb', { width: 0.16, height: 0.3, depth: 0.5 }, [0, 1.79, 0.1], COMB],
    ['wattle', { width: 0.14, height: 0.22, depth: 0.14 }, [0, 1.1, 0.52], COMB],
    ['tail', { width: 0.7, height: 0.55, depth: 0.28 }, [0, 1.0, -0.6], BODY],
    ['footL', { width: 0.18, height: 0.22, depth: 0.42 }, [-0.28, 0.1, 0.06], BEAK],
    ['footR', { width: 0.18, height: 0.22, depth: 0.42 }, [0.28, 0.1, 0.06], BEAK],
    ['eyeL', { size: 0.13 }, [-0.22, 1.46, 0.46], EYE],
    ['eyeR', { size: 0.13 }, [0.22, 1.46, 0.46], EYE],
  ];

  // +Z is "forward" — the sim's aim angle is atan2(x, z), so the beak points
  // down +Z and rotation.y maps straight onto rotation with no offset fudging.
  const pieces = parts.map(([name, dims, pos, hex]) => {
    const m = MeshBuilder.CreateBox(name, dims, scene);
    m.position.set(pos[0], pos[1], pos[2]);
    tint(m, hex);
    return m;
  });

  // disposeSource, allow32Bit, meshSubclass, subdivide, multiMaterial=false —
  // one material is the whole point.
  const root = Mesh.MergeMeshes(pieces, true, true, undefined, false, false);
  root.name = 'chicken';
  root.isPickable = false;

  // White diffuse so the baked vertex colours come through unmodified.
  const bodyMat = litMat(scene, `chicken_${color}_${dark ? 'd' : 'l'}`, '#ffffff', {
    emissive: dark ? 0.1 : 0.13,
    cache: false, // mutated per instance for the hit flash / bomber strobe
  });
  root.material = bodyMat;
  root.scaling.setAll(scale);

  return { root, bodyMat };
}

/** Writes a flat colour into a mesh's vertex colour buffer. */
function tint(mesh, hex) {
  const c = Color3.FromHexString(hex);
  const count = mesh.getTotalVertices();
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    colors[i * 4 + 0] = c.r;
    colors[i * 4 + 1] = c.g;
    colors[i * 4 + 2] = c.b;
    colors[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

/** Per-player view: mesh, bob animation, hit flash, and spawn-shield bubble. */
export class PlayerView {
  constructor(scene, player) {
    this.scene = scene;
    this.id = player.id;
    this.color = player.color;
    const built = buildChicken(scene, { color: player.color });
    this.root = built.root;
    this.bodyMat = built.bodyMat;
    this.baseEmissive = this.bodyMat.emissiveColor.clone();

    this.x = player.x;
    this.z = player.z;
    this.aim = player.aim;
    this.bob = Math.random() * Math.PI * 2;
    this.flash = 0;
    this.visible = true;

    this.shield = MeshBuilder.CreateSphere('shield', { diameter: 2.3, segments: 10 }, scene);
    this.shield.material = emissiveMat(scene, 'shieldMat', '#8ecae6', { intensity: 0.5, alpha: 0.22 });
    this.shield.parent = this.root;
    this.shield.position.y = 0.85;
    this.shield.isPickable = false;
    this.shield.setEnabled(false);

    // Gold aura while rapid-fire is active.
    this.aura = MeshBuilder.CreateTorus('aura', { diameter: 2.0, thickness: 0.09, tessellation: 18 }, scene);
    this.aura.material = emissiveMat(scene, 'auraMat', '#ffcc3d', { intensity: 1.0 });
    this.aura.parent = this.root;
    this.aura.position.y = 0.12;
    this.aura.isPickable = false;
    this.aura.setEnabled(false);
  }

  setVisible(v) {
    if (this.visible === v) return;
    this.visible = v;
    this.root.setEnabled(v);
  }

  hit() { this.flash = 1; }

  /**
   * @param moving whether to play the waddle bob
   * @param lerpT  0..1 smoothing factor; 1 means snap (used for the local
   *               player, which is already predicted and needs no smoothing)
   */
  update(dt, target, { moving, lerpT }) {
    this.x += (target.x - this.x) * lerpT;
    this.z += (target.z - this.z) * lerpT;

    // Shortest-path angle interpolation, so turning past ±180° doesn't spin.
    let d = (target.aim - this.aim) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.aim += d * Math.min(1, lerpT * 1.6);

    this.root.position.x = this.x;
    this.root.position.z = this.z;
    this.root.rotation.y = this.aim;

    // Waddle: bounce vertically and rock side to side while moving.
    if (moving) {
      this.bob += dt * 13;
      this.root.position.y = Math.abs(Math.sin(this.bob)) * 0.16;
      this.root.rotation.z = Math.sin(this.bob) * 0.09;
    } else {
      this.bob += dt * 2.4;
      this.root.position.y += (Math.sin(this.bob) * 0.03 - this.root.position.y) * 0.1;
      this.root.rotation.z *= 0.85;
    }

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 5);
      const f = this.flash;
      this.bodyMat.emissiveColor.set(
        this.baseEmissive.r + f * 1.6,
        this.baseEmissive.g + f * 0.15,
        this.baseEmissive.b + f * 0.25,
      );
    }

    this.shield.setEnabled(!!target.invuln);
    if (target.invuln) this.shield.rotation.y += dt * 2;

    this.aura.setEnabled(!!target.rapid);
    if (target.rapid) {
      this.aura.rotation.y += dt * 5;
      this.aura.position.y = 0.12 + Math.sin(this.bob * 0.6) * 0.06;
    }
  }

  dispose() {
    this.root.dispose(false, true);
  }
}

/** The black chicken bomber: same silhouette, menacing paint job. */
export class BomberView {
  constructor(scene) {
    const built = buildChicken(scene, { color: '#14141c', dark: true, scale: 1.25 });
    this.root = built.root;
    this.bodyMat = built.bodyMat;
    this.x = 0;
    this.z = 0;
    this.aim = 0;
    this.bob = 0;
    this.pulse = 0;

    // Red danger ring that flares while the fuse is burning.
    this.ring = MeshBuilder.CreateTorus('bomberRing', { diameter: 2.6, thickness: 0.12, tessellation: 22 }, scene);
    this.ring.material = emissiveMat(scene, 'bomberRingMat', '#ff2d4b', { intensity: 1.0 });
    this.ring.parent = this.root;
    this.ring.position.y = 0.1;
    this.ring.isPickable = false;

    this.root.setEnabled(false);
  }

  setActive(v) { this.root.setEnabled(v); }

  sync(b, dt, lerpT) {
    this.x += (b.x - this.x) * lerpT;
    this.z += (b.z - this.z) * lerpT;
    let d = (b.aim - this.aim) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.aim += d * Math.min(1, lerpT * 1.4);

    this.root.position.x = this.x;
    this.root.position.z = this.z;
    this.root.rotation.y = this.aim;

    this.bob += dt * (b.state === 'arm' ? 22 : 11);
    this.root.position.y = Math.abs(Math.sin(this.bob)) * 0.2;

    // Armed: strobe faster as the fuse runs down, so panic scales with danger.
    if (b.state === 'arm') {
      const urgency = 1 - b.fuse / BOMBER.fuse;
      this.pulse += dt * (5 + urgency * 26);
      const glow = 0.5 + Math.abs(Math.sin(this.pulse)) * (1.6 + urgency * 2.4);
      this.bodyMat.emissiveColor.set(glow, glow * 0.06, glow * 0.12);
      const s = 1 + Math.abs(Math.sin(this.pulse)) * 0.14 * (0.4 + urgency);
      this.root.scaling.setAll(1.25 * s);
      this.ring.scaling.setAll(1 + urgency * 0.5);
      this.ring.setEnabled(true);
    } else {
      this.bodyMat.emissiveColor.set(0.16, 0.02, 0.04);
      this.root.scaling.setAll(1.25);
      this.ring.setEnabled(false);
    }
    this.ring.rotation.y += dt * 3;
  }
}

/** Floating, spinning pickup cube. */
export class PickupView {
  constructor(scene, pickup) {
    this.id = pickup.id;
    this.type = pickup.type;
    const isHealth = pickup.type === 'health';
    this.mesh = MeshBuilder.CreateBox('pickup', { size: isHealth ? 0.85 : 0.75 }, scene);
    this.mesh.material = emissiveMat(
      scene,
      isHealth ? 'pickHealth' : 'pickRapid',
      isHealth ? '#35e07f' : '#ffcc3d',
      { intensity: 1.5 },
    );
    this.mesh.position.set(pickup.x, 1, pickup.z);
    this.mesh.isPickable = false;
    this.t = Math.random() * 10;
  }

  update(dt) {
    this.t += dt;
    this.mesh.rotation.y += dt * 1.8;
    this.mesh.rotation.x += dt * 0.9;
    this.mesh.position.y = 1 + Math.sin(this.t * 2.4) * 0.22;
  }

  dispose() { this.mesh.dispose(); }
}
