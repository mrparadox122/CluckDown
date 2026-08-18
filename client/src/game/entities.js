import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Color3 } from '@babylonjs/core/Maths/math';
import { emissiveMat, litMat } from './scene.js';
import { BOMBER, AMMO, POTATO, HEIST, BOMB } from '@cluckdown/shared';

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
    this.y = player.y ?? 0;
    this.z = player.z;
    this.aim = player.aim;
    // The waddle is tracked apart from `y` so the two can be added rather than
    // fighting over mesh.position.y — a bob written straight onto the mesh
    // would be overwritten by the jump height, and vice versa.
    this.bobY = 0;
    this.bob = Math.random() * Math.PI * 2;
    this.hidden = false;
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

    this.flame = MeshBuilder.CreateSphere('flame', { diameter: 1.5, segments: 8 }, scene);
    this.flame.material = emissiveMat(scene, 'flameMat', AMMO.fire.color, { intensity: 1.0, alpha: 0.5 });
    this.flame.parent = this.root;
    this.flame.position.y = 1.0;
    this.flame.isPickable = false;
    this.flame.setEnabled(false);

    // Bounty crown. A gold bar above the head reads instantly at this camera
    // angle, and it doubles as "shoot this one".
    this.crown = MeshBuilder.CreateBox('crown', { width: 0.62, height: 0.2, depth: 0.5 }, scene);
    this.crown.material = emissiveMat(scene, 'crownMat', '#ffcc3d', { intensity: 1.0 });
    this.crown.parent = this.root;
    this.crown.position.y = 2.15;
    this.crown.isPickable = false;
    this.crown.setEnabled(false);

    // Nemesis ring: whoever killed you last. Deliberately at ground level and
    // in a colour nothing else uses, so "that one owes me" is legible from
    // across the arena without competing with the crown above their head.
    this.grudge = MeshBuilder.CreateTorus('grudge', {
      diameter: 2.4, thickness: 0.11, tessellation: 22,
    }, scene);
    this.grudge.material = emissiveMat(scene, 'grudgeMat', '#ff4df0', { intensity: 1.0 });
    this.grudge.parent = this.root;
    this.grudge.position.y = 0.06;
    this.grudge.isPickable = false;
    this.grudge.setEnabled(false);
  }

  setVisible(v) {
    if (this.visible === v) return;
    this.visible = v;
    this.root.setEnabled(v && !this.hidden);
  }

  /**
   * Hides the body without touching alive/dead state.
   *
   * Used for your own chicken in first person, where the camera sits inside
   * the mesh and would otherwise render the inside of your own beak.
   */
  setHidden(h) {
    if (this.hidden === h) return;
    this.hidden = h;
    this.root.setEnabled(this.visible && !h);
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
    this.y += ((target.y ?? 0) - this.y) * lerpT;

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
      this.bobY = Math.abs(Math.sin(this.bob)) * 0.16;
      this.root.rotation.z = Math.sin(this.bob) * 0.09;
    } else {
      this.bob += dt * 2.4;
      this.bobY += (Math.sin(this.bob) * 0.03 - this.bobY) * 0.1;
      this.root.rotation.z *= 0.85;
    }
    // Jump height plus waddle. `this.y` is the simulation's; the bob is ours.
    this.root.position.y = this.y + this.bobY;

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

    // Fire damage keeps ticking after the shot, so it needs to be visible on
    // the victim rather than only in the damage numbers.
    if (this.flame) {
      this.flame.setEnabled(!!target.burning);
      if (target.burning) {
        this.flame.rotation.y += dt * 7;
        this.flame.scaling.setAll(0.9 + Math.abs(Math.sin(this.bob * 1.7)) * 0.35);
      }
    }

    if (this.crown) {
      this.crown.setEnabled(!!target.bounty);
      if (target.bounty) {
        this.crown.rotation.y += dt * 1.6;
        this.crown.position.y = 2.15 + Math.sin(this.bob * 0.8) * 0.06;
      }
    }

    if (this.grudge) {
      this.grudge.setEnabled(!!target.nemesis);
      if (target.nemesis) {
        this.grudge.rotation.y -= dt * 2.2;
        this.grudge.scaling.setAll(1 + Math.abs(Math.sin(this.bob * 1.1)) * 0.07);
      }
    }

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
    // Colour comes from the ammo table, so adding a type needs no change here.
    const COLORS = { health: '#35e07f', rapid: '#ffcc3d' };
    for (const id of Object.keys(AMMO)) COLORS[id] = AMMO[id].color;
    const hex = COLORS[pickup.type] ?? '#ffffff';

    this.mesh = MeshBuilder.CreateBox('pickup', {
      size: pickup.type === 'health' ? 0.85 : 0.75,
    }, scene);
    this.mesh.material = emissiveMat(scene, `pick_${pickup.type}`, hex, { intensity: 1.0 });
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


/** The cursed egg from the Hot Potato modifier. */
export class PotatoView {
  constructor(scene) {
    this.mesh = MeshBuilder.CreateSphere('potato', { diameter: 0.9, segments: 10 }, scene);
    this.mesh.material = emissiveMat(scene, 'potatoMat', '#ff8a3d', { intensity: 1.0, cache: false });
    this.mesh.isPickable = false;
    this.mesh.setEnabled(false);

    this.ring = MeshBuilder.CreateTorus('potatoRing', {
      diameter: POTATO.passRadius * 2, thickness: 0.09, tessellation: 24,
    }, scene);
    this.ring.material = emissiveMat(scene, 'potatoRingMat', '#ff8a3d', { intensity: 1.0, cache: false });
    this.ring.isPickable = false;
    this.ring.setEnabled(false);

    this.t = 0;
  }

  sync(pot, dt) {
    const on = !!pot;
    this.mesh.setEnabled(on);
    this.ring.setEnabled(on);
    if (!on) return;

    this.t += dt;
    // Strobes faster as the fuse burns down, so the panic scales with the timer.
    const urgency = 1 - Math.max(0, Math.min(1, pot.fuse / POTATO.fuse));
    const pulse = 1 + Math.abs(Math.sin(this.t * (4 + urgency * 22))) * 0.3;

    this.mesh.position.set(pot.x, 1.15, pot.z);
    this.mesh.scaling.setAll(pulse);
    this.mesh.rotation.y += dt * 3;

    // The ring shows exactly how close you must get to hand it on.
    this.ring.position.set(pot.x, 0.12, pot.z);
    this.ring.rotation.y += dt * 2;
    this.ring.scaling.setAll(0.9 + urgency * 0.2);
  }
}

/**
 * A nest: home base in Egg Heist, plant site in Plant & Defuse.
 *
 * The eggs sitting in it are real meshes rather than a number on the HUD,
 * because "their nest looks fat and mine looks empty" has to be readable from
 * across the arena — that glance is what starts a raid.
 */
export class NestView {
  constructor(scene, nest, color) {
    this.scene = scene;
    this.seat = nest.seat;
    this.color = color;
    this.eggs = [];
    this.t = Math.random() * 6;

    this.pad = MeshBuilder.CreateCylinder(`nestPad${nest.seat}`, {
      diameter: HEIST.nestRadius * 2, height: 0.07, tessellation: 28,
    }, scene);
    this.pad.position.set(nest.x, 0.04, nest.z);
    this.pad.material = emissiveMat(scene, `nestPadMat${nest.seat}`, color, {
      intensity: 0.5, alpha: 0.18, cache: false,
    });
    this.pad.isPickable = false;

    this.ring = MeshBuilder.CreateTorus(`nestRing${nest.seat}`, {
      diameter: HEIST.nestRadius * 2, thickness: 0.14, tessellation: 30,
    }, scene);
    this.ring.position.set(nest.x, 0.09, nest.z);
    this.ring.material = emissiveMat(scene, `nestRingMat${nest.seat}`, color, {
      intensity: 1.0, cache: false,
    });
    this.ring.isPickable = false;
  }

  /** Grows or shrinks the pile to match the count, reusing meshes. */
  setCount(n, x, z) {
    while (this.eggs.length < n) {
      const i = this.eggs.length;
      const egg = MeshBuilder.CreateSphere(`nestEgg${this.seat}_${i}`, {
        diameterX: 0.42, diameterY: 0.54, diameterZ: 0.42, segments: 8,
      }, this.scene);
      egg.material = emissiveMat(this.scene, 'eggMat', '#fff4d6', { intensity: 0.75 });
      egg.isPickable = false;
      this.eggs.push(egg);
    }
    while (this.eggs.length > n) this.eggs.pop().dispose();

    // Spiral outward so a big pile still reads as individual eggs.
    for (let i = 0; i < this.eggs.length; i++) {
      const a = i * 2.399; // golden angle, so nothing lines up
      const r = 0.28 + Math.sqrt(i) * 0.34;
      this.eggs[i].position.set(x + Math.cos(a) * r, 0.32, z + Math.sin(a) * r);
    }
  }

  /**
   * @param target true when this is somewhere the local player should be
   *               heading — a plantable nest while carrying the bomb, or one
   *               worth raiding. "Go to a rival nest" means nothing until one
   *               of them is lit up.
   */
  update(dt, nest, target = false) {
    this.t += dt;
    this.pad.position.set(nest.x, 0.04, nest.z);
    this.ring.position.set(nest.x, 0.09, nest.z);
    this.ring.rotation.y += dt * (target ? 1.6 : 0.4);
    // Breathe faster when the nest is nearly empty — that is when its owner
    // most needs to notice it.
    const panic = nest.eggs <= 1 ? 1 : 0;
    const beat = Math.abs(Math.sin(this.t * (target ? 5 : 1.2 + panic * 4)));
    this.pad.material.alpha = (target ? 0.26 : 0.14) + beat * 0.12;
    this.ring.scaling.setAll(target ? 1 + beat * 0.06 : 1);
    this.setCount(Math.min(nest.eggs, 12), nest.x, nest.z);
  }

  dispose() {
    for (const e of this.eggs) e.dispose();
    this.pad.dispose();
    this.ring.dispose();
  }
}

/** A single egg on the floor, dropped by a carrier who died. */
export class LooseEggView {
  constructor(scene) {
    this.mesh = MeshBuilder.CreateSphere('looseEgg', {
      diameterX: 0.46, diameterY: 0.58, diameterZ: 0.46, segments: 8,
    }, scene);
    this.mesh.material = emissiveMat(scene, 'looseEggMat', '#fff4d6', { intensity: 1.0, cache: false });
    this.mesh.isPickable = false;
    this.t = Math.random() * 6;
  }

  update(dt, egg) {
    this.t += dt;
    this.mesh.position.set(egg.x, 0.45 + Math.sin(this.t * 2.4) * 0.12, egg.z);
    this.mesh.rotation.y += dt * 1.6;
    // Flash as it is about to walk itself home, so a nearby player knows the
    // window is closing.
    const soon = egg.returnAt < 4;
    this.mesh.material.emissiveColor.copyFrom(
      Color3.FromHexString(soon && Math.sin(this.t * 12) > 0 ? '#ffb347' : '#fff4d6'),
    );
  }

  dispose() { this.mesh.dispose(); }
}

/**
 * The bomb in Plant & Defuse.
 *
 * One object with three very different jobs — lying around, being carried, and
 * ticking down in someone's nest — so its look changes with its state rather
 * than relying on the HUD to explain which is which.
 */
export class BombView {
  constructor(scene) {
    this.mesh = MeshBuilder.CreateBox('bomb', { size: 0.85 }, scene);
    this.mesh.material = emissiveMat(scene, 'bombMat', '#ff3b30', { intensity: 1.0, cache: false });
    this.mesh.isPickable = false;
    this.mesh.setEnabled(false);

    this.ring = MeshBuilder.CreateTorus('bombRing', {
      diameter: BOMB.blastRadius * 2, thickness: 0.16, tessellation: 40,
    }, scene);
    this.ring.material = emissiveMat(scene, 'bombRingMat', '#ff3b30', {
      intensity: 1.0, alpha: 0.5, cache: false,
    });
    this.ring.isPickable = false;
    this.ring.setEnabled(false);

    this.t = 0;
  }

  sync(bomb, dt) {
    const on = !!bomb;
    this.mesh.setEnabled(on);
    if (!on) {
      this.ring.setEnabled(false);
      return;
    }

    this.t += dt;
    const planted = bomb.state === 'planted';
    // Once planted the strobe tracks the fuse, so the panic is legible without
    // reading a number.
    const urgency = planted ? 1 - Math.max(0, Math.min(1, bomb.fuse / BOMB.fuse)) : 0;
    const rate = planted ? 4 + urgency * 24 : 3;

    this.mesh.position.set(bomb.x, planted ? 0.6 : 0.9, bomb.z);
    this.mesh.rotation.y += dt * (planted ? 1 : 2.4);
    this.mesh.scaling.setAll(1 + Math.abs(Math.sin(this.t * rate)) * (planted ? 0.28 : 0.12));
    this.mesh.material.emissiveColor.copyFrom(
      Color3.FromHexString(planted ? '#ff2d1a' : '#ffb020'),
    );

    // The blast radius is only worth drawing once it can actually hurt you.
    this.ring.setEnabled(planted);
    if (planted) {
      this.ring.position.set(bomb.x, 0.12, bomb.z);
      this.ring.rotation.y += dt * 0.7;
      this.ring.material.alpha = 0.25 + urgency * 0.45;
    }
  }

  dispose() {
    this.mesh.dispose();
    this.ring.dispose();
  }
}
