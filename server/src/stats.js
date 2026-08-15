// Live server counters.
//
// Rooms report into this registry as they're created, joined and disposed,
// rather than reading Colyseus internals — those are undocumented and move
// between versions, and the numbers we want are ones we already know.

const state = {
  startedAt: Date.now(),
  rooms: new Map(), // roomId -> { mode, humans, bots }
  matchesPlayed: 0,
  peakPlayers: 0,
};

export function roomOpened(roomId, mode, code = '') {
  state.rooms.set(roomId, { mode, code, humans: 0, bots: 0, maxPlayers: 0, phase: 'warmup' });
}

export function roomClosed(roomId) {
  if (state.rooms.delete(roomId)) state.matchesPlayed++;
}

export function roomPopulation(roomId, humans, bots, extra = {}) {
  const room = state.rooms.get(roomId);
  if (!room) return;
  room.humans = humans;
  room.bots = bots;
  Object.assign(room, extra);
  state.peakPlayers = Math.max(state.peakPlayers, totalHumans());
}

/**
 * Public, joinable matches for the server browser.
 *
 * Coded rooms are excluded deliberately — a private match should be reachable
 * only by someone who was given the code, never by browsing.
 */
export function listPublicRooms() {
  const out = [];
  for (const [roomId, r] of state.rooms) {
    if (r.code) continue;
    if (r.phase === 'over') continue;
    out.push({
      roomId,
      mode: r.mode,
      humans: r.humans,
      bots: r.bots,
      maxPlayers: r.maxPlayers,
      full: r.maxPlayers > 0 && r.humans >= r.maxPlayers,
      phase: r.phase,
    });
  }
  return out.sort((a, b) => b.humans - a.humans);
}

function totalHumans() {
  let n = 0;
  for (const r of state.rooms.values()) n += r.humans;
  return n;
}

export function snapshot() {
  const byMode = {};
  for (const r of state.rooms.values()) {
    byMode[r.mode] ??= { rooms: 0, players: 0 };
    byMode[r.mode].rooms++;
    byMode[r.mode].players += r.humans;
  }

  const mem = process.memoryUsage();
  return {
    ok: true,
    uptime: Math.round(process.uptime()),
    // Server clock, so the client can measure one-way skew if it ever wants to.
    now: Date.now(),
    players: totalHumans(),
    rooms: state.rooms.size,
    matchesPlayed: state.matchesPlayed,
    peakPlayers: state.peakPlayers,
    byMode,
    memoryMb: Math.round(mem.heapUsed / 1048576),
  };
}
