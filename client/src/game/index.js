import { Vector3, Matrix } from '@babylonjs/core/Maths/math';
import {
  createStage, buildArena, buildHillZone, buildSafeZone, CameraRig,
} from './scene.js';
import {
  PlayerView, BomberView, PickupView, PotatoView, NestView, LooseEggView, BombView,
} from './entities.js';
import { BulletPool, DebrisPool, BlastRings, MuzzleFlash } from './fx.js';
import { Controls } from './controls.js';
import { sfx } from '../audio/sfx.js';
import {
  PLAYER, BULLET, BOMBER, MODIFIERS, MODES, HILL, BOMB, HEIST, SEAT_COLORS,
  GRAVITY, modValue, clampUnit, clamp,
} from '@cluckdown/shared';

// Matches the server's simulation rate: sending slower would leave most ticks
// with no new input to act on, wasting the responsiveness a 60Hz sim buys.
const INPUT_HZ = 60;
const INPUT_DT = 1 / INPUT_HZ;

// Prediction error above this means something real happened (a blast, a wall,
// a rejected move) — snap instead of sliding the player across the arena.
const SNAP_ERROR = 3.5;
const CORRECTION_RATE = 9;

// One line of "what am I supposed to do", announced at the whistle. Only for
// modes whose goal isn't legible from the arena itself — free-for-all doesn't
// need telling.
const MODE_OPENERS = {
  bomb: 'GRAB THE BOMB — PLANT IT IN A RIVAL NEST',
  heist: 'STEAL THEIR EGGS — BANK THEM AT HOME',
  hill: 'HOLD THE ZONE — IT MOVES',
};

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
    this.pred = { x: 0, y: 0, z: 0, vy: 0, aim: 0, has: false };
    this.inputAcc = 0;
    this.statsAt = 0;
    this.lastHp = PLAYER.maxHp;

    this.controls = new Controls({
      leftZone: document.getElementById('stick-left'),
      canvas,
    });
    this.controls.setButtonEdit(!!gfx?.fireEdit);
    this.controls.setAssist(gfx?.assist !== false);
    this.controls.setSensitivity(gfx?.sensitivity ?? 1);

    // Who to watch while dead — set from the kill event, cleared on respawn.
    this.killedBy = null;

    // Shown once per match, the first time the cursor gets captured.
    let hinted = false;
    this.controls.onLockHint = () => {
      if (hinted) return;
      hinted = true;
      this.hud.announce('ESC TO FREE THE CURSOR');
    };

    this.hud.setMode(session.mode, this.modifier);
    // Announce the twist once the match view is actually up.
    const mod = MODIFIERS[this.modifier];
    if (mod && this.modifier !== 'none') {
      setTimeout(() => this.hud.announce(mod.label), 700);
    }
    // ...and say what the mode wants from you, for the modes where that is not
    // obvious from looking at the arena. Plant & Defuse was reported as simply
    // unlearnable; the running prompt handles the moment-to-moment, but the
    // one-line goal has to land before the first bomb even spawns.
    const opener = MODE_OPENERS[session.mode];
    if (opener) setTimeout(() => this.hud.announce(opener), mod && this.modifier !== 'none' ? 2600 : 900);
    this.bindSession();

    this.onResize = () => {
      this.engine.resize();
      // Aspect ratio changed, so the camera's follow limits changed with it.
      this.rig.recomputeLimits();
    };
    window.addEventListener('resize', this.onResize);

    this.engine.runRenderLoop(() => this.frame());
  }

  setButtonEdit(on) { this.controls.setButtonEdit(on); }

  setAssist(on) { this.controls.setAssist(on); }

  setSensitivity(mul) { this.controls.setSensitivity(mul); }

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
          // Your own gun goes off roughly where your eyeballs are, so in first
          // person both of these effects were rendering INSIDE the camera: a
          // 0.9-unit glowing sphere and the tracer streak, at point blank. The
          // result was a full-screen white flash on every shot. 3.2 units of
          // push is camera clearance, not tracer length — it has to stay clear
          // of the near plane whatever BULLET.tracerLength is set to.
          const ownShot = self && e.owner === self.id;
          this.bullets.spawn(e, ownShot ? 3.2 : 0);
          if (!ownShot) this.muzzle.fire(e.x, e.y, e.z);
          // ...replaced by a recoil kick, which reads as "I fired" far better
          // than a flash does anyway.
          if (ownShot) this.rig.addRecoil();
          sfx.play(e.rapid ? 'rapidShot' : 'shot');
          break;
        }
        case 'bulletEnd': {
          this.bullets.end(e.id);
          // Sparks fly back out of whatever the bullet hit — at the height it
          // hit at, which is now the floor, a wall, or somebody's head.
          this.debris.emit('red', e.x, e.y ?? 0.85, e.z, e.wall ? 4 : 6, {
            speed: e.wall ? 5 : 7, up: 0.5, size: 0.35, life: 0.32, drag: 3.5,
          });
          break;
        }
        case 'hit': {
          const view = this.views.get(e.target);
          if (view) view.hit();
          const at = e.target === 'bomber' ? { x: e.x, z: e.z } : (view ?? { x: e.x, z: e.z });
          // The view carries its height, so feathers and damage numbers follow
          // a chicken that was in the air when you hit it.
          const atY = at.y ?? 0;
          this.debris.feathers(at.x, atY + 1.2, at.z, 3);
          this.hud.popDamage(this.projectFn(at.x, atY + 1.9, at.z), e.amount, e.kind === 'burn' ? 'burn' : 'hit');
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
          this.explodeChicken(e.x, e.y ?? 0, e.z, e.color);
          if (self && e.target === self.id) {
            this.rig.addShake(0.75);
            sfx.play('death');
            // Stash it for the respawn overlay — by the time that renders, the
            // event is long gone.
            this.killedBy = e.by
              ? { name: e.byName, color: e.byColor, hp: e.byHp, dist: e.byDist, kind: e.kind }
              : { name: null, kind: e.kind };
          } else {
            sfx.play('kill');
          }
          if (self && e.by === self.id) {
            if (e.multi > 1) sfx.streak(e.multi);
            if (e.revenge) {
              this.hud.announce('REVENGE!');
              sfx.play('pickupHealth');
            }
          }
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
          this.bullets.redirect(e.id, e.x, e.y, e.z);
          this.debris.emit('white', e.x, e.y ?? 0.85, e.z, 3, {
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
        case 'jump': {
          // A puff of floor dust. Small on purpose — jumping happens a lot, and
          // an effect that reads as an event would be exhausting within a
          // minute. It exists so other players' jumps are legible: from across
          // the arena a chicken rising 1.25 units is easy to miss entirely.
          this.debris.emit('white', e.x, 0.1, e.z, 4, {
            speed: 2.6, up: 0.25, size: 0.16, life: 0.28, drag: 4,
          });
          break;
        }
        case 'respawn': {
          this.debris.emit('white', e.x, 0.8, e.z, 10, { speed: 6, up: 1.1, size: 0.3, life: 0.5 });
          if (self && e.target === self.id) {
            // Cut to the new corner tight, so "I'm back" is unmissable.
            this.rig.respawnPunch(e.x, e.z);
            this.pred.x = e.x;
            this.pred.z = e.z;
            this.pred.y = 0;
            this.pred.vy = 0;
            this.hud.announce('GO!');
            this.killedBy = null;
            sfx.play('respawn');
          }
          break;
        }
        default:
          break;
      }
    }
  }

  explodeChicken(x, y, z, color) {
    // The chicken bursts into its own cubes, then a cloud of feathers.
    const key = color === '#ffd166' ? 'gold' : 'white';
    this.debris.emit(key, x, y + 0.9, z, 16, { speed: 9, up: 1.15, size: 0.5, life: 1.1, drag: 1.1 });
    this.debris.emit('red', x, y + 0.9, z, 6, { speed: 7, up: 1, size: 0.3, life: 0.6 });
    this.debris.feathers(x, y + 1.4, z, 14);
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
    // Height is predicted for exactly the same reason X and Z are: a jump that
    // waited for a round-trip before the view left the ground would feel like
    // the button was broken.
    const focusY = self ? (this.pred.has ? this.pred.y : (self.y ?? 0)) : 0;
    const alive = !self || self.alive;
    this.rig.setAlive(alive);
    // The camera follows the LOCAL look direction, never the server's — a 40Hz
    // round-trip on "where am I looking" is the most noticeable lag there is.
    this.controls.clampPitch();
    // Dead: watch whoever put you there, if they are still up.
    const killer = !alive && this.killedBy?.id
      ? players.find((p) => p.id === this.killedBy.id && p.alive)
      : null;
    this.rig.update(
      dt, focusX, focusY, focusZ, this.controls.yaw, alive, this.controls.pitch,
      killer ? { x: killer.x, z: killer.z } : null,
    );

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
    this.hud.setActionPrompt(this.actionPrompt(self));
    this.hud.setMarkers(
      this.markers(self, players, focusX, focusZ),
      this.projectFn,
      { w: this.engine.getRenderWidth() * this.engine.getHardwareScalingLevel(),
        h: this.engine.getRenderHeight() * this.engine.getHardwareScalingLevel() },
    );
    {
      // The crosshair is simply the middle of the screen.
      //
      // It used to be projected 16 units down the firing line, because shots
      // travelled flat at chest height whatever the view was doing — a centre
      // reticle would have been pointing at one thing while the bullet went to
      // another. Aim carries pitch now and fire() builds the bullet from the
      // same yaw/pitch pair the camera looks down, so the centre of the screen
      // IS the aim point and the projection has nothing left to correct for.
      this.hud.setCrosshair(alive);
      this.hud.drawMinimap({
        half: this.session.safeHalf,
        players,
        self,
        selfX: focusX,
        selfZ: focusZ,
        aim: this.controls.yaw,
        bomber: this.session.bomber,
        pickups: this.session.pickups,
        nests: this.session.nests,
        hill: this.session.hill,
        bomb: this.session.bomb,
      });
    }
    const dead = self && !self.alive;
    this.hud.setRespawn(dead ? self.respawnIn : 0);
    this.hud.setKilledBy(dead ? this.killedBy : null);

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
    // Aim assist runs client-side, so it needs the roster. See
    // shared/src/aim.js for why it is on this side of the wire.
    const players = this.session.players;
    const me = players.find((p) => p.isSelf);
    // `y` rides along because assist is vertical now too: pulling onto someone
    // standing on the floor and pulling onto someone mid-jump are different
    // angles, and the one that matters is whichever of you left the ground.
    const foes = me
      ? players.filter((p) => !p.isSelf).map((p) => ({
        id: p.id, x: p.x, y: p.y ?? 0, z: p.z, alive: p.alive, team: p.team,
        invuln: p.invuln, mx: 0, mz: 0,
      }))
      : [];
    const input = this.controls.sample(
      me && me.alive
        ? { id: me.id, x: src.x, y: src.y ?? 0, z: src.z, team: me.team }
        : null,
      dt,
      foes,
    );

    // Send at a fixed 20Hz regardless of framerate: a 144Hz display shouldn't
    // flood the socket, and a 30fps phone shouldn't feel less responsive.
    this.inputAcc += dt;
    if (this.inputAcc >= INPUT_DT) {
      this.inputAcc %= INPUT_DT;
      this.session.sendInput({
        mx: input.mx, mz: input.mz,
        ax: input.ax, az: input.az,
        pitch: input.pitch, jump: input.jump,
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
      this.pred.y = self.y ?? 0;
      this.pred.z = self.z;
      this.pred.vy = 0;
      this.pred.aim = self.aim;
      this.pred.has = self.alive;
      return;
    }

    // Offline sessions are already authoritative in this tab — no prediction.
    if (this.session.offline) {
      this.pred.x = self.x;
      this.pred.y = self.y ?? 0;
      this.pred.z = self.z;
      this.pred.aim = self.aim;
      return;
    }

    const inp = this.controls.input;
    const [mx, mz] = clampUnit(inp.mx, inp.mz);
    const half = this.session.safeHalf;

    // Everything stepPlayers does to velocity has to be mirrored here, or the
    // prediction and the server disagree permanently and the correction fights
    // your input every frame.
    //
    // Knockback was the big omission: it is ADDED to movement server-side, so a
    // client that ignores it predicts you walking forward while the server has
    // you flying backwards. That mismatch is what made being shot feel like the
    // controls had come loose.
    let moveScale = this.session.phase === 'live' ? 1 : 0.35;
    if (self.carrying > 0) {
      moveScale *= 1 - Math.min(HEIST.maxCarrySlow, HEIST.carrySlow * self.carrying);
    }
    if (this.session.bomb?.carriedBy === self.id) moveScale *= 1 - BOMB.carrySlow;

    const vx = mx * PLAYER.speed * moveScale + (self.kx ?? 0);
    const vz = mz * PLAYER.speed * moveScale + (self.kz ?? 0);
    this.pred.x = clamp(this.pred.x + vx * dt, -half + PLAYER.radius, half - PLAYER.radius);
    this.pred.z = clamp(this.pred.z + vz * dt, -half + PLAYER.radius, half - PLAYER.radius);

    // The vertical, mirroring stepPlayers exactly — same jump condition, same
    // gravity, same ceiling. Unlike knockback there is nothing to be told about
    // here: the impulse comes from an input this client just sent, so it can
    // run the whole arc itself and only ease toward the server's answer.
    const gravity = GRAVITY * modValue(this.modifier, 'gravityMul');
    if (inp.jump && this.pred.y <= 0 && this.pred.vy <= 0) this.pred.vy = PLAYER.jumpSpeed;
    this.pred.vy -= gravity * dt;
    this.pred.y += this.pred.vy * dt;
    if (this.pred.y <= 0) {
      this.pred.y = 0;
      this.pred.vy = 0;
    } else if (this.pred.y >= PLAYER.maxJumpHeight) {
      this.pred.y = PLAYER.maxJumpHeight;
      if (this.pred.vy > 0) this.pred.vy = 0;
    }

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

    // Height is corrected on its own, and gently. A whole jump is 1.25 units,
    // so the horizontal SNAP_ERROR of 3.5 would never fire on it — and snapping
    // the view vertically is far more noticeable than snapping it sideways.
    this.pred.y += ((self.y ?? 0) - this.pred.y) * (1 - Math.exp(-CORRECTION_RATE * dt));
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
      // First person: you are looking out of your own head, so your own body
      // fills the screen. Hide it rather than clipping through it.
      // You are looking out of your own head, so your own body would fill
      // the screen from the inside.
      view.setHidden(p.isSelf);
      if (!p.alive) continue;

      const isSelf = p.isSelf;
      // Our own chicken uses the predicted transform; everyone else is
      // smoothed toward the last server position.
      const crowned = this.session.bounty === p.id;
      // Whoever killed you last is outlined, so a grudge has somewhere to go.
      const nemesis = !!self && !p.isSelf && self.nemesis === p.id;
      const target = isSelf && this.pred.has
        ? {
          x: this.pred.x, y: this.pred.y, z: this.pred.z, aim: p.aim,
          invuln: p.invuln, rapid: p.rapid, burning: p.burning, bounty: crowned,
          nemesis: false,
        }
        : { ...p, bounty: crowned, nemesis };

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
    const self = players.find((p) => p.isSelf);
    const rules = MODES[this.session.mode] ?? {};
    const bomb = this.session.bomb;

    // Which nests the player is currently supposed to be running at. Lighting
    // these up is what turns "carry it to a rival nest" from instructions into
    // something you can see from across the arena.
    const carryingBomb = rules.bomb && bomb?.carriedBy === self?.id;
    const raiding = rules.heist && self && self.carrying === 0;

    for (const nest of nests) {
      let view = this.nests.get(nest.seat);
      if (!view) {
        const owner = players.find((p) => p.seat % 4 === nest.seat);
        view = new NestView(this.scene, nest, owner?.color ?? SEAT_COLORS[nest.seat]);
        this.nests.set(nest.seat, view);
      }
      const rival = self ? nest.seat !== self.seat % 4 : false;
      const owned = players.some((p) => p.seat % 4 === nest.seat);
      const target = (carryingBomb && rival && owned)
        || (raiding && rival && nest.eggs > 0)
        || (rules.bomb && bomb?.state === 'planted' && bomb.plantSeat === nest.seat);
      view.update(dt, nest, target);
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

  /**
   * Works out what the player should be told to do next.
   *
   * Computed entirely client-side — it needs only nest positions, your own
   * position and the bomb state, all of which are already synced. No new
   * traffic, and it stays correct in offline practice for free.
   */
  actionPrompt(self) {
    if (!self?.alive) return null;
    const rules = MODES[this.session.mode] ?? {};
    const px = this.pred.has ? this.pred.x : self.x;
    const pz = this.pred.has ? this.pred.z : self.z;
    const nests = this.session.nests ?? [];
    const inp = this.controls.input;
    const still = Math.hypot(inp.mx, inp.mz) < 0.2;
    const near = (n, r) => Math.hypot(px - n.x, pz - n.z) <= r;

    if (rules.bomb) {
      const bomb = this.session.bomb;
      if (!bomb) return null;

      if (bomb.state === 'planted') {
        // Only its owner can do anything about it. Everyone else is told to
        // defend, because "wait it out" is genuinely the correct play.
        if (bomb.plantSeat !== self.seat % 4) {
          return { text: `Bomb planted — ${Math.ceil(bomb.fuse)}s`, progress: 0 };
        }
        if (!near(bomb, BOMB.plantRadius)) {
          return { text: '⚠ GET TO YOUR NEST AND DEFUSE', progress: 0, urgent: true };
        }
        if (!still) return { text: 'STOP MOVING TO DEFUSE', progress: 0, urgent: true };
        return { text: 'DEFUSING…', progress: bomb.defuse, urgent: true };
      }

      if (bomb.carriedBy === self.id) {
        const target = nests.find((n) => n.seat !== self.seat % 4 && near(n, BOMB.plantRadius));
        if (!target) return { text: 'CARRY THE BOMB TO A RIVAL NEST', progress: 0 };
        if (!still) return { text: 'STOP MOVING TO PLANT', progress: 0 };
        return { text: 'PLANTING…', progress: bomb.plant };
      }

      if (bomb.state === 'loose') return { text: 'GRAB THE BOMB', progress: 0 };
      return null;
    }

    if (rules.heist) {
      if (self.carrying > 0) {
        const home = nests.find((n) => n.seat === self.seat % 4);
        if (home && near(home, HEIST.nestRadius)) return null; // already banking
        return { text: `RUN ${self.carrying} EGG${self.carrying > 1 ? 'S' : ''} HOME`, progress: 0 };
      }
      const raidable = nests.some((n) => n.seat !== self.seat % 4 && n.eggs > 0);
      if (raidable) return { text: 'RAID A RIVAL NEST', progress: 0 };
    }

    return null;
  }

  /**
   * What deserves an on-screen marker right now.
   *
   * First person took the overview away, and two things broke with it. The
   * bomber could creep up behind you with no warning at all — tense becomes
   * unfair the moment you cannot possibly have seen it coming. And every
   * objective instruction ("run the eggs home", "carry the bomb to a rival
   * nest") quietly assumed you could see where that was.
   *
   * Deliberately sparse. A screen ringed with arrows is the same as no arrows:
   * only the bomber, the thing you are carrying somewhere, and the one place
   * you are supposed to be heading.
   */
  markers(self, players, px, pz) {
    if (!self?.alive) return [];
    const out = [];
    const rules = MODES[this.session.mode] ?? {};
    const yaw = this.controls.yaw;
    // Bearing relative to where we're looking, so the HUD can put an
    // off-screen marker on the correct edge.
    const add = (key, x, z, icon, color, urgent = false) => {
      const dist = Math.hypot(x - px, z - pz);
      out.push({ key, x, z, icon, color, urgent, dist, bearing: Math.atan2(x - px, z - pz) - yaw });
    };

    // --- the bomber. The one thing that can kill you from behind.
    const b = this.session.bomber;
    if (b) {
      const armed = b.state === 'arm';
      const d = Math.hypot(b.x - px, b.z - pz);
      // Always marked once it is armed; otherwise only when it is close enough
      // to be your problem.
      if (armed || d < BOMBER.detectRadius) add('bomber', b.x, b.z, '💣', '#ff2d4b', armed);
    }

    // --- Egg Heist: where the eggs go, and where to get more.
    if (rules.heist) {
      const nests = this.session.nests ?? [];
      const home = nests.find((n) => n.seat === self.seat % 4);
      if (self.carrying > 0 && home) {
        add('home', home.x, home.z, '🏠', self.color, false);
      } else {
        const target = nests
          .filter((n) => n.seat !== self.seat % 4 && n.eggs > 0)
          .sort((a, c) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(c.x - px, c.z - pz))[0];
        if (target) add('raid', target.x, target.z, '🥚', '#fff4d6', false);
      }
    }

    // --- Plant & Defuse: the bomb, or the nest it is in.
    if (rules.bomb) {
      const bomb = this.session.bomb;
      if (bomb?.state === 'planted') {
        const mine = bomb.plantSeat === self.seat % 4;
        add('bomb', bomb.x, bomb.z, mine ? '🛠' : '💥', mine ? '#ff2d4b' : '#ffcc3d', mine);
      } else if (bomb?.carriedBy === self.id) {
        const nests = this.session.nests ?? [];
        const target = nests
          .filter((n) => n.seat !== self.seat % 4 && players.some((p) => p.seat % 4 === n.seat))
          .sort((a, c) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(c.x - px, c.z - pz))[0];
        if (target) add('plant', target.x, target.z, '🎯', '#ff8a3d', false);
      } else if (bomb) {
        add('bomb', bomb.x, bomb.z, '💣', '#ffb020', false);
      }
    }

    // --- King of the Coop: the zone moves, so it has to be findable.
    const hill = this.session.hill;
    if (hill) {
      const inside = Math.hypot(hill.x - px, hill.z - pz) <= HILL.radius;
      if (!inside) add('hill', hill.x, hill.z, '⬢', '#ffcc3d', false);
    }

    // --- Hot Potato: whoever has it wants to give it to you.
    const pot = this.session.potato;
    if (pot) {
      const mine = pot.holder === self.id;
      add('potato', pot.x, pot.z, mine ? '🔥' : '🥔', '#ff8a3d', mine);
    }

    return out;
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
