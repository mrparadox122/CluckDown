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
  constructor({ enabled = false, rate = 1.15, pitch = 1.15, volume = 0.9 } = {}) {
    this.enabled = enabled;
    this.rate = rate;
    this.pitch = pitch;
    this.volume = volume;
    this.muted = false;
    this.voice = null;
    this.lastAt = new Map();
    this.speakingPriority = 0;
    this.speakingUntil = 0;

    this.supported = typeof window !== 'undefined'
      && typeof window.speechSynthesis !== 'undefined'
      && typeof window.SpeechSynthesisUtterance !== 'undefined';

    if (this.supported) {
      // Voices load asynchronously in most browsers and the list is empty on
      // the first call, so this has to be re-run rather than read once.
      const pick = () => { this.voice = this.chooseVoice(); };
      pick();
      try { window.speechSynthesis.addEventListener('voiceschanged', pick); } catch { /* older API */ }
    }
  }

  /**
   * Prefers a local English voice.
   *
   * Local matters: remote voices round-trip to a server, which for a line meant
   * to land on a kill is far too slow, and they fail entirely offline — which
   * this game explicitly supports.
   */
  chooseVoice() {
    if (!this.supported) return null;
    let voices = [];
    try { voices = window.speechSynthesis.getVoices() ?? []; } catch { return null; }
    if (!voices.length) return null;
    const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang || ''));
    const pool = en.length ? en : voices;
    return pool.find((v) => v.localService) ?? pool[0];
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
    try { window.speechSynthesis.cancel(); } catch { /* nothing to cancel */ }
    this.speakingPriority = 0;
    this.speakingUntil = 0;
  }

  /**
   * Say something, if it is worth saying.
   *
   * @param key  what this line IS, for repeat suppression — not the text, so
   *             "Nugget down" and "Colonel down" are one kind of announcement
   *             and do not talk over each other every few seconds.
   */
  say(text, { priority = SAY.chatter, key = text } = {}) {
    if (!this.supported || !this.enabled || this.muted || !text) return false;

    const now = Date.now();
    if (now - (this.lastAt.get(key) ?? -Infinity) < REPEAT_MS) return false;

    // Something more important is mid-sentence. Yield rather than queue: a line
    // that waits its turn arrives describing a moment that has passed.
    if (now < this.speakingUntil && priority < this.speakingPriority) return false;

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
