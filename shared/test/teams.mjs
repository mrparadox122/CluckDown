// Four a side: who is on which team, where they come back, and what they can
// say to each other.
//
// This file exists because 4v4 rewrote three things that were previously
// hardcoded to four seats, and every one of them is silent when it breaks:
//
//   * `teamForSeat` was `seat === 1 || seat === 2`, which at 8 seats would have
//     produced a 2v6 with nothing anywhere throwing an error;
//   * spawns were four corners, so both teams would have started diagonally
//     across from each other with no front line at all;
//   * respawn picked the corner furthest from the nearest enemy, which on a
//     map with team lines means "come back behind theirs".
//
// The ping assertions are here rather than in a file of their own for one
// reason: the only thing that matters about a ping is that the wrong team
// cannot see it, and that is a question about teams.
//
//   node shared/test/teams.mjs

import {
  createWorld, addPlayer, stepWorld, beginMatch, spawnPoints, spawnFor,
  feederFor, placePing, pingsFor, teamForSeat, teamSlot, teamShade,
  pingWedge, pingAngle, seatOrder,
  MODES, MODE_LIST, TICK_DT, PING, PINGS, PLAYER, TEAM_COLORS,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

/** A live 4v4 with `n` seats filled. */
function live(mode = 'casual', n = 8) {
  const w = createWorld({ mode, seed: 77, modifier: 'none' });
  for (let seat = 0; seat < n; seat++) {
    addPlayer(w, { id: `p${seat}`, name: `P${seat}`, seat });
  }
  beginMatch(w, 'coop');
  for (let t = 0; t < 300 && w.phase !== 'live'; t++) stepWorld(w, TICK_DT);
  return w;
}

// ------------------------------------------------------------- assignment

console.log('\n--- seats split into two roosts ---');
{
  const teams = [0, 1, 2, 3, 4, 5, 6, 7].map(teamForSeat);
  console.log('  seat -> team:', teams.join(','));
  check('eight seats split four and four',
    teams.filter((t) => t === 0).length === 4 && teams.filter((t) => t === 1).length === 4,
    teams.join(','));
  check('four seats still split two and two',
    teams.slice(0, 4).filter((t) => t === 0).length === 2,
    teams.slice(0, 4).join(','));
  // The old 2v2 mapping is load-bearing: the README documents it and the
  // existing mode test asserts it.
  check('the old 2v2 mapping is unchanged',
    teams[0] === 0 && teams[1] === 1 && teams[2] === 1 && teams[3] === 0);

  const slots = [0, 1, 2, 3, 4, 5, 6, 7].map(teamSlot);
  check('every seat gets its own slot inside its team',
    new Set([0, 3, 4, 7].map(teamSlot)).size === 4
    && new Set([1, 2, 5, 6].map(teamSlot)).size === 4,
    slots.join(','));
  check('slots stay in range', slots.every((s) => s >= 0 && s < 4), slots.join(','));
}

console.log('\n--- eight bodies stay readable ---');
{
  const w = live();
  const roster = [...w.players.values()];
  check('a whole team shares one silhouette colour',
    new Set(roster.filter((p) => p.team === 0).map((p) => p.color)).size === 1
    && new Set(roster.filter((p) => p.team === 1).map((p) => p.color)).size === 1,
    roster.map((p) => p.color).join(' '));
  check('the two teams do not share it',
    roster.find((p) => p.team === 0).color !== roster.find((p) => p.team === 1).color);
  // Team colour answers "shoot them?". The shade answers "which of you is
  // that?", and at eight players that second question needs an answer too.
  check('every player still has a shade of their own',
    new Set(roster.map((p) => p.shade)).size === 8,
    roster.map((p) => p.shade).join(' '));
  check('a shade belongs to its own team colour',
    roster.every((p) => teamShade(p.seat, p.team) === p.shade));
  check('free-for-all falls back to seat colours',
    teamShade(2, null) !== teamShade(3, null));
}

// ----------------------------------------------------------------- spawns

console.log('\n--- a front line, not a scramble ---');
{
  const w = live();
  const pts = spawnPoints(w);
  console.log('  spawns:', pts.map((p) => `(${p.x.toFixed(0)},${p.z.toFixed(0)})`).join(' '));

  const west = pts.filter((_, seat) => teamForSeat(seat) === 0);
  const east = pts.filter((_, seat) => teamForSeat(seat) === 1);
  check('one roost lines up west, the other east',
    west.every((p) => p.x < 0) && east.every((p) => p.x > 0),
    `${west.length} west / ${east.length} east`);
  check('nobody shares a spawn spot',
    new Set(pts.map((p) => `${p.x},${p.z}`)).size === pts.length);
  check('the two lines mirror each other',
    west.every((p, i) => Math.abs(p.x + east[i].x) < 1e-6 && Math.abs(p.z - east[i].z) < 1e-6));
  // Chickens are 0.6 across. Lanes closer together than a couple of bodies
  // would spawn a team inside itself.
  const gaps = west.slice(1).map((p, i) => Math.abs(p.z - west[i].z));
  check('team-mates get room to stand', Math.min(...gaps) > PLAYER.radius * 4,
    `closest lanes ${Math.min(...gaps).toFixed(1)} apart`);
  check('every spawn is inside the walls',
    pts.every((p) => Math.abs(p.x) < w.arena.half && Math.abs(p.z) < w.arena.half));

  check('players actually start on their own side',
    [...w.players.values()].every((p) => (p.team === 0 ? p.x < 0 : p.x > 0)),
    [...w.players.values()].map((p) => `T${p.team}@${p.x.toFixed(0)}`).join(' '));
}

console.log('\n--- one feeder per roost ---');
{
  const w = live();
  const blue = feederFor(w, 0);
  const red = feederFor(w, 1);
  console.log(`  pads: blue (${blue.x.toFixed(0)},${blue.z.toFixed(0)}) red (${red.x.toFixed(0)},${red.z.toFixed(0)})`);
  check('the two pads are on opposite sides', blue.x < 0 && red.x > 0);
  check('a pad sits in the middle of its own line', blue.z === 0 && red.z === 0);
  check('every team-mate is handed the same pad',
    [...w.players.values()].filter((p) => p.team === 0)
      .every((p) => feederFor(w, p.team).x === blue.x));
  // A duel has no teams, so it keeps its own corner per seat.
  const d = createWorld({ mode: 'duel', seed: 3 });
  addPlayer(d, { id: 'a', name: 'A', seat: 0 });
  addPlayer(d, { id: 'b', name: 'B', seat: 1 });
  beginMatch(d, 'coop');
  check('a duel still gets a corner each',
    feederFor(d, 0).x !== feederFor(d, 1).x && feederFor(d, 0).z !== feederFor(d, 1).z);
}

console.log('\n--- you come back on your own side ---');
{
  const w = live();
  const me = w.players.get('p0'); // team 0, west
  // Park every enemy on the west line, which is exactly the shape that used to
  // send you to the far corner — i.e. into their spawn.
  for (const p of w.players.values()) {
    if (p.team === me.team) continue;
    p.x = -w.arena.half + 4;
    p.z = 0;
  }
  me.alive = false;
  me.respawnAt = w.time;
  for (let t = 0; t < 5 / TICK_DT && !me.alive; t++) stepWorld(w, TICK_DT);
  console.log(`  respawned at (${me.x.toFixed(0)}, ${me.z.toFixed(0)}) with every enemy at x=${(-w.arena.half + 4).toFixed(0)}`);
  check('respawn came back alive', me.alive);
  check('respawn stays on your own half, even when the enemy is standing on it',
    me.x < 0, `x=${me.x.toFixed(1)}`);
}

console.log('\n--- every mode is a team mode except the duel ---');
{
  for (const id of MODE_LIST) {
    const cfg = MODES[id];
    if (id === 'duel') {
      check('duel is 1v1 and teamless', cfg.maxPlayers === 2 && !cfg.teams);
      continue;
    }
    if (id === 'teams') {
      check('2v2 Teams stayed 2v2', cfg.maxPlayers === 4 && cfg.teams === true);
      continue;
    }
    check(`${id} is four a side`, cfg.maxPlayers === 8 && cfg.teams === true,
      `maxPlayers=${cfg.maxPlayers} teams=${!!cfg.teams}`);
  }
}

// ------------------------------------------------------------------ pings

console.log('\n--- pings reach your roost and nobody else ---');
{
  const w = live();
  const me = w.players.get('p0');
  const mate = w.players.get('p3');     // same team
  const enemy = w.players.get('p1');    // other team

  const ping = placePing(w, 'p0', 'enemy', 4, 6);
  check('a ping is placed', !!ping, ping ? `${ping.intent} at (${ping.x},${ping.z})` : 'refused');
  check('it carries the pinger, their name and their team',
    ping.by === 'p0' && ping.byName === me.name && ping.team === me.team);
  check('a team-mate can see it', pingsFor(w, mate.id).length === 1);
  check('the other roost cannot', pingsFor(w, enemy.id).length === 0);
  check('it is announced as an event', w.events.some((e) => e.type === 'ping'));

  // The cooldown is the whole difference between comms and spam.
  const spam = placePing(w, 'p0', 'help', 1, 1);
  check('a second ping inside the cooldown is refused', spam === null);

  w.time += PING.cooldown + 0.01;
  check('...and allowed once it has passed', !!placePing(w, 'p0', 'help', 1, 1));

  // Past the cap, the oldest goes — the newest thing you saw is what matters.
  w.time += PING.cooldown + 0.01;
  placePing(w, 'p0', 'attack', 2, 2);
  const mine = pingsFor(w, 'p0').filter((q) => q.by === 'p0');
  check('a player cannot hold more than their cap', mine.length === PING.maxPerPlayer,
    `${mine.length} of ${PING.maxPerPlayer}`);
  check('the cap drops the oldest, not the newest',
    mine.some((q) => q.intent === 'attack'), mine.map((q) => q.intent).join(' '));
}

console.log('\n--- a ping is not a trust boundary ---');
{
  const w = live();
  const far = w.arena.half * 4;
  check('a marker outside the arena is refused', placePing(w, 'p0', 'enemy', far, far) === null);
  check('a NaN marker is refused', placePing(w, 'p0', 'enemy', NaN, 0) === null);

  const me = w.players.get('p0');
  w.time += PING.cooldown + 0.01;
  check('an unknown intent falls back to the first one rather than throwing',
    placePing(w, 'p0', 'nonsense', me.x + 1, 0)?.intent === PINGS[0].id);

  // The range cap only bites on a map big enough to exceed it, so test it on
  // one. The Big Yard's diagonal is the only thing in the game that does.
  {
    const big = createWorld({ mode: 'casual', seed: 5, modifier: 'none' });
    addPlayer(big, { id: 'a', name: 'A', seat: 0 });
    addPlayer(big, { id: 'b', name: 'B', seat: 1 });
    beginMatch(big, 'yard');
    for (let t = 0; t < 300 && big.phase !== 'live'; t++) stepWorld(big, TICK_DT);
    const far = big.players.get('a');
    far.x = -big.arena.half; far.z = -big.arena.half;
    const opposite = big.arena.half;
    const reach = Math.hypot(opposite - far.x, opposite - far.z);
    check('the far corner really is out of range', reach > PING.maxRange,
      `${reach.toFixed(0)} units vs a ${PING.maxRange} cap`);
    check('a marker further than you can see is refused',
      placePing(big, 'a', 'enemy', opposite, opposite) === null);
    check('...but one inside the cap still lands',
      !!placePing(big, 'a', 'enemy', far.x + 10, far.z + 10));
  }

  w.time += PING.cooldown + 0.01;
  me.alive = false;
  check('the dead cannot ping', placePing(w, 'p0', 'enemy', 0, 0) === null);
}

console.log('\n--- markers expire ---');
{
  const w = live();
  placePing(w, 'p0', 'enemy', 3, 3);
  check('the marker is up', w.pings.length === 1);
  for (let t = 0; t < (PING.life + 1) / TICK_DT; t++) stepWorld(w, TICK_DT);
  check('the marker is gone after its lifetime', w.pings.length === 0, `${w.pings.length} left`);
}

console.log('\n--- the wheel picks by direction, not by hitting a target ---');
{
  // A thumb under fire flicks; it does not land on things. So every wedge has
  // to be reachable by pointing roughly at it from anywhere past the deadzone.
  const hits = PINGS.map((_, i) => {
    const a = pingAngle(i);
    return pingWedge(Math.cos(a) * 80, Math.sin(a) * 80);
  });
  console.log('  aiming straight at each wedge picks:', hits.join(','));
  check('aiming at a wedge picks that wedge', hits.every((got, i) => got === i), hits.join(','));

  check('a tap with no drag picks the first intent', pingWedge(0, 0) === 0);
  check('a wobble inside the deadzone still picks the first intent',
    pingWedge(6, -8) === 0, String(pingWedge(6, -8)));
  check('a long flick counts the same as a short one past the deadzone',
    pingWedge(0, -40) === pingWedge(0, -400));

  // Halfway between two wedges must land on one of them, never off the end.
  const between = [];
  for (let i = 0; i < PINGS.length; i++) {
    const a = pingAngle(i) + Math.PI / PINGS.length;
    between.push(pingWedge(Math.cos(a) * 90, Math.sin(a) * 90));
  }
  check('every angle resolves to a real wedge',
    between.every((i) => i >= 0 && i < PINGS.length), between.join(','));
  check('the first intent is what a tap should mean', PINGS[0].id === 'enemy', PINGS[0].id);
}

console.log('\n--- who you get seated with ---');
{
  // Seat index decides your team, so seat ALLOCATION decides who you play with,
  // and the right answer differs by room. Both orders must still be
  // permutations, or a seat becomes unreachable and the room never fills.
  for (const size of [8, 4, 2]) {
    for (const together of [false, true]) {
      const order = seatOrder(size, together);
      check(`seatOrder(${size}, ${together}) uses every seat once`,
        order.length === size && new Set(order).size === size,
        order.join(','));
    }
  }

  // Public: strangers, so humans spread. Balanced at EVERY prefix, not just at
  // the end — the second player to arrive must not be alone on a side.
  const split = seatOrder(8, false).map(teamForSeat);
  console.log('  public queue  :', split.join(','));
  const balanced = split.every((_, i) => {
    const seen = split.slice(0, i + 1);
    return Math.abs(seen.filter((t) => t === 0).length - seen.filter((t) => t === 1).length) <= 1;
  });
  check('a public queue never leaves anyone the only human on a side', balanced, split.join(','));

  // Private: friends who typed the same code. Splitting them is the opposite
  // of what they came for.
  const party = seatOrder(8, true).map(teamForSeat);
  console.log('  private room  :', party.join(','));
  check('a private room seats the first four arrivals together',
    new Set(party.slice(0, 4)).size === 1, party.join(','));
  check('...and the next four on the other roost',
    new Set(party.slice(4)).size === 1 && party[0] !== party[4], party.join(','));

  const pair = seatOrder(4, true).map(teamForSeat);
  check('two friends in a private 2v2 are still team-mates', pair[0] === pair[1], pair.join(','));
}

console.log('\n--- team colours are still two ---');
check('exactly two roost colours', TEAM_COLORS.length === 2);

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
