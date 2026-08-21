// Where you are looking. ONE number for the camera, the crosshair and the shot.
//
// THE BUG THIS FILE EXISTS TO MAKE IMPOSSIBLE. Recoil used to be a field on the
// camera rig: `const look = pitch + this.recoil`. The camera aimed along the
// kicked angle and the input struct went out along the un-kicked one, so the
// crosshair — which is nailed to screen centre — rode a view that the bullets
// were not following. Under sustained fire the reticle sat up to 0.12 radians
// above where rounds actually landed, which at duelling range is 1.4 units: a
// whole chicken. Everything on screen agreed with everything else on screen,
// which is exactly why nobody could name it.
//
// The fix is structural rather than arithmetic. There is now no second angle to
// add: the recoil goes into the look pitch itself, `scene.js` renders that, and
// `controls.js` sends that. A future kick, sway, or hit-flinch has to come
// through here too, and the moment one does not, `client/test/aim.mjs` fails.
//
// No DOM, no Babylon, no nipplejs — deliberately. This is the piece that has to
// be testable without a browser, because the browser is where the bug hid.

import {
  PLAYER, SPREAD, clamp,
  createRecoil, recoilKick, recoilRecover, recoilAbsorb, nextSpread,
} from '@cluckdown/shared';

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
export const FP_PITCH_RATIO = 0.9;

export class Look {
  constructor() {
    // The angles, held here rather than read back from the simulation: looking
    // around has to respond to this frame's input, not to a network round-trip.
    this.yaw = 0;
    this.pitch = 0;

    // Accumulated recoil climb, and the clock that decides when it settles.
    // The climb is already IN `pitch` — this is only the record of how much of
    // it is owed back.
    this.recoil = createRecoil();

    // Movement inaccuracy, in radians. Stepped from the local input rather than
    // read off the network: it is a pure function of what the player is doing
    // right now, and the crosshair drawing it a network tick late would be a
    // reticle describing a stance you have already left.
    this.spread = SPREAD.still;

    // Player-set multiplier over the tuned base sensitivities.
    this.sensitivity = 1;
  }

  /**
   * A pointer delta becomes a change in where you are looking.
   *
   * Mouse look, swipe-to-look and drag-from-the-fire-button all come through
   * here, which is what makes them feel identical.
   *
   * Pulling DOWN spends the recoil bank — see recoilAbsorb. Compensating for a
   * climbing gun has to actually remove the climb, or the automatic recovery
   * lands on top of the player's own correction and the view sinks below the
   * target. A shooter that punishes correct recoil control is worse than one
   * with no recoil at all.
   */
  turn(dx, dy, base) {
    const k = base * this.sensitivity;
    this.yaw += dx * k;
    const was = this.pitch;
    this.pitch = clamp(
      this.pitch - dy * k * FP_PITCH_RATIO, PLAYER.pitchMin, PLAYER.pitchMax,
    );
    // The APPLIED delta, not the requested one: a downward flick against the
    // bottom of the pitch clamp moves nothing and must therefore pay nothing.
    recoilAbsorb(this.recoil, this.pitch - was);
  }

  /**
   * A shot left the gun: climb.
   *
   * Driven by the `shot` event rather than by the trigger, because the trigger
   * is a request and the shot is what the simulation decided actually happened
   * — a round the crop could not pay for must not kick.
   */
  kick() {
    this.pitch += recoilKick(this.recoil, PLAYER.pitchMax - this.pitch);
  }

  /**
   * Per-frame: settle the recoil, and resize the movement cone.
   *
   * @param moving   0..1, how hard the movement stick is being pushed
   * @param airborne mid-jump, the widest cone in the game
   */
  step(dt, moving, airborne) {
    this.pitch -= recoilRecover(this.recoil, dt);
    this.spread = nextSpread(this.spread, moving, airborne, dt);
  }

  /**
   * Clamps pitch into the range the simulation will accept.
   *
   * The limits come from PLAYER, not from the renderer, because pitch is part
   * of the shot: the server clamps whatever it is sent to the same two numbers.
   * Clamping here as well means the camera can never show you an angle you are
   * not allowed to fire along.
   */
  clampPitch(min = PLAYER.pitchMin, max = PLAYER.pitchMax) {
    this.pitch = clamp(this.pitch, min, max);
  }

  /** Fresh life, fresh gun: nothing owed, nothing wide. */
  reset() {
    this.recoil = createRecoil();
    this.spread = SPREAD.still;
  }
}
