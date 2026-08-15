import { Room } from 'colyseus';
import {
  createWorld, addPlayer, removePlayer, applyInput, stepWorld,
  stepBots, initBot, botName,
  MODES, TICK_HZ, TICK_DT, PATCH_MS, MAX_CATCHUP, QUICK_CHAT, PLAYER,
} from '@cluckdown/shared';
import { ArenaState, PlayerState, PickupState } from './state.js';
import { ratingDeltas } from '../rating.js';
import { roomOpened, roomClosed, roomPopulation } from '../stats.js';

const BOT_FILL_DELAY = 8; // seconds to wait for humans before padding with bots
const POST_MATCH_SECONDS = 12;

export class ArenaRoom extends Room {
  onCreate(options) {
    const mode = MODES[options?.mode] ? options.mode : 'casual';
    this.cfg = MODES[mode];
    this.maxClients = this.cfg.maxPlayers;
    this.autoDispose = true;

    this.world = createWorld({ mode });
    this.seats = new Array(this.cfg.maxPlayers).fill(null);
    this.botFillAt = BOT_FILL_DELAY;
    this.postMatch = 0;
    this.fxQueue = [];
    this.fxFlushAt = 0;
    this.acc = 0;
    this.disconnecting = false;
    this.ratingsById = new Map();

    const state = new ArenaState();
    state.mode = mode;
    state.phase = this.world.phase;
    state.clock = this.world.clock;
    state.arenaSize = this.cfg.arena;
    state.killLimit = this.cfg.killLimit;
    this.setState(state);

    this.setMetadata({ mode, label: this.cfg.label });

    this.onMessage('input', (client, msg) => {
      if (this.world.phase === 'over') return;
      applyInput(this.world, client.sessionId, msg ?? {});
    });

    this.onMessage('chat', (client, msg) => this.handleChat(client, msg));

    // Round-trip probe. Echoing the client's own timestamp back means the
    // server needs no clock agreement and the client can measure RTT exactly.
    this.onMessage('ping', (client, sentAt) => client.send('pong', sentAt));

    roomOpened(this.roomId, mode);

    // Simulate fast, broadcast slower. Clients interpolate between patches, so
    // pushing state at the full simulation rate would cost them decode work for
    // motion they already smooth out themselves.
    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), 1000 / TICK_HZ);
    this.setPatchRate(PATCH_MS);
  }

  // -------------------------------------------------------------- lifecycle

  onJoin(client, options) {
    const seat = this.takeSeat(client.sessionId);

    const name = sanitizeName(options?.name);
    const p = addPlayer(this.world, { id: client.sessionId, name, seat: seat >= 0 ? seat : 0 });
    this.ratingsById.set(client.sessionId, clampRating(options?.rating));

    const ps = new PlayerState();
    this.syncPlayer(ps, p);
    this.state.players.set(client.sessionId, ps);

    this.broadcast('feed', { kind: 'join', name: p.name, color: p.color });

    if (this.clients.length >= this.cfg.maxPlayers) this.lock();
    this.reportPopulation();
  }

  async onLeave(client, consented) {
    const p = this.world.players.get(client.sessionId);
    if (p) this.broadcast('feed', { kind: 'leave', name: p.name, color: p.color });

    if (consented) return this.dropPlayer(client.sessionId);

    // Network blip? Keep both their chicken and their seat reserved for a bit,
    // so no bot can take the slot out from under them before they reconnect.
    try {
      await this.allowReconnection(client, 20);
    } catch {
      this.dropPlayer(client.sessionId);
    }
  }

  dropPlayer(sessionId) {
    removePlayer(this.world, sessionId);
    this.state.players.delete(sessionId);
    this.ratingsById.delete(sessionId);
    this.releaseSeat(sessionId);
    if (this.world.phase !== 'over') this.unlock();
    this.reportPopulation();
  }

  reportPopulation() {
    let humans = 0;
    let bots = 0;
    for (const p of this.world.players.values()) {
      if (p.isBot) bots++; else humans++;
    }
    roomPopulation(this.roomId, humans, bots);
  }

  onDispose() {
    roomClosed(this.roomId);
  }

  // ---------------------------------------------------------------- seating

  /**
   * Claims a seat for an arriving human.
   *
   * A seat decides spawn corner and colour, so two players must never share
   * one. If bots hold every seat, one of them makes way — a human always
   * outranks a bot. Returns -1 only if the room is genuinely full of humans,
   * which maxClients should already have prevented.
   */
  takeSeat(id) {
    let seat = this.seats.indexOf(null);
    if (seat < 0) seat = this.evictBotSeat();
    if (seat < 0) return -1;
    this.seats[seat] = id;
    return seat;
  }

  /** Removes the first bot found and hands back the seat index it freed. */
  evictBotSeat() {
    for (let i = 0; i < this.seats.length; i++) {
      const occupant = this.seats[i];
      const p = occupant ? this.world.players.get(occupant) : null;
      if (!p?.isBot) continue;
      this.dropPlayer(occupant); // also clears this.seats[i]
      return i;
    }
    return -1;
  }

  releaseSeat(id) {
    const seat = this.seats.indexOf(id);
    if (seat >= 0) this.seats[seat] = null;
  }

  // ------------------------------------------------------------------- bots

  humanCount() {
    return [...this.world.players.values()].filter((p) => !p.isBot).length;
  }

  /**
   * Tops the lobby up to maxPlayers with bots.
   *
   * The rule is "always a full arena, humans preferred": bots only ever occupy
   * seats no human has claimed, and an arriving human evicts one (see
   * takeSeat). So a solo casual match is you + 3 bots; when a friend joins it
   * becomes 2 humans + 2 bots, not 2 humans alone in a 40x40 arena.
   *
   * Only casual and deathmatch do this — MODES.fillWithBots is the switch, and
   * ranked/1v1 leave it off so ratings are only ever staked against people.
   */
  fillWithBots() {
    if (!this.cfg.fillWithBots) return;
    let guard = 0;
    while (this.world.players.size < this.cfg.maxPlayers && guard++ < 8) {
      const seat = this.seats.indexOf(null);
      if (seat < 0) break;
      const id = `bot_${seat}_${Math.random().toString(36).slice(2, 7)}`;
      this.seats[seat] = id;
      const p = addPlayer(this.world, { id, name: botName(), seat, isBot: true });
      initBot(p, this.cfg.ranked ? 'hard' : 'normal');
      const ps = new PlayerState();
      this.syncPlayer(ps, p);
      this.state.players.set(id, ps);
    }
    this.reportPopulation();
  }

  // ------------------------------------------------------------------- chat

  handleChat(client, msg) {
    const p = this.world.players.get(client.sessionId);
    if (!p) return;

    const now = Date.now();
    p._chatAt ??= 0;
    if (now - p._chatAt < 900) return; // rate limit
    p._chatAt = now;

    let text;
    if (typeof msg?.preset === 'number') {
      text = QUICK_CHAT[msg.preset];
    } else if (typeof msg?.text === 'string') {
      text = msg.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    if (!text) return;

    this.broadcast('chat', { name: p.name, color: p.color, text });
  }

  // ------------------------------------------------------------------- tick

  /**
   * Simulation driver.
   *
   * A timer is not a clock. Colyseus fires this on a setInterval, but Windows
   * timer granularity is ~15.6ms, so a 16.67ms interval really lands at ~26ms.
   * Advancing the world by a fixed 1/60s per callback therefore ran the match
   * at roughly 60% of real speed — bots arriving late, match clock drifting.
   * (At 20Hz the interval was long enough that this never showed.)
   *
   * So: accumulate the real elapsed time and spend it in fixed-size steps. The
   * simulation stays deterministic and identical to the client's, while the
   * match still runs on wall-clock time whatever the timer does.
   */
  tick(deltaMs) {
    const elapsed = Math.min((Number(deltaMs) || 1000 / TICK_HZ) / 1000, MAX_CATCHUP);
    this.acc += elapsed;

    const maxSteps = Math.ceil(MAX_CATCHUP / TICK_DT);
    let steps = 0;
    while (this.acc >= TICK_DT && steps++ < maxSteps) {
      this.acc -= TICK_DT;
      this.stepOnce(TICK_DT);
    }

    // Written once per callback rather than once per simulation step: Colyseus
    // only ships state at the patch rate, so writing it more often is wasted
    // dirty-tracking.
    this.syncState();

    this.fxFlushAt -= elapsed;
    if (this.fxFlushAt <= 0) {
      this.fxFlushAt = PATCH_MS / 1000;
      if (this.fxQueue.length) {
        this.broadcast('fx', this.fxQueue);
        this.fxQueue = [];
      }
    }
  }

  /** One fixed-size simulation step. */
  stepOnce(dt) {
    if (this.world.phase === 'over') {
      this.postMatch -= dt;
      if (this.postMatch <= 0 && !this.disconnecting) {
        this.disconnecting = true; // several steps can run per callback
        this.disconnect();
      }
      return;
    }

    if (this.cfg.fillWithBots && this.world.players.size < this.cfg.maxPlayers) {
      this.botFillAt -= dt;
      if (this.botFillAt <= 0) this.fillWithBots();
    }

    // Not enough chickens yet — hold in warmup rather than starting a 1-player match.
    if (this.world.phase === 'warmup' && this.world.players.size < this.cfg.minPlayers) {
      this.world.time = 0;
      return;
    }

    stepBots(this.world, dt);
    const events = stepWorld(this.world, dt);
    if (events.length) this.broadcastEvents(events);
  }

  broadcastEvents(events) {
    const fx = [];
    for (const e of events) {
      switch (e.type) {
        case 'kill':
          this.broadcast('feed', {
            kind: 'kill',
            by: e.by ? this.world.players.get(e.by)?.name : null,
            byColor: e.by ? this.world.players.get(e.by)?.color : null,
            target: this.world.players.get(e.target)?.name,
            targetColor: e.color,
            weapon: e.kind,
            multi: e.multi,
          });
          fx.push(e);
          break;
        case 'matchEnd':
          this.finishMatch(e);
          break;
        case 'bomberDown':
          this.broadcast('feed', {
            kind: 'bomber',
            by: e.by ? this.world.players.get(e.by)?.name : null,
            byColor: e.by ? this.world.players.get(e.by)?.color : null,
          });
          fx.push(e);
          break;
        default:
          fx.push(e);
      }
    }
    // Queued here; tick() flushes on the broadcast cadence.
    if (fx.length) this.fxQueue.push(...fx);
  }

  finishMatch(ev) {
    const humans = [...this.world.players.values()].filter((p) => !p.isBot);
    const ranking = [...this.world.players.values()]
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .map((p, i) => ({
        place: i + 1,
        id: p.id,
        name: p.name,
        color: p.color,
        seat: p.seat,
        kills: p.kills,
        deaths: p.deaths,
        score: p.score,
        damage: Math.round(p.damageDealt),
        bot: p.isBot,
      }));

    let deltas = {};
    if (this.cfg.ranked) {
      deltas = ratingDeltas(
        ranking.filter((r) => !r.bot),
        (id) => this.ratingsById.get(id) ?? 1000,
      );
    }

    this.postMatch = POST_MATCH_SECONDS;
    this.lock();
    this.broadcast('matchEnd', {
      reason: ev.reason,
      winner: ev.winner,
      ranking,
      ranked: this.cfg.ranked,
      deltas,
      humans: humans.length,
      returnIn: POST_MATCH_SECONDS,
    });
  }

  // ------------------------------------------------------------ state sync

  syncPlayer(ps, p) {
    ps.name = p.name;
    ps.seat = p.seat;
    ps.x = p.x;
    ps.z = p.z;
    ps.aim = p.aim;
    ps.hp = Math.max(0, Math.round(p.hp));
    ps.alive = p.alive;
    ps.invuln = p.invulnUntil > this.world.time;
    ps.rapid = p.rapidUntil > this.world.time;
    ps.kills = p.kills;
    ps.deaths = p.deaths;
    ps.score = p.score;
    ps.respawnIn = p.alive ? 0 : Math.max(0, p.respawnAt - this.world.time);
    ps.ack = p.lastSeq >>> 0;
    ps.bot = !!p.isBot;
  }

  syncState() {
    const s = this.state;
    s.phase = this.world.phase;
    s.clock = this.world.clock;

    for (const [id, p] of this.world.players) {
      let ps = s.players.get(id);
      if (!ps) {
        ps = new PlayerState();
        s.players.set(id, ps);
      }
      this.syncPlayer(ps, p);
    }
    for (const id of [...s.players.keys()]) {
      if (!this.world.players.has(id)) s.players.delete(id);
    }

    const live = new Set();
    for (const pk of this.world.pickups) {
      const key = String(pk.id);
      live.add(key);
      if (s.pickups.has(key)) continue;
      const ps = new PickupState();
      ps.x = pk.x;
      ps.z = pk.z;
      ps.kind = pk.type;
      s.pickups.set(key, ps);
    }
    for (const key of [...s.pickups.keys()]) {
      if (!live.has(key)) s.pickups.delete(key);
    }

    const b = this.world.bomber;
    s.bomber.active = !!(b && b.alive);
    if (b && b.alive) {
      s.bomber.x = b.x;
      s.bomber.z = b.z;
      s.bomber.aim = b.aim;
      s.bomber.hp = Math.max(0, Math.round(b.hp));
      s.bomber.phase = b.state;
      s.bomber.fuse = Math.max(0, b.fuse);
    }
  }
}

function sanitizeName(raw) {
  const name = String(raw ?? '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 14);
  return name || 'Chicken';
}

function clampRating(r) {
  const n = Number(r);
  return Number.isFinite(n) ? Math.min(4000, Math.max(0, Math.round(n))) : 1000;
}
