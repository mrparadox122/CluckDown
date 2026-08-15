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

export function roomOpened(roomId, mode) {
  state.rooms.set(roomId, { mode, humans: 0, bots: 0 });
}

export function roomClosed(roomId) {
  if (state.rooms.delete(roomId)) state.matchesPlayed++;
}

export function roomPopulation(roomId, humans, bots) {
  const room = state.rooms.get(roomId);
  if (!room) return;
  room.humans = humans;
  room.bots = bots;
  state.peakPlayers = Math.max(state.peakPlayers, totalHumans());
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
