// Mobile behaviour: pinch suppression, fullscreen, orientation.
//
// All of this exists because phones do things mid-match that a game does not
// want: zooming when two thumbs touch the screen, rotating to portrait, and
// bouncing the page around. Every player report so far has been from a phone in
// landscape, so this file is worth more than it looks.

/**
 * Stops the browser zooming the page.
 *
 * `user-scalable=no` in the viewport meta is not enough: iOS Safari has ignored
 * it since iOS 10, which is exactly where the accidental-zoom reports come
 * from. So the gestures are cancelled directly.
 *
 * Everything here must be a non-passive listener — preventDefault() is ignored
 * on passive ones, and touch listeners default to passive in modern browsers.
 */
export function blockZoomGestures(target = document) {
  const opts = { passive: false, capture: true };

  // Safari-only pinch events. Chrome never fires these; iOS fires them instead
  // of (not as well as) multi-touch touchmove for a pinch.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    target.addEventListener(type, (e) => e.preventDefault(), opts);
  }

  // Any second finger is a pinch attempt as far as this game is concerned:
  // both sticks are single-touch, so a two-finger drag is never gameplay.
  target.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, opts);

  // Double-tap-to-zoom. There is no dblclick on iOS, so it's caught by timing
  // two taps landing close together.
  let lastTap = 0;
  target.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 320) e.preventDefault();
    lastTap = now;
  }, opts);

  // Ctrl+wheel is desktop browser zoom; harmless to block on the game canvas.
  target.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, opts);
}

// ------------------------------------------------------------- fullscreen

const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

/**
 * True only where the API actually exists. iPhone Safari has no element
 * fullscreen at all (iPad does), so the button is hidden there rather than
 * offering something that silently fails.
 */
export function fullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

export function isFullscreen() {
  return !!fsElement();
}

export async function toggleFullscreen() {
  const el = document.documentElement;
  try {
    if (fsElement()) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
      return false;
    }
    await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
    // Orientation lock is only permitted from fullscreen on Android Chrome, so
    // it has to be attempted here rather than on load.
    await lockLandscape();
    return true;
  } catch {
    return isFullscreen();
  }
}

/**
 * Best-effort landscape lock.
 *
 * Unsupported on iOS entirely, and elsewhere it usually requires fullscreen —
 * so this is allowed to fail quietly. The rotate prompt is the fallback that
 * actually covers every device.
 */
export async function lockLandscape() {
  try {
    await screen.orientation?.lock?.('landscape');
    return true;
  } catch {
    return false;
  }
}

export function onFullscreenChange(cb) {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
}
