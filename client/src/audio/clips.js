// The recorded half of the sound. Everything else in here is synthesised.
//
// Three cues earn a real file, and it is the same reason for all three: they
// are the moments the player is not doing anything. A shot has to be instant,
// layerable and forty-a-second, which is what oscillators are for. Dying,
// landing a head and winning are punctuation — one at a time, with a beat of
// silence around them — and punctuation is where a recorded sample is worth
// the download it costs.
//
// FILES ARE DISCOVERED, NOT LISTED. Dropping `d6.mp3` into this folder adds a
// sixth death sting and nothing else has to change. The family is the leading
// letters and the variant is the trailing digits, so `hs4.mp3` is headshot
// number four — which is also why `hs.mp3` not existing costs nothing.
//
//   d*.mp3    you died
//   hs*.mp3   you landed a headshot
//   win*.mp3  you won the match

const FAMILIES = {
  d: 'death',
  hs: 'headshot',
  win: 'win',
};

/**
 * Playback gain per family, before the master.
 *
 * Recorded clips do not arrive at a level anyone chose, and these three land in
 * very different places in a match: the death sting plays over a fading
 * gunfight, the headshot has to cut through one, and the win has the screen to
 * itself. Tuned by ear against the synth kit rather than normalised — matching
 * peak levels would make the win the loudest thing in the game.
 */
export const CLIP_GAIN = {
  death: 0.85,
  headshot: 0.7,
  win: 0.9,
};

/**
 * Minimum seconds between repeats, per family.
 *
 * Only the headshot really needs one: a burst that lands two heads inside a
 * fifth of a second would otherwise stack two copies of the same recording and
 * turn a reward into a smear. Death and win are naturally once-per-event, and
 * their guards are there for the pathological case rather than the real one.
 */
export const CLIP_THROTTLE = {
  death: 0.4,
  headshot: 0.34,
  win: 2,
};

// Vite resolves these to hashed asset URLs at build time, so the files are
// fingerprinted and cached like everything else. Eager because the map itself
// is three lines of strings — it is the DECODING that is deferred, and that
// happens on the same gesture that builds the AudioContext.
const FILES = import.meta.glob('./*.mp3', { eager: true, query: '?url', import: 'default' });

/**
 * Family -> list of urls, sorted so the numbering is stable between builds.
 *
 * Stable order matters for exactly one reason: the "never the same clip twice
 * running" rule is an index comparison, and an order that shuffled per build
 * would make that guarantee mean something different every deploy.
 */
export const CLIPS = (() => {
  const out = {};
  for (const [path, url] of Object.entries(FILES)) {
    const m = /^\.\/([a-z]+)(\d*)\.mp3$/i.exec(path);
    if (!m) continue;
    const family = FAMILIES[m[1].toLowerCase()];
    if (!family) continue;
    (out[family] ??= []).push({ n: m[2] ? Number(m[2]) : 1, url });
  }
  for (const family of Object.keys(out)) {
    out[family] = out[family].sort((a, b) => a.n - b.n).map((c) => c.url);
  }
  return out;
})();
