import './style.css';
import { MODE_LIST, MODES, makeRoomCode, cleanRoomCode } from '@cluckdown/shared';
import { findMatch, wakeServer, fetchServerStats, fetchRooms, joinRoomById, LocalSession } from './net.js';
import { loadProfile, saveProfile, rankLabel, applyResult } from './profile.js';
import { Hud } from './hud.js';
import { Game } from './game/index.js';
import { sfx } from './audio/sfx.js';
import { loadGfx, saveGfx, RESOLUTIONS } from './graphics.js';
import {
  blockZoomGestures, fullscreenSupported, isFullscreen, toggleFullscreen,
  lockLandscape, onFullscreenChange,
} from './mobile.js';

const $ = (id) => document.getElementById(id);

const screens = {
  menu: $('menu'),
  finding: $('finding'),
  results: $('results'),
};

const canvas = $('stage');
let profile = loadProfile();
let gfx = loadGfx();
let game = null;
let session = null;
let hud = null;
let matchAbort = null;
let lastResult = null;
let privateCode = '';
// Remembers that the player was in fullscreen when a match ended, so "Play
// again" can put them back without them having to ask twice.
let wantFullscreen = false;
// Invite code of the match in progress, so the HUD can keep showing it.
let activeCode = '';

// ------------------------------------------------------------------ helpers

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.classList.toggle('hidden', key !== name);
  if (name) hud?.hide();
}

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function setStatus(text, isError = false) {
  const el = $('menu-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// --------------------------------------------------------------- main menu

function renderMenu() {
  $('name-input').value = profile.name;
  $('rank-name').textContent = rankLabel(profile.rating);
  $('rank-elo').textContent = `${profile.rating} ELO`;

  const grid = $('mode-grid');
  grid.replaceChildren(...MODE_LIST.map((id) => {
    const cfg = MODES[id];
    const btn = document.createElement('button');
    btn.className = 'mode-btn';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(profile.mode === id));
    btn.dataset.mode = id;

    const title = document.createElement('strong');
    title.textContent = cfg.label;
    const blurb = document.createElement('small');
    blurb.textContent = cfg.blurb;
    btn.append(title, blurb);

    if (cfg.ranked) {
      const tag = document.createElement('span');
      tag.className = 'ranked-tag';
      tag.textContent = 'RANKED';
      btn.append(tag);
    }

    btn.addEventListener('click', () => {
      sfx.play('uiClick');
      profile.mode = id;
      saveProfile(profile);
      for (const b of grid.children) b.setAttribute('aria-pressed', String(b.dataset.mode === id));
    });
    return btn;
  }));

  const kd = profile.deaths ? (profile.kills / profile.deaths).toFixed(2) : String(profile.kills);
  $('career-stats').replaceChildren(...[
    ['Matches', profile.matches],
    ['Wins', profile.wins],
    ['Kills', profile.kills],
    ['Deaths', profile.deaths],
    ['K/D', kd],
    ['Rating', profile.rating],
  ].map(([label, value]) => {
    const box = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = String(value);
    const s = document.createElement('span');
    s.textContent = label;
    box.append(b, s);
    return box;
  }));
}

function currentName() {
  const raw = $('name-input').value.trim();
  const name = raw.replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, 14);
  return name || 'Chicken';
}

// ------------------------------------------------------------- match flow

async function startOnline(code = '') {
  activeCode = code;
  const name = currentName();
  profile.name = name;
  saveProfile(profile);

  const mode = profile.mode;
  const cfg = MODES[mode];

  show('finding');
  $('finding-title').textContent = code ? `Private match ${code}` : 'Finding lobby…';
  $('finding-sub').textContent = code
    ? 'Waiting for friends to join with your code'
    : `${cfg.label} · up to ${cfg.maxPlayers} chickens`;

  matchAbort = new AbortController();

  try {
    const s = await findMatch({ mode, name, rating: profile.rating, code, signal: matchAbort.signal });
    if (matchAbort.signal.aborted) { s.leave(); return; }
    launch(s);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    show('menu');
    setStatus(
      'Could not reach the server. Practice offline works without it.',
      true,
    );
  } finally {
    matchAbort = null;
  }
}

function startOffline() {
  activeCode = '';
  const name = currentName();
  profile.name = name;
  saveProfile(profile);
  launch(new LocalSession({ mode: profile.mode, name }));
  toast('Offline practice — bots only, no rating.');
}

function launch(newSession) {
  session = newSession;

  hud ??= new Hud({ onChat: (msg) => session?.sendChat(msg) });
  hud.reset();

  show(null);
  hud.show();
  hud.setRoomCode(activeCode, copyCode);
  document.body.classList.add('in-match');

  session.on('matchEnd', (result) => showResults(result));
  session.on('error', ({ message }) => {
    toast(message || 'Connection lost');
    endMatch();
    show('menu');
  });

  game = new Game({ canvas, session, hud, gfx, onExit: endMatch });
}

function endMatch() {
  document.body.classList.remove('in-match');
  game?.dispose();
  game = null;
  session?.leave();
  session = null;
  hud?.hide();
  hud?.reset();
}

// ----------------------------------------------------------------- results

function showResults(result) {
  const selfId = session?.selfId;
  lastResult = result;

  if (!result.offline) {
    profile = applyResult(profile, { ...result, selfId });
    saveProfile(profile);
  }

  const ranking = result.ranking ?? [];
  const me = ranking.find((r) => r.id === selfId);

  $('results-title').textContent = me?.place === 1 ? '🏆 Top Chicken!' : `You placed #${me?.place ?? '-'}`;

  // Podium: 2nd, 1st, 3rd — so first place stands in the middle.
  const podium = $('podium');
  const order = [ranking[1], ranking[0], ranking[2]];
  const classes = ['p2', 'p1', 'p3'];
  podium.replaceChildren(...order.map((entry, i) => {
    const slot = document.createElement('div');
    slot.className = `podium-slot ${classes[i]}`;
    if (!entry) return slot;

    const chicken = document.createElement('div');
    chicken.className = 'podium-chicken';
    chicken.textContent = '🐔';
    chicken.style.filter = `drop-shadow(0 0 8px ${entry.color})`;

    const name = document.createElement('div');
    name.className = 'podium-name';
    name.textContent = entry.name;
    name.style.color = entry.color;

    const block = document.createElement('div');
    block.className = 'podium-block';
    block.textContent = String(entry.place);

    slot.append(chicken, name, block);
    return slot;
  }));

  $('results-rows').replaceChildren(...ranking.map((r) => {
    const tr = document.createElement('tr');
    if (r.id === selfId) tr.className = 'is-self';

    const place = document.createElement('td');
    place.textContent = String(r.place);

    const nameCell = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'rt-dot';
    dot.style.background = r.color;
    nameCell.append(dot, document.createTextNode(r.name + (r.bot ? ' 🤖' : '')));

    tr.append(place, nameCell);
    for (const value of [r.kills, r.deaths, r.damage, r.score]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    return tr;
  }));

  const ratingEl = $('results-rating');
  const delta = result.ranked ? result.deltas?.[selfId] : null;
  if (typeof delta === 'number') {
    ratingEl.textContent = '';
    const span = document.createElement('span');
    span.className = delta >= 0 ? 'up' : 'down';
    span.textContent = `${delta >= 0 ? '+' : ''}${delta} ELO`;
    ratingEl.append(
      document.createTextNode(`${rankLabel(profile.rating)} · ${profile.rating} `),
      span,
    );
  } else {
    ratingEl.textContent = result.offline ? 'Offline practice — no rating change.' : 'Unranked match.';
  }

  sfx.play('matchEnd');
  endMatch();

  // Drop out of fullscreen for the results screen. It's a scrollable page, and
  // on a landscape phone the podium plus the table overflow a short viewport —
  // being stuck fullscreen with no way to reach the bottom is the bug this
  // fixes. The preference is remembered for the rematch.
  if (isFullscreen()) {
    wantFullscreen = true;
    toggleFullscreen();
  }

  show('results');
  renderMenu();
}

// -------------------------------------------------------------------- boot

// --------------------------------------------------------------------- audio

function syncAudioUi() {
  const icon = sfx.muted ? '\u{1F507}' : '\u{1F50A}';
  for (const id of ['mute-btn', 'hud-mute']) {
    const btn = $(id);
    if (!btn) continue;
    btn.textContent = icon;
    btn.setAttribute('aria-pressed', String(sfx.muted));
    btn.setAttribute('aria-label', sfx.muted ? 'Unmute' : 'Mute');
  }
  $('volume').value = String(Math.round(sfx.volume * 100));
}

function bindAudio() {
  syncAudioUi();

  // Browsers refuse to start audio outside a user gesture, so the very first
  // tap or keypress anywhere is what actually boots the audio engine.
  const unlock = () => sfx.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  const toggle = () => {
    sfx.unlock();
    sfx.toggleMute();
    syncAudioUi();
    if (!sfx.muted) sfx.play('uiClick');
  };
  $('mute-btn').addEventListener('click', toggle);
  $('hud-mute').addEventListener('click', toggle);

  $('volume').addEventListener('input', (e) => {
    sfx.unlock();
    sfx.setVolume(Number(e.target.value) / 100);
    // Dragging the slider up is an obvious "I want sound" signal.
    if (sfx.muted && sfx.volume > 0) sfx.setMuted(false);
    syncAudioUi();
  });
  // Preview the level once you let go, rather than on every pixel of drag.
  $('volume').addEventListener('change', () => sfx.play('uiClick'));

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.target instanceof HTMLInputElement) return;
    toggle();
    toast(sfx.muted ? 'Sound off' : 'Sound on', 1200);
  });
}

function bindGraphics() {
  const res = $('gfx-resolution');
  res.replaceChildren(...RESOLUTIONS.map(({ value, label }) => {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = label;
    return opt;
  }));
  res.value = String(gfx.resolution);
  $('gfx-glow').checked = gfx.glow;
  $('gfx-antialias').checked = gfx.antialias;

  // Settings are read when the renderer is built, which happens at match start,
  // so there is never a live engine to reconfigure here.
  const apply = (patch) => {
    gfx = { ...gfx, ...patch };
    saveGfx(gfx);
    sfx.play('uiClick');
    if (game) toast('Applies to your next match.');
  };

  res.addEventListener('change', (e) => apply({ resolution: Number(e.target.value) }));
  $('gfx-glow').addEventListener('change', (e) => apply({ glow: e.target.checked }));
  $('gfx-antialias').addEventListener('change', (e) => apply({ antialias: e.target.checked }));
}

// --------------------------------------------------------------- server

let serverPoll = null;

async function refreshServerStatus() {
  const box = $('server-status');
  const text = $('server-text');
  const ping = $('server-ping');

  const stats = await fetchServerStats();
  box.classList.toggle('is-online', stats.online);
  box.classList.toggle('is-offline', !stats.online);
  box.classList.remove('is-checking');

  if (!stats.online) {
    text.textContent = stats.error === 'timeout' ? 'Server not responding' : 'Server offline';
    ping.textContent = '';
    ping.className = 'server-ping';
    setStatus('Server unreachable — practice offline still works.');
    return;
  }

  const players = stats.players ?? 0;
  const rooms = stats.rooms ?? 0;
  text.textContent = players === 0
    ? 'Online · be the first in'
    : `Online · ${players} player${players === 1 ? '' : 's'} in ${rooms} match${rooms === 1 ? '' : 'es'}`;

  ping.textContent = `${stats.ping} ms`;
  ping.className = `server-ping ${stats.ping <= 60 ? 'good' : stats.ping <= 140 ? 'fair' : 'poor'}`;
  setStatus('');
}

function startServerPolling() {
  refreshServerStatus();
  clearInterval(serverPoll);
  // Only while the menu is up; no point polling during a match.
  refreshRooms();
  serverPoll = setInterval(() => {
    if (screens.menu.classList.contains('hidden')) return;
    refreshServerStatus();
    refreshRooms();
  }, 5000);
}

// ------------------------------------------------------- friends & browser

async function copyCode(code) {
  if (!code) return;
  sfx.play('uiClick');
  try {
    await navigator.clipboard.writeText(code);
    toast(`Copied ${code} — send it to a friend`);
  } catch {
    // Clipboard needs permission and a secure context; the code is on screen
    // either way, so just surface it.
    toast(`Invite code: ${code}`);
  }
}

function bindFriends() {
  const codeInput = $('join-code');

  $('create-private').addEventListener('click', () => {
    sfx.play('uiClick');
    privateCode = makeRoomCode();
    $('room-code').textContent = privateCode;
    $('code-display').classList.remove('hidden');
    startOnline(privateCode);
  });

  $('copy-code').addEventListener('click', () => copyCode(privateCode));

  // Force the field to the canonical alphabet as they type.
  codeInput.addEventListener('input', () => {
    codeInput.value = cleanRoomCode(codeInput.value);
  });

  const join = () => {
    const code = cleanRoomCode(codeInput.value);
    if (code.length < 4) { toast('Enter the 4-character code'); return; }
    sfx.play('uiClick');
    startOnline(code);
  };
  $('join-code-btn').addEventListener('click', join);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
}

async function refreshRooms() {
  const list = $('room-list');
  const rooms = await fetchRooms();

  if (!rooms.length) {
    list.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'room-empty',
      textContent: 'No open matches right now — hit PLAY to start one.',
    }));
    return;
  }

  list.replaceChildren(...rooms.map((r) => {
    const row = document.createElement('div');
    row.className = 'room-row';

    const mode = document.createElement('span');
    mode.className = 'room-mode';
    mode.textContent = MODES[r.mode]?.label ?? r.mode;

    const count = document.createElement('span');
    count.className = 'room-count';
    count.textContent = `${r.humans}/${r.maxPlayers}${r.bots ? ` +${r.bots}🤖` : ''}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = r.full ? 'Full' : 'Join';
    btn.disabled = !!r.full;
    btn.addEventListener('click', async () => {
      sfx.play('uiClick');
      btn.disabled = true;
      show('finding');
      $('finding-title').textContent = 'Joining match…';
      $('finding-sub').textContent = MODES[r.mode]?.label ?? r.mode;
      try {
        const name = currentName();
        profile.name = name;
        saveProfile(profile);
        launch(await joinRoomById({ roomId: r.roomId, name, rating: profile.rating }));
      } catch {
        show('menu');
        setStatus('That match is no longer available.', true);
        refreshRooms();
      }
    });

    row.append(mode, count, btn);
    return row;
  }));
}

// --------------------------------------------------------------- mobile

function bindMobile() {
  // Must run before any match starts: accidental pinch-zoom mid-fight was the
  // single most common complaint from phone players.
  blockZoomGestures();

  const fsBtn = $('hud-fullscreen');
  if (!fullscreenSupported()) {
    // iPhone Safari has no element fullscreen. Hide the button rather than
    // offer something that silently does nothing.
    fsBtn.classList.add('hidden');
  } else {
    fsBtn.addEventListener('click', async () => {
      sfx.play('uiClick');
      await toggleFullscreen();
    });
    const syncFs = () => { fsBtn.textContent = isFullscreen() ? '✕' : '⛶'; };
    onFullscreenChange(syncFs);
    syncFs();
  }

  $('hud-view').addEventListener('click', () => {
    if (!game) return;
    sfx.play('uiClick');
    const { view, label } = game.cycleView();
    gfx = { ...gfx, view };
    saveGfx(gfx);
    toast(`Camera: ${label}`, 1200);
  });

  // Worth attempting on load too — it works on Android Chrome when already
  // fullscreen, and fails harmlessly everywhere else.
  lockLandscape();
}

function bind() {
  bindAudio();
  bindGraphics();
  bindFriends();
  bindMobile();
  startServerPolling();
  $('play-btn').addEventListener('click', () => { sfx.unlock(); sfx.play('uiClick'); startOnline(); });
  $('practice-btn').addEventListener('click', () => { sfx.unlock(); sfx.play('uiClick'); startOffline(); });

  $('cancel-btn').addEventListener('click', () => {
    matchAbort?.abort();
    matchAbort = null;
    show('menu');
    setStatus('');
  });

  $('again-btn').addEventListener('click', () => {
    // Requesting fullscreen is only allowed from a user gesture, and this click
    // is one — so a player who was fullscreen gets it back automatically.
    if (wantFullscreen && !isFullscreen()) toggleFullscreen();
    wantFullscreen = false;
    if (lastResult?.offline) startOffline();
    else startOnline(privateCode); // keep the party together for a rematch
  });
  $('menu-btn').addEventListener('click', () => {
    wantFullscreen = false;
    privateCode = '';
    $('code-display').classList.add('hidden');
    show('menu');
    setStatus('');
    refreshRooms();
  });

  $('name-input').addEventListener('change', () => {
    profile.name = currentName();
    saveProfile(profile);
  });

  // Enter on the name field is the same as pressing PLAY.
  $('name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); startOnline(); }
  });

  // Leaving the tab mid-match shouldn't keep a socket burning.
  window.addEventListener('pagehide', () => endMatch());
}

renderMenu();
bind();
show('menu');

// Dev-only debug handle: lets you poke at the live session from the console
// (e.g. `__cluckdown.session.world.clock = 2` to jump to the results screen).
// Stripped from production builds.
if (import.meta.env.DEV) {
  window.__cluckdown = {
    get session() { return session; },
    get game() { return game; },
    get profile() { return profile; },
    sfx,
  };
}

// Warm the free-tier server while the player is typing their name, so the first
// PLAY doesn't eat a 30-second cold start. The status panel reports the result,
// so nothing to do with the answer here.
wakeServer();
