// Seat allocation test.
//
// A seat decides which team you are on, which lane you spawn in and which
// shade you wear, so two players sharing one is a real bug (they spawn on top
// of each other, on the same side, in the same colour). This joins humans into
// a lobby that bots have already filled and checks that each human gets a
// distinct seat, that bots are evicted to make room, and that a leaving human
// frees their seat again.
//
// Casual is eight seats and four a side now, so the counts below moved with it.
//
//   npm run dev:server
//   node server/test/seats.mjs

import { Client } from 'colyseus.js';

const ENDPOINT = process.env.SMOKE_ENDPOINT || 'ws://localhost:2567';
const failures = [];
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
};

const table = (room) => [...room.state.players.values()]
  .map((p) => ({ name: p.name, seat: p.seat, team: p.team, bot: p.bot }))
  .sort((a, b) => a.seat - b.seat);

const show = (rows) => rows.map((r) => `seat${r.seat}/T${r.team}:${r.name}${r.bot ? '(bot)' : ''}`).join('  ');

async function joined(room) {
  if (room.state?.players) return room;
  await new Promise((res) => room.onStateChange.once(res));
  return room;
}

async function main() {
  console.log(`→ ${ENDPOINT}\n`);

  // First human in. Bots fill the remaining seats after the fill delay.
  const a = await joined(await new Client(ENDPOINT).joinOrCreate('arena', { mode: 'casual', name: 'Alpha' }));
  a.onMessage('fx', () => {});
  a.onMessage('feed', () => {});
  console.log('after Alpha joins + bot fill:');
  await new Promise((r) => setTimeout(r, 11000));
  let rows = table(a);
  console.log('   ', show(rows), '\n');
  check('lobby topped up to 8', rows.length === 8, `${rows.length}`);
  check('7 of them are bots', rows.filter((r) => r.bot).length === 7);
  check('the roster splits four and four',
    rows.filter((r) => r.team === 0).length === 4 && rows.filter((r) => r.team === 1).length === 4,
    show(rows));

  // Second human joins a lobby with no free seats — a bot must make way.
  const b = await joined(await new Client(ENDPOINT).joinOrCreate('arena', { mode: 'casual', name: 'Bravo' }));
  b.onMessage('fx', () => {});
  b.onMessage('feed', () => {});
  await new Promise((r) => setTimeout(r, 1500));

  rows = table(a);
  console.log('after Bravo joins:');
  console.log('   ', show(rows), '\n');

  const humans = rows.filter((r) => !r.bot);
  const seats = rows.map((r) => r.seat);
  const uniqueSeats = new Set(seats);

  check('still exactly 8 players', rows.length === 8, `${rows.length}`);
  check('both humans are present', humans.length === 2, humans.map((h) => h.name).join(', '));
  check('a bot was evicted, not stacked', rows.filter((r) => r.bot).length === 2);
  check('every seat is unique', uniqueSeats.size === rows.length, `seats=[${seats.join(',')}]`);
  check('Alpha kept their original seat', table(a).find((r) => r.name === 'Alpha')?.seat === rows.find((r) => r.name === 'Alpha')?.seat);

  // Leaving frees the seat for a bot to reclaim.
  await b.leave(true);
  await new Promise((r) => setTimeout(r, 1500));
  rows = table(a);
  console.log('after Bravo leaves:');
  console.log('   ', show(rows), '\n');
  check('lobby refilled back to 8', rows.length === 8, `${rows.length}`);
  check('seats still unique after refill', new Set(rows.map((r) => r.seat)).size === rows.length,
    `seats=[${rows.map((r) => r.seat).join(',')}]`);
  check('only Alpha remains human', rows.filter((r) => !r.bot).length === 1);

  await a.leave(true);
  console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
