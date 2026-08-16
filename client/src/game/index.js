import { Vector3, Matrix } from '@babylonjs/core/Maths/math';
import {
  createStage, buildArena, buildHillZone, buildSafeZone, CameraRig, VIEW_LABELS,
} from './scene.js';
import {
  PlayerView, BomberView, PickupView, PotatoView, NestView, LooseEggView, BombView,
} from './entities.js';
import { BulletPool, DebrisPool, BlastRings, MuzzleFlash } from './fx.js';
import { Controls } from './controls.js';
import { sfx } from '../audio/sfx.js';
import {
  PLAYER, BULLET, BOMBER, MODIFIERS, MODES, HILL, BOMB, SEAT_COLORS, modValue, clampUnit, clamp,
} from '@cluckdown/shared';

// Matches the server's simulation rate: sending slower would leave most ticks
// with no new input to act on, wasting the responsiveness a 60Hz sim buys.
const INPUT_HZ = 60;
const INPUT_DT = 1 / INPUT_HZ;

// Prediction error above this means something real happened (a blast, a wall,
// a rejected move) — snap instead of sliding the player across the arena.
const SNAP_ERROR = 3.5;
const CORRECTION_RATE = 9;

export class Game {
  constructor({ canvas, session, hud, gfx, onExit }) {
    this.canvas = canvas;
    this.session = session;
    this.hud = hud;
    this.onExit = onExit;
    this.disposed = false;

    this.modifier = session.modifier ?? 'none';
    const stage = createStage(canvas, gfx, this.modifier);
    this.engine = stage.engine;
    this.scene = stage.scene;
    this.camera = stage.camera;
    this.glow = stage.glow;

    // Arena geometry and palette both come from the voted map.
    this.map = session.map ?? 'coop';
    this.arena = buildArena(this.scene, session.arenaSize, this.map);
    this.rig = new CameraRig(this.camera, session.arenaSize, this.engine);
    this.rig.setView(gfx?.view ?? 'close');

    // Objective markers, built only for the modes that have them.
    const rules = MODES[session.mode] ?? {};
    this.hillZone = rules.hill ? buildHillZone(this.scene, HILL.radius) : null;
    this.safeZone = rules.shrink ? buildSafeZone(this.scene, session.arenaSize / 2) : null;
    this.lastSafeHalf = session.arenaSize / 2;

    // Nests exist in both Egg Heist and Plant & Defuse, but only the heist
    // fills them with eggs.
    this.nests = new Map();
    this.looseEggs = new Map();
    this.bombView = rules.bomb ? new BombView(this.scene) : null;

    this.bullets = new BulletPool(this.scene, this.glow);
    this.debris = new DebrisPool(this.scene, this.glow, 90, modValue(this.modifier, 'debrisGravityMul'));
    this.blasts = new BlastRings(this.scene, this.glow);
    this.muzzle = new MuzzleFlash(this.scene, this.glow);

    this.views = new Map();
    this.pickups = new Map();
    this.bomberView = new BomberView(this.scene);
    this.potatoView = new PotatoView(this.scene);

    // Locally predicted position for our own chicken.
    this.pred = { x: 0, z: 0, aim: 0, has: false };
    this.inputAcc = 0;
    this.statsAt = 0;
    this.lastHp = PLAYER.maxHp;

    this.controls = new Controls({
      leftZone: document.getElementById('stick-left'),
      rightZone: document.getElementById('stick-right'),
      canvas,
      camera: this.camera,
      scene: this.scene,
    });

    this.hud.setMode(session.mode, this.modifier);
    // Announce the twist once the match view is actually up.
    const mod = MODIFIERS[this.modifier];
    if (mod && this.modifier !== 'none') {
      setTimeout(() => this.hud.announce(mod.label), 700);
    }
    this.bindSession();

    this.onResize = () => {
      this.engine.resize();
      // Aspect ratio changed, so the camera's follow limits changed with it.
      this.rig.recomputeLimits();
    };
    window.addEventListener('resize', this.onResize);

    this.engine.runRenderLoop(() => this.frame());
  }

  /** Cycles close -> mid -> full and reports the new label for the HUD. */
  cycleView() {
    const view = this.rig.cycleView();
    return { view, label: VIEW_LABELS[view] };
  }

  // ------------------------------------------------------------------ setup

  bindSession() {
    this.session.on('fx', (events) => this.handleFx(events));
    this.session.on('feed', (f) => {
      this.hud.addFeed(f);
      if (f.kind === 'kill' && f.multi > 1) this.hud.announceMulti(f.multi);
    });
    this.session.on('chat', (m) => this.hud.addChat(m));
  }

  self() {
    return this.session.players.find((p) => p.isSelf) ?? null;
  }

  /**
   * World -> screen, for HTML overlay elements. Returns null if off-camera.
   *
   * The result is converted to CSS pixels. Vector3.Project works in
   * render-buffer pixels, and the buffer is not the same size as the page: the
   * engine runs at a hardware scaling level derived from devicePixelRatio, so
   * on a 1.5x display the buffer is 1.5x wider than the CSS viewport. Feeding
   * raw buffer coordinates to a CSS transform pushes every nameplate away from
   * the top-left corner, by more the further out it is — so it looks fine near
   * the corner and badly wrong across the rest of the screen.
   */
  projectFn = (x, y, z) => {
    const p = Vector3.Project(
      new Vector3(x, y, z),
      Matrix.Identity(),
      this.scene.getTransformMatrix(),
      this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight()),
    );
    if (p.z < 0 || p.z > 1) return null;
    const toCss = this.engine.getHardwareScalingLevel();
    return { x: p.x * toCss, y: p.y * toCss };
  };

  // -------------------------------------------------------------------- fx

  handleFx(events) {
    const self = this.self();

    for (const e of events) {
      switch (e.type) {
        case 'shot': {
          this.bullets.spawn(e);
          this.muzzle.fire(e.x, e.z);
          sfx.play(e.rapid ? 'rapidShot' : 'shot');
          break;
        }
        case 'bulletEnd': {
          this.bullets.end(e.id);
          // Sparks fly back out of whatever the bullet hit.
          this.debris.emit('red', e.x, 0.85, e.z, e.wall ? 4 : 6, {
            speed: e.wall ? 5 : 7, up: 0.5, size: 0.35, life: 0.32, drag: 3.5,
          });
          break;
        }
        case 'hit': {
          const view = this.views.get(e.target);
          if (view) view.hit();
          const at = e.target === 'bomber' ? { x: e.x, z: e.z } : (view ?? { x: e.x, z: e.z });
          this.debris.feathers(at.x, 1.2, at.z, 3);
          this.hud.popDamage(this.projectFn(at.x, 1.9, at.z), e.amount, e.kind === 'burn' ? 'burn' : 'hit');
          if (self && e.target === self.id) {
            this.rig.addShake(0.18);
            this.flashHurt();
            sfx.play('hurt');
          } else if (self && e.by === self.id) {
            // Only your own hits get a hit-marker; other people's are noise.
            sfx.play('hit');
          }
          break;
        }
        case 'kill': {
          this.explodeChicken(e.x, e.z, e.color);
          if (self && e.target === self.id) {
            this.rig.addShake(0.75);
            sfx.play('death');
          } else {
            sfx.play('kill');
          }
          if (self && e.by === self.id && e.multi > 1) sfx.streak(e.multi);
          break;
        }
        case 'blast': {
          this.blasts.fire(e.x, e.z, e.radius ?? BOMBER.blastRadius);
          sfx.stopFuse();
          sfx.play('blast');
          this.debris.emit('red', e.x, 0.6, e.z, 26, { speed: 15, up: 0.9, size: 0.55, life: 0.85, drag: 1.4 });
          this.debris.emit('gold', e.x, 0.6, e.z, 14, { speed: 11, up: 1.2, size: 0.4, life: 0.7, drag: 1.6 });
          this.debris.feathers(e.x, 1.2, e.z, 10);
          this.bomberView.setActive(false);
          // Shake scales with how close you were to the blast.
          if (self) {
            const d = Math.hypot(self.x - e.x, self.z - e.z);
            this.rig.addShake(Math.max(0, 1.1 * (1 - d / (BOMBER.blastRadius * 2.2))));
          }
          break;
        }
        case 'bomberDown': {
          sfx.stopFuse();
          sfx.play('bomberDown');
          this.debris.emit('red', e.x, 0.9, e.z, 16, { speed: 9, up: 1, size: 0.42, life: 0.7 });
          this.debris.feathers(e.x, 1.3, e.z, 8);
          this.bomberView.setActive(false);
          this.rig.addShake(0.2);
          break;
        }
        case 'bomberSpawn': {
          this.debris.emit('red', e.x, 0.6, e.z, 12, { speed: 7, up: 1.1, size: 0.3, life: 0.6 });
          this.hud.announce('BOMBER INCOMING');
          sfx.play('bomberSpawn');
          break;
        }
        case 'bounce': {
          // Keep the tracer in step with the authoritative ricochet.
          this.bullets.redirect(e.id, e.x, e.z);
          this.debris.emit('white', e.x, 0.85, e.z, 3, {
            speed: 4, up: 0.4, size: 0.22, life: 0.25, drag: 4,
          });
          sfx.play('hit');
          break;
        }
        case 'ignite': {
          this.debris.emit('gold', e.x, 1.0, e.z, 8, {
            speed: 5, up: 1.3, size: 0.3, life: 0.6, drag: 2,
          });
          sfx.play('pickupRapid');
          break;
        }
        case 'bounty': {
          if (e.target) {
            this.hud.announce(e.target === self?.id ? 'YOU ARE MARKED' : `${e.name} IS MARKED`);
            sfx.play('bomberSpawn');
          }
          break;
        }
        case 'potatoSpawn': {
          this.hud.announce('HOT POTATO');
          sfx.play('bomberSpawn');
          this.debris.emit('gold', e.x, 1, e.z, 12, { speed: 7, up: 1.2, size: 0.3, life: 0.6 });
          break;
        }
        case 'potatoPass': {
          this.debris.emit('gold', e.x, 1.1, e.z, 8, { speed: 6, up: 1.1, size: 0.26, life: 0.45 });
          sfx.play('pickupRapid');
          if (self && e.to === self.id) this.hud.announce('YOU HAVE IT!');
          break;
        }
        case 'potatoBlast': {
          this.blasts.fire(e.x, e.z, 5);
          this.debris.emit('gold', e.x, 0.8, e.z, 22, { speed: 13, up: 1.1, size: 0.45, life: 0.8 });
          this.debris.feathers(e.x, 1.2, e.z, 10);
          sfx.play('blast');
          if (self && e.target === self.id) this.rig.addShake(0.9);
          break;
        }
        // --- contracts
        case 'contractNew': {
          // No announcement: a new task arrives every 45s per player, and an
          // announcer line that often becomes wallpaper. The strip flashes.
          if (self && e.target === self.id) sfx.play('pickupRapid');
          break;
        }
        case 'contractDone': {
          if (self && e.target === self.id) {
            this.hud.announce(`TASK COMPLETE  +${e.reward}`);
            sfx.play('pickupHealth');
            this.debris.emit('gold', self.x, 1.2, self.z, 14, {
              speed: 7, up: 1.4, size: 0.3, life: 0.7, drag: 2,
            });
          }
          break;
        }

        // --- Egg Heist
        case 'eggSteal': {
          this.debris.emit('white', e.x, 0.9, e.z, 6, { speed: 5, up: 1, size: 0.24, life: 0.45 });
          sfx.play(self && e.by === self.id ? 'pickupRapid' : 'hit');
          if (self && e.from === self.seat % 4 && e.by !== self.id) {
            this.hud.announce('YOUR NEST IS BEING RAIDED');
          }
          break;
        }
        case 'eggDeposit': {
          this.debris.emit('gold', e.x, 1, e.z, 10 + e.count * 3, {
            speed: 7, up: 1.3, size: 0.3, life: 0.7, drag: 2,
          });
          sfx.play('pickupHealth');
          if (self && e.by === self.id) this.hud.announce(`BANKED ${e.count}`);
          break;
        }
        case 'eggDropped': {
          this.debris.emit('white', e.x, 1, e.z, 8, { speed: 6, up: 1.1, size: 0.26, life: 0.5 });
          break;
        }
        case 'eggPickup': {
          this.debris.emit('white', e.x, 0.8, e.z, 4, { speed: 4, up: 0.9, size: 0.2, life: 0.35 });
          if (self && e.by === self.id) sfx.play('pickupRapid');
          break;
        }
        case 'eggReturned': {
          this.debris.emit('white', e.x, 0.9, e.z, 5, { speed: 5, up: 1, size: 0.22, life: 0.4 });
          break;
        }

        // --- Plant & Defuse
        case 'bombSpawn': {
          this.hud.announce('BOMB IS LOOSE');
          sfx.play('bomberSpawn');
          this.debris.emit('red', e.x, 0.8, e.z, 10, { speed: 6, up: 1.1, size: 0.3, life: 0.6 });
          break;
        }
        case 'bombTaken': {
          if (self && e.by === self.id) this.hud.announce('YOU HAVE THE BOMB');
          sfx.play('pickupRapid');
          break;
        }
        case 'bombPlanted': {
          const mine = self && e.seat === self.seat % 4;
          this.hud.announce(mine ? 'BOMB IN YOUR NEST — DEFUSE IT' : 'BOMB PLANTED');
          sfx.play('bomberSpawn');
          this.debris.emit('red', e.x, 0.8, e.z, 14, { speed: 8, up: 1.2, size: 0.34, life: 0.7 });
          break;
        }
        case 'bombDefused': {
          this.hud.announce('DEFUSED');
          sfx.stopFuse();
          sfx.play('bomberDown');
          this.debris.emit('green', e.x, 0.9, e.z, 14, { speed: 7, up: 1.2, size: 0.3, life: 0.7 });
          break;
        }
        case 'bombBlast': {
          this.blasts.fire(e.x, e.z, e.radius);
          sfx.stopFuse();
          sfx.play('blast');
          this.debris.emit('red', e.x, 0.6, e.z, 30, { speed: 16, up: 0.9, size: 0.55, life: 0.9, drag: 1.4 });
          this.debris.emit('gold', e.x, 0.6, e.z, 16, { speed: 12, up: 1.2, size: 0.4, life: 0.75, drag: 1.6 });
          if (self) {
            const d = Math.hypot(self.x - e.x, self.z - e.z);
            this.rig.addShake(Math.max(0, 1.2 * (1 - d / (e.radius * 2))));
          }
          break;
        }

        // --- rotating hill
        case 'hillMoving': {
          this.hud.announce(`ZONE MOVES IN ${e.inSeconds}`);
          sfx.play('pickupRapid');
          break;
        }
        case 'hillMoved': {
          this.hud.announce('ZONE MOVED');
          this.debris.emit('gold', e.x, 0.8, e.z, 16, {
            speed: 8, up: 1.3, size: 0.32, life: 0.8, drag: 2,
          });
          sfx.play('bomberSpawn');
          break;
        }

        case 'bomberArm': {
          this.rig.addShake(0.1);
          break;
        }
        case 'pickupTaken': {
          const isHeal = e.kind === 'health';
          this.debris.emit(isHeal ? 'green' : 'gold', e.x, 1, e.z, 10, {
            speed: 6, up: 1.2, size: 0.3, life: 0.55, drag: 2,
          });
          sfx.play(isHeal ? 'pickupHealth' : 'pickupRapid');
          if (isHeal) this.hud.popDamage(this.projectFn(e.x, 1.8, e.z), 35, 'heal');
          if (self && e.by === self.id && !isHeal) this.hud.announce('RAPID FIRE');
          break;
        }
        case 'respawn': {
          this.debris.emit('white', e.x, 0.8, e.z, 10, { speed: 6, up: 1.1, size: 0.3, life: 0.5 });
          if (self && e.target === self.id) {
            // Cut to the new corner tight, so "I'm back" is unmissable.
            this.rig.respawnPunch(e.x, e.z);
            this.pred.x = e.x;
            this.pred.z = e.z;
            this.hud.announce('GO!');
            sfx.play('respawn');
          }
          break;
        }
        default:
          break;
      }
    }
  }

  explodeChicken(x, z, color) {
    // The chicken bursts into its own cubes, then a cloud of feathers.
    const key = color === '#ffd166' ? 'gold' : 'white';
    this.debris.emit(key, x, 0.9, z, 16, { speed: 9, up: 1.15, size: 0.5, life: 1.1, drag: 1.1 });
    this.debris.emit('red', x, 0.9, z, 6, { speed: 7, up: 1, size: 0.3, life: 0.6 });
    this.debris.feathers(x, 1.4, z, 14);
  }

  flashHurt() {
    document.body.animate(
      [{ boxShadow: 'inset 0 0 90px 20px rgba(255,45,75,0.55)' }, { boxShadow: 'inset 0 0 0 0 rgba(255,45,75,0)' }],
      { duration: 380, easing: 'ease-out' },
    );
  }

  // ----------------------------------------------------------------- frame

  frame() {
    if (this.disposed) return;
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);

    this.session.update(dt);

    const players = this.session.players;
    const self = players.find((p) => p.isSelf) ?? null;

    this.pumpInput(dt, self);
    this.predict(dt, self);
    this.syncPlayers(dt, players, self);
    this.syncPickups(dt);
    this.syncBomber(dt);

    this.syncObjectives(dt, players);
    this.potatoView.sync(this.session.potato, dt);
    this.bullets.update(dt);
    this.debris.update(dt);
    this.blasts.update(dt);
    this.muzzle.update(dt);

    // Camera follows the predicted position — following the server position
    // would make the whole view stutter at the network tick rate.
    const focusX = self ? (this.pred.has ? this.pred.x : self.x) : 0;
    const focusZ = self ? (this.pred.has ? this.pred.z : self.z) : 0;
    this.rig.setAlive(!self || self.alive);
    this.rig.update(dt, focusX, focusZ);

    // Render BEFORE projecting the HUD. projectFn reads scene.getTransformMatrix(),
    // which is only recomputed during render — projecting first would place every
    // nameplate using the previous frame's camera.
    this.scene.render();

    // Nameplates track the *rendered* position of each chicken, not the raw
    // server position: our own chicken is drawn at the predicted spot and
    // everyone else's is interpolated, so using server coordinates here left
    // every plate floating away from the bird it belongs to.
    this.hud.syncNameplates(players, this.projectFn, this.session.selfId, (id) => this.views.get(id));
    this.hud.syncBomberFuse(this.session.bomber, this.projectFn, this.bomberView);
    this.hud.syncScoreboard(players, this.session.selfId);
    this.hud.setClock(this.session.clock);
    this.hud.setObjective({
      teamScores: this.session.teamScores,
      hill: this.session.hill,
      nests: MODES[this.session.mode]?.heist ? this.session.nests : null,
      bomb: this.session.bomb,
      self,
      players,
    });
    this.hud.setContract(self?.contract ?? null);
    this.hud.setRespawn(self && !self.alive ? self.respawnIn : 0);

    // Refresh at 4Hz — this is a diagnostic, and rebuilding its DOM every
    // frame would itself cost frames on the devices most likely to need it.
    this.statsAt -= dt;
    if (this.statsAt <= 0) {
      this.statsAt = 0.25;
      this.hud.setNetStats(this.session.netStats(), this.engine.getFps());
    }
  }

  pumpInput(dt, self) {
    const src = this.pred.has ? this.pred : self;
    const input = this.controls.sample(src);

    // Send at a fixed 20Hz regardless of framerate: a 144Hz display shouldn't
    // flood the socket, and a 30fps phone shouldn't feel less responsive.
    this.inputAcc += dt;
    if (this.inputAcc >= INPUT_DT) {
      this.inputAcc %= INPUT_DT;
      this.session.sendInput({
        mx: input.mx, mz: input.mz,
        ax: input.ax, az: input.az,
        shoot: input.shoot, seq: input.seq,
      });
    }
  }

  /**
   * Client-side prediction for the local chicken only.
   *
   * We re-run the same movement the server will run, then ease toward whatever
   * the server actually reported. Without this, every input waits a full
   * round-trip before anything moves and the game feels underwater.
   */
  predict(dt, self) {
    if (!self) { this.pred.has = false; return; }

    if (!this.pred.has || !self.alive) {
      this.pred.x = self.x;
      this.pred.z = self.z;
      this.pred.aim = self.aim;
      this.pred.has = self.alive;
      return;
    }

    // Offline sessions are already authoritative in this tab — no prediction.
    if (this.session.offline) {
      this.pred.x = self.x;
      this.pred.z = self.z;
      this.pred.aim = self.aim;
      return;
    }

    const inp = this.controls.input;
    const [mx, mz] = clampUnit(inp.mx, inp.mz);
    const half = this.session.arenaSize / 2;
    this.pred.x = clamp(this.pred.x + mx * PLAYER.speed * dt, -half + PLAYER.radius, half - PLAYER.radius);
    this.pred.z = clamp(this.pred.z + mz * PLAYER.speed * dt, -half + PLAYER.radius, half - PLAYER.radius);

    const ex = self.x - this.pred.x;
    const ez = self.z - this.pred.z;
    const err = Math.hypot(ex, ez);
    if (err > SNAP_ERROR) {
      this.pred.x = self.x;
      this.pred.z = self.z;
    } else {
      const t = 1 - Math.exp(-CORRECTION_RATE * dt);
      this.pred.x += ex * t;
      this.pred.z += ez * t;
    }
  }

  syncPlayers(dt, players, self) {
    const seen = new Set();

    for (const p of players) {
      seen.add(p.id);
      let view = this.views.get(p.id);
      if (!view) {
        view = new PlayerView(this.scene, p);
        this.views.set(p.id, view);
      }

      view.setVisible(p.alive);
      if (!p.alive) continue;

      const isSelf = p.isSelf;
      // Our own chicken uses the predicted transform; everyone else is
      // smoothed toward the last server position.
      const crowned = this.session.bounty === p.id;
      const target = isSelf && this.pred.has
        ? {
          x: this.pred.x, z: this.pred.z, aim: p.aim,
          invuln: p.invuln, rapid: p.rapid, burning: p.burning, bounty: crowned,
        }
        : { ...p, bounty: crowned };

      const moving = isSelf
        ? Math.hypot(this.controls.input.mx, this.controls.input.mz) > 0.1
        : Math.hypot(p.x - view.x, p.z - view.z) > 0.05;

      view.update(dt, target, {
        moving,
        lerpT: isSelf ? 1 : Math.min(1, dt * 14),
      });
    }

    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      view.dispose();
      this.views.delete(id);
    }

    // Took damage since last frame? Nudge the camera.
    if (self) {
      if (self.hp < this.lastHp - 0.5 && self.alive) this.rig.addShake(0.1);
      this.lastHp = self.hp;
    }
  }

  /** Keeps the hill marker and closing boundary in step with the rules. */
  syncObjectives(dt, players) {
    if (this.hillZone) {
      const hill = this.session.hill;
      const holder = hill?.holder ? players.find((p) => p.id === hill.holder) : null;
      this.hillZone.update(
        dt, holder?.color ?? null, !!hill?.contested,
        hill?.x ?? 0, hill?.z ?? 0, hill?.moveAt ?? null,
      );
    }

    this.syncNests(dt, players);
    this.syncEggs(dt);
    if (this.bombView) this.bombView.sync(this.session.bomb, dt);

    if (this.safeZone) {
      const half = this.session.safeHalf;
      const closing = half < this.lastSafeHalf - 0.0005;
      this.safeZone.update(dt, half, closing);
      this.lastSafeHalf = half;
    }
  }

  /** Nests are keyed by seat and coloured by their owner. */
  syncNests(dt, players) {
    const nests = this.session.nests ?? [];
    for (const nest of nests) {
      let view = this.nests.get(nest.seat);
      if (!view) {
        const owner = players.find((p) => p.seat % 4 === nest.seat);
        view = new NestView(this.scene, nest, owner?.color ?? SEAT_COLORS[nest.seat]);
        this.nests.set(nest.seat, view);
      }
      view.update(dt, nest);
    }
  }

  syncEggs(dt) {
    const seen = new Set();
    for (const egg of this.session.looseEggs ?? []) {
      seen.add(egg.id);
      let view = this.looseEggs.get(egg.id);
      if (!view) {
        view = new LooseEggView(this.scene);
        this.looseEggs.set(egg.id, view);
      }
      view.update(dt, egg);
    }
    for (const [id, view] of this.looseEggs) {
      if (seen.has(id)) continue;
      view.dispose();
      this.looseEggs.delete(id);
    }
  }

  syncPickups(dt) {
    const seen = new Set();
    for (const pk of this.session.pickups) {
      seen.add(pk.id);
      let view = this.pickups.get(pk.id);
      if (!view) {
        view = new PickupView(this.scene, pk);
        this.pickups.set(pk.id, view);
      }
      view.update(dt);
    }
    for (const [id, view] of this.pickups) {
      if (seen.has(id)) continue;
      view.dispose();
      this.pickups.delete(id);
    }
  }

  syncBomber(dt) {
    const b = this.session.bomber;
    if (!b) {
      this.bomberView.setActive(false);
      this.tickFuse();
      return;
    }
    this.bomberView.setActive(true);
    this.bomberView.sync(b, dt, Math.min(1, dt * 12));
    this.tickFuse(b);
  }

  /**
   * Drives the accelerating beep from whichever fuse is running.
   *
   * An armed bomber and a planted bomb are the same signal to the player —
   * something is about to go off nearby — so they share one voice rather than
   * beeping over each other. The bomber wins when both are live, because it is
   * the one that chases you.
   */
  tickFuse(bomber = null) {
    if (bomber && bomber.state === 'arm') {
      sfx.fuseTick(bomber.fuse, BOMBER.fuse);
      return;
    }
    const bomb = this.session.bomb;
    if (bomb?.state === 'planted') {
      sfx.fuseTick(bomb.fuse, BOMB.fuse);
      return;
    }
    sfx.stopFuse();
  }

  // --------------------------------------------------------------- cleanup

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    for (const v of this.nests.values()) v.dispose();
    for (const v of this.looseEggs.values()) v.dispose();
    this.bombView?.dispose();
    sfx.stopFuse();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
