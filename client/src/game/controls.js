import nipplejs from 'nipplejs';
import { AIM_ASSIST, PLAYER, pickAimTarget, pullAim, pullPitch } from '@cluckdown/shared';
import { asView, convergeAim } from './view.js';

/**
 * First-person input.
 *
 * Cluckdown is a first-person game now, so there is exactly one control scheme:
 * a movement stick (or WASD) that is relative to where you are looking, and a
 * look control that is POSITIONAL on both mouse and touch.
 *
 * The simulation never learns any of this. It still receives the same plain
 * `{ mx, mz, ax, az, shoot }` struct it always has, in world space — the
 * rotation from "forward" to "north" happens here.
 */

// Base look sensitivity, in radians per pixel of pointer movement.
//
// Both mouse and touch are positional: you move the pointer by an amount, the
// view turns by a proportional amount. An earlier version used the right stick
// as a RATE control (hold right, keep turning) and it was the single loudest
// complaint about the game — hitting a specific angle meant holding a specific
// direction for exactly the right number of milliseconds, which a thumb cannot
// do under pressure. Every shipped mobile shooter uses a swipe surface for this
// reason.
//
// Touch is the more sensitive of the two because a thumb has far less travel
// available than a mouse does.
//
// BASE, because the player multiplies it. What feels right depends on the
// device, the grip and the person, and no single pair of numbers has ever
// served everyone — hence the sensitivity slider in Settings.
const FP_MOUSE_SENS = 0.0022;
const FP_TOUCH_SENS = 0.0052;

// Vertical sensitivity, as a fraction of horizontal.
//
// It used to be 0.65 on the grounds that pitch was a look control rather than
// an aim one — everything stood on the ground plane, so the vertical axis did
// nothing but tilt the horizon. Pitch is half of the shot now, so damping it is
// damping your aim: "the crosshair only moves left and right" was the report,
// and a sluggish vertical axis is the mild version of exactly that.
//
// Not quite 1.0 either. A screen is wider than it is tall, so a thumb has less
// vertical travel to spend, and every shooter that ships pulls this number
// slightly under.
const FP_PITCH_RATIO = 0.9;

export class Controls {
  constructor({ leftZone, canvas }) {
    this.input = { mx: 0, mz: 0, ax: 0, az: 0, pitch: 0, jump: false, shoot: false, seq: 0 };
    this.keys = new Set();
    this.destroyed = false;
    this.canvas = canvas;
    this.mouseDown = false;
    this.usingTouch = false;

    // Look angles are held here, not read back from the simulation: looking
    // around has to respond to this frame's input, not to a network round-trip.
    this.yaw = 0;
    this.pitch = 0;
    this.pointerLocked = false;

    // Aim assist state. Applied to our own look angles before sending — see
    // shared/src/aim.js for why it lives on this side of the wire.
    this.assistOn = true;
    this.aimTarget = null;
    this.assistYaw = 0;
    this.assistPitch = 0;

    // Player-set multiplier over the two base sensitivities above.
    this.sensitivity = 1;

    // Which camera is rendering. It changes nothing about how you look around
    // and everything about where the shot has to be pointed — see view.js.
    this.view = 'fps';
    // Third person needs the arena: the shoulder offset is squeezed against a
    // wall, and the aim has to be squeezed with it or the crosshair drifts off
    // the shot in exactly the places you are most likely to be fighting.
    this.arenaHalf = Infinity;
    // Cover, so a crosshair resting on a box converges on the box rather than
    // on whatever is 20 units past it.
    this.cover = [];

    // Touch look, tracked by pointerId so that looking with one thumb while
    // holding fire with another works. That is the whole reason fire is its own
    // button rather than living on the look surface.
    this.lookId = null;
    this.lookAt = { x: 0, y: 0 };
    this.stickX = 0;
    this.stickZ = 0;

    this.left = nipplejs.create({
      zone: leftZone,
      mode: 'dynamic',
      color: 'rgba(255,255,255,0.45)',
      size: 110,
      fadeTime: 100,
      restJoystick: true,
    });

    // nipplejs 1.x hands the listener ONE argument, `{ type, target, data }`,
    // where the joystick payload lives on `.data`. (0.x used to call
    // `(event, data)`.) Reading the old second argument throws on every single
    // touchmove, which silently kills the stick — hence this helper.
    const payload = (evt) => evt?.data ?? evt;

    this.left.on('move', (evt) => {
      const d = payload(evt);
      if (!d?.vector) return;
      this.usingTouch = true;
      const f = Math.min(1, d.force);
      // Kept raw: these are strafe/forward axes and have to be rotated into
      // world space by the current yaw, which only happens at sample time.
      this.stickX = d.vector.x * f;
      this.stickZ = d.vector.y * f;
    });
    this.left.on('end', () => { this.stickX = 0; this.stickZ = 0; });

    // ------------------------------------------------------------ keyboard
    this.onKeyDown = (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      // Space scrolls the page and clicks whatever has focus if left alone.
      if (e.code === 'Space') e.preventDefault();
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);
    this.onBlur = () => {
      this.keys.clear();
      this.mouseDown = false;
      // Backgrounding the tab does not reliably deliver pointerup for a thumb
      // that is still down, and a button left held is a chicken that fires (or
      // hops) forever once you come back.
      this.fire?.onUp();
      this.jump?.onUp();
    };

    // --------------------------------------------------------- mouse look
    this.onPointerMove = (e) => {
      if (e.pointerType === 'touch' || !this.pointerLocked) return;
      // Locked: the cursor does not exist, only its deltas do.
      this.applyLook(e.movementX ?? 0, e.movementY ?? 0, FP_MOUSE_SENS);
    };
    this.onPointerDown = (e) => {
      if (e.pointerType === 'touch') return;
      if (!this.pointerLocked) {
        // Browsers only grant pointer lock from a user gesture, which this is.
        this.requestLock();
        // Locking hands the cursor to the canvas, which makes every HUD button
        // unclickable until Esc gives it back. Correct FPS behaviour, and
        // completely baffling if nobody says so.
        this.onLockHint?.();
        return; // this click was "enter the game", not "fire"
      }
      if (e.button === 0) this.mouseDown = true;
    };
    this.onPointerUp = (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.mouseDown = false;
    };
    this.onContextMenu = (e) => e.preventDefault();

    this.onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      // Losing the lock (Esc, alt-tab) must not leave the trigger held down.
      if (!this.pointerLocked) this.mouseDown = false;
    };

    // -------------------------------------- touch: look, fire and jump
    this.lookZone = document.getElementById('look-zone');
    this.fireBtn = document.getElementById('fire-btn');

    this.onLookDown = (e) => {
      if (this.lookId !== null) return; // already tracking a thumb
      this.lookId = e.pointerId;
      this.lookAt = { x: e.clientX, y: e.clientY };
      this.usingTouch = true;
      capturePointer(this.lookZone, e.pointerId);
    };
    this.onLookMove = (e) => {
      if (e.pointerId !== this.lookId) return;
      this.applyLook(e.clientX - this.lookAt.x, e.clientY - this.lookAt.y, FP_TOUCH_SENS);
      this.lookAt = { x: e.clientX, y: e.clientY };
    };
    this.onLookUp = (e) => {
      if (e.pointerId !== this.lookId) return;
      this.lookId = null;
    };

    // The two thumb buttons.
    //
    // `onLook` is the important one: a finger holding FIRE can drag, and the
    // drag turns the view exactly as a swipe on the look surface would, because
    // it is literally the same call. That single gesture — press, keep firing,
    // track the target, never lift — is how every shipped mobile shooter
    // handles a moving target, and it is what players mean when they say the
    // fire button should not pin their thumb in place.
    const opts = {
      onTouch: () => { this.usingTouch = true; },
      onLook: (dx, dy) => this.applyLook(dx, dy, FP_TOUCH_SENS),
    };
    this.fire = new HoldButton(this.fireBtn, FIRE_POS_KEY, opts);
    this.jump = new HoldButton(document.getElementById('jump-btn'), JUMP_POS_KEY, opts);
    this.fire.attach();
    this.jump.attach();

    if (this.lookZone) {
      this.lookZone.addEventListener('pointerdown', this.onLookDown);
      this.lookZone.addEventListener('pointermove', this.onLookMove);
      this.lookZone.addEventListener('pointerup', this.onLookUp);
      this.lookZone.addEventListener('pointercancel', this.onLookUp);
    }

    document.addEventListener('pointerlockchange', this.onLockChange);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  // ------------------------------------------------------------ pointer lock

  requestLock() {
    try { this.canvas.requestPointerLock?.(); } catch { /* unsupported; look still works via touch */ }
  }

  releaseLock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
  }

  // ----------------------------------------------------------------- config

  /**
   * Clamps pitch into the range the simulation will accept.
   *
   * The limits come from PLAYER, not from the renderer, because pitch is part
   * of the shot now: the server clamps whatever it is sent to the same two
   * numbers. Clamping here as well means the camera can never show you an angle
   * you are not allowed to fire along.
   */
  clampPitch(min = PLAYER.pitchMin, max = PLAYER.pitchMax) {
    this.pitch = Math.max(min, Math.min(max, this.pitch));
  }

  setAssist(on) { this.assistOn = on; }

  /**
   * 'fps' | 'tpp'.
   *
   * The controls are identical in both — same stick, same swipe, same buttons,
   * same crosshair. All this decides is whether the angle that goes out is the
   * one you are looking down, or the one that makes a shot from the chicken's
   * shoulder pass through the middle of the screen.
   */
  setView(v) { this.view = asView(v); }

  setArenaHalf(half) {
    this.arenaHalf = Number.isFinite(half) && half > 0 ? half : Infinity;
  }

  setCover(boxes) { this.cover = boxes ?? []; }

  /**
   * Look sensitivity multiplier. 1 is the tuned default; the slider spans
   * roughly a quarter to double that.
   *
   * One number over both mouse and touch on purpose. They already sit at
   * different base rates for good reasons, and what a player is actually
   * adjusting is "faster or slower than this game's idea of normal" — two
   * sliders would ask them to re-derive that relationship themselves.
   */
  setSensitivity(mul) {
    const n = Number(mul);
    this.sensitivity = Number.isFinite(n) && n > 0 ? Math.min(4, Math.max(0.1, n)) : 1;
  }

  /**
   * The one place a pointer delta becomes a change in where you are looking.
   *
   * Mouse look, swipe-to-look and drag-from-the-fire-button all come through
   * here, which is what makes them feel identical — and means the sensitivity
   * multiplier cannot apply to some of them and not others.
   */
  applyLook(dx, dy, base) {
    const k = base * this.sensitivity;
    this.yaw += dx * k;
    this.pitch -= dy * k * FP_PITCH_RATIO;
  }

  /** Drag-to-reposition mode, for both thumb buttons at once. */
  setButtonEdit(on) {
    this.fire.setEdit(on);
    this.jump.setEdit(on);
  }

  resetButtonPos() {
    this.fire.reset();
    this.jump.reset();
  }

  // ----------------------------------------------------------------- sample

  /**
   * Folds every input source into the struct the simulation expects.
   *
   * @param self  the local player, for aim assist. Null while dead.
   * @param foes  everyone else, for aim assist.
   */
  sample(self, dt = 1 / 60, foes = []) {
    // W/S walk, A/D strafe — all relative to where you are looking.
    let sx = 0;
    let sz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) sz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) sz -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) sx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) sx += 1;

    if (sx || sz) {
      const l = Math.hypot(sx, sz);
      sx /= l;
      sz /= l;
      this.usingTouch = false;
    } else if (this.usingTouch) {
      sx = this.stickX;
      sz = this.stickZ;
    }

    const look = this.assistedLook(self, foes, dt);

    // In first person the shot IS the look direction — the camera is at the
    // muzzle, so there is nothing to reconcile. In third person the camera has
    // moved onto a boom and the two are different lines, so the shot is bent to
    // pass through the crosshair. Either way the simulation receives one
    // ordinary aim angle and never learns which view produced it.
    const shot = this.view === 'tpp' && self
      ? convergeAim(
        self.x, self.y ?? 0, self.z, look.yaw, look.pitch, foes, this.arenaHalf, this.cover,
      )
      : look;

    // Movement follows the CAMERA, not the shot. They differ by a fraction of a
    // degree in third person, but "forward" means "the way I am looking" and
    // borrowing the aim line for it would be the wrong idea at any size.
    const sin = Math.sin(look.yaw);
    const cos = Math.cos(look.yaw);

    // Rotate the facing-relative vector into the world space the sim uses.
    // Horizontal only: walking is a floor activity even when you are mid-jump,
    // so pitch is deliberately absent from this half.
    this.input.mx = sz * sin + sx * cos;
    this.input.mz = sz * cos - sx * sin;

    this.input.ax = Math.sin(shot.yaw);
    this.input.az = Math.cos(shot.yaw);
    this.input.pitch = shot.pitch;

    // Space is jump, so the desktop trigger is the mouse — with F as a
    // keyboard fallback for anyone who would rather not hold a button down.
    // Something had to give: Space is the jump key in every shooter anyone has
    // played, and fire already had a better home.
    // takeTap() is what makes a quick tap fire exactly one shot. A touch can
    // easily start and end between two samples — the render loop is the only
    // thing that reads this, and on a weak phone that is 30 times a second at
    // best — so a press latches until it has been seen once. Called
    // unconditionally, never inside the ||, or a held button would leave the
    // latch set and fire a phantom extra round on release.
    const tappedFire = this.fire.takeTap();
    const tappedJump = this.jump.takeTap();
    this.input.shoot = this.usingTouch
      ? (this.fire.held || tappedFire)
      : (this.mouseDown || this.keys.has('KeyF'));
    this.input.jump = this.usingTouch
      ? (this.jump.held || tappedJump)
      : this.keys.has('Space');

    this.input.seq = (this.input.seq + 1) >>> 0;
    return this.input;
  }

  /**
   * The angles actually sent, after aim assist. Both of them.
   *
   * `this.yaw` and `this.pitch` stay the RAW look angles the player asked for —
   * target acquisition is measured against the yaw, so deliberately turning
   * away still drops a lock. The assisted angles accumulate separately, which
   * is what lets the pull build up over several frames instead of being
   * reapplied from scratch and erased each one.
   */
  assistedLook(self, foes, dt) {
    const raw = { yaw: this.yaw, pitch: this.pitch };
    if (!this.assistOn || !AIM_ASSIST.enabled || AIM_ASSIST.strength <= 0 || !self) {
      this.aimTarget = null;
      this.assistYaw = this.yaw;
      this.assistPitch = this.pitch;
      return raw;
    }

    const target = pickAimTarget(self, foes, this.yaw, this.aimTarget);
    if (!target) {
      this.aimTarget = null;
      this.assistYaw = this.yaw;
      this.assistPitch = this.pitch;
      return raw;
    }

    // Carry the previous assisted angles forward, but re-seed them from the raw
    // look whenever the lock changes — otherwise the camera and the shot could
    // drift apart without bound.
    if (this.aimTarget !== target.id) {
      this.assistYaw = this.yaw;
      this.assistPitch = this.pitch;
    }
    this.aimTarget = target.id;
    this.assistYaw = pullAim(self, target, this.assistYaw, dt);
    this.assistPitch = Math.max(
      PLAYER.pitchMin,
      Math.min(PLAYER.pitchMax, pullPitch(self, target, this.assistPitch, dt)),
    );
    return { yaw: this.assistYaw, pitch: this.assistPitch };
  }

  // ---------------------------------------------------------------- cleanup

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.left.destroy();
    this.releaseLock();

    if (this.lookZone) {
      this.lookZone.removeEventListener('pointerdown', this.onLookDown);
      this.lookZone.removeEventListener('pointermove', this.onLookMove);
      this.lookZone.removeEventListener('pointerup', this.onLookUp);
      this.lookZone.removeEventListener('pointercancel', this.onLookUp);
    }
    this.fire.detach();
    this.jump.detach();
    document.removeEventListener('pointerlockchange', this.onLockChange);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}

/**
 * Pointer capture, defensively.
 *
 * setPointerCapture throws NotFoundError if the pointer id isn't currently
 * active — on a synthetic event, on a touch the browser has already cancelled,
 * during a rotation. Capture is an optimisation here (it keeps a drag alive
 * when the finger leaves the element), so failing to get it must never take the
 * input handler down with it.
 */
function capturePointer(el, pointerId) {
  try { el?.setPointerCapture?.(pointerId); } catch { /* pointer already gone */ }
}

// --- thumb buttons ----------------------------------------------------------

const FIRE_POS_KEY = 'cluckdown.fire.v1';
const JUMP_POS_KEY = 'cluckdown.jump.v1';

/**
 * A hold-to-act touch button that can be dragged somewhere else, and that keeps
 * working after your thumb has slid off it.
 *
 * Fire and jump are the same object with a different label and a different
 * saved position, which is the point: the second button had to behave exactly
 * like the first, and duplicating sixty lines is how two buttons quietly stop
 * behaving the same.
 *
 * Three behaviours, and each one is a thing players asked for:
 *
 * 1. **The press sticks to the finger, not to the circle.** Once you are down
 *    on the button, every move and the eventual release belong to it until you
 *    lift, wherever on the screen that finger goes. Without this, sliding a few
 *    pixels off the visual edge silently stops you firing mid-burst — which
 *    reads as the gun jamming rather than as a UI boundary.
 * 2. **Dragging that same finger looks around.** The move is forwarded to the
 *    same call the look surface uses, so you press, keep firing, and track a
 *    moving target in one continuous gesture. This is the whole reason the
 *    button overlaps the look zone rather than sitting beside it.
 * 3. **A tap fires once.** `pendingTap` latches the press until something has
 *    read it, because a tap can begin and end inside a single rendered frame.
 *
 * The listeners for move and release live on `window`, deliberately. Pointer
 * capture would usually deliver them to the element, but it throws on a pointer
 * the browser has already cancelled and is a best-effort call — building (1) on
 * top of it would make the difference between firing and not firing depend on
 * whether an optimisation happened to work. Filtering by `pointerId` at the
 * window level is the same guarantee without the dependency, and it is what
 * keeps a thumb on FIRE, a thumb on JUMP and a thumb swiping to look three
 * independent things.
 *
 * Repositioning sits behind an explicit edit mode rather than a long-press,
 * because a long-press on a fire button is just... firing.
 */
class HoldButton {
  constructor(el, storageKey, { onTouch, onLook } = {}) {
    this.el = el;
    this.key = storageKey;
    this.held = false;
    this.pendingTap = false;
    this.edit = false;
    this.activeId = null;
    this.dragging = false;
    this.dragOff = { x: 0, y: 0 };
    this.lastAt = { x: 0, y: 0 };
    this.pos = loadPos(storageKey);
    this.apply();

    this.onDown = (e) => {
      if (this.activeId !== null) return; // already owned by another finger
      e.preventDefault?.();
      onTouch?.();
      this.activeId = e.pointerId;
      this.lastAt = { x: e.clientX, y: e.clientY };
      // Best-effort: nice when it works, and nothing depends on it.
      capturePointer(this.el, e.pointerId);

      if (this.edit) {
        this.dragging = true;
        const r = this.el.getBoundingClientRect();
        this.dragOff = {
          x: e.clientX - r.left - r.width / 2,
          y: e.clientY - r.top - r.height / 2,
        };
        return;
      }
      this.held = true;
      this.pendingTap = true;
      this.el?.classList.add('is-held');
    };

    this.onMove = (e) => {
      if (e.pointerId !== this.activeId) return;
      if (this.dragging) {
        // Stored as a fraction of the viewport so a layout set up in landscape
        // survives a rotation, a resize, or moving to another device.
        this.pos = {
          x: Math.min(0.96, Math.max(0.04, (e.clientX - this.dragOff.x) / window.innerWidth)),
          y: Math.min(0.94, Math.max(0.06, (e.clientY - this.dragOff.y) / window.innerHeight)),
        };
        this.apply();
        return;
      }
      // Holding and dragging: keep firing, turn the view.
      onLook?.(e.clientX - this.lastAt.x, e.clientY - this.lastAt.y);
      this.lastAt = { x: e.clientX, y: e.clientY };
    };

    this.onUp = (e) => {
      // No pointerId at all means "release unconditionally" — window blur, or
      // leaving edit mode, where there is no event to match against.
      if (e && e.pointerId !== undefined && e.pointerId !== this.activeId) return;
      this.activeId = null;
      this.held = false;
      this.el?.classList.remove('is-held');
      if (this.dragging) {
        this.dragging = false;
        savePos(this.key, this.pos);
      }
    };
  }

  /**
   * Was this button pressed since the last time anyone asked?
   *
   * Clears the flag, so a tap counts exactly once however long the gap between
   * frames was. Holding is reported by `held` instead.
   */
  takeTap() {
    const tapped = this.pendingTap;
    this.pendingTap = false;
    return tapped;
  }

  attach() {
    if (!this.el) return;
    this.el.addEventListener('pointerdown', this.onDown);
    // Move and release on the window: see the note above about why this cannot
    // depend on pointer capture.
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  detach() {
    if (!this.el) return;
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
  }

  setEdit(on) {
    this.edit = on;
    this.el?.classList.toggle('editing', on);
    // Leaving edit mode with the button still "held" would fire (or jump)
    // forever, since the pointerup that would have cleared it was a drag end.
    if (!on) this.onUp();
  }

  reset() {
    this.pos = null;
    savePos(this.key, null);
    this.apply();
  }

  /** Writes the stored fraction back out as a CSS position. */
  apply() {
    if (!this.el) return;
    if (!this.pos) {
      this.el.style.left = '';
      this.el.style.top = '';
      return;
    }
    this.el.style.left = `${this.pos.x * 100}%`;
    this.el.style.top = `${this.pos.y * 100}%`;
  }
}

function loadPos(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') return null;
    return { x: raw.x, y: raw.y };
  } catch {
    return null;
  }
}

function savePos(key, pos) {
  try {
    if (pos) localStorage.setItem(key, JSON.stringify(pos));
    else localStorage.removeItem(key);
  } catch { /* private mode; the layout just won't persist */ }
}
