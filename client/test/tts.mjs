// The spoken announcer, headless.
//
// Speech synthesis is a browser API, but almost nothing interesting about the
// announcer is: which voice gets picked, and which lines are allowed to be
// spoken at all, are both plain logic sitting on top of a list. So this stubs
// the API and checks the logic in milliseconds, rather than in a Playwright run
// that would still not be able to hear anything.
//
// Two things it protects, both of which have already been wrong once:
//
//   * voice choice. This originally preferred `localService`, reasoning that a
//     remote voice is slower. That systematically picked the WORST voice on
//     every device, because the good neural ones are all remote.
//   * volume of speech. An announcer that says everything is worse than none,
//     so the suppression rules are the feature, not an optimisation.
//
//   node client/test/tts.mjs

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

// A stand-in for the browser's engine that records what it was asked to say.
const spoken = [];
let cancels = 0;
let resumes = 0;
const listeners = [];
let voices = [];

class FakeUtterance {
  constructor(text) { this.text = text; }
}

globalThis.window = {
  SpeechSynthesisUtterance: FakeUtterance,
  speechSynthesis: {
    getVoices: () => voices,
    speak: (u) => spoken.push(u),
    cancel: () => { cancels += 1; },
    resume: () => { resumes += 1; },
    addEventListener: (name, fn) => { if (name === 'voiceschanged') listeners.push(fn); },
  },
};
const fireVoicesChanged = () => { for (const fn of listeners) fn(); };

const voice = (name, lang = 'en-US', extra = {}) => ({ name, lang, localService: false, ...extra });

const { Tts, SAY } = await import('../src/audio/tts.js');

// ---------------------------------------------------------------- voices
{
  // A realistic Windows list: the two legacy local voices plus the neural ones.
  voices = [
    voice('Microsoft David - English (United States)', 'en-US', { localService: true, default: true }),
    voice('Microsoft Zira - English (United States)', 'en-US', { localService: true }),
    voice('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
    voice('Google UK English Male', 'en-GB'),
    voice('Microsoft Hedda - German', 'de-DE', { localService: true }),
  ];
  const tts = new Tts();

  check('the neural voice is chosen over the local ones', tts.voice?.name === 'Microsoft Aria Online (Natural) - English (United States)', String(tts.voice?.name));
  check('localService is not treated as a reason to prefer a voice', tts.voice?.localService === false);
  check('a non-English voice is not offered', !tts.listVoices().some((v) => v.lang === 'de-DE'));
  check('the picker lists voices best first',
    tts.listVoices().map((v) => v.name).join(' | ') === 'Microsoft Aria Online (Natural) - English (United States) | Google UK English Male | Microsoft David - English (United States) | Microsoft Zira - English (United States)', tts.listVoices().map((v) => v.name).join(' | '));

  // An explicit pick beats the ranking — that is the entire point of the picker.
  tts.setVoice('Google UK English Male');
  check('an explicit pick beats the ranking', tts.voice?.name === 'Google UK English Male', String(tts.voice?.name));

  // ...but a name from a device that no longer has it falls back rather than
  // leaving the announcer mute, which is what storing an object would have done.
  tts.setVoice('A Voice This Phone Does Not Have');
  check('a saved voice this device lacks falls back to the best one', tts.voice?.name === 'Microsoft Aria Online (Natural) - English (United States)', String(tts.voice?.name));
}

// Voices arrive late on Chrome — the list is empty on the first call.
{
  voices = [];
  const tts = new Tts();
  check('an empty voice list is survivable', tts.voice === null);

  const seen = [];
  tts.onVoices((list) => seen.push(list.length));
  voices = [voice('Microsoft Aria Online (Natural) - English (United States)')];
  fireVoicesChanged();
  check('onVoices runs straight away, even with nothing to show', seen[0] === 0, String(seen[0]));
  check('onVoices runs again when the browser reports voices', seen.at(-1) === 1, String(seen.at(-1)));
  check('a voice that arrives late is still picked up', tts.voice?.name === 'Microsoft Aria Online (Natural) - English (United States)', String(tts.voice?.name));
}

// ------------------------------------------------------------- what it says
{
  voices = [voice('Microsoft Aria Online (Natural) - English (United States)')];
  const tts = new Tts();
  spoken.length = 0;

  check('says nothing at all until switched on', tts.say('Headshot') === false);

  tts.setEnabled(true);
  check('speaks once switched on', tts.say('Headshot', { key: 'head', priority: SAY.streak }) === true);
  check('will not repeat the same kind of line straight away', tts.say('Headshot', { key: 'head' }) === false);
  check('a lesser line yields rather than queueing behind one',
    tts.say('Grain', { key: 'grain', priority: SAY.chatter }) === false);
  check('a more important line cuts in',
    tts.say('Triple kill', { key: 'multi', priority: SAY.match }) === true);
  check('force overrides both, for the settings preview',
    tts.say('Headshot', { key: 'head', force: true }) === true);

  check('muting the game mutes the announcer', (tts.setMuted(true), tts.say('Triple kill', { key: 'x' })) === false);
  tts.setMuted(false);

  check('every line cancels whatever was speaking', cancels > 0);
  check('resume follows every cancel, or Chrome sticks silent', resumes >= cancels);
  check('only ever hands the engine real utterances', spoken.every((u) => u instanceof FakeUtterance));
  check('pitch is left alone rather than made chirpy', spoken.at(-1).pitch === 1, String(spoken.at(-1).pitch));
  check('rate is brisk but not comic', spoken.at(-1).rate > 1 && spoken.at(-1).rate <= 1.35,
    String(spoken.at(-1).rate));
  check('speaks with the chosen voice', spoken.at(-1).voice?.name === 'Microsoft Aria Online (Natural) - English (United States)');

  // Priming is a real utterance, so it has to be silent and happen once only.
  const before = spoken.length;
  tts.prime();
  tts.prime();
  check('priming happens once and is silent',
    spoken.length === before + 1 && spoken.at(-1).volume === 0);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
