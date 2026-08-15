import { QUICK_CHAT, PLAYER, MODES, MULTIKILL_NAMES } from '@cluckdown/shared';

const $ = (id) => document.getElementById(id);
const MAX_FEED = 5;
const MAX_CHAT = 6;

// Everything user-supplied goes through textContent, never innerHTML — a name
// or chat line is attacker-controlled input and this is the only place it
// touches the DOM.
function el(tag, cls, text) {
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
  }

  setMode(mode) {
    this.modePill.textContent = MODES[mode]?.label ?? mode;
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
      if (!pos) { plate.style.display = 'none'; continue; }

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
    node.className = `dmg-number${amount >= 25 ? ' crit' : ''}${kind === 'heal' ? ' heal' : ''}`;
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
}
