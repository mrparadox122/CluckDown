// Two ways to play, one interface.
//
// OnlineSession talks to Colyseus. LocalSession runs the shared sim right here
// in the tab against bots. The renderer consumes `players` / `pickups` /
// `bomber` / `onFx` and genuinely cannot tell which one it's driving, so
// offline practice mode costs almost nothing and doubles as a way to develop
// the game feel without a server running.

import { Client } from 'colyseus.js';
import {
  createWorld, addPlayer, applyInput, stepWorld,
  stepBots, initBot, botName,
  MODES, SEAT_COLORS, TEAM_COLORS, TICK_DT, MAX_CATCHUP, QUICK_CHAT, cleanRoomCode,
  hillProgress, castVote, voteTally, beginMatch, MAP_VOTE, MAPS, contractInfo, BOMB,
} from '@cluckdown/shared';

const DEFAULT_ENDPOINT = import.meta.env.VITE_SERVER_URL
  || (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'ws://localhost:2567'
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:2567`);

const PING_INTERVAL_MS = 1000;
const PING_WINDOW = 12; // samples kept for average / jitter

class BaseSession {
  constructor() {
    this.handlers = {
      fx: [], feed: [], chat: [], matchEnd: [], error: [], joinedInProgress: [],
    };
  }

  /**
   * Network readout for the HUD. Both session types answer this, so the HUD
   * never has to know whether it's online — offline simply reports online:false
   * and the network rows are hidden.
   */
  netStats() {
    return { online: false, ping: null, jitter: null, patchRate: 0, loss: 0 };
  }

  on(event, cb) {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  emit(event, payload) {
    for (const cb of this.handlers[event] ?? []) {
      try { cb(payload); } catch (err) { console.error(`[${event}]`, err); }
    }
  }
}

// ------------------------------------------------------------------ online

export class OnlineSession extends BaseSession {
  constructor(room) {
    super();
    this.room = room;
    this.offline = false;
    this.selfId = room.sessionId;
    this.mode = room.state.mode || 'casual';
    // Latched when the match actually starts — the arena resizes when the map
    // vote resolves, and the renderer builds its geometry from this.
    this.modifier = room.state.modifier || 'none';

    room.onMessage('fx', (evs) => this.emit('fx', evs));
    room.onMessage('feed', (f) => this.emit('feed', f));
    room.onMessage('chat', (m) => this.emit('chat', m));
    room.onMessage('matchEnd', (m) => this.emit('matchEnd', m));
    // Dropped into a match already running — the client shows a heads-up so
    // the clock reading 0:47 is not a mystery.
    room.onMessage('joinedInProgress', (m) => this.emit('joinedInProgress', m));
    room.onError((code, message) => this.emit('error', { code, message }));

    // Round-trip timing. The server echoes our own timestamp back, so this is a
    // true RTT with no clock-sync assumptions.
    this.pings = [];
    this.pendingPings = 0;
    this.patchCount = 0;
    this.patchWindowAt = Date.now();
    this.patchRate = 0;

    room.onStateChange(() => {
      this.patchCount++;
      const now = Date.now();
      const dt = now - this.patchWindowAt;
      if (dt >= 1000) {
        this.patchRate = (this.patchCount * 1000) / dt;
        this.patchCount = 0;
        this.patchWindowAt = now;
      }
    });

    room.onMessage('pong', (sentAt) => {
      this.pendingPings = 0;
      const rtt = Date.now() - sentAt;
      this.pings.push(rtt);
      if (this.pings.length > PING_WINDOW) this.pings.shift();
    });

    this.pingTimer = setInterval(() => {
      // Unanswered probes stack up when the link drops — that's our loss signal.
      this.pendingPings = Math.min(this.pendingPings + 1, 99);
      try { room.send('ping', Date.now()); } catch { /* socket gone */ }
    }, PING_INTERVAL_MS);
    room.onLeave((code) => {
      // 1000 is a clean close; anything else dropped us unexpectedly.
      if (code !== 1000 && !this.left) this.emit('error', { code, message: 'Disconnected' });
    });
  }

  get arenaSize() { return this.room.state?.arenaSize || MODES[this.mode]?.arena || 40; }
  get phase() { return this.room.state?.phase ?? 'lobby'; }
  get clock() { return this.room.state?.clock ?? 0; }
  get safeHalf() { return this.room.state?.safeHalf ?? this.arenaSize / 2; }
  get map() { return this.room.state?.map ?? 'coop'; }
  get lobbyTime() { return this.room.state?.lobbyTime ?? 0; }

  get mapChoices() {
    const out = [];
    this.room.state?.mapChoices?.forEach((c) => out.push({ id: c.id, votes: c.votes }));
    return out;
  }

  get bounty() { return this.room.state?.bounty || null; }

  get potato() {
    const st = this.room.state;
    if (!st?.potatoActive) return null;
    return { x: st.potatoX, z: st.potatoZ, fuse: st.potatoFuse, holder: st.potatoHolder || null };
  }

  sendVote(mapId) { this.room.send('vote', mapId); }
  get teamScores() {
    const st = this.room.state;
    return MODES[this.mode]?.teams ? [st?.teamBlue ?? 0, st?.teamRed ?? 0] : null;
  }
  get hill() {
    if (!MODES[this.mode]?.hill) return null;
    const st = this.room.state;
    return {
      holder: st?.hillHolder || null,
      contested: !!st?.hillContested,
      x: st?.hillX ?? 0,
      z: st?.hillZ ?? 0,
      moveAt: st?.hillMoveAt ?? 0,
    };
  }

  get nests() {
    const out = [];
    this.room.state?.nests?.forEach((n) => out.push({ seat: n.seat, x: n.x, z: n.z, eggs: n.eggs }));
    return out;
  }

  get looseEggs() {
    const out = [];
    this.room.state?.eggs?.forEach((e, id) => {
      out.push({ id, x: e.x, z: e.z, seat: e.seat, returnAt: e.returnAt });
    });
    return out;
  }

  get bomb() {
    const st = this.room.state;
    if (!st?.bombState) return null;
    return {
      state: st.bombState,
      x: st.bombX,
      z: st.bombZ,
      carriedBy: st.bombCarrier || null,
      plantSeat: st.bombSeat,
      fuse: st.bombFuse,
      plant: st.bombPlant,
      defuse: st.bombDefuse,
    };
  }

  get players() {
    const out = [];
    if (!this.room.state?.players) return out;
    this.room.state.players.forEach((p, id) => {
      out.push({
        id,
        name: p.name,
        seat: p.seat,
        team: p.team >= 0 ? p.team : null,
        hillPct: (p.hillPct ?? 0) / 100,
        color: p.team >= 0 ? TEAM_COLORS[p.team] : SEAT_COLORS[p.seat % SEAT_COLORS.length],
        x: p.x, z: p.z, aim: p.aim,
        hp: p.hp, alive: p.alive,
        invuln: p.invuln, rapid: p.rapid,
        ammo: p.ammo || 'none', burning: !!p.burning,
        kills: p.kills, deaths: p.deaths, score: p.score,
        respawnIn: p.respawnIn,
        kx: p.kx ?? 0,
        kz: p.kz ?? 0,
        nemesis: p.nemesis || null,
        carrying: p.carrying ?? 0,
        contract: p.contract
          ? {
            id: p.contract,
            label: p.contractLabel,
            progress: p.contractDone,
            target: p.contractGoal,
            secondsLeft: p.contractAt,
          }
          : null,
        isBot: p.bot,
        isSelf: id === this.selfId,
      });
    });
    return out;
  }

  get pickups() {
    const out = [];
    if (!this.room.state?.pickups) return out;
    this.room.state.pickups.forEach((p, id) => out.push({ id, x: p.x, z: p.z, type: p.kind }));
    return out;
  }

  get bomber() {
    const b = this.room.state?.bomber;
    if (!b || !b.active) return null;
    return { x: b.x, z: b.z, aim: b.aim, hp: b.hp, state: b.phase, fuse: b.fuse };
  }

  sendInput(input) { this.room.send('input', input); }
  sendChat(msg) { this.room.send('chat', msg); }

  update() { /* server drives the sim */ }

  netStats() {
    const n = this.pings.length;
    if (!n) {
      return { online: true, ping: null, jitter: null, patchRate: this.patchRate, loss: this.pendingPings };
    }
    const avg = this.pings.reduce((a, b) => a + b, 0) / n;
    // Mean absolute deviation: cheaper than stddev and reads the same to a
    // player — how much the ping is bouncing around.
    const jitter = this.pings.reduce((a, b) => a + Math.abs(b - avg), 0) / n;
    return {
      online: true,
      ping: Math.round(avg),
      jitter: Math.round(jitter),
      patchRate: this.patchRate,
      loss: this.pendingPings,
    };
  }

  leave() {
    this.left = true;
    clearInterval(this.pingTimer);
    try { this.room.leave(); } catch { /* already gone */ }
  }
}

// ----------------------------------------------------------------- offline

export class LocalSession extends BaseSession {
  constructor({ mode = 'casual', name = 'You' } = {}) {
    super();
    this.offline = true;
    this.selfId = 'you';
    this.mode = mode;
    const cfg = MODES[mode] ?? MODES.casual;

    // Dev escape hatch: window.__forceMod pins the modifier so a specific twist
    // can be tested or demoed without rerolling until it turns up.
    const forced = import.meta.env.DEV ? window.__forceMod : undefined;
    this.world = createWorld({ mode, modifier: forced });
    this.modifier = this.world.modifier;
    addPlayer(this.world, { id: this.selfId, name, seat: 0 });

    for (let seat = 1; seat < cfg.maxPlayers; seat++) {
      const p = addPlayer(this.world, { id: `bot${seat}`, name: botName(), seat, isBot: true });
      initBot(p, cfg.ranked ? 'hard' : 'normal');
    }

    this.acc = 0;
    this.ended = false;
    this.botVoteAt = 1.2; // bots don't all vote the instant the lobby opens
  }

  get map() { return this.world.map; }
  get lobbyTime() { return this.world.lobbyTime; }
  get bounty() { return this.world.bounty; }
  get potato() { return this.world.potato; }

  get mapChoices() {
    const counts = voteTally(this.world);
    return this.world.mapCandidates.map((id) => ({ id, votes: counts[id] ?? 0 }));
  }

  sendVote(mapId) {
    castVote(this.world, this.selfId, mapId);
  }

  get phase() { return this.world.phase; }
  get clock() { return this.world.clock; }
  get arenaSize() { return this.world.arena.size; }
  get safeHalf() { return this.world.safeHalf; }
  get teamScores() { return this.world.teamScores ? [...this.world.teamScores] : null; }
  get hill() {
    const h = this.world.hill;
    return h
      ? { holder: h.holder, contested: h.contested, x: h.x, z: h.z, moveAt: h.moveAt }
      : null;
  }

  get nests() {
    return this.world.nests ? this.world.nests.map((n) => ({ ...n })) : [];
  }

  get looseEggs() {
    return (this.world.looseEggs ?? []).map((e) => ({
      id: String(e.id), x: e.x, z: e.z, seat: e.fromSeat, returnAt: e.returnAt,
    }));
  }

  get bomb() {
    const b = this.world.bomb;
    if (!b) return null;
    return {
      state: b.state,
      x: b.x,
      z: b.z,
      carriedBy: b.carriedBy,
      plantSeat: b.state === 'planted' ? b.plantSeat : -1,
      fuse: b.fuse,
      plant: Math.min(1, b.plant / BOMB.plantTime),
      defuse: Math.min(1, b.defuse / BOMB.defuseTime),
    };
  }

  get players() {
    return [...this.world.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      team: p.team,
      hillPct: hillProgress(this.world, p.seat),
      color: p.color,
      x: p.x, z: p.z, aim: p.aim,
      hp: p.hp, alive: p.alive,
      invuln: p.invulnUntil > this.world.time,
      rapid: p.rapidUntil > this.world.time,
      ammo: p.ammoUntil > this.world.time ? p.ammo : 'none',
      burning: p.burnUntil > this.world.time,
      kills: p.kills, deaths: p.deaths, score: p.score,
      respawnIn: p.alive ? 0 : Math.max(0, p.respawnAt - this.world.time),
      kx: p.kx,
      kz: p.kz,
      nemesis: this.world.time < p.nemesisUntil ? p.nemesis : null,
      carrying: p.carrying,
      contract: contractInfo(p),
      isBot: p.isBot,
      isSelf: p.id === this.selfId,
    }));
  }

  get pickups() {
    return this.world.pickups.map((p) => ({ id: String(p.id), x: p.x, z: p.z, type: p.type }));
  }

  get bomber() {
    const b = this.world.bomber;
    return b && b.alive ? { x: b.x, z: b.z, aim: b.aim, hp: b.hp, state: b.state, fuse: b.fuse } : null;
  }

  sendInput(input) { applyInput(this.world, this.selfId, input); }

  sendChat(msg) {
    const text = typeof msg?.preset === 'number' ? QUICK_CHAT[msg.preset] : String(msg?.text ?? '').slice(0, 80);
    if (!text) return;
    const me = this.world.players.get(this.selfId);
    this.emit('chat', { name: me?.name ?? 'You', color: me?.color, text });
  }

  /**
   * Drives the offline lobby: bots vote after a beat, and the lobby closes on
   * the same rules the server uses. Practice mode is where this gets tried
   * first, so it should behave the same.
   */
  stepLobby(dt) {
    const w = this.world;
    this.botVoteAt -= dt;
    if (this.botVoteAt <= 0) {
      for (const p of w.players.values()) {
        if (p.isBot && !w.votes.has(p.id)) {
          castVote(w, p.id, w.mapCandidates[Math.floor(Math.random() * w.mapCandidates.length)]);
        }
      }
    }

    const humans = [...w.players.values()].filter((p) => !p.isBot);
    const allVoted = humans.length > 0 && humans.every((p) => w.votes.has(p.id));
    if (w.lobbyTime >= MAP_VOTE.seconds || (w.lobbyTime >= MAP_VOTE.minSeconds && allVoted)) {
      const map = beginMatch(w);
      this.arenaSizeAtStart = w.arena.size;
      this.emit('mapChosen', { map, votes: voteTally(w) });
    }
  }

  /** Steps the sim on a fixed accumulator so it matches the server exactly. */
  update(dt) {
    if (this.ended) return;
    this.acc += Math.min(dt, MAX_CATCHUP); // a backgrounded tab must not fast-forward the match
    // Budget in seconds, not steps: at 60Hz a fixed 5-step cap would only
    // advance 83ms per frame, so a 10fps phone would run the match at half
    // speed. Deriving the cap from TICK_DT keeps behaviour rate-independent.
    let guard = 0;
    const maxSteps = Math.ceil(MAX_CATCHUP / TICK_DT);
    while (this.acc >= TICK_DT && guard++ < maxSteps) {
      this.acc -= TICK_DT;
      if (this.world.phase === 'lobby') {
        stepWorld(this.world, TICK_DT);
        this.stepLobby(TICK_DT);
        continue;
      }
      stepBots(this.world, TICK_DT);
      const events = stepWorld(this.world, TICK_DT);
      if (events.length) this.dispatch(events);
    }
  }

  dispatch(events) {
    const fx = [];
    for (const e of events) {
      if (e.type === 'kill') {
        const target = this.world.players.get(e.target);
        const by = e.by ? this.world.players.get(e.by) : null;
        this.emit('feed', {
          kind: 'kill',
          by: by?.name ?? null, byColor: by?.color ?? null,
          target: target?.name, targetColor: e.color,
          weapon: e.kind, multi: e.multi,
        });
        fx.push(e);
      } else if (e.type === 'bomberDown') {
        const by = e.by ? this.world.players.get(e.by) : null;
        this.emit('feed', { kind: 'bomber', by: by?.name ?? null, byColor: by?.color ?? null });
        fx.push(e);
      } else if (e.type === 'matchEnd') {
        this.finish(e);
      } else {
        fx.push(e);
      }
    }
    if (fx.length) this.emit('fx', fx);
  }

  finish(ev) {
    this.ended = true;
    const ranking = [...this.world.players.values()]
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .map((p, i) => ({
        place: i + 1, id: p.id, name: p.name, color: p.color, seat: p.seat,
        kills: p.kills, deaths: p.deaths, score: p.score,
        damage: Math.round(p.damageDealt), bot: p.isBot,
      }));
    this.emit('matchEnd', {
      reason: ev.reason, winner: ev.winner, ranking,
      ranked: false, deltas: {}, offline: true, returnIn: 0,
    });
  }

  netStats() {
    return { online: false, ping: null, jitter: null, patchRate: 0, loss: 0 };
  }

  leave() { this.ended = true; }
}

// -------------------------------------------------------------- connecting

/**
 * @param code optional friends-only room code. Rooms are matched on mode AND
 *             code, so a code of '' queues publicly and a real code only ever
 *             meets other people who typed the same one.
 */
export async function findMatch({ mode, name, rating, code = '', endpoint = DEFAULT_ENDPOINT, signal }) {
  const client = new Client(endpoint);
  const room = await client.joinOrCreate('arena', { mode, name, rating, code: cleanRoomCode(code) });

  // joinOrCreate resolves as soon as the seat is confirmed — the first state
  // patch arrives a tick later. Building the scene before then means reading
  // arenaSize/mode off an empty state, so wait for real state to land.
  try {
    await waitForState(room);
  } catch (err) {
    try { await room.leave(); } catch { /* nothing to clean up */ }
    throw err;
  }

  // The player hit Cancel while the handshake was still in flight.
  if (signal?.aborted) {
    try { await room.leave(); } catch { /* nothing to clean up */ }
    throw new DOMException('Cancelled', 'AbortError');
  }
  return new OnlineSession(room);
}

/** Joins a specific room straight from the server browser. */
export async function joinRoomById({ roomId, name, rating, endpoint = DEFAULT_ENDPOINT }) {
  const client = new Client(endpoint);
  // Public rooms carry an empty code; onAuth checks it either way.
  const room = await client.joinById(roomId, { name, rating, code: '' });
  await waitForState(room);
  return new OnlineSession(room);
}

/** Public, joinable matches for the server browser. */
export async function fetchRooms(endpoint = DEFAULT_ENDPOINT, timeoutMs = 4000) {
  const http = endpoint.replace(/^ws/, 'http');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${http}/rooms`, { mode: 'cors', signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.rooms) ? data.rooms : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function waitForState(room, timeoutMs = 10000) {
  if (room.state?.players) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for game state')), timeoutMs);
    room.onStateChange.once(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Server status for the main menu. Measures the HTTP round trip as a rough
 * ping — it's TCP rather than the game's WebSocket, so treat it as indicative
 * of reachability and rough latency, not as the in-match ping.
 */
export async function fetchServerStats(endpoint = DEFAULT_ENDPOINT, timeoutMs = 5000) {
  const http = endpoint.replace(/^ws/, 'http');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(`${http}/stats`, { mode: 'cors', signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { ...data, online: true, ping: Math.round(performance.now() - t0) };
  } catch (err) {
    return { online: false, ping: null, error: err?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Nudges a sleeping free-tier dyno so the first real join isn't a cold start. */
export function wakeServer(endpoint = DEFAULT_ENDPOINT) {
  const http = endpoint.replace(/^ws/, 'http');
  return fetch(`${http}/wake`, { mode: 'cors' })
    .then((r) => r.ok)
    .catch(() => false);
}

export { DEFAULT_ENDPOINT };
