import { Room, ServerError } from 'colyseus';
import {
  createWorld, addPlayer, removePlayer, applyInput, stepWorld, xpForLevel,
  stepBots, initBot, botName,
  MODES, TICK_HZ, TICK_DT, PATCH_MS, MAX_CATCHUP, QUICK_CHAT, PLAYER, cleanRoomCode,
  hillProgress, castVote, voteTally, beginMatch, MAP_VOTE, contractInfo, BOMB,
  placePing, PING, seatOrder, setRole, useAbility, assignBotRole, abilityMax,
} from '@cluckdown/shared';
import {
  ArenaState, PlayerState, PickupState, MapChoiceState, NestState, EggState, PadState,
} from './state.js';
import { ratingDeltas } from '../rating.js';
import { roomOpened, roomClosed, roomPopulation } from '../stats.js';

/**
 * How long a public queue waits for other humans before padding with bots.
 *
 * This used to be 8 seconds, which — on top of the map vote — meant well over
 * ten seconds of staring at a lobby before the first shot. For a free-tier
 * browser game that is often the whole session: an empty server is the failure
 * mode that kills small multiplayer games, not a missing feature.
 *
 * So the room fills almost immediately and starts. Nobody is stranded, because
 * a human arriving later evicts a bot and drops straight into the running match
 * (see takeSeat/evictBotSeat) — the seat is the same either way.
 */
const BOT_FILL_DELAY = 1.5;

// Private rooms are the exception: friends are actively gathering, and filling
// their match with bots before they arrive is the opposite of what they want.
const BOT_FILL_DELAY_PRIVATE = 30;

const POST_MATCH_SECONDS = 12;

export class ArenaRoom extends Room {
  onCreate(options) {
    const mode = MODES[options?.mode] ? options.mode : 'casual';
    // Rooms are matched on mode AND code (see filterBy in index.js). Public
    // matches use the empty string, so a public queue can never drop someone
    // into a friends-only room, and vice versa.
    this.code = cleanRoomCode(options?.code);
    this.cfg = MODES[mode];
    this.maxClients = this.cfg.maxPlayers;
    this.autoDispose = true;

    this.world = createWorld({ mode });
    this.seats = new Array(this.cfg.maxPlayers).fill(null);
    // Seat index decides your team, so who gets which seat decides who you
    // play WITH. A coded room is friends; a public queue is strangers.
    this.seatOrder = seatOrder(this.cfg.maxPlayers, !!this.code);
    // Friends need longer to gather than a public queue does.
    this.botFillAt = this.code ? BOT_FILL_DELAY_PRIVATE : BOT_FILL_DELAY;
    this.postMatch = 0;
    this.fxQueue = [];
    this.fxFlushAt = 0;
    this.acc = 0;
    this.disconnecting = false;
    this.ratingsById = new Map();

    const state = new ArenaState();
    state.mode = mode;
    state.modifier = this.world.modifier;
    state.phase = this.world.phase;
    state.clock = this.world.clock;
    state.arenaSize = this.cfg.arena;
    state.safeHalf = this.world.safeHalf;
    state.map = this.world.map;
    for (const id of this.world.mapCandidates) {
      const c = new MapChoiceState();
      c.id = id;
      c.votes = 0;
      state.mapChoices.push(c);
    }
    state.killLimit = this.cfg.killLimit;
    this.setState(state);

    this.setMetadata({ mode, label: this.cfg.label, code: this.code });

    this.onMessage('input', (client, msg) => {
      if (this.world.phase === 'over') return;
      applyInput(this.world, client.sessionId, msg ?? {});
    });

    this.onMessage('chat', (client, msg) => this.handleChat(client, msg));

    // Role pick. The simulation decides whether it lands now or on respawn —
    // see setRole — and refuses one a team-mate is holding, so the room does
    // not need a second copy of the uniqueness rule to keep in step.
    this.onMessage('role', (client, msg) => {
      const got = setRole(this.world, client.sessionId, msg?.role ?? msg);
      // Answered either way. A picker that goes quiet on a refusal leaves the
      // player staring at a screen wondering whether their tap registered,
      // which is the exact dead time this feature was told not to add.
      client.send('role', { role: got, taken: this.takenRoles(client.sessionId) });
    });

    // One button, whatever the role decides it does. The simulation refuses it
    // when there is no charge, no heading, or no ability — nothing to check
    // here that would not be a second copy of that.
    this.onMessage('ability', (client) => useAbility(this.world, client.sessionId));

    // 'mark', NOT 'ping' — 'ping' is already the RTT probe below, and Colyseus
    // keeps one handler per message name, so the second registration silently
    // replaces the first. A team marker and a latency probe sharing a name is
    // one of them quietly never arriving.
    this.onMessage('mark', (client, msg) => this.handlePing(client, msg));

    this.onMessage('vote', (client, mapId) => {
      if (!castVote(this.world, client.sessionId, String(mapId ?? ''))) return;
      this.syncVotes();
      // Everyone has spoken — no reason to make them sit out the timer, as long
      // as the lobby has been up long enough to actually be seen.
      if (this.world.lobbyTime >= MAP_VOTE.minSeconds && this.everyoneVoted()) {
        this.closeLobby();
      }
    });

    // Round-trip probe. Echoing the client's own timestamp back means the
    // server needs no clock agreement and the client can measure RTT exactly.
    this.onMessage('ping', (client, sentAt) => client.send('pong', sentAt));

    roomOpened(this.roomId, mode, this.code);

    // Simulate fast, broadcast slower. Clients interpolate between patches, so
    // pushing state at the full simulation rate would cost them decode work for
    // motion they already smooth out themselves.
    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), 1000 / TICK_HZ);
    this.setPatchRate(PATCH_MS);
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * Enforces the room code before anyone is let in.
   *
   * filterBy('code') alone is NOT enough: a client that simply omits the field
   * sends `undefined`, which matches any room, so a public queue could drop a
   * stranger straight into a friends-only match. Matchmaking filters are a
   * routing hint — this is the actual gate.
   */
  onAuth(client, options) {
    const offered = cleanRoomCode(options?.code);
    if (offered !== this.code) {
      throw new ServerError(4001, this.code ? 'Wrong room code' : 'This match is private');
    }
    return true;
  }

  onJoin(client, options) {
    const seat = this.takeSeat(client.sessionId);

    const name = sanitizeName(options?.name);
    // The role they were playing last match, if their side still has it free.
    // Arriving already in the role you were playing is the difference between a
    // pick screen and a toll gate.
    const p = addPlayer(this.world, {
      id: client.sessionId, name, seat: seat >= 0 ? seat : 0, role: options?.role,
    });
    this.ratingsById.set(client.sessionId, clampRating(options?.rating));

    const ps = new PlayerState();
    this.syncPlayer(ps, p);
    this.state.players.set(client.sessionId, ps);

    this.broadcast('feed', { kind: 'join', name: p.name, color: p.color });

    // Dropping into a match already in progress: give the newcomer the same
    // spawn protection a respawn would, so "joined and was instantly dead" —
    // the thing that makes hot-join feel hostile — can't happen.
    if (this.world.phase === 'live') {
      p.invulnUntil = this.world.time + PLAYER.spawnInvuln;
      client.send('joinedInProgress', {
        clock: this.world.clock,
        map: this.world.map,
        seat: p.seat,
        role: p.role,
      });
    }

    // Only humans occupy client slots, so a room running with bots stays
    // joinable — which is the entire point: the arena is always full, and real
    // players displace bots as they arrive.
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
    roomPopulation(this.roomId, humans, bots, {
      maxPlayers: this.cfg.maxPlayers,
      phase: this.world.phase,
    });
  }

  onDispose() {
    roomClosed(this.roomId);
  }

  // ---------------------------------------------------------------- seating

  /**
   * Claims a seat for an arriving human.
   *
   * A seat decides your team, your spawn lane and your shade, so two players
   * must never share one. If bots hold every seat, one of them makes way — a
   * human always outranks a bot. Returns -1 only if the room is genuinely full
   * of humans, which maxClients should already have prevented.
   *
   * Both halves walk seatOrder rather than the raw seat list, or a private
   * room full of bots would evict one at random and split the friends who just
   * typed the same code.
   */
  takeSeat(id) {
    let seat = this.seatOrder.find((i) => this.seats[i] === null) ?? -1;
    if (seat < 0) seat = this.evictBotSeat();
    if (seat < 0) return -1;
    this.seats[seat] = id;
    return seat;
  }

  /** Removes the best-placed bot and hands back the seat index it freed. */
  evictBotSeat() {
    for (const i of this.seatOrder) {
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
    while (this.world.players.size < this.cfg.maxPlayers && guard++ < 16) {
      const seat = this.seats.indexOf(null);
      if (seat < 0) break;
      const id = `bot_${seat}_${Math.random().toString(36).slice(2, 7)}`;
      this.seats[seat] = id;
      const p = addPlayer(this.world, { id, name: botName(), seat, isBot: true });
      initBot(p, this.cfg.ranked ? 'hard' : 'normal');
      // Random rather than first-free, so a bot-filled roost is a different
      // shape every match instead of the same four in the same order.
      assignBotRole(this.world, p);
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

    // Team modes keep chat inside the team. Calling a rotation to the people
    // you are shooting at is not communication, it is a handicap.
    const line = { name: p.name, color: p.color, text, team: p.team ?? -1 };
    if (p.team === null) {
      this.broadcast('chat', line);
      return;
    }
    this.sendToTeam(p.team, 'chat', line);
  }

  /**
   * A team marker.
   *
   * The world point comes from the client, because it is the point under their
   * own crosshair and only their camera knows where that is. The simulation
   * checks it is inside the arena and within range before it becomes a marker,
   * and does the rate limiting — see placePing.
   */
  handlePing(client, msg) {
    const ping = placePing(
      this.world, client.sessionId, msg?.intent, msg?.x, msg?.z,
    );
    if (!ping) return;
    const out = {
      id: ping.id, by: ping.by, byName: ping.byName, intent: ping.intent,
      x: ping.x, z: ping.z, life: PING.life,
    };
    if (ping.team === null) client.send('mark', out);
    else this.sendToTeam(ping.team, 'mark', out);
  }

  /** Broadcast, but only to the clients whose chicken is on this side. */
  sendToTeam(team, type, payload) {
    for (const c of this.clients) {
      if (this.world.players.get(c.sessionId)?.team !== team) continue;
      c.send(type, payload);
    }
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

  // ------------------------------------------------------------------ lobby

  everyoneVoted() {
    const humans = [...this.world.players.values()].filter((p) => !p.isBot);
    return humans.length > 0 && humans.every((p) => this.world.votes.has(p.id));
  }

  syncVotes() {
    const counts = voteTally(this.world);
    for (const c of this.state.mapChoices) c.votes = counts[c.id] ?? 0;
  }

  closeLobby() {
    if (this.world.phase !== 'lobby') return;
    // Bots vote too, so a solo player still sees a real tally rather than a
    // one-horse race — and a lobby with nobody voting still resolves.
    for (const p of this.world.players.values()) {
      if (p.isBot && !this.world.votes.has(p.id)) {
        const pick = this.world.mapCandidates[
          Math.floor(Math.random() * this.world.mapCandidates.length)
        ];
        castVote(this.world, p.id, pick);
      }
    }
    this.syncVotes();
    const map = beginMatch(this.world);
    this.broadcast('mapChosen', { map, votes: voteTally(this.world) });
  }

  /** One fixed-size simulation step. */
  stepOnce(dt) {
    if (this.world.phase === 'lobby') {
      // The sim owns the lobby clock, so it has to be stepped even though no
      // gameplay runs during a lobby — stepWorld returns immediately after
      // advancing lobbyTime. Skipping it froze the timer at zero, which meant
      // neither the timeout nor the everyone-voted early close could ever fire.
      stepWorld(this.world, dt);

      // Bots are pulled in early so the vote isn't decided by one person, and
      // so the lobby shows a full roster.
      if (this.cfg.fillWithBots && this.world.players.size < this.cfg.maxPlayers) {
        this.botFillAt -= dt;
        if (this.botFillAt <= 0) this.fillWithBots();
      }
      // Checked every tick, not only when a vote arrives: if everyone votes
      // before the minimum lobby duration is up, the vote handler's check has
      // already been and gone, and the lobby would sit out the whole timeout.
      if (this.world.lobbyTime >= MAP_VOTE.seconds
          || (this.world.lobbyTime >= MAP_VOTE.minSeconds && this.everyoneVoted())) {
        this.closeLobby();
      }
      return;
    }

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
        case 'ping':
          // Already sent to the team that owns it in handlePing. Letting it
          // into the fx broadcast would hand every opponent the marker.
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
        shade: p.shade,
        seat: p.seat,
        team: p.team ?? -1,
        kills: p.kills,
        deaths: p.deaths,
        score: p.score,
        damage: Math.round(p.damageDealt),
        healed: Math.round(p.healGiven ?? 0),
        role: p.role,
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
      winnerTeam: ev.winnerTeam ?? null,
      teams: this.cfg.teams ? [...this.world.teamScores] : null,
      ranking,
      ranked: this.cfg.ranked,
      deltas,
      humans: humans.length,
      returnIn: POST_MATCH_SECONDS,
    });
  }

  // ------------------------------------------------------------ state sync

  /**
   * Rounds a countdown to a tenth of a second before it goes into state.
   *
   * COLYSEUS SENDS WHAT CHANGED. A float that is recomputed from `world.time`
   * every tick therefore changes every tick, which means it is dirty in every
   * single patch — and this schema is full of them: respawnIn, abilityIn,
   * contractAt, the two reveal clocks, the bomb and potato fuses, the hill's
   * relocation timer, every pad's lifetime and every loose egg's. Between them
   * they were a permanent floor under the patch size, paid thirty times a
   * second, per client, forever.
   *
   * Every one of them is DISPLAYED at a resolution far coarser than it is sent
   * at: most go through Math.ceil to become a whole number of seconds, and the
   * one that does not — the ability sweep — is a bar with a CSS transition
   * across it. So a tenth of a second is not a compromise on any of them, and
   * it takes a field that changes 60 times a second down to 10, against a patch
   * rate of 30. Two patches in three now carry nothing for it at all.
   *
   * Positions are NOT run through this and must not be: x/y/z/aim/pitch are the
   * things interpolation is built on, and quantising them is visible instantly.
   */
  static tenths(seconds) {
    return Math.round(Math.max(0, seconds) * 10) / 10;
  }

  syncPlayer(ps, p) {
    ps.name = p.name;
    ps.seat = p.seat;
    ps.team = p.team ?? -1;
    ps.hillPct = Math.round(hillProgress(this.world, p.seat) * 100);
    ps.x = p.x;
    ps.y = p.y;
    ps.z = p.z;
    ps.aim = p.aim;
    ps.pitch = p.pitch;
    ps.hp = Math.max(0, Math.round(p.hp));
    ps.alive = p.alive;
    ps.invuln = p.invulnUntil > this.world.time;
    ps.level = p.level;
    ps.xp = Math.max(0, Math.min(65535, Math.round(p.xp)));
    ps.nextXp = Math.max(0, Math.min(65535, Math.round(xpForLevel(p.level + 1))));
    ps.wind = p.windUntil > this.world.time;
    ps.frenzy = p.frenzyUntil > this.world.time;
    ps.role = p.role ?? '';
    ps.rotateTo = p.rotateTo ?? '';
    ps.abilityCharges = Math.max(0, Math.min(255, p.abilityCharges | 0));
    ps.abilityIn = p.abilityCharges >= abilityMax(p)
      ? 0
      : ArenaRoom.tenths(p.abilityAt - this.world.time);
    ps.bulwark = p.bulwarkUntil > this.world.time;
    ps.dashing = p.dashUntil > this.world.time;
    ps.healGiven = Math.max(0, Math.min(65535, Math.round(p.healGiven ?? 0)));
    ps.crop = Math.max(0, Math.min(255, Math.floor(p.crop)));
    ps.pecking = !!p.pecking;
    ps.feeding = !!p.feeding;
    ps.dry = !!p.dry;
    ps.kills = p.kills;
    ps.deaths = p.deaths;
    ps.score = p.score;
    ps.respawnIn = p.alive ? 0 : ArenaRoom.tenths(p.respawnAt - this.world.time);
    ps.kx = p.kx;
    ps.kz = p.kz;
    ps.nemesis = this.world.time < p.nemesisUntil ? (p.nemesis ?? '') : '';
    ps.ack = p.lastSeq >>> 0;
    ps.bot = !!p.isBot;
    ps.carrying = p.carrying ?? 0;

    const contract = contractInfo(p);
    ps.contract = contract?.id ?? '';
    ps.contractLabel = contract?.label ?? '';
    ps.contractAt = ArenaRoom.tenths(contract?.secondsLeft ?? 0);
    ps.contractGoal = contract?.target ?? 0;
    ps.contractDone = contract?.progress ?? 0;
  }

  syncState() {
    const s = this.state;
    s.phase = this.world.phase;
    s.clock = ArenaRoom.tenths(this.world.clock);
    s.safeHalf = this.world.safeHalf;
    // Set every tick, not just at creation: the voted map changes it.
    s.arenaSize = this.world.arena.size;
    s.map = this.world.map;
    s.lobbyTime = this.world.lobbyTime;
    s.bounty = this.world.bounty ?? '';

    const pot = this.world.potato;
    s.potatoActive = !!pot;
    if (pot) {
      s.potatoX = pot.x;
      s.potatoZ = pot.z;
      s.potatoFuse = ArenaRoom.tenths(pot.fuse);
      s.potatoHolder = pot.holder ?? '';
    }
    if (this.world.teamScores) {
      [s.teamBlue, s.teamRed] = this.world.teamScores;
    }
    if (this.world.hill) {
      s.hillHolder = this.world.hill.holder ?? '';
      s.hillContested = this.world.hill.contested;
      s.hillX = this.world.hill.x;
      s.hillZ = this.world.hill.z;
      s.hillMoveAt = ArenaRoom.tenths(this.world.hill.moveAt);
    }

    // Sweeps, as seconds remaining rather than an absolute time — clients have
    // no shared clock with the server, and this is a countdown either way.
    s.revealBlue = ArenaRoom.tenths((this.world.reveal?.[0] ?? 0) - this.world.time);
    s.revealRed = ArenaRoom.tenths((this.world.reveal?.[1] ?? 0) - this.world.time);

    this.syncNests();
    this.syncEggs();
    this.syncPads();
    this.syncBomb();

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

  /**
   * Nests are created once and then only their egg count changes — they sit on
   * the spawn corners, which are fixed for the whole match.
   */
  syncNests() {
    const nests = this.world.nests;
    if (!nests) return;

    if (this.state.nests.length !== nests.length) {
      this.state.nests.clear();
      for (const n of nests) {
        const ns = new NestState();
        ns.team = n.team;
        ns.x = n.x;
        ns.z = n.z;
        ns.eggs = n.eggs;
        this.state.nests.push(ns);
      }
      return;
    }
    for (let i = 0; i < nests.length; i++) {
      const ns = this.state.nests[i];
      ns.eggs = nests[i].eggs;
      ns.x = nests[i].x;
      ns.z = nests[i].z;
    }
  }

  syncPads() {
    const live = new Set();
    for (const pad of this.world.pads) {
      const key = String(pad.id);
      live.add(key);
      let ps = this.state.pads.get(key);
      if (!ps) {
        ps = new PadState();
        ps.x = pad.x;
        ps.z = pad.z;
        ps.team = pad.team ?? -1;
        ps.radius = pad.radius;
        this.state.pads.set(key, ps);
      }
      ps.until = ArenaRoom.tenths(pad.until - this.world.time);
    }
    for (const key of [...this.state.pads.keys()]) {
      if (!live.has(key)) this.state.pads.delete(key);
    }
  }

  /** Roles this player's side has spoken for, so the picker can grey them out. */
  takenRoles(exceptId) {
    const me = this.world.players.get(exceptId);
    if (!me || me.team === null) return [];
    const out = [];
    for (const o of this.world.players.values()) {
      if (o.id === exceptId || o.team !== me.team || !o.role) continue;
      out.push(o.role);
    }
    return out;
  }

  syncEggs() {
    const eggs = this.world.looseEggs;
    if (!eggs) return;

    const live = new Set();
    for (const egg of eggs) {
      const key = String(egg.id);
      live.add(key);
      let es = this.state.eggs.get(key);
      if (!es) {
        es = new EggState();
        es.x = egg.x;
        es.z = egg.z;
        es.team = egg.fromTeam;
        this.state.eggs.set(key, es);
      }
      es.returnAt = ArenaRoom.tenths(egg.returnAt);
    }
    for (const key of [...this.state.eggs.keys()]) {
      if (!live.has(key)) this.state.eggs.delete(key);
    }
  }

  syncBomb() {
    if (!this.cfg.bomb) return;
    const s = this.state;
    const bomb = this.world.bomb;

    if (!bomb) {
      s.bombState = '';
      s.bombCarrier = '';
      s.bombTeam = -1;
      s.bombPlant = 0;
      s.bombDefuse = 0;
      return;
    }
    s.bombState = bomb.state;
    s.bombX = bomb.x;
    s.bombZ = bomb.z;
    s.bombCarrier = bomb.carriedBy ?? '';
    s.bombTeam = bomb.state === 'planted' ? bomb.plantTeam : -1;
    s.bombFuse = ArenaRoom.tenths(bomb.fuse);
    // Sent as a 0..1 share so the client can draw a ring without knowing the
    // hold durations.
    s.bombPlant = Math.min(1, bomb.plant / BOMB.plantTime);
    s.bombDefuse = Math.min(1, bomb.defuse / BOMB.defuseTime);
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
