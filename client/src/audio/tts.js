// Spoken announcer, on the browser's own speech synthesis.
//
// A stand-in for recorded VO, and a deliberate one: real voice lines are the
// single most expensive asset a game like this could take on, and this answers
// the question they would answer — does an announcer actually make the kill feed
// land harder — for nothing, before anybody records anything.
//
// The whole design problem with an announcer is VOLUME OF SPEECH, not sound.
// Speech occupies a channel nothing else can share: two lines at once are
// unintelligible, and a queue that runs behind the action is worse than silence
// because it narrates a fight you already lost. So everything here is about
// deciding what NOT to say:
//
//   * one line at a time, and a more important line cuts off a lesser one
//   * nothing repeats inside a short window
//   * a line that has waited too long is dropped rather than spoken late
//
// Off by default. An announcer is a strong taste, screen readers share this
// exact API, and speaking without being asked is rude on a device someone else
// can hear.

/** Higher wins. A line only interrupts one strictly below it. */
export const SAY = {
  chatter: 1,   // pickups, minor events
  event: 2,     // objectives, the bomber
  kill: 3,      // you killed someone
  streak: 4,    // multikills, headshots, level-ups
  match: 5,     // the match itself starting or ending
};

// Dropped rather than spoken if it could not start within this. An announcer
// describing something from two seconds ago is actively confusing.
const STALE_MS = 1400;
// The same line twice in a row inside this window is almost always the game
// repeating itself rather than something happening twice.
const REPEAT_MS = 2600;

export class Tts {
  constructor({ enabled = false, rate = 1.2, pitch = 1.0, volume = 1 } = {}) {
    this.enabled = enabled;
    // Slightly quick, because these are callouts during a fight rather than
    // narration — an announcer at conversational pace is still talking about
    // the kill when the next one lands.
    this.rate = rate;
    // Natural pitch, deliberately. The chirpy 1.15 this started at made every
    // voice sound like a cartoon, which is precisely the note the game is
    // trying not to hit. Whatever character the announcer has should come from
    // the VOICE, not from pitch-shifting it.
    this.pitch = pitch;
    this.volume = volume;
    this.muted = false;
    this.voice = null;
    this.preferred = null; // player's explicit pick, by name
    this.lastAt = new Map();
    this.speakingPriority = 0;
    this.speakingUntil = 0;
    this.primed = false;
    this.watchers = [];

    this.supported = typeof window !== 'undefined'
      && typeof window.speechSynthesis !== 'undefined'
      && typeof window.SpeechSynthesisUtterance !== 'undefined';

    if (this.supported) {
      // Voices load asynchronously in most browsers and the list is empty on
      // the first call, so this has to be re-run rather than read once.
      const pick = () => {
        this.voice = this.chooseVoice();
        // The settings picker cannot poll for this: on Chrome the list is empty
        // until the engine reports in, which can be after the panel is open.
        for (const fn of this.watchers) fn(this.listVoices());
      };
      pick();
      try { window.speechSynthesis.addEventListener('voiceschanged', pick); } catch { /* older API */ }
    }
  }

  /** Every English voice worth offering, best first. For the settings picker. */
  listVoices() {
    if (!this.supported) return [];
    let voices = [];
    try { voices = window.speechSynthesis.getVoices() ?? []; } catch { return []; }
    const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang || ''));
    const pool = en.length ? en : voices;
    return [...pool].sort((a, b) => this.score(b) - this.score(a));
  }

  /**
   * How good a voice is likely to sound, higher is better.
   *
   * This started out preferring `localService`, on the reasoning that a remote
   * voice round-trips to a server and a late callout is a useless one. That was
   * exactly backwards in practice: the good neural voices — Microsoft's
   * "Natural"/"Online" set, Google's — are ALL remote, and the local ones are
   * the flat robotic speech engines from a decade ago. Optimising for latency
   * was quietly guaranteeing the worst voice on the device.
   *
   * The latency does exist, and it is the right trade anyway: these lines are
   * confirmations, not warnings. "Headshot" landing 200ms after the kill banner
   * still reads as a reward. It is only a problem for a line that has to change
   * what the player DOES — which is an argument for keeping warnings on the
   * synth in sfx.js, where they already are, rather than for a worse voice.
   */
  score(v) {
    const name = `${v.name || ''}`;
    let n = 0;
    // Neural voices announce themselves in the name on every platform that has
    // them. This is the single biggest quality jump available.
    if (/natural|neural/i.test(name)) n += 100;
    if (/google/i.test(name)) n += 60;
    if (/online/i.test(name)) n += 25;
    // Apple's better built-ins, which advertise nothing in the name.
    if (/samantha|alex|daniel|karen|moira|serena/i.test(name)) n += 40;
    // Microsoft's legacy local pair. Usable, but the sound of 2012.
    if (/zira|david|mark/i.test(name)) n += 5;
    if (/^en-US/i.test(v.lang || '')) n += 8;
    if (/^en-GB/i.test(v.lang || '')) n += 4;
    if (v.default) n += 2;
    return n;
  }

  /** The best available voice, or the player's pick if it is still installed. */
  chooseVoice() {
    const pool = this.listVoices();
    if (!pool.length) return null;
    if (this.preferred) {
      const exact = pool.find((v) => v.name === this.preferred);
      if (exact) return exact;
    }
    return pool[0];
  }

  /** Run `fn(voices)` now and whenever the browser's voice list changes. */
  onVoices(fn) {
    this.watchers.push(fn);
    fn(this.listVoices());
  }

  /** Remember an explicit choice. Pass null to go back to picking the best. */
  setVoice(name) {
    this.preferred = name || null;
    this.voice = this.chooseVoice();
    return this.voice;
  }

  /**
   * Speaks a silent utterance to wake the engine up.
   *
   * The first `speak()` of a page is routinely hundreds of milliseconds slower
   * than every one after it, and on a remote voice it also has to open the
   * connection. Paying that once at the audio unlock — which is already a user
   * gesture — means the first real callout of the match is not the slow one.
   */
  prime() {
    if (!this.supported || this.primed) return;
    this.primed = true;
    try {
      const u = new window.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      if (this.voice) u.voice = this.voice;
      window.speechSynthesis.speak(u);
    } catch { /* nothing to warm up */ }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.stop();
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.muted) this.stop();
  }

  stop() {
    if (!this.supported) return;
    try {
      window.speechSynthesis.cancel();
      // Chrome can leave the queue paused after a cancel, and every later
      // speak() then goes silently nowhere. Resuming an already-running engine
      // is a no-op, so this is free insurance against a announcer that works
      // for one line and then never again.
      window.speechSynthesis.resume();
    } catch { /* nothing to cancel */ }
    this.speakingPriority = 0;
    this.speakingUntil = 0;
  }

  /**
   * Say something, if it is worth saying.
   *
   * @param key    what this line IS, for repeat suppression — not the text, so
   *               "Nugget down" and "Colonel down" are one kind of announcement
   *               and do not talk over each other every few seconds.
   * @param force  say it regardless of repeat and priority. For the settings
   *               preview only: auditioning voices means asking for the same
   *               line several times in a row on purpose, which is exactly what
   *               the suppression above exists to stop.
   */
  say(text, { priority = SAY.chatter, key = text, force = false } = {}) {
    if (!this.supported || !this.enabled || this.muted || !text) return false;

    const now = Date.now();
    if (!force && now - (this.lastAt.get(key) ?? -Infinity) < REPEAT_MS) return false;

    // Something more important is mid-sentence. Yield rather than queue: a line
    // that waits its turn arrives describing a moment that has passed.
    if (!force && now < this.speakingUntil && priority < this.speakingPriority) return false;

    let u;
    try {
      u = new window.SpeechSynthesisUtterance(String(text));
    } catch {
      return false;
    }
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    u.pitch = this.pitch;
    u.volume = this.volume;

    try {
      // Cancel rather than layer. Two voices at once is not twice the
      // information, it is none.
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume(); // see stop() — Chrome sticks after cancel
      window.speechSynthesis.speak(u);
    } catch {
      return false;
    }

    this.lastAt.set(key, now);
    this.speakingPriority = priority;
    // Roughly how long it will take, so priority can be compared without
    // depending on onend, which does not fire reliably when cancel() is used.
    this.speakingUntil = now + Math.min(STALE_MS + 900, 380 + String(text).length * 62);
    return true;
  }
}
