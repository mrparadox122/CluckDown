// Player-facing settings.
//
// The panel is called Settings rather than Graphics now, because it holds feel
// controls too — aim assist, look sensitivity, thumb-button layout — and a
// player looking for those was never going to open a menu called "Graphics".
// The module, the storage key and the element ids still say gfx: renaming them
// would reset the saved settings of everyone who already has some.
//
// These three are the levers that actually matter on weak hardware, in order:
// render resolution (fill rate), the glow layer (a wide blur on a separate
// render target every frame), and MSAA. Everything else worth optimising is
// done unconditionally for all devices, because it costs nothing to look good.
//
// Antialiasing is fixed at engine construction and the engine is built when a
// match starts, so changing it in the menu applies to the next match — which
// is the only place these controls live anyway.

import { asView } from './game/view.js';

const STORAGE_KEY = 'cluckdown.gfx.v1';

export const RESOLUTIONS = [
  { value: 1, label: 'Full' },
  { value: 0.85, label: 'High (85%)' },
  { value: 0.75, label: 'Medium (75%)' },
  { value: 0.6, label: 'Low (60%)' },
  { value: 0.5, label: 'Potato (50%)' },
];

/**
 * What kind of machine is this, in the only two categories that matter?
 *
 * The three levers that actually cost frames — render resolution, the glow
 * layer's extra render target and blur, and MSAA — were all defaulted ON, and
 * that is a defensible default for exactly one of the two devices this game
 * runs on. Profiling a mid-range phone put the main thread at 99% saturation
 * with those on; turning glow and MSAA off alone moved a 6x-throttled
 * benchmark from 30.6fps to 36.9, and dropping the pixel ratio with them is
 * most of the rest.
 *
 * So the DEFAULTS are per-tier now. Nothing is taken away from anybody: every
 * one of these is still in the settings panel, and an explicit choice always
 * outranks the guess (see loadGfx). This only decides what a player who never
 * opens Settings gets handed on their first match — which is nearly all of
 * them, and on a phone the current answer is "a slideshow".
 *
 * `(pointer: coarse)` is the honest question: not "is this Android" but "is the
 * primary input a finger", which is true of exactly the devices with a mobile
 * GPU and false of the desktops without one. deviceMemory and hardwareConcurrency
 * catch the cheap laptops that answer `fine` and still cannot hold 60.
 */
export function deviceTier() {
  try {
    // The primary signal, and the only one that is really about the GPU:
    // a coarse pointer means a finger, and a finger means a phone or tablet.
    if (window.matchMedia?.('(pointer: coarse)')?.matches) return 'low';

    const mem = navigator.deviceMemory;      // Chromium only; undefined elsewhere
    const cores = navigator.hardwareConcurrency;

    // Chromium reports deviceMemory rounded down to a power of two and capped
    // at 8, so <=4 is "this is not a workstation" — cheap laptops and
    // Chromebooks, which have integrated graphics and the same problem phones
    // do.
    if (typeof mem === 'number' && mem > 0 && mem <= 4) return 'low';

    // Core count is the weakest signal and is only trusted where there is no
    // memory reading to go on. On its own it demotes machines it should not:
    // a modern quad-core laptop reports 8 with hyper-threading, and a browser
    // with fingerprint resistance turned on reports 2 whatever it is running
    // on. So this is the last resort, not the first.
    if (typeof mem !== 'number' && typeof cores === 'number' && cores > 0 && cores <= 4) return 'low';

    return 'high';
  } catch {
    // No matchMedia at all is an old or unusual browser. Guess low: a player on
    // a fast machine sees a slightly softer picture until they open Settings,
    // and a player on a slow one gets a game they can actually play.
    return 'low';
  }
}

/**
 * The graphics knobs a fresh install gets, by tier.
 *
 * Only the three that cost frames differ. Everything else — sensitivity, view,
 * brightness, assist — is a taste, and a taste does not change with the GPU.
 */
const TIER_GFX = {
  high: { resolution: 1, glow: true, antialias: true, dynamicRes: true, fpsCap: 0 },
  low: { resolution: 0.75, glow: false, antialias: false, dynamicRes: true, fpsCap: 0 },
};

/**
 * The graphics defaults every build before tiering shipped with.
 *
 * Used to tell "never chose" from "chose these": saveGfx writes the whole
 * object, so a player who once nudged the brightness slider has all three of
 * these on disk without ever having thought about them. A blob still sitting on
 * exactly this triple is one nobody decided, and is safe to re-default. Anything
 * else is a choice and is left alone. See loadGfx.
 */
const LEGACY_GFX = { resolution: 1, glow: true, antialias: true };

/** Effect budgets that scale with the tier, so a phone throws fewer particles. */
export const EFFECT_BUDGETS = {
  // Debris particles per colour. Four colours, so this is x4 in the worst case.
  high: { debris: 90, tracers: 220, aura: true },
  // 40 still reads as an explosion; it is the tail of a burst nobody counts.
  // `aura` off is the one visible cut on this tier: the rung ring is worn
  // constantly by every high-level player, so it is the effect most likely to
  // be on screen several times at once.
  low: { debris: 40, tracers: 96, aura: false },
};

export function effectBudget(gfx) {
  return EFFECT_BUDGETS[gfx?.tier === 'high' ? 'high' : 'low'] ?? EFFECT_BUDGETS.high;
}

const DEFAULTS = {
  resolution: 1,
  glow: true,
  antialias: true,

  /**
   * Which tier the saved settings were written against.
   *
   * Present only so a player who installed before tiering existed gets the
   * correction once — see loadGfx. After that it is just a record.
   */
  tier: 'high',

  /**
   * Dynamic resolution: hold the frame rate by softening the picture.
   *
   * A phone that cannot hold 60 has two ways to fail. It can stutter, which
   * ruins aim, or it can render fewer pixels, which nobody notices while
   * moving. Every mobile shooter picks the second and so does this. The floor
   * is half the player's chosen resolution and the ceiling is exactly what they
   * asked for, so this can only ever make the game faster than the setting,
   * never blurrier than the floor. See game/adaptive.js.
   */
  dynamicRes: true,

  /**
   * Frame cap: 0 (uncapped), 30 or 60.
   *
   * Uncapped by default, because a cap is a preference rather than a fix — a
   * locked 30 is steadier than a wandering 45 and less responsive than either.
   * It exists for the players who would rather have the steadiness, and for
   * anyone trying to make a phone battery last a bus ride.
   */
  fpsCap: 0,
  // Cluckdown is first person. There is no camera setting any more.
  //
  // Aim assist is 'auto' | 'on' | 'off' — three states, not a checkbox. See
  // ASSIST_MODES below for why the device gets a vote.
  assist: 'auto',
  fireEdit: false, // drag-to-reposition mode for the touch buttons

  /**
   * Look sensitivity, as a multiplier over the tuned base rates in controls.js.
   *
   * 1 is the default the game ships with. The range below is deliberately wide
   * — a thumb on a 5" phone and a mouse on a desk are not the same instrument,
   * and there has never been one number that suits both the player who flicks
   * and the player who tracks.
   */
  sensitivity: 1,

  /**
   * 'fps' or 'tpp'. Remembered rather than reset each match: a player who
   * prefers third person prefers it every time, and the in-match button is
   * there for the times they want the other one for thirty seconds.
   */
  view: 'fps',

  /**
   * Scene brightness, as a multiplier over the tuned lighting.
   *
   * A setting rather than a constant because the variable is the SCREEN. This
   * is a deliberately dark game played on phones, and usable contrast varies by
   * more than a factor of two between panels and by far more than that between
   * a dim room and a bus window. "Too dark" is frequently a device statement,
   * and no single number answers it.
   */
  brightness: 1,

  /**
   * Spoken announcer, off by default.
   *
   * Off is the right default for three reasons and none of them is quality: an
   * announcer is a strong taste, speech synthesis shares an output channel with
   * screen readers, and a game that starts talking on a device someone else can
   * hear is rude. Opt in.
   */
  announcer: false,

  /**
   * Which voice says it. Empty means "pick the best one available".
   *
   * Stored by NAME rather than as the voice object, because the objects come
   * from the browser and are neither serialisable nor stable across a reload —
   * and the same device can gain or lose voices between sessions, so the name
   * has to be treated as a preference that might not be honoured rather than a
   * guarantee.
   */
  voice: '',
};

export const BRIGHTNESS_MIN = 0.6;
export const BRIGHTNESS_MAX = 1.6;

export const SENSITIVITY_MIN = 0.25;
export const SENSITIVITY_MAX = 2;

// ------------------------------------------------------------- aim assist
//
// THREE states, because a boolean was answering the wrong question.
//
// Assist exists for thumbs. Aiming at a chicken on a 375px-tall screen with a
// finger is genuinely hard, it was the loudest piece of player feedback the
// game ever got, and at 0.6 strength it makes that playable. On a MOUSE it is
// the opposite of help: a pointer is already exact, so a soft lock pulling at
// the angle you just set is the game arguing with your hand — and it is the
// direct cause of "the shots don't feel like mine". The same feature, the same
// number, two opposite verdicts, decided entirely by what you are holding.
//
// A default of `true` therefore could not be right for everybody, and a default
// of `false` could not either. 'auto' asks the device: a fine pointer means a
// mouse or a trackpad, and assist stays out of the way; anything else is a
// thumb, and it helps. 'on' and 'off' remain, because an explicit choice has to
// outrank a guess — a player who wants assist with a mouse (or none with a
// thumb) has said so, and the browser has not.
export const ASSIST_MODES = ['auto', 'on', 'off'];

/**
 * Normalises anything into one of the three modes.
 *
 * Booleans are the old shape and are migrated rather than rejected. `true`
 * becomes 'auto' rather than 'on': it was the shipped default, so almost
 * everyone carrying one never chose it — treating it as an explicit preference
 * would preserve the exact bug this change exists to fix. `false` becomes 'off',
 * because nobody ever got that by default; it was always somebody deciding.
 */
export function assistMode(v) {
  if (v === true) return 'auto';
  if (v === false) return 'off';
  return ASSIST_MODES.includes(v) ? v : 'auto';
}

/**
 * Does assist actually run, on THIS device, right now?
 *
 * `(pointer: fine)` is the standard query for "the primary input is precise" —
 * a mouse, a trackpad, a stylus. It is a live media query rather than a
 * user-agent guess, so a tablet with a mouse plugged in answers correctly and a
 * phone never has to be sniffed for.
 */
export function assistOn(mode) {
  const m = assistMode(mode);
  if (m === 'on') return true;
  if (m === 'off') return false;
  try {
    return !window.matchMedia?.('(pointer: fine)')?.matches;
  } catch {
    // No matchMedia at all: assume a thumb. Getting it wrong on a mouse is an
    // annoyance a player can turn off, and getting it wrong on a phone is a
    // game they cannot aim.
    return true;
  }
}

export function loadGfx() {
  const tier = deviceTier();
  const base = { ...DEFAULTS, ...TIER_GFX[tier], tier };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const merged = { ...base, ...raw };

    // ONE-TIME CORRECTION for settings written before tiering existed.
    //
    // saveGfx writes every key, so a player who once nudged the brightness
    // slider has `glow: true` on disk whether or not they ever thought about
    // glow. Honouring that as an explicit choice would leave every existing
    // phone player on the defaults this change exists to fix.
    //
    // But only for a blob still sitting on exactly the old shipped triple.
    // Somebody who went and set Potato resolution with the glow off HAS decided,
    // and re-defaulting them would be this change overriding the very preference
    // it claims to respect. Everything that is genuinely a taste — sensitivity,
    // view, brightness, assist, the announcer — is untouched either way.
    //
    // The tier is stamped on the way out, so this happens once and never again.
    const untouched = !raw.tier && Object.entries(LEGACY_GFX).every(([k, v]) => raw[k] === v);
    if (untouched) Object.assign(merged, TIER_GFX[tier]);
    merged.tier = tier;

    // Guard against a hand-edited or stale value knocking out the renderer.
    if (!RESOLUTIONS.some((r) => r.value === merged.resolution)) merged.resolution = base.resolution;
    merged.glow = !!merged.glow;
    merged.antialias = !!merged.antialias;
    merged.fireEdit = !!merged.fireEdit;
    merged.dynamicRes = !!merged.dynamicRes;
    merged.fpsCap = clampFpsCap(merged.fpsCap);
    merged.assist = assistMode(merged.assist);
    merged.sensitivity = clampSensitivity(merged.sensitivity);
    merged.view = asView(merged.view);
    merged.brightness = clampBrightness(merged.brightness);
    merged.announcer = !!merged.announcer;
    merged.voice = typeof merged.voice === 'string' ? merged.voice : '';
    return merged;
  } catch {
    return { ...base };
  }
}

export function saveGfx(gfx) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      resolution: gfx.resolution,
      glow: gfx.glow,
      antialias: gfx.antialias,
      assist: assistMode(gfx.assist),
      fireEdit: !!gfx.fireEdit,
      dynamicRes: !!gfx.dynamicRes,
      fpsCap: clampFpsCap(gfx.fpsCap),
      // Stamped so loadGfx knows these settings have seen a tier and must not
      // be corrected a second time.
      tier: gfx.tier === 'high' ? 'high' : 'low',
      sensitivity: clampSensitivity(gfx.sensitivity),
      view: asView(gfx.view),
      brightness: clampBrightness(gfx.brightness),
      announcer: !!gfx.announcer,
      voice: typeof gfx.voice === 'string' ? gfx.voice : '',
    }));
  } catch {
    // Private mode — settings just won't persist.
  }
}

/** Keeps a hand-edited or stale value from blacking the screen out. */
export function clampBrightness(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.brightness;
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, n));
}

/** Keeps a hand-edited or stale value from making the game unplayable. */
export function clampSensitivity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.sensitivity;
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, n));
}

/** The frame caps the panel offers. 0 means "as fast as the device likes". */
export const FPS_CAPS = [
  { value: 0, label: 'Uncapped' },
  { value: 60, label: '60 fps' },
  { value: 30, label: '30 fps (battery)' },
];

export function clampFpsCap(v) {
  const n = Number(v);
  return FPS_CAPS.some((c) => c.value === n) ? n : 0;
}

/**
 * Babylon's hardware scaling level is inverse resolution: higher means fewer
 * pixels.
 *
 * The device pixel ratio is capped BEFORE the resolution setting is applied,
 * and the cap is the single highest-leverage number in the renderer: fill rate
 * goes as its square. 1.5 was the cap for every device, which on a 3x phone
 * screen is 2.25x the pixels of 1x — paid on a mobile GPU, every frame, for a
 * difference nobody can see at arm's length while a chicken is shooting at
 * them. Phones get 1.0 and desktops keep 1.5, where a still, close screen
 * genuinely does show the difference.
 */
export function hardwareScaling(resolution, tier = deviceTier()) {
  const dpr = Math.min(window.devicePixelRatio || 1, tier === 'low' ? 1 : 1.5);
  return 1 / (dpr * resolution);
}
