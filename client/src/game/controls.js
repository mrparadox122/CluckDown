import nipplejs from 'nipplejs';

// Side-effect import: this is what attaches createPickingRay() to Scene.
// Without it, desktop mouse aiming throws on the first pointermove.
import '@babylonjs/core/Culling/ray';

/**
 * Dual input: nipple.js sticks on touch, WASD + mouse on desktop.
 *
 * Both write into the same `{ mx, mz, ax, az, shoot }` struct the sim expects,
 * so nothing downstream cares which one is driving.
 *
 * Axis note: the sim's world +Z is "up" on screen, and a joystick's +Y is also
 * up, so vector.y maps to mz directly with no inversion.
 */
export class Controls {
  constructor({ leftZone, rightZone, canvas, camera, scene }) {
    this.input = { mx: 0, mz: 0, ax: 0, az: 0, shoot: false, seq: 0 };
    this.keys = new Set();
    this.destroyed = false;
    this.canvas = canvas;
    this.camera = camera;
    this.scene = scene;
    this.mouseAim = null;
    this.mouseDown = false;
    this.usingTouch = false;

    this.left = nipplejs.create({
      zone: leftZone,
      mode: 'dynamic',
      color: 'rgba(255,255,255,0.45)',
      size: 110,
      fadeTime: 100,
      restJoystick: true,
    });
    this.right = nipplejs.create({
      zone: rightZone,
      mode: 'dynamic',
      color: 'rgba(255,60,90,0.5)',
      size: 110,
      fadeTime: 100,
      restJoystick: true,
    });

    // nipplejs 1.x hands the listener ONE argument, `{ type, target, data }`,
    // where the joystick payload lives on `.data`. (0.x used to call
    // `(event, data)`.) Reading the old second argument throws on every single
    // touchmove, which silently kills both sticks — hence this helper.
    const payload = (evt) => evt?.data ?? evt;

    this.left.on('move', (evt) => {
      const d = payload(evt);
      if (!d?.vector) return;
      this.usingTouch = true;
      const f = Math.min(1, d.force);
      this.input.mx = d.vector.x * f;
      this.input.mz = d.vector.y * f;
    });
    this.left.on('end', () => { this.input.mx = 0; this.input.mz = 0; });

    // Holding the right stick aims AND fires — no separate fire button to
    // fight for thumb space on a phone.
    this.right.on('move', (evt) => {
      const d = payload(evt);
      if (!d?.vector) return;
      this.usingTouch = true;
      if (d.force < 0.28) return; // tiny nudges shouldn't spin you around
      this.input.ax = d.vector.x;
      this.input.az = d.vector.y;
      this.input.shoot = true;
    });
    this.right.on('end', () => {
      this.input.ax = 0;
      this.input.az = 0;
      this.input.shoot = false;
    });

    this.onKeyDown = (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);
    this.onBlur = () => { this.keys.clear(); this.mouseDown = false; };

    this.onPointerMove = (e) => {
      if (e.pointerType === 'touch') return;
      this.mouseAim = { x: e.clientX, y: e.clientY };
    };
    this.onPointerDown = (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.mouseDown = true;
      this.mouseAim = { x: e.clientX, y: e.clientY };
    };
    this.onPointerUp = (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.mouseDown = false;
    };
    this.onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  /**
   * Folds keyboard/mouse into the input struct. `selfPos` is the local
   * player's world position, used to turn a screen-space cursor into an
   * aim direction.
   */
  sample(selfPos) {
    const k = this.keys;
    let kx = 0;
    let kz = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) kz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) kz -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) kx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) kx += 1;

    if (kx || kz) {
      const l = Math.hypot(kx, kz);
      this.input.mx = kx / l;
      this.input.mz = kz / l;
      this.usingTouch = false;
    } else if (!this.usingTouch) {
      this.input.mx = 0;
      this.input.mz = 0;
    }

    if (!this.usingTouch && this.mouseAim && selfPos) {
      const dir = this.screenToGroundDir(this.mouseAim, selfPos);
      if (dir) {
        this.input.ax = dir.x;
        this.input.az = dir.z;
      }
      this.input.shoot = this.mouseDown || k.has('Space');
    }

    this.input.seq = (this.input.seq + 1) >>> 0;
    return this.input;
  }

  /**
   * Unprojects the cursor onto the y=0.85 plane (roughly chicken chest height)
   * and returns the normalised direction from the player to that point.
   */
  screenToGroundDir(screen, selfPos) {
    const ray = this.scene.createPickingRay(screen.x, screen.y, null, this.camera);
    const denom = ray.direction.y;
    if (Math.abs(denom) < 1e-5) return null;
    const t = (0.85 - ray.origin.y) / denom;
    if (t < 0) return null;
    const wx = ray.origin.x + ray.direction.x * t;
    const wz = ray.origin.z + ray.direction.z * t;
    const dx = wx - selfPos.x;
    const dz = wz - selfPos.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.4) return null;
    return { x: dx / l, z: dz / l };
  }

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.left.destroy();
    this.right.destroy();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}
