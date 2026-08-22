// Holding the frame rate by spending pixels instead of dropping frames.
//
// A phone that cannot render this scene at 60 has two ways to fail, and they
// are not equally bad. It can miss frames — which shows up as the camera
// stuttering while you are trying to track someone, and is the single worst
// thing that can happen to aim. Or it can render fewer pixels and stay on
// schedule, which on a 5" screen at arm's length nobody notices at all. Every
// mobile shooter picks the second, and so does this.
//
// Two independent controls live here because they answer different questions:
//
//   DYNAMIC RESOLUTION is automatic and reactive. "This device is struggling
//   right now" — which changes within a match, when a four-way firefight fills
//   the screen with tracers and debris, and changes back when it ends.
//
//   THE FRAME CAP is a preference. "I would rather have a steady 30 and a
//   battery than a wandering 45." Nothing detects that; the player says it.
//
// Neither one can make the game look worse than the player asked for: the cap
// is off by default and the resolution ceiling is exactly the setting from the
// panel. The floor is half of it, which is where the picture stops being worth
// having and the honest answer is a lower graphics preset.

/** Frame time we are trying to stay under, in ms, per target rate. */
const BUDGET = (targetFps) => 1000 / targetFps;

// How much slack before acting. A frame budget hit exactly is a frame budget
// missed half the time, so the trigger sits above it: step down when we are
// meaningfully over, step back up only when there is real room to spare.
const OVER = 1.22;   // >22% over budget for a sustained window -> shed pixels
const UNDER = 0.72;  // <72% of budget -> we can afford to put them back

// Seconds between adjustments. Long enough that one bad frame — a chicken
// exploding, a match starting — cannot move the resolution, and that a step
// has taken effect before the next reading is trusted.
const SETTLE_DOWN = 0.9;
const SETTLE_UP = 2.6;

// Multiplicative step. Small enough that a change is invisible mid-fight;
// four of them cover the whole range.
const STEP = 1.12;

// The floor, as a multiple of the player's own scaling level. 2.0 is half
// resolution on each axis — a quarter of the pixels, and the point past which
// the picture stops being worth having.
const MAX_RELAXATION = 2.0;

// How much of the frame budget our own main-thread work may occupy before the
// frame is judged CPU-bound and resolution is left alone. Below 70% there is
// room for the GPU to be the thing that is late; above it, there is not.
const CPU_HEADROOM = 0.7;

export class Adaptive {
  /**
   * @param engine the Babylon engine, already at the player's chosen scaling
   * @param gfx    the live settings object: { dynamicRes, fpsCap }
   */
  constructor(engine, gfx = {}) {
    this.engine = engine;
    // The ceiling: whatever the resolution setting resolved to at build time.
    // Every adjustment is relative to this, so the panel stays the authority.
    this.base = engine.getHardwareScalingLevel();
    this.level = this.base;
    this.enabled = !!gfx.dynamicRes;
    this.setFpsCap(gfx.fpsCap);

    // Exponential moving average of frame time. Cheaper than a ring buffer and
    // it forgets a hitch on its own, which is what we want — one long frame is
    // a garbage collection, not a device that is too slow.
    this.avgMs = 0;
    this.avgCpuMs = 0;
    this.sinceChange = 0;
    // Frames to ignore after a resize: the first one or two land while the
    // render targets are still being rebuilt and read as far slower than the
    // steady state, which would spiral the resolution to the floor.
    this.settleFrames = 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.reset();
  }

  /** 0 for uncapped, or a target frame rate. */
  setFpsCap(fps) {
    const n = Number(fps) || 0;
    this.cap = n > 0 ? n : 0;
    // A whole frame of slack. Vsync will not land exactly on the period, and
    // subtracting a little is the difference between "30fps" and "every other
    // frame is skipped, so 30fps looks like 20".
    this.capPeriod = this.cap ? (1000 / this.cap) - 1.5 : 0;
    this.lastFrameAt = 0;
  }

  /** Back to exactly what the player asked for. */
  reset() {
    this.level = this.base;
    this.avgMs = 0;
    this.avgCpuMs = 0;
    this.sinceChange = 0;
    if (this.engine.getHardwareScalingLevel() !== this.base) {
      this.engine.setHardwareScalingLevel(this.base);
    }
  }

  /**
   * Should this frame be rendered at all?
   *
   * Called at the very top of the render loop, before any simulation or HUD
   * work, so a skipped frame costs a comparison and nothing else. Returns false
   * only when a cap is set and the previous frame was too recent.
   *
   * Babylon's runRenderLoop is driven by requestAnimationFrame, so this is a
   * frame SKIP rather than a timer — the display still paces us, we simply
   * decline some of the slots. That keeps the cap honest on a 120Hz phone,
   * where a naive setTimeout loop would drift.
   */
  shouldRender(nowMs) {
    if (!this.cap) return true;
    if (nowMs - this.lastFrameAt < this.capPeriod) return false;
    this.lastFrameAt = nowMs;
    return true;
  }

  /**
   * Called once per RENDERED frame.
   *
   * @param deltaMs the whole frame, GPU included — the only honest measure of
   *                whether the device is keeping up.
   * @param cpuMs   how much of that was our own main-thread work. This is what
   *                decides whether shedding pixels can possibly help.
   */
  update(deltaMs, cpuMs = 0) {
    if (!this.enabled) return;
    if (this.settleFrames > 0) { this.settleFrames--; return; }

    // A frame this long is a stall — a tab coming back to the foreground, a
    // major garbage collection, the match starting. Feeding it to the average
    // would drop the resolution for something that has already finished.
    if (deltaMs > 250) return;

    this.avgMs = this.avgMs ? this.avgMs + (deltaMs - this.avgMs) * 0.08 : deltaMs;
    this.avgCpuMs = this.avgCpuMs ? this.avgCpuMs + (cpuMs - this.avgCpuMs) * 0.08 : cpuMs;
    this.sinceChange += deltaMs / 1000;

    // Uncapped, the target is a flat 60.
    //
    // The obvious thing — derive the target from the rate we are measuring —
    // is circular and cannot ever fire: if the target is whatever we are
    // currently achieving, then by construction we are always achieving it,
    // and the resolution never moves. (It was written that way first, and the
    // benchmark duly reported a device pinned at 50fps with the scaler
    // reporting everything was fine.)
    //
    // 60 is the right constant rather than the display's real refresh because
    // of the guard band: at OVER = 1.22 the trigger sits at 20.3ms, so a
    // display honestly delivering 60 never trips it, a 90 or 120Hz panel is
    // far under it, and only a device genuinely missing 60 is asked to give up
    // pixels — which is exactly the population this exists for.
    const target = this.cap || 60;
    const budget = BUDGET(target);

    // ONLY SHED PIXELS WHEN PIXELS ARE THE PROBLEM.
    //
    // Resolution is a fill-rate lever, and fill rate is the GPU's half of the
    // frame. If our own main-thread work already fills the budget on its own,
    // rendering fewer pixels changes nothing about the frame time — so the
    // scaler would step down, see no improvement, step down again, and arrive
    // at the floor having made the game blurry and no faster. (Benchmarked
    // against a CPU-throttled device doing exactly that: 196x436 and still
    // missing the target.)
    //
    // So a step down needs the overrun to be plausibly the GPU's: our own code
    // has to fit inside the budget with room to spare. When it does not, the
    // honest answer is that this device needs a lower graphics preset or the
    // frame cap, and the resolution is held where the player put it.
    const cpuBound = this.avgCpuMs > budget * CPU_HEADROOM;

    if (this.avgMs > budget * OVER && !cpuBound && this.sinceChange >= SETTLE_DOWN) {
      this.apply(Math.min(this.base * MAX_RELAXATION, this.level * STEP));
    } else if (this.level > this.base && this.sinceChange >= SETTLE_UP
        && (this.avgMs < budget * UNDER || cpuBound)) {
      // Recovering also happens when the bottleneck turns out to be the CPU:
      // whatever pixels were given up are not buying anything, so take them
      // back rather than leaving the picture soft for no gain.
      this.apply(Math.max(this.base, this.level / STEP));
    }
  }

  apply(level) {
    if (Math.abs(level - this.level) < 0.005) return;
    this.level = level;
    this.engine.setHardwareScalingLevel(level);
    this.sinceChange = 0;
    // Let the resize land before believing another reading.
    this.settleFrames = 4;
    // Half-forget the average too. Keeping it would mean the next few checks
    // are still judging the resolution we just left.
    this.avgMs *= 0.85;
  }

  /**
   * The window changed size, so the scaling level the player asked for now
   * corresponds to a different pixel count. Re-read the base and start again.
   */
  onResize(baseLevel) {
    this.base = baseLevel;
    this.reset();
    this.settleFrames = 8;
  }

  /** For the network/FPS readout: how far below the setting we are running. */
  get relaxation() {
    return this.base > 0 ? this.level / this.base : 1;
  }
}
