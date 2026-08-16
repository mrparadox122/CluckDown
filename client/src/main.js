import './style.css';
import {
  MODE_LIST, MODES, makeRoomCode, cleanRoomCode, MAPS, MAP_VOTE,
} from '@cluckdown/shared';
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
  lobby: $('lobby'),
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

// Auto-requeue. The results screen used to make "do nothing" the default
// action, and doing nothing means leaving — so the countdown makes "play again"
// the thing that happens if you don't intervene. Any interaction cancels it,
// because a player who is reading the table has not decided to leave.
let requeueTimer = null;
let requeueLeft = 0;
let privateCode = '';
// Remembers that the player was in fullscreen when a match ended, so "Play
// again" can put them back without them having to ask twice.
let wantFullscreen = false;
// Invite code of the match in progress, so the HUD can keep showing it.
let activeCode = '';
let lobbyPoll = null;
let myVote = null;

// ------------------------------------------------------------------ helpers

function show(name) {
  // Leaving the results screen for ANY reason kills the auto-requeue. Without
  // this it keeps counting while the player sits on the menu and then yanks
  // them into a match they didn't ask for.
  if (name !== 'results') stopRequeue();
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
    if (s.phase === 'lobby') runLobby(s, () => launch(s));
    else launch(s);
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
  const local = new LocalSession({ mode: profile.mode, name });
  // The offline lobby needs the sim ticking to advance, and nothing is driving
  // it until the Game's render loop exists — so pump it here for the vote.
  const pump = setInterval(() => local.update(0.05), 50);
  runLobby(local, () => { clearInterval(pump); launch(local); });
  toast('Offline practice — bots only, no rating.');
}

/**
 * Map vote, shown between joining and the match starting.
 *
 * The renderer builds its arena from the chosen size, so the Game cannot be
 * constructed until the vote resolves — which is exactly why this sits here
 * rather than as an overlay on top of a running match.
 */
function runLobby(newSession, onDone) {
  session = newSession;
  myVote = null;
  show('lobby');

  const grid = $('map-choices');
  let built = false;

  const render = () => {
    const choices = session.mapChoices;
    if (!choices.length) return;

    if (!built) {
      built = true;
      grid.replaceChildren(...choices.map(({ id }) => {
        const map = MAPS[id] ?? { label: id, blurb: '', size: 40, floor: '#3f6fd8' };
        const btn = document.createElement('button');
        btn.className = 'map-choice';
        btn.type = 'button';
        btn.dataset.map = id;
        btn.setAttribute('aria-pressed', 'false');

        const swatch = document.createElement('div');
        swatch.className = 'map-swatch';
        swatch.style.backgroundColor = map.floor;

        const votes = document.createElement('span');
        votes.className = 'map-votes';
        votes.dataset.n = '0';

        const name = document.createElement('strong');
        name.textContent = map.label;
        const blurb = document.createElement('small');
        blurb.textContent = map.blurb;
        const size = document.createElement('div');
        size.className = 'map-size';
        size.textContent = `${map.size}×${map.size}`;

        btn.append(swatch, votes, name, blurb, size);
        btn.addEventListener('click', () => {
          if (myVote === id) return;
          myVote = id;
          sfx.play('uiClick');
          session.sendVote(id);
          for (const b of grid.children) b.setAttribute('aria-pressed', String(b.dataset.map === id));
        });
        return btn;
      }));
    }

    for (const btn of grid.children) {
      const found = choices.find((c) => c.id === btn.dataset.map);
      const badge = btn.querySelector('.map-votes');
      const n = found?.votes ?? 0;
      badge.textContent = n > 0 ? String(n) : '';
      badge.dataset.n = String(n);
    }

    const left = Math.max(0, MAP_VOTE.seconds - session.lobbyTime);
    $('lobby-bar').style.transform = `scaleX(${left / MAP_VOTE.seconds})`;
    $('lobby-status').textContent = myVote
      ? `You picked ${MAPS[myVote]?.label ?? myVote}`
      : 'Tap a map to vote';

    if (session.phase !== 'lobby') {
      clearInterval(lobbyPoll);
      lobbyPoll = null;
      onDone();
    }
  };

  clearInterval(lobbyPoll);
  lobbyPoll = setInterval(render, 150);
  render();
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
  // Hot-join: the match was already running. Say so, or a clock reading 0:47
  // and a scoreboard full of kills you didn't miss reads as a bug.
  session.on('joinedInProgress', () => toast('Dropped into a match in progress'));
  session.on('error', ({ message }) => {
    toast(message || 'Connection lost');
    endMatch();
    show('menu');
  });

  game = new Game({ canvas, session, hud, gfx, onExit: endMatch });
}

function endMatch() {
  clearInterval(lobbyPoll);
  lobbyPoll = null;
  document.body.classList.remove('in-match');
  game?.dispose();
  game = null;
  session?.leave();
  session = null;
  hud?.hide();
  hud?.reset();
}

// ----------------------------------------------------------------- results

/**
 * Starts the "next match in N" countdown on the results screen.
 *
 * Cancelled by any pointer or key event anywhere: someone scrolling the
 * scoreboard or reading their rating is engaged, and yanking them into a new
 * match mid-read is worse than letting them choose.
 */
function startRequeue(seconds = 8) {
  stopRequeue();
  requeueLeft = seconds;

  const label = $('again-label');
  const bar = $('again-bar');
  bar.style.transform = 'scaleX(1)';

  const tick = () => {
    requeueLeft -= 0.1;
    if (requeueLeft <= 0) {
      stopRequeue();
      playAgain();
      return;
    }
    label.textContent = `Play again in ${Math.ceil(requeueLeft)}`;
    bar.style.transform = `scaleX(${requeueLeft / seconds})`;
  };
  label.textContent = `Play again in ${seconds}`;
  requeueTimer = setInterval(tick, 100);

  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, cancelRequeue, { once: true, passive: true });
  }
}

function stopRequeue() {
  clearInterval(requeueTimer);
  requeueTimer = null;
  $('again-bar').style.transform = 'scaleX(0)';
  // Reset the caption too. Without this the button keeps reading "Play again
  // in 1" after the countdown has already fired, which is stale the moment
  // anyone lands back on this screen.
  $('again-label').textContent = 'Play again';
}

function cancelRequeue() {
  if (!requeueTimer) return;
  stopRequeue();
}

/** The rematch itself — shared by the button and the countdown. */
function playAgain() {
  // Requesting fullscreen is only allowed from a user gesture. The countdown is
  // not one, so an auto-requeue simply comes back windowed rather than failing.
  if (wantFullscreen && !isFullscreen() && requeueTimer === null) {
    try { toggleFullscreen(); } catch { /* not a gesture; carry on windowed */ }
  }
  wantFullscreen = false;
  if (lastResult?.offline) startOffline();
  else startOnline(privateCode); // keep the party together for a rematch
}

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

  // Near-miss framing. "2nd" is a verdict; "40 points behind Nugget" is a
  // rematch. Same data, and the second one is what brings people back.
  const nearEl = $('results-near');
  nearEl.textContent = '';
  if (me && me.place > 1) {
    const above = ranking[me.place - 2];
    const gap = (above?.score ?? 0) - (me.score ?? 0);
    if (above && gap > 0) {
      nearEl.textContent = `${gap} point${gap === 1 ? '' : 's'} behind ${above.name}. So close.`;
    }
  } else if (me?.place === 1 && ranking[1]) {
    const gap = (me.score ?? 0) - (ranking[1].score ?? 0);
    nearEl.textContent = gap > 0 ? `Won by ${gap}. ${ranking[1].name} was breathing down your neck.` : '';
  }

  sfx.play('matchEnd');
  endMatch();

  startRequeue();

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

  // Aim assist. Live, like the fire-button editor below — it is a feel setting
  // and the only way to judge it is to try it.
  const assist = $('gfx-assist');
  assist.checked = gfx.assist !== false;
  assist.addEventListener('change', (e) => {
    gfx = { ...gfx, assist: e.target.checked };
    saveGfx(gfx);
    sfx.play('uiClick');
    game?.setAssist(gfx.assist);
  });

  // Fire-button layout editing. Also live: the whole point is to drag it while
  // looking at the match it will be used in.
  const fireEdit = $('gfx-fire-edit');
  fireEdit.checked = !!gfx.fireEdit;
  fireEdit.addEventListener('change', (e) => {
    gfx = { ...gfx, fireEdit: e.target.checked };
    saveGfx(gfx);
    sfx.play('uiClick');
    game?.setFireEdit(gfx.fireEdit);
    if (gfx.fireEdit) toast('Drag the FIRE button where you want it.', 3200);
  });
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
    clearInterval(lobbyPoll);
    lobbyPoll = null;
    session?.leave();
    session = null;
    show('menu');
    setStatus('');
  });

  $('again-btn').addEventListener('click', () => {
    // This click IS a user gesture, so fullscreen can be restored here even
    // though the countdown path cannot.
    stopRequeue();
    if (wantFullscreen && !isFullscreen()) toggleFullscreen();
    playAgain();
  });
  $('menu-btn').addEventListener('click', () => {
    stopRequeue();
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
