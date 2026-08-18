// Every sound in the game, synthesised at runtime. No audio files, no
// loading, no licensing — just oscillators, filtered noise and gain envelopes.
//
// Two rules kept throughout:
//   1. Nothing is created until the player makes a gesture. Browsers refuse to
//      start audio before that, and an AudioContext built too early gets stuck
//      "suspended" forever.
//   2. Every voice disconnects itself when it finishes. A shooter fires
//      hundreds of sounds a minute and orphaned nodes would pile up.

const STORAGE_KEY = 'cluckdown.audio.v1';

// Cheap protection against a four-way firefight turning into white noise.
const MAX_VOICES = 22;

// Minimum seconds between repeats of the same cue. Shots fire faster than the
// ear can separate them, and stacking identical transients just sounds harsh.
const THROTTLE = {
  shot: 0.035,
  hit: 0.045,
  hurt: 0.09,
  feather: 0.08,
  // The crop refills nine grain a second and the feeder heals in chunks, so
  // both would otherwise fire several times per second forever. Throttled to
  // roughly a heartbeat: enough to read as ongoing, not enough to nag.
  peck: 0.16,
  fed: 0.3,
  dryFire: 0.25,
};

const noteToFreq = (n) => 440 * 2 ** ((n - 69) / 12);

export class Sfx {
  constructor({ volume = 0.7, muted = false } = {}) {
    const saved = loadSettings();
    this.volume = saved.volume ?? volume;
    this.muted = saved.muted ?? muted;

    this.ctx = null;
    this.master = null;
    this.voices = 0;
    this.lastAt = new Map();

    this.fuse = { active: false, nextBeep: 0 };
    this.noiseBuffer = null;
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Must be called from inside a real user gesture (pointerdown/keydown).
   * Safe to call repeatedly.
   */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.buildNoise();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && !this.muted) this.rampMaster(this.volume);
    saveSettings(this);
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.rampMaster(this.muted ? 0 : this.volume);
    if (this.muted) this.stopFuse();
    saveSettings(this);
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Short ramp rather than a jump, so muting doesn't click. */
  rampMaster(target) {
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + 0.05);
  }

  buildNoise() {
    const len = Math.floor(this.ctx.sampleRate * 0.6);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ----------------------------------------------------------- primitives

  /** A pitched blip with an optional pitch sweep. */
  tone({ freq, to, type = 'square', dur = 0.12, gain = 0.15, attack = 0.004, delay = 0, detune = 0 }) {
    if (!this.canPlay()) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    if (detune) osc.detune.setValueAtTime(detune, t);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(g).connect(this.master);
    this.startVoice(osc, t, dur);
  }

  /** Filtered noise — the basis of every impact, explosion and whoosh. */
  noise({ dur = 0.2, gain = 0.2, freq = 1200, to, q = 1, type = 'lowpass', delay = 0 }) {
    if (!this.canPlay()) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();

    src.buffer = this.noiseBuffer;
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (to && to !== freq) filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);

    g.gain.setValueAtTime(Math.max(0.0001, gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter).connect(g).connect(this.master);
    this.startVoice(src, t, dur);
  }

  startVoice(node, t, dur) {
    this.voices++;
    node.start(t);
    node.stop(t + dur + 0.02);
    node.onended = () => {
      this.voices--;
      try { node.disconnect(); } catch { /* already torn down */ }
    };
  }

  canPlay() {
    return this.ready && !this.muted && this.voices < MAX_VOICES;
  }

  throttled(name) {
    const min = THROTTLE[name];
    if (!min) return false;
    const now = this.ctx.currentTime;
    if (now - (this.lastAt.get(name) ?? -1) < min) return true;
    this.lastAt.set(name, now);
    return false;
  }

  // --------------------------------------------------------------- the kit

  play(name, opts = {}) {
    if (!this.canPlay() || this.throttled(name)) return;
    const r = (a, b) => a + Math.random() * (b - a);

    switch (name) {
      // Pitch-jittered so sustained fire doesn't turn into one flat buzz.
      case 'shot':
        this.tone({ freq: r(820, 960), to: 260, type: 'square', dur: 0.085, gain: 0.075 });
        this.noise({ freq: 3600, to: 900, dur: 0.05, gain: 0.05, type: 'bandpass', q: 1.2 });
        break;

      case 'rapidShot':
        this.tone({ freq: r(1050, 1200), to: 420, type: 'square', dur: 0.06, gain: 0.06 });
        break;

      // Empty crop. A dry click with no tail — deliberately the least musical
      // sound in the game, because it has to read as "that did not happen"
      // rather than as a quieter version of a shot.
      case 'dryFire':
        this.noise({ freq: 2400, to: 1400, dur: 0.035, gain: 0.09, type: 'bandpass', q: 3 });
        this.tone({ freq: 190, to: 120, type: 'square', dur: 0.035, gain: 0.045 });
        break;

      // Pecking grain. Short, soft, woody, and pitch-jittered so a full refill
      // is a handful of pecks rather than one buzzing note.
      case 'peck':
        this.tone({ freq: r(620, 760), to: 300, type: 'triangle', dur: 0.045, gain: 0.05 });
        break;

      // Standing on the feeder: warm and rising, the same shape as the health
      // pickup so it reads as the same KIND of good thing.
      case 'fed':
        this.tone({ freq: 440, to: 660, type: 'sine', dur: 0.14, gain: 0.07 });
        this.tone({ freq: 660, to: 880, type: 'sine', dur: 0.12, gain: 0.05, delay: 0.07 });
        break;

      // Landing a hit on someone else: crisp, high, informative.
      case 'hit':
        this.tone({ freq: 1500, to: 900, type: 'sine', dur: 0.05, gain: 0.09 });
        this.noise({ freq: 2600, dur: 0.04, gain: 0.05, type: 'bandpass', q: 2 });
        break;

      // Taking a hit yourself: low and dull, unmistakably different.
      case 'hurt':
        this.tone({ freq: 220, to: 90, type: 'sawtooth', dur: 0.17, gain: 0.12 });
        this.noise({ freq: 900, to: 200, dur: 0.16, gain: 0.1 });
        break;

      case 'kill':
        this.tone({ freq: 480, to: 180, type: 'square', dur: 0.16, gain: 0.11 });
        this.noise({ freq: 1800, to: 300, dur: 0.22, gain: 0.13 });
        this.tone({ freq: 900, to: 1400, type: 'sine', dur: 0.1, gain: 0.07, delay: 0.05 });
        break;

      case 'death':
        this.tone({ freq: 300, to: 60, type: 'sawtooth', dur: 0.5, gain: 0.16 });
        this.noise({ freq: 1400, to: 120, dur: 0.55, gain: 0.18 });
        break;

      case 'blast':
        this.tone({ freq: 90, to: 32, type: 'sine', dur: 0.75, gain: 0.3 });
        this.noise({ freq: 2400, to: 90, dur: 0.7, gain: 0.3 });
        this.noise({ freq: 700, to: 60, dur: 0.5, gain: 0.18, delay: 0.04 });
        break;

      case 'pickupHealth': // rising perfect fifth — resolves, feels good
        this.tone({ freq: noteToFreq(72), type: 'sine', dur: 0.1, gain: 0.11 });
        this.tone({ freq: noteToFreq(79), type: 'sine', dur: 0.16, gain: 0.11, delay: 0.08 });
        break;

      case 'pickupRapid': // brighter three-note climb
        [76, 80, 83].forEach((n, i) => this.tone({
          freq: noteToFreq(n), type: 'triangle', dur: 0.12, gain: 0.1, delay: i * 0.06,
        }));
        break;

      case 'respawn':
        this.noise({ freq: 300, to: 3000, dur: 0.3, gain: 0.1, type: 'bandpass', q: 0.8 });
        [64, 71, 76].forEach((n, i) => this.tone({
          freq: noteToFreq(n), type: 'triangle', dur: 0.22, gain: 0.1, delay: i * 0.05,
        }));
        break;

      case 'bomberSpawn': // ominous, descending, unmistakable
        this.tone({ freq: 320, to: 70, type: 'sawtooth', dur: 0.8, gain: 0.13 });
        this.tone({ freq: 160, to: 40, type: 'square', dur: 0.9, gain: 0.08, delay: 0.06 });
        break;

      case 'bomberDown':
        this.tone({ freq: 700, to: 120, type: 'square', dur: 0.28, gain: 0.12 });
        this.noise({ freq: 3000, to: 400, dur: 0.3, gain: 0.14, type: 'bandpass', q: 1.5 });
        break;

      case 'fuseBeep': {
        // Pitch climbs with urgency (0..1), so panic scales with the countdown.
        const u = opts.urgency ?? 0;
        this.tone({ freq: 620 + u * 700, type: 'square', dur: 0.06, gain: 0.09 + u * 0.06 });
        break;
      }

      case 'uiClick':
        this.tone({ freq: 700, to: 900, type: 'triangle', dur: 0.05, gain: 0.07 });
        break;

      case 'matchEnd':
        [72, 76, 79, 84].forEach((n, i) => this.tone({
          freq: noteToFreq(n), type: 'triangle', dur: 0.42, gain: 0.11, delay: i * 0.11,
        }));
        break;

      default:
        break;
    }
  }

  /**
   * Killstreak stinger. Each tier climbs higher and adds a note, so the reward
   * escalates audibly without needing a recorded announcer voice.
   */
  streak(multi) {
    if (!this.canPlay() || multi < 2) return;
    const tier = Math.min(multi, 5);
    // Major arpeggio, transposed up a step per tier.
    const root = 67 + (tier - 2) * 2;
    const shape = [0, 4, 7, 12, 16].slice(0, tier);
    shape.forEach((step, i) => {
      this.tone({
        freq: noteToFreq(root + step),
        type: 'triangle',
        dur: 0.3,
        gain: 0.12,
        delay: i * 0.075,
      });
    });
    // Top sparkle on the big ones.
    if (tier >= 4) {
      this.tone({
        freq: noteToFreq(root + 24), type: 'sine', dur: 0.5,
        gain: 0.08, delay: shape.length * 0.075,
      });
    }
  }

  // ----------------------------------------------------------- fuse beeps

  /**
   * Called every frame with the bomber's remaining fuse (or null when it isn't
   * armed). Beeps accelerate from ~2/sec to ~10/sec as the timer runs out, so
   * you can track the threat without looking at it.
   */
  fuseTick(fuseRemaining, total) {
    if (fuseRemaining == null) return this.stopFuse();
    if (!this.canPlay()) return;

    const urgency = Math.max(0, Math.min(1, 1 - fuseRemaining / total));
    const now = this.ctx.currentTime;

    if (!this.fuse.active) {
      this.fuse.active = true;
      this.fuse.nextBeep = now; // beep immediately on arming
    }
    if (now < this.fuse.nextBeep) return;

    this.play('fuseBeep', { urgency });
    const interval = 0.5 - urgency * 0.4; // 0.5s -> 0.1s
    this.fuse.nextBeep = now + Math.max(0.09, interval);
  }

  stopFuse() {
    this.fuse.active = false;
  }

  dispose() {
    this.stopFuse();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }
}

// ------------------------------------------------------------- persistence

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveSettings(sfx) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume: sfx.volume, muted: sfx.muted }));
  } catch {
    // Private mode — settings just won't persist.
  }
}

/** One instance for the whole app. */
export const sfx = new Sfx();
