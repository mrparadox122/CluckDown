import { Vector3, Matrix } from '@babylonjs/core/Maths/math';
import {
  createStage, buildArena, buildHillZone, buildSafeZone, CameraRig,
} from './scene.js';
import {
  PlayerView, BomberView, PickupView, PotatoView, NestView, LooseEggView, BombView, BeakView,
  PadView,
} from './entities.js';
import { BulletPool, DebrisPool, BlastRings, MuzzleFlash, RoleRings } from './fx.js';
import { Controls } from './controls.js';
import { asView, lookBasis, rayOrigin, convergeDistance, PlateVision } from './view.js';
import { assistOn, effectBudget } from '../graphics.js';
import { Adaptive } from './adaptive.js';
import { sfx } from '../audio/sfx.js';
import { tts, SAY } from '../audio/index.js';
import {
  PLAYER, BULLET, BOMBER, MODIFIERS, MODES, HILL, BOMB, HEIST, SEAT_COLORS,
  GRAVITY, coverFor, cropCapacity, MULTIKILL_NAMES, modValue, clampUnit, clamp,
  spreadPixels, TEAM_COLORS, PING, pingDef, roleDef, ROLE_LIST, PROGRESS,
} from '@cluckdown/shared';

// How often the local input struct goes on the wire.
//
// This said 60 while its own comment at the send site said 20, which is how a
// constant ends up at three times the rate anybody decided on. 30 is the number
// to have: the server simulates at 60 but it holds the last input it was given
// between ticks, so the only thing a second sample inside one 33ms window buys
// is one tick of freshness — against a doubled upstream packet rate, which on a
// phone means a radio that never idles and a battery that notices.
//
// It is also a ceiling, not a floor: the loop can only sample what the player
// is doing once per rendered frame, so a 24fps device sends 24 times a second.
// That is the correct behaviour and not worth padding with duplicates.
const INPUT_HZ = 30;
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
  constructor({ canvas, session, hud, gfx, onExit, career = null }) {
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
    // Kept so the brightness setting can be dragged mid-match. Judging a
    // brightness without seeing the actual scene is guesswork, and this is a
    // setting that exists precisely because devices differ.
    this.lights = { key: stage.key, hemi: stage.hemi, gain: stage.gain };

    // Arena geometry and palette both come from the voted map.
    this.map = session.map ?? 'coop';
    this.arena = buildArena(
      this.scene, session.arenaSize, this.map, this.modifier,
      !!MODES[session.mode]?.teams,
    );
    // The same boxes the simulation collides against, derived rather than
    // synced — the camera has to retract off them and the crosshair has to
    // converge on them, and both must agree with what stops a bullet.
    this.cover = coverFor(this.map, session.arenaSize);
    this.rig = new CameraRig(this.camera, session.arenaSize, this.engine, this.cover);

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

    // Effect volume scales with the graphics tier. A phone still gets an
    // explosion; it gets one made of forty cubes instead of ninety, which is
    // the tail of a burst nobody has ever counted. See EFFECT_BUDGETS.
    this.budget = effectBudget(gfx);
    this.bullets = new BulletPool(this.scene, this.glow, this.budget.tracers);
    this.debris = new DebrisPool(
      this.scene, this.glow, this.budget.debris, modValue(this.modifier, 'debrisGravityMul'),
    );
    this.blasts = new BlastRings(this.scene, this.glow);
    this.rings = new RoleRings(this.scene, this.glow);
    this.muzzle = new MuzzleFlash(this.scene, this.glow);
    // Engineer pads, keyed by id like every other transient world object.
    this.pads = new Map();

    // Your own beak, in first person. See BEAK in view.js.
    this.beak = new BeakView(this.scene, this.camera);

    // The career tally. Roles rotate every round, so "what did you finish as"
    // is not the question mastery asks — this is what was actually played, by
    // role, kept here because the Game is the only thing that sees every
    // second of it. Read once at the whistle. See shared/src/progress.js.
    this.roleXp = Object.create(null);
    this.contractsDone = 0;
    // Where each bar stood at kick-off. Added to `roleXp` for display only —
    // what gets banked at the whistle is the earnings, never this.
    this.careerRoleXp = career ?? {};

    /**
     * One read of the world per frame, shared by everything that draws it.
     *
     * `session.players` and its neighbours are GETTERS that rebuild their
     * answer on every access — for the online session that means walking the
     * Colyseus schema and minting eight ~45-field objects, plus a maxHpOf and
     * an abilityMax per player. The frame path was touching `players` six
     * times a frame, `bomb` four, `nests` three, and so on down: roughly forty
     * fresh allocations per frame, all of them identical to each other, all of
     * them garbage by the next one.
     *
     * So the frame reads the world exactly once, here, and everything
     * downstream is handed the same snapshot. Event handlers still go straight
     * to the session — they run on a kill or a chat line, not sixty times a
     * second, and a stale snapshot is the one thing this must never hand out.
     */
    this.snap = {
      players: [], self: null, phase: 'lobby', clock: 0, safeHalf: 0,
      pickups: [], nests: [], looseEggs: [], pads: [], bomb: null, hill: null,
      bomber: null, potato: null, teamScores: null, takenRoles: [], revealLeft: 0,
      bounty: null,
    };

    this.views = new Map();
    // Who is allowed a health bar. Nameplates are HTML with no depth buffer,
    // so this is what stops them being a wallhack — see PlateVision.
    this.plateVision = new PlateVision();
    this.visiblePlates = null;
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
    // 'auto' | 'on' | 'off' resolved against the device — a fine pointer gets
    // no assist, because a mouse is already exact and a soft lock on top of one
    // is what "the shots don't feel like mine" actually is.
    this.controls.setAssist(assistOn(gfx?.assist));
    this.controls.setSensitivity(gfx?.sensitivity ?? 1);
    tts.setEnabled(!!gfx?.announcer);
    // The arena never changes size within a match — the map vote resolves
    // before the Game is built — so this is set once.
    this.controls.setArenaHalf(session.arenaSize / 2);
    this.controls.setCover(this.cover);
    this.setView(gfx?.view);

    // Holds the frame rate by trading pixels for it, and honours a manual cap
    // if the player set one. Built after the engine has its scaling level, so
    // the setting from the panel becomes the ceiling. See game/adaptive.js.
    this.adaptive = new Adaptive(this.engine, gfx ?? {});

    // Who to watch while dead — set from the kill event, cleared on respawn.
    this.killedBy = null;

    // Team markers, and the world point the open wheel is aimed at. Latched
    // when the wheel opens, because that is the moment the player pointed at
    // the thing they mean.
    this.pings = new Map();
    this.pingAim = null;
    this.bindPingWheel();

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
      // ...and a different pixel count means the resolution the player asked
      // for is a different scaling level. Re-anchor before adapting again.
      this.adaptive.onResize(this.engine.getHardwareScalingLevel());
    };
    window.addEventListener('resize', this.onResize);

    this.engine.runRenderLoop(() => this.frame());
  }

  setButtonEdit(on) { this.controls.setButtonEdit(on); }

  setAssist(on) { this.controls.setAssist(on); }

  setSensitivity(mul) { this.controls.setSensitivity(mul); }

  /** Both are live: neither needs the renderer rebuilt to take effect. */
  setDynamicRes(on) { this.adaptive.setEnabled(on); }

  setFpsCap(fps) { this.adaptive.setFpsCap(fps); }

  /** Live brightness, as a multiplier over whatever the scene was built with. */
  setBrightness(mul) {
    const g = clamp(Number(mul) || 1, 0.5, 1.8) / (this.lights.gain || 1);
    if (this.lights.hemi) this.lights.hemi.intensity *= g;
    if (this.lights.key) this.lights.key.intensity *= g;
    this.lights.gain = clamp(Number(mul) || 1, 0.5, 1.8);
  }

  /**
   * Switch between the eye and the shoulder.
   *
   * Three things move together, and all three have to: the camera framing, the
   * angle the shot is bent to (view.js), and whether your own chicken is drawn.
   * Set only two of them and the game either aims at nothing or renders the
   * inside of your own beak.
   */
  setView(v) {
    this.view = asView(v);
    this.rig.setView(this.view);
    this.controls.setView(this.view);
    return this.view;
  }

  toggleView() {
    return this.setView(this.view === 'tpp' ? 'fps' : 'tpp');
  }

  // ------------------------------------------------------------------ setup

  bindSession() {
    this.session.on('fx', (events) => this.handleFx(events));
    this.session.on('feed', (f) => {
      this.hud.addFeed(f);
      if (f.kind === 'kill' && f.multi > 1) this.hud.announceMulti(f.multi);
    });
    this.session.on('chat', (m) => this.hud.addChat(m));
    // Only ever arrives for your own side — see ArenaRoom.handlePing.
    this.session.on('ping', (m) => this.addPing(m));
    // Refusals arrive here too, with role null. Nothing to do but redraw — the
    // picker reads the roster, and going quiet on a refusal is the exact dead
    // time this feature was told not to add.
    this.session.on('role', () => this.hud.repaintRolePicker());
  }

  /**
   * The wheel, on both input schemes.
   *
   * Touch drives it from the HUD button; the keyboard drives it from Z, with
   * the mouse borrowed for the selection. Both end in the same place: an intent
   * and the point that was under the crosshair when the wheel opened.
   */
  bindPingWheel() {
    const open = () => {
      this.pingAim = this.pingTarget();
      this.hud.openPingWheel();
    };
    const close = (intent) => {
      const at = this.pingAim;
      this.pingAim = null;
      if (!intent || !at) return;
      this.session.sendPing?.(intent, at.x, at.z);
    };

    // One button, whatever the role decides it does. The simulation refuses it
    // when there is no charge, no heading, or no ability at all.
    this.controls.onAbility = () => this.session.sendAbility?.();
    // 1-6 while the picker is up. Ignored otherwise: a number key that swaps
    // your role mid-fight is a number key somebody presses mid-fight.
    this.controls.onRolePick = (i) => {
      if (!this.hud.pickerUp) return;
      const role = ROLE_LIST[i];
      if (role) this.hud.pickRole(role);
    };
    this.controls.onPingOpen = open;
    this.controls.onPingDrag = (dx, dy) => this.hud.movePingWheel(dx, dy);
    this.controls.onPingClose = () => close(this.hud.closePingWheel());
    // The HUD owns the touch button, so it calls back rather than being polled.
    this.hud.onPing = { open, close };
  }

  /**
   * Where the crosshair is actually pointing, in world space.
   *
   * The same ray view.js converges the shot onto — a marker has to land on the
   * thing you were looking at, and "the thing you were looking at" is already
   * a solved problem here.
   */
  pingTarget() {
    const self = this.self();
    if (!self) return null;
    const px = this.pred.has ? this.pred.x : self.x;
    const py = this.pred.has ? this.pred.y : (self.y ?? 0);
    const pz = this.pred.has ? this.pred.z : self.z;
    const basis = lookBasis(this.controls.yaw, this.controls.pitch);
    const half = this.session.arenaSize / 2;
    const o = rayOrigin(px, py, pz, basis, half);
    const foes = this.session.players.filter((p) => !p.isSelf && p.alive);
    const range = convergeDistance(o, basis, foes, half, this.cover);
    return { x: o.x + basis.fx * range, z: o.z + basis.fz * range };
  }

  addPing(m) {
    if (!m?.intent) return;
    this.pings.set(String(m.id), { ...m, left: m.life ?? PING.life });
    this.hud.addPingLine(m);
    sfx.play('ping');
  }

  stepPings(dt) {
    for (const [key, p] of this.pings) {
      p.left -= dt;
      if (p.left <= 0) this.pings.delete(key);
    }
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
          // Your own shots in first person leave the tip of your beak, not the
          // camera. Everyone else's — and all of your own in third person —
          // leave the chicken, which is where the simulation put them.
          const ownShot = self && e.owner === self.id;
          const fromBeak = ownShot && this.view === 'fps' && this.beak.shown;
          const tip = fromBeak ? this.beak.tipWorld() : null;
          this.bullets.spawn(e, tip);
          // The flash comes back for your own shots now that it has somewhere
          // to be that is not inside your head. It was suppressed because a
          // 0.9-unit glowing sphere at point blank was a full-screen white
          // flash; on the end of a beak it is what firing looks like.
          // The world flash is a 0.9-unit glowing sphere on the glow layer:
          // right at five metres, a full-screen white blowout at the 0.8 units
          // your own beak sits from the camera. Your own first-person flash is
          // the beak's, sized for the distance it is actually seen from.
          if (!tip) this.muzzle.fire(e.x, e.y, e.z);
          // ...replaced by a recoil kick, which reads as "I fired" far better
          // than a flash does anyway — and which now moves the AIM rather than
          // only the camera. It goes to the controls, not to the rig: the rig
          // renders whatever pitch it is handed, and a rig with its own private
          // kick is exactly the bug look.js exists to prevent.
          //
          // Driven by the shot EVENT rather than by the trigger, so a round the
          // crop could not pay for never kicks.
          if (ownShot) {
            this.controls.addRecoil();
            this.beak.kick();
          }
          sfx.play(e.rapid ? 'rapidShot' : 'shot');

          // Impact sparks, at the point the trace already resolved to. There is
          // no separate "the bullet landed" message any more — the shot event
          // carries both ends of the line, because both were decided in the
          // same instant.
          if (e.hx !== undefined) {
            this.debris.emit('red', e.hx, e.hy ?? 0.85, e.hz, e.hit ? 6 : 4, {
              speed: e.hit ? 7 : 5, up: 0.5, size: 0.35, life: 0.32, drag: 3.5,
            });
          }
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
            sfx.play(e.head ? 'headshot' : 'hit');
            // The recorded sting rides ON TOP of the synth ping rather than
            // replacing it. The ping is the confirmation — instant, and it
            // arrives on the same frame as the hit marker; the sample is the
            // celebration behind it. Swapping one for the other would trade a
            // tight confirm for a slower, prettier one.
            if (e.head) sfx.sample('headshot');
            // ...and now a visible one as well. The sound was carrying this
            // alone, which fails exactly when it matters: a phone on silent, a
            // busy round, or the moment three other things are also making
            // noise. Two channels saying the same thing is redundancy, not
            // clutter.
            this.hud.hitMarker(e.head ? 'head' : 'hit');
            if (e.head) {
              this.hud.announce('HEADSHOT');
              tts.say('Headshot', { priority: SAY.streak, key: 'headshot' });
              // A burst at the point of impact, not at the body centre — a
              // headshot that sprays feathers from the belly does not read as
              // one, and reading it is the entire reward.
              this.debris.feathers(at.x, atY + 1.55, at.z, 7);
            }
          }
          break;
        }
        case 'kill': {
          this.explodeChicken(e.x, e.y ?? 0, e.z, e.color);
          if (self && e.target === self.id) {
            this.rig.addShake(0.75);
            sfx.play('death');
            // Your own death only. Eight chickens dying every twenty seconds
            // would make this the most-heard sound in the game, and a sting
            // you hear constantly stops being one.
            sfx.sample('death');
            // Stash it for the respawn overlay — by the time that renders, the
            // event is long gone.
            this.killedBy = e.by
              ? { name: e.byName, color: e.byColor, hp: e.byHp, dist: e.byDist, kind: e.kind }
              : { name: null, kind: e.kind };
          } else {
            sfx.play('kill');
          }
          if (self && e.by === self.id) {
            // The kill mark, over the top of the hit mark the same round just
            // drew. Distinct from an ordinary hit on purpose: "they are dead"
            // and "that landed" are different pieces of news, and a fight you
            // have already won is a fight you should stop spending grain on.
            this.hud.hitMarker('kill');
            this.earnRole(self.role, PROGRESS.mastery.perKill);
            if (e.multi > 1) sfx.streak(e.multi);
            if (e.revenge) {
              this.hud.announce('REVENGE!');
              sfx.play('pickupHealth');
            }
            // Spoken, in order of how much it deserves the channel. A
            // multikill outranks a revenge outranks a plain kill, and only one
            // of them is ever said — see tts.js on why speech cannot queue.
            const name = MULTIKILL_NAMES[Math.min(e.multi, MULTIKILL_NAMES.length) - 1];
            if (e.multi > 1 && name) {
              tts.say(name, { priority: SAY.streak, key: 'multi' });
            } else if (e.revenge) {
              tts.say('Revenge', { priority: SAY.streak, key: 'revenge' });
            } else if (e.punchedUp) {
              tts.say('Giant slayer', { priority: SAY.streak, key: 'punchUp' });
            } else {
              tts.say('Chicken down', { priority: SAY.kill, key: 'kill' });
            }
          } else if (self && e.target === self.id && e.byName) {
            tts.say(`Killed by ${e.byName}`, { priority: SAY.kill, key: 'death' });
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
          tts.say('Bomber incoming', { priority: SAY.event, key: 'bomber' });
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
            this.contractsDone++;
            this.earnRole(self.role, PROGRESS.mastery.perContract);
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
          if (self && e.from === self.team && e.by !== self.id) {
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
          const mine = self && e.team === self.team;
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
        // --- the pecking order
        case 'levelUp':
        case 'levelDown': {
          const mine = self && e.target === self.id;
          const up = e.type === 'levelUp';
          if (mine) {
            // The payoff. Banner, sound, and a burst of feathers in the rung's
            // own colour — three channels, because this half-second is what the
            // whole climb gets remembered as.
            this.hud.announceRung(e);
            sfx.play(up ? 'levelUp' : 'levelDown');
            this.rig.addShake(up ? 0.28 : 0.12);
            tts.say(up ? `Level ${e.level}. ${e.name}` : `Demoted. ${e.name}`,
              { priority: SAY.streak, key: 'rung' });
          } else {
            // Someone ELSE moved. Quieter, but not silent: knowing the room's
            // hierarchy is shifting is most of what makes the ladder social.
            sfx.play(up ? 'rivalUp' : 'hit');
          }
          this.debris.emit(up ? 'gold' : 'white', e.x, (e.y ?? 0) + 1.0, e.z, up ? 18 : 8, {
            speed: up ? 9 : 5, up: 1.3, size: 0.3, life: up ? 0.9 : 0.5, drag: 2,
          });
          break;
        }
        case 'secondWind': {
          // Rung 5, firing at the worst moment of a fight. Loud for its owner
          // because it is a rescue they should feel arrive.
          this.debris.emit('gold', e.x, (e.y ?? 0) + 0.9, e.z, 12, {
            speed: 8, up: 1.2, size: 0.26, life: 0.6, drag: 2.4,
          });
          if (self && e.target === self.id) {
            this.hud.announce('SECOND WIND');
            sfx.play('secondWind');
          }
          break;
        }
        // --- role abilities
        case 'dash': {
          this.debris.emit('white', e.x, (e.y ?? 0) + 0.35, e.z, 7, {
            speed: 5, up: 0.3, size: 0.2, life: 0.3, drag: 4,
          });
          if (self && e.target === self.id) sfx.play('dash');
          break;
        }
        case 'pulse': {
          // The ring is drawn whether or not it caught anyone: a Medic has to
          // be able to SEE their own radius, or they cannot learn where to
          // stand, which is the entire skill of the role.
          this.rings.ring(e.x, e.y ?? 0, e.z, e.radius, roleDef('medic').color);
          if (self && e.target === self.id) sfx.play('pulse');
          break;
        }
        case 'healed': {
          this.debris.emit('green', e.x, (e.y ?? 0) + 1.0, e.z, 4, {
            speed: 3, up: 1.2, size: 0.17, life: 0.4, drag: 3,
          });
          if (self && e.target === self.id) {
            this.hud.popDamage(this.projectFn(e.x, (e.y ?? 0) + 1.9, e.z), e.heal, 'heal');
            sfx.play('healed');
          }
          break;
        }
        case 'sweep': {
          this.rings.ring(e.x, e.y ?? 0, e.z, Math.min(e.range, 22), roleDef('scout').color);
          // Only your own side hears it. An enemy who learned that a sweep had
          // just happened would know to break line of sight, which is exactly
          // the information the Scout was buying.
          if (self && e.team === self.team) {
            sfx.play('sweep');
            if (e.target === self.id) this.hud.announce(`SWEEP — ${e.found} SPOTTED`);
          }
          break;
        }
        case 'bulwark': {
          this.debris.emit('white', e.x, (e.y ?? 0) + 0.9, e.z, 14, {
            speed: 6, up: 0.9, size: 0.32, life: 0.7, drag: 2.6,
          });
          if (self && e.target === self.id) {
            this.hud.announce('BULWARK');
            sfx.play('bulwark');
          }
          break;
        }
        case 'pad': {
          this.debris.emit('gold', e.x, 0.3, e.z, 8, {
            speed: 3.4, up: 0.6, size: 0.2, life: 0.4, drag: 3.5,
          });
          if (self && (e.team === self.team || e.target === self.id)) sfx.play('pad');
          break;
        }
        case 'role': {
          if (!self || e.target !== self.id) break;
          this.hud.setRole(e.role);
          // A rotation you asked for needs no announcement — you just tapped
          // it. One you were handed does: respawning as a Bruiser with 180 HP
          // and a falloff you did not choose is a different chicken, and it has
          // to say so before the first fight rather than after it.
          if (e.rotated) {
            const def = roleDef(e.role);
            this.hud.announce(`ROTATED · ${def.name.toUpperCase()}`);
            tts.say(`You are ${def.name}`, { priority: SAY.event, key: 'role' });
          }
          break;
        }
        case 'frenzy': {
          this.debris.emit('red', e.x, (e.y ?? 0) + 1.1, e.z, 14, {
            speed: 10, up: 1.1, size: 0.3, life: 0.7, drag: 2,
          });
          if (self && e.target === self.id) {
            this.hud.announce('FEEDING FRENZY');
            sfx.play('frenzy');
          }
          break;
        }
        case 'peck': {
          if (self && e.target === self.id) sfx.play('peck');
          // A small puff of grain dust at the beak. Quiet on purpose: this
          // happens constantly, and an effect loud enough to notice the first
          // time is exhausting by the twentieth.
          this.debris.emit('gold', e.x, 0.25, e.z, 3, {
            speed: 1.8, up: 0.4, size: 0.12, life: 0.3, drag: 4,
          });
          break;
        }
        case 'fed': {
          this.debris.emit('green', e.x, 1.0, e.z, 4, {
            speed: 3.2, up: 1.1, size: 0.18, life: 0.45, drag: 3,
          });
          if (self && e.target === self.id) {
            this.hud.popDamage(this.projectFn(e.x, (self.y ?? 0) + 1.9, e.z), e.heal, 'heal');
            sfx.play('fed');
          }
          break;
        }
        case 'dryFire': {
          // The one moment a player MUST get feedback: they asked for a shot
          // and did not get one. Silence here reads as the game being broken
          // rather than as the magazine being empty.
          // Sound only. The crosshair is already red and the crop hint already
          // says what to do — putting it through the announcer as well would be
          // a fourth channel for one event, and the announcer is where match
          // results live.
          if (self && e.target === self.id) sfx.play('dryFire');
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
            // Fresh life, fresh gun. The simulation zeroes the movement cone on
            // respawn for the same reason: a first shot back that misses for
            // something you did that last life reads as the game cheating.
            this.controls.look.reset();
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

  /** Adds mastery XP to whichever role earned it. */
  earnRole(role, xp) {
    if (!role || !(xp > 0)) return;
    this.roleXp[role] = (this.roleXp[role] ?? 0) + xp;
  }

  /** The match's mastery tally, for the results screen. */
  careerTally() {
    return { roleXp: { ...this.roleXp }, contracts: this.contractsDone };
  }

  /** Career mastery INCLUDING this match so far, for the picker's pips. */
  liveMastery() {
    const out = { ...this.careerRoleXp };
    for (const [role, xp] of Object.entries(this.roleXp)) out[role] = (out[role] ?? 0) + xp;
    return out;
  }

  flashHurt() {
    document.body.animate(
      [{ boxShadow: 'inset 0 0 90px 20px rgba(255,45,75,0.55)' }, { boxShadow: 'inset 0 0 0 0 rgba(255,45,75,0)' }],
      { duration: 380, easing: 'ease-out' },
    );
  }

  // ----------------------------------------------------------------- frame

  /**
   * Reads the world once, into `this.snap`. See the field for why.
   *
   * Ordered cheapest-last on purpose: `players` is by far the most expensive
   * of these and everything else is a handful of field reads.
   */
  sample() {
    const s = this.session;
    const snap = this.snap;
    snap.players = s.players;
    snap.self = snap.players.find((p) => p.isSelf) ?? null;
    snap.phase = s.phase;
    snap.clock = s.clock;
    snap.safeHalf = s.safeHalf;
    snap.pickups = s.pickups;
    snap.nests = s.nests ?? [];
    snap.looseEggs = s.looseEggs ?? [];
    snap.pads = s.pads ?? [];
    snap.bomb = s.bomb;
    snap.hill = s.hill;
    snap.bomber = s.bomber;
    snap.potato = s.potato;
    snap.teamScores = s.teamScores;
    snap.takenRoles = s.takenRoles ?? [];
    snap.revealLeft = s.revealLeft ?? 0;
    snap.bounty = s.bounty;
    return snap;
  }

  frame() {
    if (this.disposed) return;

    // The frame cap, checked before anything else — a skipped frame has to
    // cost a comparison, or capping to 30 would mean doing the work twice and
    // showing it once. Babylon drives this off requestAnimationFrame, so the
    // display still paces us and we simply decline some of the slots.
    const now = performance.now();
    if (!this.adaptive.shouldRender(now)) return;

    // Timed OFF THE WALL CLOCK, not off engine.getDeltaTime().
    //
    // Babylon updates its own delta inside beginFrame, which runs on every
    // animation frame whether or not our render callback does anything. So with
    // a frame cap set, the frames we actually run would each be told 16ms had
    // passed when 33ms really had — and every time-based thing in the game
    // would quietly halve: the offline sim would run the match at half speed,
    // prediction would drift behind the server, and the camera and the waddle
    // would move at the wrong rate. A cap has to change how often we draw and
    // nothing else.
    //
    // Clamped the same way the old path was, so one long stall (a tab returning
    // to the foreground) still cannot fast-forward the world.
    const deltaMs = this.lastFrameAt ? Math.min(now - this.lastFrameAt, 250) : this.engine.getDeltaTime();
    this.lastFrameAt = now;
    const dt = Math.min(deltaMs / 1000, 0.1);
    // Our own frame rate, which with a cap set is NOT the display's — and the
    // display's is what engine.getFps() measures. Reported rather than that so
    // the readout says what the player is seeing.
    this.fps = this.fps ? this.fps + (1000 / Math.max(1, deltaMs) - this.fps) * 0.08 : 1000 / Math.max(1, deltaMs);
    // Both halves of the frame, from the frame before this one: the whole
    // elapsed time says whether the device is keeping up, and our own share of
    // it says whether giving up pixels could possibly help. See Adaptive.update.
    this.adaptive.update(deltaMs, this.lastCpuMs ?? 0);

    this.session.update(dt);

    const snap = this.sample();
    const players = snap.players;
    const self = snap.self;

    // Time served, in whatever role you are currently holding. Alive only —
    // a respawn screen is not practice.
    if (self?.alive && this.snap.phase === 'live') {
      this.earnRole(self.role, dt * PROGRESS.mastery.perSecond);
    }

    this.pumpInput(dt, self);
    this.predict(dt, self);
    this.syncPlayers(dt, players, self);
    this.syncPickups(dt);
    this.syncBomber(dt);

    this.syncObjectives(dt, players);
    this.stepPings(dt);
    this.potatoView.sync(this.snap.potato, dt);
    this.bullets.update(dt);
    this.debris.update(dt);
    this.blasts.update(dt);
    this.rings.update(dt);
    this.muzzle.update(dt);
    this.syncPads(dt);
    // First person only: in third person you can already see the whole chicken,
    // and a beak floating in front of the camera would be a second one.
    this.beak.setVisible(this.view === 'fps' && (!self || self.alive));
    this.beak.update(dt, {
      moving: Math.hypot(this.controls.input.mx, this.controls.input.mz) > 0.1,
      pecking: !!(self?.pecking || self?.feeding),
      dry: !!self?.dry,
    });

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

    // Who has earned a health bar this frame. Off the LOCAL look angles and
    // the PREDICTED position — the same pair fire() builds a round from, so a
    // bar appears exactly when a shot would arrive. See PlateVision.
    this.visiblePlates = this.plateVision.update(dt, {
      self,
      players,
      x: focusX, y: focusY, z: focusZ,
      yaw: this.controls.yaw,
      pitch: this.controls.pitch,
      obstacles: this.cover,
      revealed: (this.snap.revealLeft ?? 0) > 0,
    });

    // Render BEFORE projecting the HUD. projectFn reads scene.getTransformMatrix(),
    // which is only recomputed during render — projecting first would place every
    // nameplate using the previous frame's camera.
    this.scene.render();

    // Nameplates track the *rendered* position of each chicken, not the raw
    // server position: our own chicken is drawn at the predicted spot and
    // everyone else's is interpolated, so using server coordinates here left
    // every plate floating away from the bird it belongs to.
    this.hud.syncNameplates(
      players, this.projectFn, this.session.selfId, (id) => this.views.get(id),
      this.visiblePlates,
    );
    this.hud.syncBomberFuse(this.snap.bomber, this.projectFn, this.bomberView);
    // Only does anything while the board is held open — see setScoreboardOpen.
    this.hud.syncScoreboard(players, this.session.selfId);
    this.hud.setClock(this.snap.clock);
    this.hud.setObjective({
      teamScores: this.snap.teamScores,
      hill: this.snap.hill,
      nests: MODES[this.session.mode]?.heist ? this.snap.nests : null,
      bomb: this.snap.bomb,
      self,
      players,
    });
    this.hud.setVitals(self, cropCapacity(this.modifier));
    this.hud.setRole(self?.role ?? null);
    this.hud.setAbility(self);
    // Scout vision. Held as seconds left rather than a flag so the edge glow
    // can be driven off the same number that decides who is drawn through walls.
    const revealLeft = this.snap.revealLeft ?? 0;
    this.hud.setSweep(revealLeft);
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
      // Three states, because "can I shoot" is three questions: yes, no, and
      // not yet. Reloading and empty look different on purpose — one is a wait
      // you started, the other is a wait you have to start.
      // `dry` rather than `crop === 0`: after running out you stay locked until
      // the crop is back above CROP.recoverTo, and the reticle has to say so for
      // the whole of that window rather than clearing on the first grain.
      const busy = !!(self?.pecking || self?.feeding);
      // The arms ARE the movement cone, converted from radians to pixels
      // through the camera's own field of view — so what the reticle shows is
      // the radius a round can actually land inside, not a stylised wobble.
      //
      // Read from the local look state rather than from the snapshot. The cone
      // is a pure function of what the player is doing this frame, and a
      // reticle that opened a network tick after they started running would be
      // describing a stance they had already left.
      //
      // In third person the cone leaves the chicken while the reticle belongs
      // to a camera four units behind it, so the conversion is a close
      // approximation there rather than an identity — the same parallax view.js
      // exists to manage, and far smaller than the cone it is drawing.
      const spread = spreadPixels(
        this.controls.spread,
        this.camera.fov,
        this.engine.getRenderHeight() * this.engine.getHardwareScalingLevel(),
      );
      this.hud.setCrosshair(alive, self?.dry ? 'dry' : (busy ? 'busy' : ''), spread);
    }
    const dead = self && !self.alive;
    this.hud.setRespawn(dead ? self.respawnIn : 0);
    this.hud.setKilledBy(dead ? this.killedBy : null);
    // THE PICKER, and where it is allowed to appear: while dead, and during
    // warmup before the first spawn. Never over a live fight — a menu you can
    // open mid-duel is a menu somebody opens mid-duel.
    this.syncRolePicker(self, dead);

    // Refresh at 4Hz — this is a diagnostic, and rebuilding its DOM every
    // frame would itself cost frames on the devices most likely to need it.
    this.statsAt -= dt;
    if (this.statsAt <= 0) {
      this.statsAt = 0.25;
      this.hud.setNetStats(this.session.netStats(), this.fps ?? this.engine.getFps());
    }

    // Our own share of the frame, handed to the resolution scaler on the next
    // one. Measured here at the very end rather than by wrapping frame(),
    // because a wrapper would be one more call in the hottest path in the game
    // to measure the cost of the hottest path in the game.
    this.lastCpuMs = performance.now() - now;
  }

  pumpInput(dt, self) {
    const src = this.pred.has ? this.pred : self;
    // Aim assist runs client-side, so it needs the roster. See
    // shared/src/aim.js for why it is on this side of the wire.
    const players = this.snap.players;
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
    const half = this.snap.safeHalf;

    // Everything stepPlayers does to velocity has to be mirrored here, or the
    // prediction and the server disagree permanently and the correction fights
    // your input every frame.
    //
    // Knockback was the big omission: it is ADDED to movement server-side, so a
    // client that ignores it predicts you walking forward while the server has
    // you flying backwards. That mismatch is what made being shot feel like the
    // controls had come loose.
    let moveScale = this.snap.phase === 'live' ? 1 : 0.35;
    if (self.carrying > 0) {
      moveScale *= 1 - Math.min(HEIST.maxCarrySlow, HEIST.carrySlow * self.carrying);
    }
    if (this.snap.bomb?.carriedBy === self.id) moveScale *= 1 - BOMB.carrySlow;

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
    const reveal = this.snap.revealLeft ?? 0;

    for (const p of players) {
      seen.add(p.id);
      let view = this.views.get(p.id);
      if (!view) {
        view = new PlayerView(this.scene, p, { aura: this.budget.aura });
        this.views.set(p.id, view);
      }

      view.setVisible(p.alive);
      // First person only: the camera is inside your own head, so your body
      // would fill the screen from the inside. In third person it is the thing
      // you are looking at.
      view.setHidden(p.isSelf && this.view === 'fps');
      if (!p.alive) continue;

      const isSelf = p.isSelf;
      // Our own chicken uses the predicted transform; everyone else is
      // smoothed toward the last server position.
      const crowned = this.snap.bounty === p.id;
      // Whoever killed you last is outlined, so a grudge has somewhere to go.
      const nemesis = !!self && !p.isSelf && self.nemesis === p.id;
      // Lit up by our Scout. Decided per FRAME from our own side's clock, never
      // read off a flag on the enemy — see revealedTo: a revealed player must
      // not be told they have been spotted.
      const spotted = reveal > 0 && !!self && self.team !== null
        && p.team !== null && p.team !== self.team;
      const target = isSelf && this.pred.has
        ? {
          x: this.pred.x, y: this.pred.y, z: this.pred.z,
          // Your own body turns with the LOCAL look angle, never the server's
          // echo of it. Invisible in first person, glaring in third: `p.aim` is
          // where you were pointing a round trip ago, so the chicken you are
          // watching would swing into place a tenth of a second after the
          // camera did.
          aim: this.controls.yaw,
          invuln: p.invuln, level: p.level, wind: p.wind, frenzy: p.frenzy, bounty: crowned,
          // Your own peck pose matters in third person, where you are watching
          // your own chicken do it.
          pecking: p.pecking, feeding: p.feeding,
          nemesis: false, spotted: false,
        }
        : { ...p, bounty: crowned, nemesis, spotted };

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
      const hill = this.snap.hill;
      const holder = hill?.holder ? players.find((p) => p.id === hill.holder) : null;
      this.hillZone.update(
        dt, holder?.color ?? null, !!hill?.contested,
        hill?.x ?? 0, hill?.z ?? 0, hill?.moveAt ?? null,
      );
    }

    this.syncNests(dt, players);
    this.syncEggs(dt);
    if (this.bombView) this.bombView.sync(this.snap.bomb, dt);

    if (this.safeZone) {
      const half = this.snap.safeHalf;
      const closing = half < this.lastSafeHalf - 0.0005;
      this.safeZone.update(dt, half, closing);
      this.lastSafeHalf = half;
    }
  }

  /** Nests are keyed by team and coloured by the roost that owns them. */
  syncNests(dt, players) {
    const nests = this.snap.nests ?? [];
    const self = players.find((p) => p.isSelf);
    const rules = MODES[this.session.mode] ?? {};
    const bomb = this.snap.bomb;

    // Which nests the player is currently supposed to be running at. Lighting
    // these up is what turns "carry it to a rival nest" from instructions into
    // something you can see from across the arena.
    const carryingBomb = rules.bomb && bomb?.carriedBy === self?.id;
    const raiding = rules.heist && self && self.carrying === 0;

    for (const nest of nests) {
      let view = this.nests.get(nest.team);
      if (!view) {
        view = new NestView(this.scene, nest, TEAM_COLORS[nest.team] ?? SEAT_COLORS[nest.team]);
        this.nests.set(nest.team, view);
      }
      const rival = self ? nest.team !== self.team : false;
      const owned = players.some((p) => p.team === nest.team);
      const target = (carryingBomb && rival && owned)
        || (raiding && rival && nest.eggs > 0)
        || (rules.bomb && bomb?.state === 'planted' && bomb.plantTeam === nest.team);
      view.update(dt, nest, target);
    }
  }

  syncEggs(dt) {
    const seen = new Set();
    for (const egg of this.snap.looseEggs ?? []) {
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
   * Shows the picker while dead or in warmup, and never over a live fight.
   *
   * THE WHOLE RULE OF THIS SCREEN is that it costs nothing. The three-second
   * respawn keeps counting behind it, the current role is already selected, and
   * a player who never looks at it comes back in what they were playing. It is
   * only ever a decision when a team-mate has taken their role — and that is
   * the one case worth saying out loud, which is what `forced` is for.
   */
  syncRolePicker(self, dead) {
    const warmup = this.snap.phase === 'warmup';
    const visible = !!self && (dead || warmup);
    if (!visible) {
      this.hud.setRolePicker({ visible: false });
      return;
    }
    this.hud.setRolePicker({
      visible: true,
      mine: self.role ?? null,
      taken: this.snap.takenRoles ?? [],
      level: self.level ?? 1,
      teamed: !!MODES[this.session.mode]?.teams,
      rotateTo: self.rotateTo ?? null,
      mastery: this.liveMastery(),
    });
  }

  /** Engineer feeders, built and torn down like every other transient object. */
  syncPads(dt) {
    const seen = new Set();
    for (const pad of this.snap.pads ?? []) {
      seen.add(pad.id);
      let view = this.pads.get(pad.id);
      if (!view) {
        // Team colour, so at a glance you know whether the pad you are running
        // to is one you can actually eat off.
        const color = pad.team >= 0 ? TEAM_COLORS[pad.team] : roleDef('engineer').color;
        view = new PadView(this.scene, pad, color);
        this.pads.set(pad.id, view);
      }
      view.sync(pad, dt);
    }
    for (const [id, view] of this.pads) {
      if (seen.has(id)) continue;
      view.dispose();
      this.pads.delete(id);
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
    const nests = this.snap.nests ?? [];
    const inp = this.controls.input;
    const still = Math.hypot(inp.mx, inp.mz) < 0.2;
    const near = (n, r) => Math.hypot(px - n.x, pz - n.z) <= r;

    if (rules.bomb) {
      const bomb = this.snap.bomb;
      if (!bomb) return null;

      if (bomb.state === 'planted') {
        // Only its owner can do anything about it. Everyone else is told to
        // defend, because "wait it out" is genuinely the correct play.
        if (bomb.plantTeam !== self.team) {
          return { text: `Bomb planted — ${Math.ceil(bomb.fuse)}s`, progress: 0 };
        }
        if (!near(bomb, BOMB.plantRadius)) {
          return { text: '⚠ GET TO YOUR NEST AND DEFUSE', progress: 0, urgent: true };
        }
        if (!still) return { text: 'STOP MOVING TO DEFUSE', progress: 0, urgent: true };
        return { text: 'DEFUSING…', progress: bomb.defuse, urgent: true };
      }

      if (bomb.carriedBy === self.id) {
        const target = nests.find((n) => n.team !== self.team && near(n, BOMB.plantRadius));
        if (!target) return { text: 'CARRY THE BOMB TO THEIR NEST', progress: 0 };
        if (!still) return { text: 'STOP MOVING TO PLANT', progress: 0 };
        return { text: 'PLANTING…', progress: bomb.plant };
      }

      if (bomb.state === 'loose') return { text: 'GRAB THE BOMB', progress: 0 };
      return null;
    }

    if (rules.heist) {
      if (self.carrying > 0) {
        const home = nests.find((n) => n.team === self.team);
        if (home && near(home, HEIST.nestRadius)) return null; // already banking
        return { text: `RUN ${self.carrying} EGG${self.carrying > 1 ? 'S' : ''} HOME`, progress: 0 };
      }
      const raidable = nests.some((n) => n.team !== self.team && n.eggs > 0);
      if (raidable) return { text: 'RAID THEIR NEST', progress: 0 };
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

    // --- team markers. Above everything else on purpose: a team-mate asking
    // you to look somewhere outranks any objective the game is asking for.
    for (const [key, ping] of this.pings) {
      const def = pingDef(ping.intent);
      out.push({
        key: `ping${key}`,
        x: ping.x,
        z: ping.z,
        icon: def.icon,
        color: def.color,
        who: ping.by === self.id ? null : ping.byName,
        ping: true,
        // Fades out over its last second rather than vanishing, so a marker
        // that expires mid-glance does not read as one that was never there.
        fade: Math.max(0.25, Math.min(1, ping.left)),
        urgent: false,
        dist: Math.hypot(ping.x - px, ping.z - pz),
        bearing: Math.atan2(ping.x - px, ping.z - pz) - yaw,
      });
    }

    // --- the bomber. The one thing that can kill you from behind.
    const b = this.snap.bomber;
    if (b) {
      const armed = b.state === 'arm';
      const d = Math.hypot(b.x - px, b.z - pz);
      // Always marked once it is armed; otherwise only when it is close enough
      // to be your problem.
      if (armed || d < BOMBER.detectRadius) add('bomber', b.x, b.z, '💣', '#ff2d4b', armed);
    }

    // --- Egg Heist: where the eggs go, and where to get more.
    if (rules.heist) {
      const nests = this.snap.nests ?? [];
      const home = nests.find((n) => n.team === self.team);
      if (self.carrying > 0 && home) {
        add('home', home.x, home.z, '🏠', self.color, false);
      } else {
        const target = nests
          .filter((n) => n.team !== self.team && n.eggs > 0)
          .sort((a, c) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(c.x - px, c.z - pz))[0];
        if (target) add('raid', target.x, target.z, '🥚', '#fff4d6', false);
      }
    }

    // --- Plant & Defuse: the bomb, or the nest it is in.
    if (rules.bomb) {
      const bomb = this.snap.bomb;
      if (bomb?.state === 'planted') {
        const mine = bomb.plantTeam === self.team;
        add('bomb', bomb.x, bomb.z, mine ? '🛠' : '💥', mine ? '#ff2d4b' : '#ffcc3d', mine);
      } else if (bomb?.carriedBy === self.id) {
        const nests = this.snap.nests ?? [];
        const target = nests
          .filter((n) => n.team !== self.team && players.some((p) => p.team === n.team))
          .sort((a, c) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(c.x - px, c.z - pz))[0];
        if (target) add('plant', target.x, target.z, '🎯', '#ff8a3d', false);
      } else if (bomb) {
        add('bomb', bomb.x, bomb.z, '💣', '#ffb020', false);
      }
    }

    // --- King of the Coop: the zone moves, so it has to be findable.
    const hill = this.snap.hill;
    if (hill) {
      const inside = Math.hypot(hill.x - px, hill.z - pz) <= HILL.radius;
      if (!inside) add('hill', hill.x, hill.z, '⬢', '#ffcc3d', false);
    }

    // --- Hot Potato: whoever has it wants to give it to you.
    const pot = this.snap.potato;
    if (pot) {
      const mine = pot.holder === self.id;
      add('potato', pot.x, pot.z, mine ? '🔥' : '🥔', '#ff8a3d', mine);
    }

    return out;
  }

  syncPickups(dt) {
    const seen = new Set();
    for (const pk of this.snap.pickups) {
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
    const b = this.snap.bomber;
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
    const bomb = this.snap.bomb;
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
    // Speech outlives a page far more stubbornly than audio nodes do: an
    // utterance already queued keeps talking after the match is gone.
    tts.stop();
    // The HUD outlives a match, so a wheel still pointed at this Game would
    // call into a disposed scene the next time somebody presses the button.
    this.hud.onPing = {};
    this.beak.dispose();
    this.controls.dispose();
    for (const v of this.nests.values()) v.dispose();
    for (const v of this.looseEggs.values()) v.dispose();
    for (const v of this.pads.values()) v.dispose();
    this.bombView?.dispose();
    sfx.stopFuse();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
