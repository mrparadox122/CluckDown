// Map vote lobby, over a real socket with two clients.
//
// This exists because the lobby shipped frozen: the server's lobby branch
// returned before stepping the sim, and the sim is what advances lobbyTime — so
// the timer never moved, the timeout never fired, and the everyone-voted early
// close (gated on a minimum lobby duration) could never trigger either. Two
// players would vote and sit there forever.
//
//   npm run dev:server
//   node server/test/lobby.mjs

import { Client } from 'colyseus.js';
import { MAPS, MAP_VOTE, MODES } from '@cluckdown/shared';

const ENDPOINT = process.env.SMOKE_ENDPOINT || 'ws://localhost:2567';
const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const join = async (name, code) => {
  const room = await new Client(ENDPOINT).joinOrCreate('arena', { mode: 'casual', name, code });
  if (!room.state?.players) await new Promise((r) => room.onStateChange.once(r));
  room.onMessage('fx', () => {});
  room.onMessage('feed', () => {});
  room.onMessage('chat', () => {});
  room.onMessage('matchEnd', () => {});
  room.onMessage('pong', () => {});
  room.onMessage('mapChosen', () => {});
  return room;
};

const choices = (room) => [...(room.state.mapChoices ?? [])].map((c) => ({ id: c.id, votes: c.votes }));

/** Waits for a predicate on state, polling, with a timeout. */
async function waitFor(room, label, predicate, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(room.state)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`      (timed out waiting for ${label})`);
  return false;
}

async function main() {
  console.log(`→ ${ENDPOINT}\n`);

  // --- two players, both vote: the match must actually start ---------------
  console.log('--- two players vote ---');
  const code = 'LOB1';
  const a = await join('Ana', code);
  const b = await join('Ben', code);

  check('both are in the same room', a.roomId === b.roomId, `${a.roomId} / ${b.roomId}`);
  check('the match opens in the lobby', a.state.phase === 'lobby', a.state.phase);

  const opts = choices(a);
  console.log('  candidates:', opts.map((c) => c.id).join(', '));
  check('three map candidates are offered', opts.length === MAP_VOTE.candidates, `${opts.length}`);
  check('every candidate is a real map', opts.every((c) => MAPS[c.id]), opts.map((c) => c.id).join(','));

  // The lobby clock must actually move. This is the exact bug.
  const t0 = a.state.lobbyTime;
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`  lobbyTime ${t0.toFixed(2)} -> ${a.state.lobbyTime.toFixed(2)}`);
  check('the lobby clock advances', a.state.lobbyTime > t0 + 0.5,
    `${t0.toFixed(2)} -> ${a.state.lobbyTime.toFixed(2)}`);

  const target = opts[1].id;
  a.send('vote', target);
  b.send('vote', target);
  await new Promise((r) => setTimeout(r, 800));
  const tally = choices(a);
  console.log('  tally:', JSON.stringify(tally));
  check('votes are counted and synced', (tally.find((c) => c.id === target)?.votes ?? 0) >= 2,
    JSON.stringify(tally));

  const started = await waitFor(a, 'the match to start', (s) => s.phase !== 'lobby', 20000);
  console.log(`  after voting: phase=${a.state.phase} map=${a.state.map} arena=${a.state.arenaSize}`);
  check('the match LEAVES the lobby', started, a.state.phase);
  // Voting early must not mean waiting out the full timer. Players voted at
  // ~1.5s, so the lobby should close at the minimum duration, not at 14s.
  check('everyone voting closes the lobby early',
    a.state.lobbyTime < MAP_VOTE.seconds - 2,
    `closed at ${a.state.lobbyTime.toFixed(1)}s of a ${MAP_VOTE.seconds}s window`);
  check('but never faster than the minimum',
    a.state.lobbyTime >= MAP_VOTE.minSeconds - 0.5, `${a.state.lobbyTime.toFixed(1)}s`);
  check('the voted map won', a.state.map === target, `${a.state.map} vs ${target}`);
  check('arena size matches the chosen map',
    a.state.arenaSize === MAPS[target].size, `${a.state.arenaSize} vs ${MAPS[target].size}`);
  check('both clients agree on the map', a.state.map === b.state.map, `${a.state.map} / ${b.state.map}`);
  check('both clients agree on the arena size', a.state.arenaSize === b.state.arenaSize);

  // Gameplay should now be live rather than stuck.
  const live = await waitFor(a, 'live phase', (s) => s.phase === 'live', 12000);
  check('the match reaches live play', live, a.state.phase);

  await Promise.all([a, b].map((r) => r.leave(true).catch(() => {})));

  // --- nobody votes: the timeout must still start the match ---------------
  console.log('\n--- nobody votes ---');
  const c = await join('Cal', 'LOB2');
  check('opens in the lobby', c.state.phase === 'lobby', c.state.phase);
  const timedOut = await waitFor(c, 'the timeout to fire', (s) => s.phase !== 'lobby',
    (MAP_VOTE.seconds + 8) * 1000);
  console.log(`  after ${c.state.lobbyTime.toFixed(1)}s: phase=${c.state.phase} map=${c.state.map}`);
  check('an unvoted lobby still starts', timedOut, c.state.phase);
  check('a map was chosen anyway', !!MAPS[c.state.map], c.state.map);

  await c.leave(true).catch(() => {});

  // --- a player leaving mid-vote must not wedge the lobby -----------------
  console.log('\n--- someone leaves mid-vote ---');
  const d = await join('Dee', 'LOB3');
  const e = await join('Eli', 'LOB3');
  await new Promise((r) => setTimeout(r, MAP_VOTE.minSeconds * 1000 + 600));
  d.send('vote', choices(d)[0].id);
  await e.leave(true); // Eli walks off without voting
  const survived = await waitFor(d, 'the lobby to resolve', (s) => s.phase !== 'lobby', 20000);
  console.log(`  phase=${d.state.phase} map=${d.state.map}`);
  check('the lobby resolves after someone leaves', survived, d.state.phase);
  await d.leave(true).catch(() => {});

  await new Promise((r) => setTimeout(r, 500));
  console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1); });
