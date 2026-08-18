import {
  QUICK_CHAT, PLAYER, MODES, MULTIKILL_NAMES, MODIFIERS, TEAM_NAMES, HILL,
  LEVELS, rungOf, xpForLevel,
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
   * Shows or hides the reticle. That is the whole job now.
   *
   * It used to be projected into screen space every frame, because the shot
   * ignored pitch and left along the yaw at chest height — a reticle at screen
   * centre would have been pointing somewhere the bullet was never going. Aim
   * is genuinely 3D now and fire() builds the bullet from the same yaw and
   * pitch the camera looks down, so screen centre is the aim point by
   * construction and the CSS can simply park it there.
   *
   * Hidden while dead, where there is nothing to aim.
   */
  setCrosshair(visible, state = '') {
    const el = $('crosshair');
    el.style.opacity = visible ? '1' : '0';
    // 'dry' = nothing to fire, 'busy' = refilling. Both are answers to the one
    // question a player asks in the instant before pulling the trigger, put
    // where they are already looking.
    el.classList.toggle('dry', visible && state === 'dry');
    el.classList.toggle('busy', visible && state === 'busy');
  }

  /**
   * Your own health and grain.
   *
   * Health was simply not shown at all, which meant the only way to learn you
   * were nearly dead was to die. The hurt flash told you that something had
   * happened, never how much was left — and "how much is left" is the input to
   * every decision worth making: push, hide, or go and eat.
   *
   * Both meters are rebuilt only when the value changes. This runs every frame,
   * and a HUD that rewrites its own DOM sixty times a second costs frames on
   * exactly the phones that can least afford them.
   */
  setVitals(self, capacity) {
    const box = $('vitals');
    if (!self || !self.alive) {
      box.classList.add('hidden');
      this.shownHp = null;
      this.shownCrop = null;
      return;
    }
    box.classList.remove('hidden');

    // --- the rung.
    const level = self.level ?? 1;
    const rung = rungOf(level);
    if (level !== this.shownLevel) {
      const badge = $('rung-badge');
      badge.textContent = String(level);
      badge.style.background = rung.color;
      $('rung-name').textContent = rung.name.toUpperCase();
      // Animate only on a real change, and only after the first paint — a badge
      // that pops when you join reads as a level-up that did not happen.
      if (this.shownLevel != null) {
        const climbed = level > this.shownLevel;
        badge.classList.remove('climbed', 'fell');
        void badge.offsetWidth; // restart the animation
        badge.classList.add(climbed ? 'climbed' : 'fell');
      }
      this.shownLevel = level;
    }

    {
      const track = $('xp-track') ?? $('xp-fill').parentElement;
      const at = level >= LEVELS.max;
      track.classList.toggle('maxed', at);
      if (!at) {
        const from = xpForLevel(level);
        const to = self.nextXp || xpForLevel(level + 1);
        const frac = Math.max(0, Math.min(1, ((self.xp ?? 0) - from) / Math.max(1, to - from)));
        $('xp-fill').style.width = `${frac * 100}%`;
      }
    }

    const hp = Math.max(0, Math.round(self.hp));
    if (hp !== this.shownHp) {
      this.shownHp = hp;
      const fill = $('hp-fill');
      const frac = hp / PLAYER.maxHp;
      fill.style.width = `${frac * 100}%`;
      fill.classList.toggle('warn', frac <= 0.55 && frac > 0.28);
      fill.classList.toggle('hurt', frac <= 0.28);
      $('hp-num').textContent = String(hp);
    }

    const crop = Math.max(0, Math.min(capacity, Math.round(self.crop ?? 0)));
    if (crop !== this.shownCrop || capacity !== this.shownCap) {
      this.shownCrop = crop;
      this.shownCap = capacity;
      const row = $('crop');
      // Rebuild only when the pip COUNT changes, which is once per shot at
      // most. TRIGGER HAPPY moves the capacity, hence the second condition.
      if (row.childElementCount !== capacity) {
        row.replaceChildren(...Array.from({ length: capacity }, () => el('div', 'crop-pip')));
      }
      const pips = row.children;
      for (let i = 0; i < pips.length; i++) {
        pips[i].classList.toggle('spent', i >= crop);
      }
      row.classList.toggle('low', crop > 0 && crop <= Math.max(2, Math.ceil(capacity * 0.25)));
      row.classList.toggle('empty', crop === 0);
    }

    // One line, and only when it earns its place.
    const hint = $('crop-hint');
    const state = self.dry ? 'empty'
      : (self.feeding ? 'feeding' : (self.pecking ? 'pecking' : ''));
    if (state !== this.shownCropState) {
      this.shownCropState = state;
      // The empty line is an instruction, not a status. It is the one moment a
      // player does not know what to do, and "EMPTY" alone would not tell them.
      hint.textContent = state === 'feeding' ? 'FEEDING'
        : state === 'pecking' ? 'PECKING'
          : state === 'empty' ? 'EMPTY — HOLD STILL TO PECK' : '';
      hint.classList.toggle('show', state !== '');
      hint.classList.toggle('pecking', state === 'pecking');
      hint.classList.toggle('feeding', state === 'feeding');
      hint.classList.toggle('empty', state === 'empty');
    }
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

  /**
   * The level-up payoff.
   *
   * Three lines, because the rank alone is a number and the number alone
   * teaches nothing: the perk needs a NAME so the player can think about it,
   * and a line saying what it does so they can use it deliberately. An unlock
   * nobody can name is one nobody ever plays around.
   *
   * Peak-end says this half-second is most of what the whole climb is
   * remembered as, so it is the loudest thing on screen while it runs.
   */
  announceRung(ev) {
    const box = $('rung-up');
    // No em dash in here. The display face has no glyph for one at weight 900
    // and renders a tofu box instead — which is only visible at this size, in
    // this one element, and looks like a broken build. The blurb below is
    // lighter and takes them fine.
    $('rung-up-rank').textContent = ev.level > ev.from
      ? `LEVEL ${ev.level}  ${String(ev.name).toUpperCase()}`
      : `DEMOTED  ${String(ev.name).toUpperCase()}`;
    $('rung-up-rank').style.color = ev.color;
    $('rung-up-perk').textContent = ev.perk ?? '';
    $('rung-up-blurb').textContent = ev.blurb ?? '';
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
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
      // Never plate yourself. In first person the projection lands on top of
      // the camera and the result is nonsense; in third person it works
      // perfectly and hangs your own name over the middle of your own screen,
      // which is worse. You know who you are.
      if (p.id === selfId) continue;
      seen.add(p.id);
      let plate = this.plates.get(p.id);
      if (!plate) {
        plate = el('div', 'nameplate');
        plate.append(
          (() => {
            // The rung, in front of the name. This one line is what makes the
            // ladder a social object instead of a private stat: you can see who
            // the threat in the room is, and they can see you seeing it.
            const row = el('div', 'np-name');
            row.append(el('span', 'np-lvl'), document.createTextNode(p.name));
            return row;
          })(),
          (() => { const bar = el('div', 'np-bar'); bar.append(el('div', 'np-fill')); return bar; })(),
          el('div', 'np-tag'),
        );
        plate.querySelector('.np-name').lastChild.textContent = p.name;
        plate.querySelector('.np-name').style.color = p.color;
        this.overlay.append(plate);
        this.plates.set(p.id, plate);
      }

      if (!p.alive) { plate.style.display = 'none'; continue; }

      const view = getView?.(p.id);
      const wx = view ? view.x : p.x;
      const wz = view ? view.z : p.z;
      // Rides up with a jumping chicken, or the plate stays pinned at head
      // height over an empty patch of floor while its owner is in the air.
      const wy = view ? (view.y ?? 0) : (p.y ?? 0);
      const pos = projectFn(wx, wy + 2.35, wz);
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
      // Rebuilt only on change: this runs per plate per frame.
      const lvlEl = plate.querySelector('.np-lvl');
      const lvl = p.level ?? 1;
      if (lvlEl && lvlEl.dataset.lvl !== String(lvl)) {
        lvlEl.dataset.lvl = String(lvl);
        lvlEl.textContent = String(lvl);
        lvlEl.style.background = rungOf(lvl).color;
      }

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
    // A headshot gets its own class rather than inheriting `crit` from the
    // damage threshold. They happen to overlap today, and the moment somebody
    // tunes headDamage down they would stop — and the loudest number in the
    // game would quietly go back to looking like every other one.
    node.className = `dmg-number${amount >= 25 ? ' crit' : ''}`
      + (kind === 'head' ? ' head' : kind === 'heal' ? ' heal' : kind === 'burn' ? ' burn' : '');
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
