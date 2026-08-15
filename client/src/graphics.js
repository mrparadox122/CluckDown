// Player-facing graphics settings.
//
// These three are the levers that actually matter on weak hardware, in order:
// render resolution (fill rate), the glow layer (a wide blur on a separate
// render target every frame), and MSAA. Everything else worth optimising is
// done unconditionally for all devices, because it costs nothing to look good.
//
// Antialiasing is fixed at engine construction and the engine is built when a
// match starts, so changing it in the menu applies to the next match — which
// is the only place these controls live anyway.

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
};

export function loadGfx() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const merged = { ...DEFAULTS, ...raw };
    // Guard against a hand-edited or stale value knocking out the renderer.
    if (!RESOLUTIONS.some((r) => r.value === merged.resolution)) merged.resolution = DEFAULTS.resolution;
    merged.glow = !!merged.glow;
    merged.antialias = !!merged.antialias;
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
    }));
  } catch {
    // Private mode — settings just won't persist.
  }
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
