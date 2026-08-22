import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Color3 } from '@babylonjs/core/Maths/math';
import { emissiveMat, litMat } from './scene.js';
import { BOMBER, POTATO, HEIST, BOMB, rungOf } from '@cluckdown/shared';
import { BEAK } from './view.js';

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
/**
 * How each badge is built, called the first time a chicken actually wears one.
 *
 * A table rather than six blocks in the constructor because the point is that
 * they are NOT built in the constructor — see PlayerView.badge. Position and
 * look are unchanged from when they were; only the moment of creation moved.
 */
const BADGES = {
  /** Spawn protection. */
  shield(scene) {
    const m = MeshBuilder.CreateSphere('shield', { diameter: 2.3, segments: 10 }, scene);
    m.material = emissiveMat(scene, 'shieldMat', '#8ecae6', { intensity: 0.5, alpha: 0.22 });
    m.position.y = 0.85;
    return m;
  },

  // The rung aura. It was the rapid-fire pickup's; it now marks anyone high
  // up the pecking order, which is a far better use of it — a ring at ground
  // level is legible from across the arena and from any angle, and "that one
  // is dangerous" is exactly what it should be saying.
  aura(scene) {
    const m = MeshBuilder.CreateTorus('aura', { diameter: 2.0, thickness: 0.09, tessellation: 18 }, scene);
    // cache:false — recoloured per wearer by rung, so a shared material would
    // repaint everyone else's ring to the last one set.
    m.material = emissiveMat(scene, 'auraMat', '#ffcc3d', { intensity: 1.0, cache: false });
    m.position.y = 0.12;
    return m;
  },

  // Second Wind and Feeding Frenzy both flare this. Kept from the old fire
  // ammo, recoloured per burst: it is the only "something is happening to
  // that chicken RIGHT NOW" shape the renderer has.
  flame(scene) {
    const m = MeshBuilder.CreateSphere('flame', { diameter: 1.5, segments: 8 }, scene);
    m.material = emissiveMat(scene, 'flameMat', '#ff8a3d', { intensity: 1.0, alpha: 0.5, cache: false });
    m.position.y = 1.0;
    return m;
  },

  // SPOTTED, by a Scout sweep. A chevron above the head that draws THROUGH
  // walls, which is the whole point of the ability.
  //
  // The trick is renderingGroupId, not a depth hack: Babylon clears the depth
  // buffer between rendering groups, so anything in a later group is drawn on
  // top of everything in an earlier one. That is one property instead of a
  // custom material with depthFunction ALWAYS, and it survives the glow layer.
  spot(scene) {
    const m = MeshBuilder.CreatePolyhedron('spot', { type: 0, size: 0.19 }, scene);
    m.material = emissiveMat(scene, 'spotMat', '#c77dff', { intensity: 1.0 });
    m.position.y = 2.5;
    m.renderingGroupId = 2;
    return m;
  },

  // Bounty crown. A gold bar above the head reads instantly at this camera
  // angle, and it doubles as "shoot this one".
  crown(scene) {
    const m = MeshBuilder.CreateBox('crown', { width: 0.62, height: 0.2, depth: 0.5 }, scene);
    m.material = emissiveMat(scene, 'crownMat', '#ffcc3d', { intensity: 1.0 });
    m.position.y = 2.15;
    return m;
  },

  // Nemesis ring: whoever killed you last. Deliberately at ground level and
  // in a colour nothing else uses, so "that one owes me" is legible from
  // across the arena without competing with the crown above their head.
  grudge(scene) {
    const m = MeshBuilder.CreateTorus('grudge', {
      diameter: 2.4, thickness: 0.11, tessellation: 22,
    }, scene);
    m.material = emissiveMat(scene, 'grudgeMat', '#ff4df0', { intensity: 1.0 });
    m.position.y = 0.06;
    return m;
  },
};

/** The two badges above that mint their own material and must clean it up. */
const OWNED_MATERIALS = ['aura', 'flame'];

export class PlayerView {
  constructor(scene, player, opts = {}) {
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
    // How far into the peck animation this chicken is, 0..1. Eased rather than
    // switched: a body that snaps to head-down reads as a glitch, and this
    // pose is the single most important piece of information one player can
    // read off another.
    this.peck = 0;
    this.hidden = false;
    this.flash = 0;
    this.visible = true;

    // --- the six badges, and why none of them is built yet.
    //
    // A chicken can wear a spawn shield, a rung aura, a perk flame, a Scout
    // chevron, a bounty crown and a nemesis ring. Building all six per player
    // meant 48 meshes and ~30 materials standing in an eight-player scene, and
    // Babylon walks every mesh in the scene each frame to decide what is
    // active — disabled or not. It measured as the third-largest single entry
    // in the renderer's own profile.
    //
    // Almost none of them are ever worn. Most players are below the aura's
    // rung, one player at a time carries the bounty, a nemesis ring needs
    // somebody to have killed you, and a Scout chevron needs a Scout. So each
    // one is built the first time it is actually switched on, and from then on
    // it belongs to that chicken. Nothing about how they look or behave
    // changes; the ones nobody wears simply never come into existence.
    //
    // `badges` holds what has been built so dispose and the enable path do not
    // have to know the list twice.
    this.badges = {};
    this.wearsAura = opts.aura !== false;
  }

  /**
   * Builds a badge on first use and returns it, or returns the built one.
   *
   * @param want false to leave it unbuilt — asking for a badge that is off is
   *             the common case, and the whole point is that it costs nothing.
   */
  badge(name, want) {
    const have = this.badges[name];
    if (have) return have;
    if (!want) return null;
    const m = BADGES[name](this.scene);
    m.parent = this.root;
    m.isPickable = false;
    this.badges[name] = m;
    return m;
  }

  /**
   * Enable/disable a badge, building it only when something wants it on.
   *
   * `isEnabled(false)` — do NOT check ancestors. A badge is parented to the
   * chicken, and the chicken is disabled while dead and while it is your own
   * body in first person, so the inherited answer is "off" even when this
   * badge's own flag says on. Comparing against the inherited value would set
   * the flag it already holds, every frame, for the whole time you are alive
   * and looking down your own beak.
   */
  setBadge(name, on) {
    const m = this.badge(name, on);
    if (!m) return null;
    if (m.isEnabled(false) !== !!on) m.setEnabled(!!on);
    return on ? m : null;
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

    // --- pecking, which is what a reload looks like from the outside.
    //
    // The whole design of the crop rests on this being obvious across the
    // arena: a chicken with its head in the dirt cannot shoot back, and seeing
    // that is what turns "they stopped moving" into a decision. So it is a
    // big, unmistakable pose — nose down, tail up, bobbing — rather than a
    // subtle animation that only reads at three metres.
    const wantPeck = target.pecking || target.feeding ? 1 : 0;
    this.peck += (wantPeck - this.peck) * Math.min(1, dt * 12);
    if (this.peck > 0.01) {
      const dip = Math.abs(Math.sin(this.bob * 2.2));
      this.root.rotation.x = this.peck * (0.5 + dip * 0.35);
      this.root.position.y += this.peck * -0.08;
      this.bob += dt * 9;
    } else if (this.root.rotation.x !== 0) {
      this.root.rotation.x = 0;
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

    const shield = this.setBadge('shield', !!target.invuln);
    if (shield) shield.rotation.y += dt * 2;

    // Fire damage keeps ticking after the shot, so it needs to be visible on
    // the victim rather than only in the damage numbers.
    //
    // A burst perk is running: Second Wind (orange) or Feeding Frenzy (pink).
    const burst = target.frenzy ? '#ff4df0' : (target.wind ? '#ff8a3d' : null);
    const flame = this.setBadge('flame', !!burst);
    if (flame) {
      if (this.flameHex !== burst) {
        this.flameHex = burst;
        flame.material.emissiveColor.copyFrom(Color3.FromHexString(burst));
      }
      flame.rotation.y += dt * 7;
      flame.scaling.setAll(0.9 + Math.abs(Math.sin(this.bob * 1.7)) * 0.35);
    }

    const crown = this.setBadge('crown', !!target.bounty);
    if (crown) {
      crown.rotation.y += dt * 1.6;
      crown.position.y = 2.15 + Math.sin(this.bob * 0.8) * 0.06;
    }

    const spot = this.setBadge('spot', !!target.spotted);
    if (spot) {
      spot.rotation.y += dt * 3;
      spot.position.y = 2.5 + Math.sin(this.bob * 1.4) * 0.09;
    }

    const grudge = this.setBadge('grudge', !!target.nemesis);
    if (grudge) {
      grudge.rotation.y -= dt * 2.2;
      grudge.scaling.setAll(1 + Math.abs(Math.sin(this.bob * 1.1)) * 0.07);
    }

    // Rung 4 and up wear the ring, tinted by rung. Below that the ladder is
    // still readable off the nameplate — an aura on everyone is an aura on
    // nobody.
    //
    // `wearsAura` is also the low-graphics cut. It is the one badge a whole
    // lobby can be wearing at once late in a match, which makes it the only
    // one whose cost scales with how well the match is going.
    const lvl = target.level ?? 1;
    const aura = this.setBadge('aura', this.wearsAura && lvl >= 4);
    if (aura) {
      if (this.auraLevel !== lvl) {
        this.auraLevel = lvl;
        aura.material.emissiveColor.copyFrom(Color3.FromHexString(rungOf(lvl).color));
      }
      aura.rotation.y += dt * 5;
      aura.position.y = 0.12 + Math.sin(this.bob * 0.6) * 0.06;
    }
  }

  dispose() {
    // Materials are NOT swept up with the mesh: emissiveMat hands out a shared,
    // per-scene instance for everything except the two badges that recolour
    // themselves, so disposing them here would take the crown off every other
    // chicken the moment one player left mid-match. The scene owns the shared
    // ones and drops them all when the match ends.
    for (const name of OWNED_MATERIALS) this.badges[name]?.material?.dispose();
    this.root.dispose(false, false);
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
    // Health is the only pickup left on the floor; the shooting power-ups were
    // replaced by the pecking order, which you earn rather than find.
    const COLORS = { health: '#35e07f' };
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
    this.team = nest.team;
    this.color = color;
    this.eggs = [];
    this.t = Math.random() * 6;

    this.pad = MeshBuilder.CreateCylinder(`nestPad${nest.team}`, {
      diameter: HEIST.nestRadius * 2, height: 0.07, tessellation: 28,
    }, scene);
    this.pad.position.set(nest.x, 0.04, nest.z);
    this.pad.material = emissiveMat(scene, `nestPadMat${nest.team}`, color, {
      intensity: 0.5, alpha: 0.18, cache: false,
    });
    this.pad.isPickable = false;

    this.ring = MeshBuilder.CreateTorus(`nestRing${nest.team}`, {
      diameter: HEIST.nestRadius * 2, thickness: 0.14, tessellation: 30,
    }, scene);
    this.ring.position.set(nest.x, 0.09, nest.z);
    this.ring.material = emissiveMat(scene, `nestRingMat${nest.team}`, color, {
      intensity: 1.0, cache: false,
    });
    this.ring.isPickable = false;
  }

  /** Grows or shrinks the pile to match the count, reusing meshes. */
  setCount(n, x, z) {
    while (this.eggs.length < n) {
      const i = this.eggs.length;
      const egg = MeshBuilder.CreateSphere(`nestEgg${this.team}_${i}`, {
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
/**
 * An Engineer's deployed feeder.
 *
 * Drawn like the rally pad it is a portable copy of, deliberately: a player who
 * has already learned "stand on the glowing disc to refill" needs no second
 * lesson, and inventing a new visual language for the same mechanic is how a
 * game ends up with two of everything.
 *
 * It fades out over its last two seconds rather than vanishing, so the team
 * standing on it gets a warning instead of a surprise.
 */
export class PadView {
  constructor(scene, pad, color) {
    this.scene = scene;
    this.t = Math.random() * 6;

    this.disc = MeshBuilder.CreateCylinder(`padDisc${pad.id}`, {
      diameter: pad.radius * 2, height: 0.06, tessellation: 24,
    }, scene);
    this.disc.position.set(pad.x, 0.035, pad.z);
    this.disc.material = emissiveMat(scene, `padDiscMat${pad.id}`, color, {
      intensity: 0.5, alpha: 0.2, cache: false,
    });
    this.disc.isPickable = false;

    this.ring = MeshBuilder.CreateTorus(`padRing${pad.id}`, {
      diameter: pad.radius * 2, thickness: 0.11, tessellation: 26,
    }, scene);
    this.ring.position.set(pad.x, 0.08, pad.z);
    this.ring.material = emissiveMat(scene, `padRingMat${pad.id}`, color, {
      intensity: 1.0, cache: false,
    });
    this.ring.isPickable = false;

    // A grain hopper in the middle, so it reads as an object someone put there
    // rather than as a decal on the floor.
    this.post = MeshBuilder.CreateCylinder(`padPost${pad.id}`, {
      diameterTop: 0.34, diameterBottom: 0.16, height: 0.5, tessellation: 8,
    }, scene);
    this.post.position.set(pad.x, 0.25, pad.z);
    this.post.material = emissiveMat(scene, 'padPostMat', '#ffcc3d', { intensity: 0.8 });
    this.post.isPickable = false;
  }

  sync(pad, dt) {
    this.t += dt;
    this.post.rotation.y = this.t * 1.4;
    // The last two seconds blink. Losing your cover is worth a warning.
    const fade = pad.until < 2 ? 0.35 + 0.65 * Math.abs(Math.sin(this.t * 7)) : 1;
    this.ring.visibility = fade;
    this.post.visibility = fade;
  }

  dispose() {
    this.disc.dispose();
    this.ring.dispose();
    this.post.dispose();
  }
}

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


/**
 * Your own beak, in first person.
 *
 * See BEAK in view.js for why this exists at all. Beyond fixing where tracers
 * come from, a viewmodel is the cheapest feedback surface in a first-person
 * game: it is always on screen, it is never in the way, and the player reads it
 * without looking at it. So it does four jobs at once — it recoils when you
 * fire, dips when you peck, sways when you walk, and shivers when you are dry.
 * Three of those are states the HUD also reports, and that redundancy is the
 * point: peripheral motion registers when a meter in the corner does not.
 */
export class BeakView {
  constructor(scene, camera) {
    const BEAK_C = '#ff9f1c';
    const WATTLE = '#ff2d4b';

    // Stepped taper, not a box.
    //
    // Seen from your own eye a beak is heavily foreshortened — you are looking
    // down the length of it — so a single rectangle reads as an orange slab
    // wedged in the corner rather than as part of a face. Three segments
    // narrowing toward the tip give it a silhouette that survives the angle,
    // and stacked cubes are what everything else in this game is made of.
    const parts = [
      ['base', { width: 0.105, height: 0.050, depth: 0.075 }, [0, 0.020, -0.020], BEAK_C],
      ['mid', { width: 0.082, height: 0.040, depth: 0.070 }, [0, 0.014, 0.045], BEAK_C],
      ['tip', { width: 0.055, height: 0.028, depth: 0.065 }, [0, 0.008, 0.105], BEAK_C],
      ['mandible', { width: 0.072, height: 0.026, depth: 0.135 }, [0, -0.028, 0.030], BEAK_C],
      ['wattle', { width: 0.042, height: 0.058, depth: 0.042 }, [0, -0.062, -0.052], WATTLE],
    ];
    const pieces = parts.map(([name, dims, pos, hex]) => {
      const m = MeshBuilder.CreateBox(name, dims, scene);
      m.position.set(pos[0], pos[1], pos[2]);
      tint(m, hex);
      return m;
    });
    this.root = Mesh.MergeMeshes(pieces, true, true, undefined, false, false);
    this.root.name = 'beak';
    this.root.isPickable = false;
    this.root.material = litMat(scene, 'beakMat', '#ffffff', { emissive: 0.22, cache: false });

    // Drawn in its own rendering group, which clears depth first. Without it the
    // beak is a real object 40cm from the camera and clips through any wall you
    // walk up to — the one artefact that makes a viewmodel look broken.
    this.root.renderingGroupId = 1;
    this.root.parent = camera;
    this.root.position.set(BEAK.right, -BEAK.down, BEAK.forward);

    // A tip node, so the tracer origin comes from the transform rather than
    // from a second copy of the offsets that could drift out of step with it.
    this.tip = new Mesh('beakTip', scene);
    this.tip.parent = this.root;
    this.tip.position.set(0, 0.006, 0.145);
    this.tip.isVisible = false;

    // The beak's own muzzle flash. A separate, much smaller thing from the
    // world MuzzleFlash pool, and parented to the beak so it is sized in the
    // space it is viewed from rather than in world units.
    this.flash = MeshBuilder.CreateSphere('beakFlash', {
      diameter: BEAK.flash, segments: 6,
    }, scene);
    this.flash.material = emissiveMat(scene, 'beakFlashMat', '#ffd98a', { intensity: 1.0 });
    this.flash.parent = this.root;
    this.flash.position.copyFrom(this.tip.position);
    this.flash.renderingGroupId = 1;
    this.flash.isPickable = false;
    this.flash.setEnabled(false);
    this.flashFor = 0;

    this.sway = 0;
    this.recoil = 0;
    this.dip = 0;
    this.shown = true;
  }

  setVisible(v) {
    if (this.shown === v) return;
    this.shown = v;
    this.root.setEnabled(v);
  }

  /** A shot went off: kick it back and up, and light the tip. */
  kick() {
    this.recoil = Math.min(1, this.recoil + 0.75);
    this.flashFor = 0.055;
  }

  /** World position of the beak tip, for spawning tracers and the flash. */
  tipWorld() {
    this.tip.computeWorldMatrix(true);
    return this.tip.getAbsolutePosition();
  }

  update(dt, { moving = false, pecking = false, dry = false } = {}) {
    if (!this.shown) return;

    this.recoil = Math.max(0, this.recoil - dt * 6.5);

    if (this.flashFor > 0) {
      this.flashFor -= dt;
      const on = this.flashFor > 0;
      this.flash.setEnabled(on);
      // Shrinks as it dies rather than fading: no transparency, no sorting.
      // Clamped, so the size never depends on how the timer was set — an
      // unclamped ratio makes a pinned or lengthened flash grow without bound.
      if (on) this.flash.scaling.setAll(0.6 + Math.min(1, this.flashFor / 0.055) * 0.9);
    } else if (this.flash.isEnabled()) {
      this.flash.setEnabled(false);
    }
    // Pecking swings the whole beak down and away, which is the same gesture
    // the third-person body makes. Somebody watching you and you yourself see
    // the same animation, which is what keeps the reload honest.
    this.dip += ((pecking ? 1 : 0) - this.dip) * Math.min(1, dt * 11);

    this.sway += dt * (moving ? 9 : 1.7);
    const bob = Math.sin(this.sway) * (moving ? 0.012 : 0.004);
    const lag = Math.cos(this.sway * 0.5) * (moving ? 0.014 : 0.004);

    // Out of grain: a small fast shiver. Deliberately motion rather than
    // colour — peripheral vision is far better at movement than at hue, and
    // this has to land while the player is looking at a target.
    const shake = dry ? Math.sin(this.sway * 9) * 0.006 : 0;

    this.root.position.set(
      BEAK.right + lag + shake,
      -BEAK.down + bob - this.recoil * 0.028 - this.dip * 0.20,
      BEAK.forward - this.recoil * 0.07,
    );
    // Tilted nose-down at rest so it reads as a beak rather than a bar; up on
    // recoil, and much further down while pecking.
    this.root.rotation.set(BEAK.tilt - this.recoil * 0.30 + this.dip * 0.85, 0, 0);
  }

  dispose() {
    this.flash.dispose();
    this.tip.dispose();
    this.root.dispose();
  }
}
