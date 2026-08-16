import {
  QUICK_CHAT, PLAYER, MODES, MULTIKILL_NAMES, MODIFIERS, TEAM_NAMES, HILL,
} from '@cluckdown/shared';

const $ = (id) => document.getElementById(id);
const MAX_FEED = 5;
const MAX_CHAT = 6;
// Slack around the viewport so a plate doesn't pop as a chicken crosses the edge.
const MARGIN = 48;

// Everything user-supplied goes through textContent, never innerHTML — a name
// or chat line is attacker-controlled input and this is the only place it
// touches the DOM.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function el2(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class Hud {
  constructor({ onChat }) {
    this.root = $('hud');
    this.overlay = $('world-overlay');
    this.killfeed = $('killfeed');
    this.chatLog = $('chat-log');
    this.chatInput = $('chat-input');
    this.quickChat = $('quick-chat');
    this.scoreboard = $('scoreboard');
    this.announcer = $('announcer');
    this.clockEl = $('match-clock');
    this.modePill = $('mode-pill');
    this.respawnOverlay = $('respawn-overlay');
    this.respawnCount = $('respawn-count');
    this.touchHint = $('touch-hint');
    this.netStatsEl = $('netstats');
    this.objectiveEl = $('objective');
    this.contractEl = $('contract');
    this.promptEl = $('action-prompt');
    this.roomChip = $('room-chip');
    this.onChat = onChat;
    // Compact by default; expanded shows the full breakdown.
    this.netExpanded = false;
    this.bindNetStats();

    this.plates = new Map();   // playerId -> nameplate element
    this.dmgPool = [];
    this.fuseRing = null;
    this.announceQueue = [];
    this.announceUntil = 0;

    this.buildQuickChat();
    this.bindChatInput();
  }

  show() {
    this.root.classList.remove('hidden');
    // The control hint has done its job after a few seconds.
    setTimeout(() => { this.touchHint.style.opacity = '0'; }, 5000);
  }

  hide() { this.root.classList.add('hidden'); }

  reset() {
    this.killfeed.replaceChildren();
    this.chatLog.replaceChildren();
    this.scoreboard.replaceChildren();
    for (const p of this.plates.values()) p.remove();
    this.plates.clear();
    if (this.fuseRing) { this.fuseRing.remove(); this.fuseRing = null; }
    this.respawnOverlay.classList.add('hidden');
    this.touchHint.style.opacity = '';
    this.netStatsEl.replaceChildren();
    this.objectiveEl.classList.add('hidden');
    this.contractEl.classList.add('hidden');
    this.contractShown = null;
    this.promptEl.classList.add('hidden');
    this.promptShown = null;
    this.setKilledBy(null);
    this.clearMarkers();
    this.roomChip.classList.add('hidden');
  }

  setMode(mode, modifier = 'none') {
    this.modeId = mode;
    this.modePill.textContent = MODES[mode]?.label ?? mode;

    // A persistent badge, because the opening announcement scrolls away and
    // players who joined mid-match never saw it at all.
    const mod = MODIFIERS[modifier];
    const badge = $('mod-badge');
    if (!badge) return;
    if (!mod || modifier === 'none') {
      badge.classList.add('hidden');
      badge.textContent = '';
      return;
    }
    badge.textContent = mod.label;
    badge.title = mod.blurb;
    badge.classList.remove('hidden');
  }

  /**
   * Mode-specific readout under the clock: team score, or your hold on the hill.
   * Hidden entirely in free-for-all so it costs nothing there.
   */
  setObjective({ teamScores, hill, nests, bomb, self, players }) {
    const el = this.objectiveEl;

    // Egg Heist: the standings ARE the nests, so show all four counts. Nothing
    // else in the mode tells you whether you are winning.
    if (nests?.length) {
      el.classList.remove('hidden');
      el.classList.remove('contested');
      el.replaceChildren();
      const row = el2('div', 'nest-row');
      for (const nest of [...nests].sort((a, b) => a.seat - b.seat)) {
        const owner = players?.find((pp) => pp.seat % 4 === nest.seat);
        const cell = el2('div', `nest-count${owner?.isSelf ? ' mine' : ''}`, String(nest.eggs));
        cell.style.setProperty('--seat', owner?.color ?? '#9aa6c4');
        cell.title = owner ? `${owner.name}'s nest` : 'Empty corner';
        row.append(cell);
      }
      el.append(row);
      if (self?.carrying > 0) el.append(el2('span', 'carrying', `Carrying ${self.carrying}`));
      return;
    }

    // Plant & Defuse: one line that says what the bomb is doing right now.
    if (MODES[this.modeId]?.bomb) {
      if (!bomb) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      el.replaceChildren();
      const planted = bomb.state === 'planted';
      el.classList.toggle('contested', planted);
      if (planted) {
        const victim = players?.find((pp) => pp.seat % 4 === bomb.plantSeat);
        el.append(el2('span', 'bomb-label', `\u{1F4A3} ${Math.ceil(bomb.fuse)}s`));
        el.append(el2('span', 'hill-label', victim ? `in ${victim.name}'s nest` : 'planted'));
      } else if (bomb.carriedBy) {
        const who = players?.find((pp) => pp.id === bomb.carriedBy);
        el.append(el2('span', 'bomb-label',
          who?.isSelf ? '\u{1F4A3} You have the bomb' : `\u{1F4A3} ${who?.name ?? 'Someone'} has it`));
        if (bomb.plant > 0) {
          const meter = el2('div', 'hill-meter');
          const fill = el2('i');
          fill.style.transform = `scaleX(${bomb.plant})`;
          meter.append(fill);
          el.append(meter);
        }
      } else {
        el.append(el2('span', 'bomb-label', '\u{1F4A3} Bomb is loose'));
      }
      return;
    }

    if (!teamScores && !hill) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.replaceChildren();

    if (teamScores) {
      const [blue, red] = teamScores;
      const mk = (n, cls, lead) => {
        const d = el2('div', `team-score ${cls}${lead ? ' leading' : ''}`, String(n));
        d.title = TEAM_NAMES[cls === 'blue' ? 0 : 1];
        return d;
      };
      el.append(mk(blue, 'blue', blue > red), el2('span', 'vs', 'VS'), mk(red, 'red', red > blue));
      return;
    }

    el.classList.toggle('contested', !!hill.contested);
    // A relocation warning outranks who currently holds it: in the next few
    // seconds, holding it stops mattering.
    const moving = hill.moveAt !== undefined && hill.moveAt !== null && hill.moveAt <= HILL.warnAt;
    el.classList.toggle('moving', moving);
    const label = moving
      ? `Moving in ${Math.ceil(hill.moveAt)}`
      : (hill.contested ? 'Contested' : (hill.holder ? 'Held' : 'Open'));
    const meter = el2('div', 'hill-meter');
    const fill = el2('i');
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, self?.hillPct ?? 0))})`;
    meter.append(fill);
    el.append(el2('span', 'hill-label', label), meter);
  }

  /**
   * Your current side-task.
   *
   * Rebuilt only when the contract itself changes; the progress bar and
   * countdown are mutated in place, because this runs every frame and
   * replaceChildren on every frame is exactly the kind of thing that costs
   * frames on the phones this game is aimed at.
   */
  setContract(contract) {
    const el = this.contractEl;
    if (!contract) {
      if (this.contractShown !== null) {
        this.contractShown = null;
        el.classList.add('hidden');
        el.replaceChildren();
      }
      return;
    }

    if (this.contractShown !== contract.id) {
      this.contractShown = contract.id;
      el.classList.remove('hidden');
      el.replaceChildren();
      el.append(el2('span', 'contract-tag', 'TASK'));
      this.contractLabel = el2('span', 'contract-label', contract.label);
      this.contractMeter = el2('div', 'contract-meter');
      this.contractFill = el2('i');
      this.contractMeter.append(this.contractFill);
      this.contractTime = el2('span', 'contract-time');
      el.append(this.contractLabel, this.contractMeter, this.contractTime);
      // Fresh contract: flash once so it is noticed without an announcement.
      el.classList.remove('flash');
      void el.offsetWidth; // restart the animation
      el.classList.add('flash');
    }

    const pct = contract.target > 0 ? contract.progress / contract.target : 0;
    this.contractFill.style.transform = `scaleX(${Math.max(0, Math.min(1, pct))})`;
    this.contractTime.textContent = `${Math.ceil(contract.secondsLeft)}s`;
    el.classList.toggle('urgent', contract.secondsLeft <= 10);
  }

  /**
   * Off-screen and on-screen markers for things that matter.
   *
   * First person took away the overview, and two things broke with it:
   *
   *  - the bomber could creep up behind you with no warning at all, which turns
   *    a tense mechanic into an unfair one;
   *  - "run the eggs home" and "carry the bomb to a rival nest" both assumed
   *    you could see where that was.
   *
   * One system fixes both. A marker in front of you sits on the thing it names;
   * a marker behind you is pinned to the edge of the screen and points at it,
   * with the distance so you can judge whether to run or fight.
   *
   * @param items [{ key, x, z, icon, color, dist, bearing, urgent }]
   */
  setMarkers(items, project, viewport) {
    this.markers ??= new Map();
    const seen = new Set();

    for (const it of items) {
      seen.add(it.key);
      let el = this.markers.get(it.key);
      if (!el) {
        el = el2('div', 'marker');
        el.append(el2('span', 'mk-icon'), el2('span', 'mk-dist'));
        this.overlay.append(el);
        this.markers.set(it.key, el);
      }

      const pt = project(it.x, 1.2, it.z);
      const { w, h } = viewport;
      const pad = 26;

      // project() returns null when the point is behind the camera — which is
      // exactly the marker that matters most, so those are placed by bearing
      // rather than dropped.
      let x;
      let y;
      let off;
      if (pt) {
        x = pt.x;
        y = pt.y;
        off = x < pad || x > w - pad || y < pad || y > h - pad;
      } else {
        off = true;
        x = angleTo(it.bearing) > 0 ? w - pad : pad;
        y = h / 2;
      }

      if (off) {
        x = Math.max(pad, Math.min(w - pad, x));
        y = Math.max(pad, Math.min(h - pad, y));
      }

      el.className = `marker${off ? ' is-off' : ''}${it.urgent ? ' is-urgent' : ''}`;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      el.style.setProperty('--mk', it.color ?? '#ffffff');
      el.firstChild.textContent = it.icon;
      el.lastChild.textContent = it.dist != null ? `${Math.round(it.dist)}m` : '';
    }

    for (const [key, el] of this.markers) {
      if (seen.has(key)) continue;
      el.remove();
      this.markers.delete(key);
    }
  }

  clearMarkers() {
    for (const el of this.markers?.values() ?? []) el.remove();
    this.markers?.clear();
  }

  /**
   * Moves the reticle to where the shot will actually land.
   *
   * Pitch is a look control, not an aim one — everything in this game stands on
   * the ground plane — so a reticle nailed to screen centre starts lying the
   * moment the view tilts. This takes the projected aim point instead, which
   * stays truthful at any pitch. Passing null hides it, which is what happens
   * while you are dead.
   */
  setCrosshairAt(pt) {
    const el = $('crosshair');
    if (!pt) { el.style.opacity = '0'; return; }
    el.style.opacity = '1';
    el.style.transform = `translate(${pt.x}px, ${pt.y}px) translate(-50%, -50%)`;
  }

  /**
   * The first-person minimap.
   *
   * Losing the overview is the real cost of first person in a 4-player arena —
   * you can no longer see who is behind you, where the objective is, or which
   * corner the bomber came from. A 2D canvas costs almost nothing and hands
   * all of that back.
   *
   * Drawn rotated so "up" is always where you're facing, which is what makes a
   * minimap readable at a glance rather than a puzzle to translate.
   */
  drawMinimap({ half, players, self, selfX, selfZ, aim, bomber, pickups, nests, hill, bomb }) {
    const cv = $('minimap');
    const ctx = cv.getContext('2d');
    const R = cv.width / 2;
    const scale = (R - 6) / (half || 20);

    ctx.clearRect(0, 0, cv.width, cv.height);

    // World -> minimap, rotated so the player's facing points up the screen.
    const sin = Math.sin(-aim);
    const cos = Math.cos(-aim);
    const to = (wx, wz) => {
      const dx = (wx - selfX) * scale;
      const dz = (wz - selfZ) * scale;
      return [R + (dx * cos - dz * sin), R + (dx * sin + dz * cos) * -1];
    };

    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(6,7,14,0.72)';
    ctx.fillRect(0, 0, cv.width, cv.height);

    // Arena bounds, so you can tell how close to a wall you are.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
    corners.forEach(([wx, wz], i) => {
      const [x, y] = to(wx, wz);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();

    const dot = (wx, wz, color, size, ring = false) => {
      const [x, y] = to(wx, wz);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
      if (!ring) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, size + 3, 0, Math.PI * 2);
      ctx.stroke();
    };

    if (hill) dot(hill.x, hill.z, 'rgba(255,204,61,0.5)', 7);
    for (const n of nests ?? []) dot(n.x, n.z, 'rgba(255,255,255,0.35)', 4);
    if (bomb) dot(bomb.x, bomb.z, '#ff3b30', 3.5, true);
    for (const pk of pickups ?? []) dot(pk.x, pk.z, 'rgba(53,224,127,0.8)', 2);
    if (bomber) dot(bomber.x, bomber.z, '#ff2d4b', 4, true);

    for (const p of players ?? []) {
      if (!p.alive || p.isSelf) continue;
      // Your nemesis gets the same colour it wears in the world.
      dot(p.x, p.z, self?.nemesis === p.id ? '#ff4df0' : p.color, 3.5);
    }

    ctx.restore();

    // You: always dead centre, always pointing up. A triangle rather than a dot
    // so facing is unmistakable.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(R, R - 6);
    ctx.lineTo(R - 4.5, R + 4);
    ctx.lineTo(R + 4.5, R + 4);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(R, R, R - 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * "What do I do right now."
   *
   * Plant & Defuse was reported as simply unlearnable, and the reason is that
   * both of its actions are *holding still on a spot* — the one input nobody
   * discovers by experimenting, because standing still is what you do when you
   * have run out of ideas. So the game has to say it.
   *
   * Same rebuild-only-on-change treatment as the contract strip: this runs
   * every frame.
   */
  setActionPrompt(prompt) {
    const el = this.promptEl;
    if (!prompt) {
      if (this.promptShown !== null) {
        this.promptShown = null;
        el.classList.add('hidden');
        el.replaceChildren();
      }
      return;
    }

    if (this.promptShown !== prompt.text) {
      this.promptShown = prompt.text;
      el.classList.remove('hidden');
      el.replaceChildren();
      this.promptText = el2('span', 'prompt-text', prompt.text);
      this.promptMeter = el2('div', 'prompt-meter');
      this.promptFill = el2('i');
      this.promptMeter.append(this.promptFill);
      el.append(this.promptText, this.promptMeter);
    }

    // The meter only appears once something is actually being held, so an
    // empty bar never sits there implying the player is making progress.
    const pct = Math.max(0, Math.min(1, prompt.progress ?? 0));
    this.promptMeter.classList.toggle('hidden', pct <= 0);
    this.promptFill.style.transform = `scaleX(${pct})`;
    el.classList.toggle('urgent', !!prompt.urgent);
    el.classList.toggle('holding', pct > 0);
  }

  /**
   * Shows the invite code for the whole match.
   *
   * Creating a private room drops the host straight into the arena, so the
   * menu's copy of the code is already hidden by the time they want to read it
   * out — which made a private room effectively uninvitable.
   */
  setRoomCode(code, onCopy) {
    this.roomCode = code;
    if (!code) {
      this.roomChip.classList.add('hidden');
      this.roomChip.textContent = '';
      return;
    }
    this.roomChip.textContent = `🔑 ${code}`;
    this.roomChip.classList.remove('hidden');
    if (!this.roomChipBound) {
      this.roomChipBound = true;
      this.roomChip.addEventListener('click', () => onCopy?.(this.roomCode));
    }
  }

  // ------------------------------------------------------------ net stats

  bindNetStats() {
    this.netStatsEl.addEventListener('click', () => {
      this.netExpanded = !this.netExpanded;
    });
    // 'N', not F3: the browser claims F3 for find-next and never forwards it
    // to the page. Tapping the readout works too, since phones have no F-keys.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyN' || this.root.classList.contains('hidden')) return;
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      this.netExpanded = !this.netExpanded;
    });
  }

  /** Colour thresholds shared by ping and fps readouts. */
  static grade(value, good, fair, lowerIsBetter = true) {
    const ok = lowerIsBetter ? value <= good : value >= good;
    const mid = lowerIsBetter ? value <= fair : value >= fair;
    return ok ? 'good' : mid ? 'fair' : 'poor';
  }

  setNetStats(stats, fps) {
    const el = this.netStatsEl;
    el.replaceChildren();

    const add = (text, cls) => {
      const span = document.createElement('span');
      span.textContent = text;
      if (cls) span.className = cls;
      el.append(span);
    };

    const fpsGrade = Hud.grade(fps, 50, 30, false);

    if (!stats.online) {
      // Offline practice has no network to report, so only FPS is meaningful.
      add(`${Math.round(fps)} fps`, fpsGrade);
      add('  offline');
      return;
    }

    if (stats.ping == null) {
      add(`${Math.round(fps)} fps`, fpsGrade);
      add('  ping …');
      return;
    }

    const pingGrade = Hud.grade(stats.ping, 60, 140);
    if (!this.netExpanded) {
      add(`${stats.ping} ms`, pingGrade);
      add(`  ${Math.round(fps)} fps`, fpsGrade);
      if (stats.loss > 1) add(`  !${stats.loss}`, 'poor');
      return;
    }

    add('ping   ');
    add(`${stats.ping} ms`, pingGrade);
    add(`\njitter ${stats.jitter} ms`);
    add('\nfps    ');
    add(`${Math.round(fps)}`, fpsGrade);
    add(`\npatch  ${stats.patchRate.toFixed(0)}/s`);
    if (stats.loss > 1) add(`\ndropped ${stats.loss}`, 'poor');
  }

  // ------------------------------------------------------------- quick chat

  buildQuickChat() {
    this.quickChat.replaceChildren(...QUICK_CHAT.map((text, i) => {
      const b = el('button', 'qc-btn', text);
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.onChat({ preset: i });
      });
      return b;
    }));
  }

  bindChatInput() {
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't let WASD in the chat box drive the chicken
      if (e.key === 'Enter') {
        const text = this.chatInput.value.trim();
        if (text) this.onChat({ text });
        this.chatInput.value = '';
        this.chatInput.blur();
      } else if (e.key === 'Escape') {
        this.chatInput.value = '';
        this.chatInput.blur();
      }
    });

    // "T" to talk, the universal shooter convention.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyT' && document.activeElement !== this.chatInput
          && !this.root.classList.contains('hidden')) {
        e.preventDefault();
        this.chatInput.focus();
      }
    });
  }

  // ------------------------------------------------------------------ feeds

  addKill({ by, byColor, target, targetColor, weapon, multi }) {
    const row = el('div', 'kf-row');
    if (by) {
      const a = el('b', null, by);
      a.style.color = byColor || '#fff';
      row.append(a, el('span', 'kf-verb', weapon === 'blast' ? ' blew up ' : ' clucked '));
    } else {
      row.append(el('span', 'kf-verb', weapon === 'blast' ? '💥 ' : '☠ '));
    }
    const t = el('b', null, target ?? '???');
    t.style.color = targetColor || '#fff';
    row.append(t);
    if (multi > 1) row.append(el('span', 'kf-verb', ` ×${multi}`));
    this.pushRow(this.killfeed, row, MAX_FEED);
  }

  addFeed(f) {
    if (f.kind === 'kill') return this.addKill(f);
    if (f.kind === 'bomber') {
      const row = el('div', 'kf-row');
      if (f.by) {
        const a = el('b', null, f.by);
        a.style.color = f.byColor || '#fff';
        row.append(a, el('span', 'kf-verb', ' defused the 🐔💣'));
      } else {
        row.append(el('span', 'kf-verb', '💣 bomber down'));
      }
      return this.pushRow(this.killfeed, row, MAX_FEED);
    }
    const verb = f.kind === 'join' ? 'joined' : 'left';
    const row = el('div', 'chat-row system', `${f.name} ${verb}`);
    this.pushRow(this.chatLog, row, MAX_CHAT);
  }

  addChat({ name, color, text }) {
    const row = el('div', 'chat-row');
    const n = el('b', null, `${name}: `);
    n.style.color = color || '#fff';
    row.append(n, document.createTextNode(text));
    this.pushRow(this.chatLog, row, MAX_CHAT);
  }

  pushRow(container, row, max) {
    container.append(row);
    while (container.childElementCount > max) container.firstElementChild.remove();
  }

  announce(text) {
    this.announcer.textContent = text;
    this.announcer.classList.remove('show');
    void this.announcer.offsetWidth; // force reflow so the animation restarts
    this.announcer.classList.add('show');
  }

  announceMulti(multi) {
    const name = MULTIKILL_NAMES[Math.min(multi, MULTIKILL_NAMES.length - 1)];
    if (name) this.announce(name);
  }

  // --------------------------------------------------------- world overlay

  /**
   * @param getView resolves a player id to its rendered view (with .x/.z).
   *                Plates must follow the mesh that's actually on screen, not
   *                the server position, or they lag behind by the prediction
   *                and interpolation error.
   */
  syncNameplates(players, projectFn, selfId, getView) {
    const seen = new Set();

    for (const p of players) {
      seen.add(p.id);
      let plate = this.plates.get(p.id);
      if (!plate) {
        plate = el('div', 'nameplate');
        plate.append(
          el('div', 'np-name', p.name),
          (() => { const bar = el('div', 'np-bar'); bar.append(el('div', 'np-fill')); return bar; })(),
          el('div', 'np-tag'),
        );
        plate.querySelector('.np-name').style.color = p.color;
        this.overlay.append(plate);
        this.plates.set(p.id, plate);
      }

      if (!p.alive) { plate.style.display = 'none'; continue; }

      const view = getView?.(p.id);
      const wx = view ? view.x : p.x;
      const wz = view ? view.z : p.z;
      const pos = projectFn(wx, 2.35, wz);
      // projectFn returns null only for points behind the camera. A player off
      // the side of the screen still projects to a valid coordinate, so the
      // plate would be positioned outside the viewport and merely clipped by
      // the overlay — costing a transform every frame for something nobody can
      // see. Hide those explicitly.
      const off = !pos
        || pos.x < -MARGIN || pos.x > window.innerWidth + MARGIN
        || pos.y < -MARGIN || pos.y > window.innerHeight + MARGIN;
      if (off) { plate.style.display = 'none'; continue; }

      plate.style.display = '';
      plate.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%)`;

      const ratio = Math.max(0, Math.min(1, p.hp / PLAYER.maxHp));
      plate.querySelector('.np-fill').style.transform = `scaleX(${ratio})`;
      plate.classList.toggle('is-hurt', ratio <= 0.6 && ratio > 0.3);
      plate.classList.toggle('is-critical', ratio <= 0.3);
      plate.classList.toggle('is-self', p.id === selfId);

      const tag = p.rapid ? '⚡ RAPID' : p.invuln ? '🛡 SAFE' : '';
      const tagEl = plate.querySelector('.np-tag');
      if (tagEl.textContent !== tag) tagEl.textContent = tag;
    }

    for (const [id, plate] of this.plates) {
      if (seen.has(id)) continue;
      plate.remove();
      this.plates.delete(id);
    }
  }

  syncBomberFuse(bomber, projectFn, view) {
    if (!bomber || bomber.state !== 'arm') {
      if (this.fuseRing) { this.fuseRing.style.display = 'none'; }
      return;
    }
    if (!this.fuseRing) {
      this.fuseRing = el('div', 'fuse-ring');
      this.overlay.append(this.fuseRing);
    }
    // Same rule as nameplates: follow the interpolated mesh, not the raw state.
    const pos = projectFn(view ? view.x : bomber.x, 3.2, view ? view.z : bomber.z);
    if (!pos) { this.fuseRing.style.display = 'none'; return; }
    this.fuseRing.style.display = '';
    this.fuseRing.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -50%)`;
    this.fuseRing.style.setProperty('--pct', String((bomber.fuse / 5) * 100));
    this.fuseRing.dataset.t = Math.ceil(bomber.fuse);
  }

  popDamage(screenPos, amount, kind = 'hit') {
    if (!screenPos) return;
    const node = this.dmgPool.pop() ?? el('div', 'dmg-number');
    node.className = `dmg-number${amount >= 25 ? ' crit' : ''}`
      + (kind === 'heal' ? ' heal' : kind === 'burn' ? ' burn' : '');
    node.textContent = kind === 'heal' ? `+${amount}` : String(amount);
    node.style.left = `${screenPos.x}px`;
    node.style.top = `${screenPos.y}px`;
    this.overlay.append(node);
    setTimeout(() => {
      node.remove();
      if (this.dmgPool.length < 24) this.dmgPool.push(node);
    }, 850);
  }

  // --------------------------------------------------------------- top bar

  setClock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (this.clockEl.textContent !== text) this.clockEl.textContent = text;
    this.clockEl.classList.toggle('urgent', s <= 30);
  }

  syncScoreboard(players, selfId) {
    const sorted = [...players].sort((a, b) => b.score - a.score || b.kills - a.kills);
    const rows = sorted.map((p) => {
      const row = el('div', `sb-row${p.id === selfId ? ' is-self' : ''}${p.alive ? '' : ' is-dead'}`);
      const dot = el('div', 'sb-dot');
      dot.style.background = p.color;
      const k = el('div', 'sb-k');
      k.append(el('b', null, String(p.kills)), document.createTextNode(` / ${p.deaths}`));
      row.append(dot, el('div', 'sb-name', p.name + (p.isBot ? ' 🤖' : '')), k);
      return row;
    });
    this.scoreboard.replaceChildren(...rows);
  }

  setRespawn(seconds) {
    if (seconds > 0) {
      this.respawnOverlay.classList.remove('hidden');
      this.respawnCount.textContent = String(Math.ceil(seconds));
    } else {
      this.respawnOverlay.classList.add('hidden');
    }
  }

  /**
   * The "killed by" panel.
   *
   * Perceived fairness in a shooter is driven almost entirely by whether you
   * understand why you died — so this reports who, with what, from how far, and
   * crucially how much health they had left. "Nugget, 12 HP left" turns "this
   * game is rigged" into "I nearly had them", which is the difference between
   * closing the tab and queueing again.
   */
  setKilledBy(info) {
    const el = $('killed-by');
    if (!info) {
      el.classList.add('hidden');
      el.replaceChildren();
      return;
    }

    el.classList.remove('hidden');
    el.replaceChildren();

    const who = el2('span', 'kb-name', info.name ?? 'The arena');
    if (info.color) who.style.color = info.color;

    const how = KILL_KINDS[info.kind] ?? 'got you';
    el.append(el2('span', 'kb-lead', 'Killed by'), who, el2('span', 'kb-how', how));

    if (typeof info.hp === 'number') {
      // The near-miss detail. Below a third of their health it is worth
      // shouting about, because that is the one that stings in a good way.
      const hp = el2('span', `kb-hp${info.hp <= 33 ? ' close' : ''}`, `${info.hp} HP left`);
      el.append(hp);
    }
    if (typeof info.dist === 'number') el.append(el2('span', 'kb-dist', `${info.dist}m`));
    if (info.name) el.append(el2('span', 'kb-revenge', '⚔ MARKED FOR REVENGE'));
  }
}

// How each damage source reads in the killed-by panel.
const KILL_KINDS = {
  bullet: 'shot you',
  shot: 'shot you',
  blast: 'blew you up',
  bomb: 'blew you up',
  burn: 'set you alight',
  potato: 'passed you the potato',
  zone: 'left you outside the zone',
};

/** Normalises an angle to (-PI, PI], so its sign says "left" or "right". */
function angleTo(a) {
  let d = (a ?? 0) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
