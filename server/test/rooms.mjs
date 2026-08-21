// Room code + server browser test.
//
// The load-bearing guarantee is isolation: a public queue must never drop a
// stranger into a friends-only match, and two people typing the same code must
// always land together. Everything else here is secondary.
//
//   npm run dev:server
//   node server/test/rooms.mjs

import { Client } from 'colyseus.js';
import { makeRoomCode, cleanRoomCode } from '@cluckdown/shared';

const ENDPOINT = process.env.SMOKE_ENDPOINT || 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const join = async (opts) => {
  const room = await new Client(ENDPOINT).joinOrCreate('arena', { code: '', ...opts });
  if (!room.state?.players) await new Promise((r) => room.onStateChange.once(r));
  room.onMessage('fx', () => {});
  room.onMessage('feed', () => {});
  return room;
};

async function main() {
  console.log(`→ ${ENDPOINT}\n`);
  const code = makeRoomCode();
  console.log(`  using code ${code}\n`);

  // --- two friends with the same code land together ----------------------
  const a = await join({ mode: 'casual', name: 'Ana', code });
  const b = await join({ mode: 'casual', name: 'Ben', code });
  check('same code puts friends in one room', a.roomId === b.roomId, `${a.roomId} / ${b.roomId}`);

  // --- a different code must NOT reach them ------------------------------
  const otherCode = code === 'AAAA' ? 'BBBB' : 'AAAA';
  const c = await join({ mode: 'casual', name: 'Cat', code: otherCode });
  check('a different code gets a different room', c.roomId !== a.roomId, `${c.roomId} vs ${a.roomId}`);

  // --- the public queue must never reach a coded room --------------------
  const pub = await join({ mode: 'casual', name: 'Stranger' });
  check('public queue never enters a private room',
    pub.roomId !== a.roomId && pub.roomId !== c.roomId,
    `public=${pub.roomId} private=${a.roomId},${c.roomId}`);

  // A client that knows the room id but not the code must be turned away.
  // This is the real guarantee — matchmaking filters can be side-stepped by
  // simply omitting the field, so the room itself has to say no.
  let rejected = false;
  try {
    const sneak = await new Client(ENDPOINT).joinById(a.roomId, { name: 'Sneak' });
    await sneak.leave(true);
  } catch {
    rejected = true;
  }
  check('joining a private room without the code is refused', rejected);

  let wrongCode = false;
  try {
    const bad = await new Client(ENDPOINT).joinById(a.roomId, { name: 'Bad', code: 'ZZZZ' });
    await bad.leave(true);
  } catch {
    wrongCode = true;
  }
  check('joining with the wrong code is refused', wrongCode);

  // --- and coded rooms stay out of the browser ---------------------------
  const listed = await (await fetch(`${HTTP}/rooms`)).json();
  const ids = listed.rooms.map((r) => r.roomId);
  console.log('\n  /rooms:', JSON.stringify(listed.rooms));
  check('private rooms are hidden from the browser',
    !ids.includes(a.roomId) && !ids.includes(c.roomId), ids.join(', ') || '(none)');
  check('the public room IS listed', ids.includes(pub.roomId), ids.join(', ') || '(none)');

  const pubRow = listed.rooms.find((r) => r.roomId === pub.roomId);
  check('listing reports mode and capacity',
    pubRow?.mode === 'casual' && pubRow?.maxPlayers === 8, JSON.stringify(pubRow));
  check('listing counts the human', pubRow?.humans >= 1, `humans=${pubRow?.humans}`);

  // --- joinById works, which is what the browser button does -------------
  const viaBrowser = await new Client(ENDPOINT).joinById(pub.roomId, { name: 'Browser' });
  if (!viaBrowser.state?.players) await new Promise((r) => viaBrowser.onStateChange.once(r));
  viaBrowser.onMessage('fx', () => {});
  viaBrowser.onMessage('feed', () => {});
  check('joining by id from the browser works', viaBrowser.roomId === pub.roomId);

  // --- code normalisation (a pure client-side concern) -------------------
  check('lowercase input is uppercased', cleanRoomCode('ab2c') === 'AB2C');
  check('confusable and stray characters are stripped', cleanRoomCode('a-b 2!c') === 'AB2C');
  check('over-long input is truncated', cleanRoomCode('ABCDEFGH').length === 4);
  check('garbage becomes empty, not a false match', cleanRoomCode('!!!') === '');

  // ...and a client sending the cleaned value lands with its friends.
  const lower = await join({ mode: 'casual', name: 'Lower', code: cleanRoomCode(code.toLowerCase()) });
  check('a normalised code reaches the same room', lower.roomId === a.roomId, `${lower.roomId} vs ${a.roomId}`);

  await Promise.all([a, b, c, pub, viaBrowser, lower].map((r) => r.leave(true).catch(() => {})));
  await new Promise((r) => setTimeout(r, 500)); // let sockets close before exit

  console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
