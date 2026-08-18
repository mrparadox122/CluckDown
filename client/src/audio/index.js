// The two audio channels, and the reason they are separate.
//
// `sfx` is synthesised sound: instant, layered, and safe to fire dozens of
// times a second. `tts` is speech: one line at a time, on a channel nothing
// else can share, and worth saying only occasionally. They are exported
// together so callers pick the right one deliberately rather than reaching for
// whichever is imported.

export { sfx, Sfx } from './sfx.js';
export { Tts, SAY } from './tts.js';

import { Tts } from './tts.js';

/** The one announcer. Enabled from saved settings once the menu binds. */
export const tts = new Tts();
