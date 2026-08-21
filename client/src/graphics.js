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

const DEFAULTS = {
  resolution: 1,
  glow: true,
  antialias: true,
  // Cluckdown is first person. There is no camera setting any more.
  assist: true,    // aim assist, applied client-side before input is sent
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

export function loadGfx() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const merged = { ...DEFAULTS, ...raw };
    // Guard against a hand-edited or stale value knocking out the renderer.
    if (!RESOLUTIONS.some((r) => r.value === merged.resolution)) merged.resolution = DEFAULTS.resolution;
    merged.glow = !!merged.glow;
    merged.antialias = !!merged.antialias;
    merged.fireEdit = !!merged.fireEdit;
    merged.assist = merged.assist !== false;
    merged.sensitivity = clampSensitivity(merged.sensitivity);
    merged.view = asView(merged.view);
    merged.brightness = clampBrightness(merged.brightness);
    merged.announcer = !!merged.announcer;
    merged.voice = typeof merged.voice === 'string' ? merged.voice : '';
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveGfx(gfx) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      resolution: gfx.resolution,
      glow: gfx.glow,
      antialias: gfx.antialias,
      assist: gfx.assist !== false,
      fireEdit: !!gfx.fireEdit,
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

/**
 * Babylon's hardware scaling level is inverse resolution: higher means fewer
 * pixels. Device pixel ratio is capped at 1.5 first, because a 3x phone screen
 * asks for nine times the fill rate of a 1x one for no visible benefit.
 */
export function hardwareScaling(resolution) {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  return 1 / (dpr * resolution);
}
