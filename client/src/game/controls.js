import nipplejs from 'nipplejs';
import { AIM_ASSIST, pickAimTarget, pullAim } from '@cluckdown/shared';

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

// Look sensitivity, in radians per pixel of pointer movement.
//
// Both mouse and touch are positional: you move the pointer by an amount, the
// view turns by a proportional amount. An earlier version used the right stick
// as a RATE control (hold right, keep turning) and it was the single loudest
// complaint about the game — hitting a specific angle meant holding a direction
// for exactly the right number of milliseconds, which a thumb cannot do under
// pressure. Every shipped mobile shooter uses a swipe surface for this reason.
//
// Touch is the more sensitive of the two because a thumb has far less travel
// available than a mouse does.
const FP_MOUSE_SENS = 0.0022;
const FP_TOUCH_SENS = 0.0052;

// Vertical is deliberately damped. Everything worth shooting stands on the
// ground plane, so pitch is for looking rather than aiming, and a twitchy
// vertical axis just makes the horizon seasick.
const FP_PITCH_RATIO = 0.65;

export class Controls {
  constructor({ leftZone, canvas }) {
    this.input = { mx: 0, mz: 0, ax: 0, az: 0, shoot: false, seq: 0 };
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

    // Aim assist state. Applied to our own yaw before sending — see
    // shared/src/aim.js for why it lives on this side of the wire.
    this.assistOn = true;
    this.aimTarget = null;
    this.assistYaw = 0;

    // Touch look, tracked by pointerId so that looking with one thumb while
    // holding fire with another works. That is the whole reason fire is its own
    // button rather than living on the look surface.
    this.lookId = null;
    this.lookAt = { x: 0, y: 0 };
    this.touchFiring = false;
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
      if (e.code === 'Space') e.preventDefault();
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);
    this.onBlur = () => { this.keys.clear(); this.mouseDown = false; };

    // --------------------------------------------------------- mouse look
    this.onPointerMove = (e) => {
      if (e.pointerType === 'touch' || !this.pointerLocked) return;
      // Locked: the cursor does not exist, only its deltas do.
      this.yaw += (e.movementX ?? 0) * FP_MOUSE_SENS;
      this.pitch -= (e.movementY ?? 0) * FP_MOUSE_SENS * FP_PITCH_RATIO;
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

    // --------------------------------------------------- touch look + fire
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
      this.yaw += (e.clientX - this.lookAt.x) * FP_TOUCH_SENS;
      this.pitch -= (e.clientY - this.lookAt.y) * FP_TOUCH_SENS * FP_PITCH_RATIO;
      this.lookAt = { x: e.clientX, y: e.clientY };
    };
    this.onLookUp = (e) => {
      if (e.pointerId !== this.lookId) return;
      this.lookId = null;
    };

    // Fire button, repositionable.
    //
    // Thumb reach varies enormously by hand and phone size, and a fixed button
    // is the difference between comfortable and unplayable. Dragging sits
    // behind an explicit edit mode rather than a long-press, because a
    // long-press on a fire button is just... firing.
    this.fireEdit = false;
    this.dragId = null;
    this.firePos = loadFirePos();
    this.applyFirePos();

    this.onFireDown = (e) => {
      e.preventDefault();
      this.usingTouch = true;
      capturePointer(this.fireBtn, e.pointerId);
      if (this.fireEdit) {
        this.dragId = e.pointerId;
        const r = this.fireBtn.getBoundingClientRect();
        this.dragOff = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
        return;
      }
      this.touchFiring = true;
    };
    this.onFireMove = (e) => {
      if (!this.fireEdit || e.pointerId !== this.dragId) return;
      // Stored as a fraction of the viewport so a layout set up in landscape
      // survives a rotation, a resize, or moving to another device.
      this.firePos = {
        x: Math.min(0.96, Math.max(0.04, (e.clientX - this.dragOff.x) / window.innerWidth)),
        y: Math.min(0.94, Math.max(0.06, (e.clientY - this.dragOff.y) / window.innerHeight)),
      };
      this.applyFirePos();
    };
    this.onFireUp = () => {
      this.touchFiring = false;
      if (this.dragId !== null) {
        this.dragId = null;
        saveFirePos(this.firePos);
      }
    };

    if (this.lookZone) {
      this.lookZone.addEventListener('pointerdown', this.onLookDown);
      this.lookZone.addEventListener('pointermove', this.onLookMove);
      this.lookZone.addEventListener('pointerup', this.onLookUp);
      this.lookZone.addEventListener('pointercancel', this.onLookUp);
    }
    if (this.fireBtn) {
      this.fireBtn.addEventListener('pointerdown', this.onFireDown);
      this.fireBtn.addEventListener('pointermove', this.onFireMove);
      this.fireBtn.addEventListener('pointerup', this.onFireUp);
      this.fireBtn.addEventListener('pointercancel', this.onFireUp);
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

  /** Clamps pitch into the range the camera is willing to render. */
  clampPitch(min, max) {
    this.pitch = Math.max(min, Math.min(max, this.pitch));
  }

  setAssist(on) { this.assistOn = on; }

  /** Drag-to-reposition mode for the fire button. */
  setFireEdit(on) {
    this.fireEdit = on;
    this.fireBtn?.classList.toggle('editing', on);
    if (!on) this.touchFiring = false;
  }

  resetFirePos() {
    this.firePos = null;
    saveFirePos(null);
    this.applyFirePos();
  }

  applyFirePos() {
    if (!this.fireBtn) return;
    if (!this.firePos) {
      this.fireBtn.style.left = '';
      this.fireBtn.style.top = '';
      return;
    }
    this.fireBtn.style.left = `${this.firePos.x * 100}%`;
    this.fireBtn.style.top = `${this.firePos.y * 100}%`;
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

    const aim = this.assistedYaw(self, foes, dt);
    const sin = Math.sin(aim);
    const cos = Math.cos(aim);

    // Rotate the facing-relative vector into the world space the sim uses.
    this.input.mx = sz * sin + sx * cos;
    this.input.mz = sz * cos - sx * sin;

    // Aim IS the look direction. No screen-to-ground unprojection, and no
    // server-side correction fighting the camera.
    this.input.ax = sin;
    this.input.az = cos;

    this.input.shoot = this.usingTouch
      ? this.touchFiring
      : (this.mouseDown || this.keys.has('Space'));

    this.input.seq = (this.input.seq + 1) >>> 0;
    return this.input;
  }

  /**
   * The angle actually sent, after aim assist.
   *
   * `this.yaw` stays the RAW look angle the player asked for — target
   * acquisition is measured against it, so deliberately turning away still
   * drops a lock. The assisted angle accumulates separately in `assistYaw`,
   * which is what lets the pull build up over several frames instead of being
   * reapplied from scratch and erased each one.
   */
  assistedYaw(self, foes, dt) {
    if (!this.assistOn || !AIM_ASSIST.enabled || AIM_ASSIST.strength <= 0 || !self) {
      this.aimTarget = null;
      this.assistYaw = this.yaw;
      return this.yaw;
    }

    const target = pickAimTarget(self, foes, this.yaw, this.aimTarget);
    if (!target) {
      this.aimTarget = null;
      this.assistYaw = this.yaw;
      return this.yaw;
    }

    // Carry the previous assisted angle forward, but never further than the
    // sticky cone from where the player is actually looking — otherwise the
    // camera and the shot could drift apart without bound.
    if (this.aimTarget !== target.id) this.assistYaw = this.yaw;
    this.aimTarget = target.id;
    this.assistYaw = pullAim(self, target, this.assistYaw, dt);
    return this.assistYaw;
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
    if (this.fireBtn) {
      this.fireBtn.removeEventListener('pointerdown', this.onFireDown);
      this.fireBtn.removeEventListener('pointermove', this.onFireMove);
      this.fireBtn.removeEventListener('pointerup', this.onFireUp);
      this.fireBtn.removeEventListener('pointercancel', this.onFireUp);
    }
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

// --- fire button placement, persisted ---------------------------------------

const FIRE_POS_KEY = 'cluckdown.fire.v1';

function loadFirePos() {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRE_POS_KEY) ?? 'null');
    if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') return null;
    return { x: raw.x, y: raw.y };
  } catch {
    return null;
  }
}

function saveFirePos(pos) {
  try {
    if (pos) localStorage.setItem(FIRE_POS_KEY, JSON.stringify(pos));
    else localStorage.removeItem(FIRE_POS_KEY);
  } catch { /* private mode; the layout just won't persist */ }
}
